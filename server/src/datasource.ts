// Data acquisition: poll the active source (radio | api), normalize records
// into our Aircraft shape, enrich them, and emit snapshots. dump1090-fa and
// airplanes.live both use the readsb JSON schema, so one normalizer covers both.

import type { Aircraft, Config, DataSource } from "@shared/index.js";
import type { SourceStatus } from "@shared/index.js";
import { lookupAirline, lookupType } from "./enrich/tables.js";
import type { RouteEnricher } from "./enrich/routes.js";

/** Raw readsb-style aircraft record (subset we use). */
interface RawAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  squawk?: string;
  category?: string;
  r?: string;
  t?: string;
  seen?: number;
  rssi?: number;
}

function normalize(raw: RawAircraft, ts: number): Aircraft | null {
  if (!raw.hex) return null;
  const onGround = raw.alt_baro === "ground";
  return {
    hex: raw.hex,
    flight: raw.flight?.trim() || undefined,
    lat: raw.lat,
    lon: raw.lon,
    altBaro: onGround ? null : (raw.alt_baro as number | undefined) ?? null,
    altGeom: raw.alt_geom ?? null,
    gs: raw.gs,
    track: raw.track,
    baroRate: raw.baro_rate ?? null,
    squawk: raw.squawk,
    category: raw.category,
    onGround,
    registration: raw.r,
    typeCode: raw.t,
    seen: raw.seen,
    rssi: raw.rssi,
    ts,
  };
}

/** Airplanes.live radius is nautical miles; SkyLight config uses statute miles. */
const NM_PER_MILE = 0.868976;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    /** Seconds to wait before retrying, from Retry-After header (if present). */
    public readonly retryAfterSec?: number,
  ) {
    super(`HTTP ${status}`);
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    let retryAfterSec: number | undefined;
    if (res.status === 429) {
      const h = res.headers.get("Retry-After");
      if (h) {
        const n = Number(h);
        retryAfterSec = Number.isFinite(n) && n > 0 ? n : undefined;
      }
    }
    throw new HttpError(res.status, retryAfterSec);
  }
  return res.json();
}

export interface PollerOptions {
  source: DataSource;
  /** dump1090 aircraft.json URL (radio source). */
  radioUrl: string;
  /** airplanes.live point template, {lat}/{lon}/{r} are filled from config. */
  apiUrlTemplate: string;
  pollMs: number;
  /** When source is "radio", also poll the API and merge (keeps landing
   *  aircraft alive when local ADS-B drops them). */
  supplementApi: boolean;
  /** API poll cadence when supplementing (slower, to respect rate limits). */
  apiPollMs: number;
  getConfig: () => Config;
  enricher: RouteEnricher;
  onSnapshot: (now: number, aircraft: Aircraft[]) => void;
  onStatus: (status: SourceStatus) => void;
}

/**
 * Merge a primary (radio) list with a secondary (API) list by hex, preferring
 * whichever fix is fresher. Radio is biased a couple seconds so it wins while
 * it's tracking; the API takes over only once the radio fix goes stale.
 */
function mergeSources(radio: Aircraft[], api: Aircraft[]): Aircraft[] {
  const byHex = new Map<string, Aircraft>();
  for (const a of api) byHex.set(a.hex, a);
  for (const r of radio) {
    const existing = byHex.get(r.hex);
    if (!existing) {
      byHex.set(r.hex, r);
      continue;
    }
    const radioArrival = (r.ts ?? 0) + 2000; // local radio keeps a two-second preference
    const apiArrival = existing.ts ?? 0;
    byHex.set(r.hex, radioArrival >= apiArrival ? r : existing);
  }
  return [...byHex.values()];
}

/** Enrichment we've resolved for an aircraft, kept sticky for its session. */
interface StickyEnrichment {
  typeName?: string;
  airline?: string;
  origin?: string;
  destination?: string;
  registration?: string;
  originName?: string;
  destName?: string;
  originLat?: number;
  originLon?: number;
  destLat?: number;
  destLon?: number;
  lastSeen: number;
}

export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private apiTimer: ReturnType<typeof setInterval> | null = null;
  private status: SourceStatus;
  private last: Aircraft[] = [];
  /** Most recent API snapshot, used to supplement the radio. */
  private lastApi: Aircraft[] = [];
  /** hex -> last good enrichment, so resolved routes never flicker back to "—". */
  private sticky = new Map<string, StickyEnrichment>();
  private tickRunning = false;
  private apiRunning = false;
  private apiFailures = 0;
  private nextApiAttempt = 0;
  /** Consecutive primary-source failures (used for backoff when rate-limited). */
  private primaryFailures = 0;
  /** Earliest time (Date.now()) we're allowed to retry the primary source. */
  private nextPrimaryAttempt = 0;
  private lastStickyPrune = 0;
  private followTargetHex = "";
  private followTargetPosition: { lat: number; lon: number } | null = null;
  private followedAircraft: Aircraft | null = null;

  constructor(private o: PollerOptions) {
    this.status = {
      source: o.source,
      ok: false,
      count: 0,
      lastOk: null,
    };
  }

  getSnapshot(): { now: number; aircraft: Aircraft[] } {
    return { now: Date.now(), aircraft: this.last };
  }
  getStatus(): SourceStatus {
    return this.status;
  }
  setSource(source: DataSource): void {
    this.o.source = source;
    this.status.source = source;
    this.syncApiTimer();
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.o.pollMs);
    this.syncApiTimer();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.apiTimer) clearInterval(this.apiTimer);
    this.timer = null;
    this.apiTimer = null;
  }

  /**
   * The supplement timer should only run when radio is primary — it exists to
   * keep landing aircraft alive when local ADS-B drops them. When the API is
   * itself the primary source, tick() already polls it, so a second timer just
   * doubles the request rate into airplanes.live and causes 429s.
   */
  private syncApiTimer(): void {
    const want = this.o.source === "radio" && this.o.supplementApi;
    if (want && !this.apiTimer && this.timer) {
      void this.refreshApi();
      this.apiTimer = setInterval(() => void this.refreshApi(), this.o.apiPollMs);
    } else if (!want && this.apiTimer) {
      clearInterval(this.apiTimer);
      this.apiTimer = null;
      this.lastApi = [];
    }
  }

  private async fetchList(source: DataSource, now: number): Promise<{ list: Aircraft[]; rateLimited: boolean; retryAfterSec?: number } | null> {
    // Timeout = 80% of poll interval, capped at 4 s. Prevents fetch pile-up
    // when the source is slow (e.g. Pi SDR under load).
    const timeoutMs = Math.min(4000, this.o.pollMs * 0.8);
    try {
      const url = source === "radio" ? this.o.radioUrl : this.buildApiUrl();
      const json = await fetchJson(url, timeoutMs);
      const payload = json.aircraft ?? json.ac;
      if (!Array.isArray(payload)) throw new Error("malformed aircraft payload");
      const rawList: RawAircraft[] = payload;
      const list: Aircraft[] = [];
      for (const raw of rawList) {
        const ac = normalize(raw, now);
        if (ac) list.push(ac);
      }
      return { list, rateLimited: false };
    } catch (error) {
      const rateLimited = error instanceof HttpError && error.status === 429;
      const retryAfterSec = error instanceof HttpError ? error.retryAfterSec : undefined;
      const message = error instanceof Error ? error.message : "unknown fetch error";
      if (source === this.o.source) {
        this.status = { ...this.status, ok: false, message };
      }
      return rateLimited ? { list: [], rateLimited: true, retryAfterSec } : null;
    }
  }

  private async refreshApi(): Promise<void> {
    if (!this.o.supplementApi || this.o.source !== "radio") return;
    const now = Date.now();
    if (this.apiRunning || now < this.nextApiAttempt) return;
    this.apiRunning = true;
    try {
      const result = await this.fetchList("api", now);
      if (result) {
        this.lastApi = result.list;
        this.apiFailures = 0;
        this.nextApiAttempt = 0;
      } else {
        this.apiFailures++;
        this.nextApiAttempt = now + Math.min(60_000, this.o.apiPollMs * 2 ** this.apiFailures);
      }
    } finally {
      this.apiRunning = false;
    }
  }

  private buildApiUrl(): string {
    const c = this.o.getConfig();
    const followHex = c.followFlightHex.toLowerCase();
    if (followHex !== this.followTargetHex) {
      this.followTargetHex = followHex;
      this.followTargetPosition = null;
      this.followedAircraft = null;
    }
    const followed = followHex
      ? this.last.find((ac) => ac.hex.toLowerCase() === c.followFlightHex.toLowerCase())
      : undefined;
    if (followed?.lat != null && followed.lon != null) {
      this.followTargetPosition = { lat: followed.lat, lon: followed.lon };
    }
    const lat = this.followTargetPosition?.lat ?? c.centerLat;
    const lon = this.followTargetPosition?.lon ?? c.centerLon;
    const r = Math.min(250, Math.ceil(c.radiusMiles * NM_PER_MILE) + 1);
    return this.o.apiUrlTemplate
      .replace("{lat}", String(lat))
      .replace("{lon}", String(lon))
      .replace("{r}", String(r));
  }

  private async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    const now = Date.now();
    try {
      // If we're in a rate-limit backoff window, skip the fetch but still
      // re-broadcast the last known snapshot so the renderer's lastSeen
      // timestamps stay fresh — preventing the freeze-then-jump artifact.
      if (now < this.nextPrimaryAttempt) {
        this.status = { ...this.status, retryAfterMs: this.nextPrimaryAttempt };
        this.o.onSnapshot(now, this.last);
        this.o.onStatus(this.status);
        return;
      }

      const result = await this.fetchList(this.o.source, now);

      if (result === null) {
        // Hard error (network failure, malformed response, etc.) — don't re-broadcast.
        this.primaryFailures++;
        this.o.onStatus(this.status);
        return;
      }

      if (result.rateLimited) {
        // 429: honour Retry-After if the server sent one; otherwise back off
        // exponentially (pollMs × 2^failures, capped at 60s).
        this.primaryFailures++;
        const serverWaitMs = result.retryAfterSec != null ? result.retryAfterSec * 1000 : 0;
        const backoffMs = Math.min(60_000, this.o.pollMs * 2 ** this.primaryFailures);
        this.nextPrimaryAttempt = now + Math.max(serverWaitMs, backoffMs);
        this.status = { ...this.status, retryAfterMs: this.nextPrimaryAttempt };
        this.o.onSnapshot(now, this.last);
        this.o.onStatus(this.status);
        return;
      }

      // Clean success — reset backoff.
      this.primaryFailures = 0;
      this.nextPrimaryAttempt = 0;

      const primary = result.list;
      const supplement = this.o.source === "radio" && this.o.supplementApi;
      const merged = supplement ? mergeSources(primary, this.lastApi) : primary;
      this.retainFollowedAircraft(merged, now);
      for (const ac of merged) this.enrich(ac, now);
      this.last = merged;
      if (now - this.lastStickyPrune > 60_000) {
        this.pruneSticky(now);
        this.lastStickyPrune = now;
      }
      this.status = {
        source: this.o.source,
        ok: true,
        count: merged.length,
        lastOk: now,
        pollMs: this.o.pollMs,
        message: supplement ? `radio + ${this.lastApi.length} via API` : undefined,
        retryAfterMs: undefined,
      };
      this.o.onSnapshot(now, merged);
      this.o.onStatus(this.status);
    } finally {
      this.tickRunning = false;
    }
  }

  private retainFollowedAircraft(aircraft: Aircraft[], now: number): void {
    const config = this.o.getConfig();
    const followHex = config.followFlightHex.toLowerCase();
    if (!followHex) {
      this.followedAircraft = null;
      return;
    }
    const current = aircraft.find((ac) => ac.hex.toLowerCase() === followHex);
    if (current) {
      this.followedAircraft = current;
      if (current.lat != null && current.lon != null) {
        this.followTargetPosition = { lat: current.lat, lon: current.lon };
      }
      return;
    }
    const cached = this.followedAircraft;
    if (cached && now - (cached.ts ?? now) <= config.hideOnlyAfterSec * 1000) {
      aircraft.push(cached);
    }
  }

  private enrich(ac: Aircraft, now: number): void {
    // Instant table lookups first.
    ac.typeName = lookupType(ac.typeCode);
    ac.airline = lookupAirline(ac.flight);

    // adsbdb fills gaps (route + better type), from cache when available.
    const e = this.o.enricher.enrichSync(ac.hex, ac.flight, now);
    if (e.route) {
      ac.airline = ac.airline ?? e.route.airline;
      ac.origin = e.route.origin ?? ac.origin;
      ac.destination = e.route.destination ?? ac.destination;
      ac.originName = e.route.originName ?? ac.originName;
      ac.destName = e.route.destName ?? ac.destName;
      ac.originLat = e.route.originLat ?? ac.originLat;
      ac.originLon = e.route.originLon ?? ac.originLon;
      ac.destLat = e.route.destLat ?? ac.destLat;
      ac.destLon = e.route.destLon ?? ac.destLon;
    }
    if (e.aircraft) {
      ac.typeName = ac.typeName ?? e.aircraft.typeName;
      ac.registration = ac.registration ?? e.aircraft.registration;
    }

    // Sticky merge: once we've resolved something for this hex, never drop it
    // back to undefined on a later snapshot (prevents label flicker).
    const prev = this.sticky.get(ac.hex);
    ac.typeName = ac.typeName ?? prev?.typeName;
    ac.airline = ac.airline ?? prev?.airline;
    ac.origin = ac.origin ?? prev?.origin;
    ac.destination = ac.destination ?? prev?.destination;
    ac.registration = ac.registration ?? prev?.registration;
    ac.originName = ac.originName ?? prev?.originName;
    ac.destName = ac.destName ?? prev?.destName;
    ac.originLat = ac.originLat ?? prev?.originLat;
    ac.originLon = ac.originLon ?? prev?.originLon;
    ac.destLat = ac.destLat ?? prev?.destLat;
    ac.destLon = ac.destLon ?? prev?.destLon;
    this.sticky.set(ac.hex, {
      typeName: ac.typeName,
      airline: ac.airline,
      origin: ac.origin,
      destination: ac.destination,
      registration: ac.registration,
      originName: ac.originName,
      destName: ac.destName,
      originLat: ac.originLat,
      originLon: ac.originLon,
      destLat: ac.destLat,
      destLon: ac.destLon,
      lastSeen: now,
    });
  }

  /** Drop sticky entries for aircraft long gone (keep the map small). */
  private pruneSticky(now: number): void {
    for (const [hex, s] of this.sticky) {
      if (now - s.lastSeen > 600_000) this.sticky.delete(hex);
    }
  }

  /**
   * Search for a flight by callsign worldwide.
   * Queries adsb.lol and adsb.fi in parallel (both free, no auth, same readsb
   * JSON schema) then deduplicates by hex. adsb.fi has better Asia/Pacific
   * coverage; adsb.lol is stronger in Europe and North America.
   */
  async searchByCallsign(q: string): Promise<Aircraft[]> {
    const callsign = encodeURIComponent(q.toUpperCase());
    const sources = [
      `https://api.adsb.lol/v2/callsign/${callsign}`,
      `https://opendata.adsb.fi/api/v2/callsign/${callsign}`,
    ];
    const now = Date.now();
    const results = await Promise.allSettled(sources.map((url) => fetchJson(url, 5000)));
    const byHex = new Map<string, Aircraft>();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const payload: RawAircraft[] = result.value.aircraft ?? result.value.ac ?? [];
      for (const raw of payload) {
        const ac = normalize(raw, now);
        if (!ac || byHex.has(ac.hex)) continue;
        ac.typeName = lookupType(ac.typeCode);
        ac.airline = lookupAirline(ac.flight);
        const e = this.o.enricher.enrichSync(ac.hex, ac.flight, now);
        if (e.route) {
          ac.airline = ac.airline ?? e.route.airline;
          ac.origin = e.route.origin;
          ac.destination = e.route.destination;
        }
        byHex.set(ac.hex, ac);
      }
    }
    return [...byHex.values()].slice(0, 10);
  }

  /** Pre-seed the follow target position so the next API poll centres there. */
  seedFollowPosition(lat: number, lon: number): void {
    this.followTargetPosition = { lat, lon };
  }
}
