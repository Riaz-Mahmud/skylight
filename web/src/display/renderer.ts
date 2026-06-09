// Canvas renderer — the art piece.
//
// Motion model: every fix is stamped with its local arrival time and pushed to a
// per-aircraft history. We render the world RENDER_DELAY_MS in the past and
// *interpolate* between the two surrounding real fixes (rather than extrapolating
// into the future). Interpolating between known points is buttery smooth and
// removes the once-per-second "snap" you get from naive dead-reckoning. The small
// added latency is irrelevant for an ambient ceiling piece.
//
// Visual language: pure black, luminous altitude-graded glyphs, comet trails that
// taper and fade, and restrained typography that fades in only for the nearest few.

import {
  llToMeters,
  project,
  pxPerMeter,
  deadReckon,
  rangeMeters,
  metersToMiles,
  EMERGENCY_SQUAWKS,
  type Aircraft,
  type Config,
  type Meters,
  type Point,
} from "@shared/index.js";
import { AIRPORTS, getAirportRevision, type Airport, type AirportArea } from "./airports.js";
import { classifyGlyph, drawAircraftGlyph, GLYPH_SCALE } from "./aircraftGlyph.js";
import { computeSky, type Sky, type Tle } from "./celestial.js";
import { ASTERISMS } from "./stars.js";
import { CITIES } from "./cities.js";
import { WeatherRadar } from "./weather.js";

/** How far in the past we render, ms. Starts at 1.15× the default poll cadence
 *  and is updated at runtime from the server's reported pollMs. */
const DEFAULT_RENDER_DELAY_MS = 1150;

interface Sample {
  t: number; // performance.now() at arrival
  /** Absolute geographic position — stored as lat/lon so trails survive
   *  center changes (pan commits). Reprojected to meters during draw. */
  lat: number;
  lon: number;
  track?: number;
  gs?: number;
}

class CircularBuffer<T> implements Iterable<T> {
  private values: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private capacity: number) {
    this.values = new Array(capacity);
  }

  get length(): number {
    return this.count;
  }

  push(value: T): void {
    const index = (this.head + this.count) % this.capacity;
    this.values[index] = value;
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }

  at(index: number): T {
    const value = this.values[(this.head + index) % this.capacity];
    if (value === undefined) throw new RangeError("circular buffer index out of range");
    return value;
  }

  last(): T | undefined {
    return this.count ? this.at(this.count - 1) : undefined;
  }

  drop(count: number): void {
    const removed = Math.min(count, this.count);
    this.head = (this.head + removed) % this.capacity;
    this.count -= removed;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (let i = 0; i < this.count; i++) yield this.at(i);
  }
}

interface Track {
  ac: Aircraft;
  history: CircularBuffer<Sample>;
  firstSeen: number;
  lastSeen: number;
  hasPos: boolean;
  /** Smoothed appearance alpha (fade in on spawn, out when stale). */
  life: number;
  /** Separate alpha for labels — lags behind `life` so labels dissolve rather
   *  than snapping on/off with the glyph. */
  labelLife: number;
  /** True when the aircraft is no longer in the live feed but still in memory. */
  estimated: boolean;
  /** Number of consecutive update cycles where this aircraft was absent. */
  missingCycles: number;
  renderedM?: Meters;
  /** Exponentially smoothed heading in radians (screen space). Eliminates
   *  per-fix rotation jitter caused by quantised ADS-B track values. */
  renderedHeading?: number;
  /** Cached llToMeters results for the trail. Avoids recomputing trig every
   *  frame — only rebuilt when the center or history changes. */
  trailMeters?: Meters[];
  /** Key that was used to build trailMeters: "lat:lon:len:lastT". */
  trailMeterKey?: string;
  /** performance.now() when an alert pulse was triggered, undefined = none. */
  alertPulseAt?: number;
  /** Visual colour of the active alert pulse. */
  alertPulseKind?: "emergency" | "interesting" | "watchlist";
  /** Set once we're confident the aircraft has landed (soft-landing hysteresis).
   *  Prevents the flicker caused by a taxiing plane oscillating around the
   *  speed threshold — once committed, the track is suppressed for good. */
  landingCommitted?: boolean;
  /** performance.now() of the most recent history entry we've seen, used to
   *  detect data gaps and dead-reckon renderedM through them so we never get
   *  a large snap when positions resume after a pause. */
  lastFixT?: number;
}

type ProjOpts = Parameters<typeof project>[1];

// Altitude colour ramp — warm low, cool high. Tuned to glow on black.
const ALT_STOPS: [number, [number, number, number]][] = [
  [0, [255, 138, 61]], // amber (ground / pattern)
  [4000, [255, 198, 92]], // gold
  [10000, [120, 224, 196]], // teal
  [20000, [110, 178, 255]], // sky blue
  [30000, [150, 150, 255]], // periwinkle
  [40000, [232, 236, 255]], // near-white
];

function altRamp(alt: number): [number, number, number] {
  if (alt <= ALT_STOPS[0][0]) return ALT_STOPS[0][1];
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (alt <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1];
      const [a1, c1] = ALT_STOPS[i];
      const f = (alt - a0) / (a1 - a0);
      return [
        c0[0] + (c1[0] - c0[0]) * f,
        c0[1] + (c1[1] - c0[1]) * f,
        c0[2] + (c1[2] - c0[2]) * f,
      ];
    }
  }
  return ALT_STOPS[ALT_STOPS.length - 1][1];
}

const rgba = (c: [number, number, number], a: number) =>
  `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

interface Visible {
  tr: Track;
  m: Meters;
  p: Point;
  heading: number;
  rangeMi: number;
  alpha: number;
  /** Separate alpha for labels, lags behind alpha so labels dissolve smoothly. */
  labelAlpha: number;
  color: [number, number, number];
  emergency: boolean;
  followed: boolean;
  /** Whether this track is kept by the memory system (not in current feed). */
  estimated: boolean;
}

export interface AircraftHit {
  aircraft: Aircraft;
  x: number;
  y: number;
  followed: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private issPulseAt?: number;
  private weather = new WeatherRadar();
  private tracks = new Map<string, Track>();
  private raf = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private prevFrame = 0;
  /** When the next frame is due (ms, rAF clock), for the maxFps cap.
   *  0 = uninitialized; set on the first capped frame. */
  private nextFrameDue = 0;
  /** Current frame time in seconds, for animating props/rotors. */
  private frameT = 0;

  // Sky layer state.
  private tles: Tle[] = [];
  private sky: Sky = { stars: [], sats: [], planets: [] };
  private skyComputedAt = 0;
  private skyOffsetUsed = NaN;
  private nearbyAirports: Airport[] = [];
  private nearbyAirportsKey = "";
  private followOffset: Meters = { east: 0, north: 0 };
  private followVelocity: Meters = { east: 0, north: 0 };
  private activeFollowHex = "";
  private visibleHits: AircraftHit[] = [];
  /** Tracks the last committed center so we can detect pan commits and
   *  invalidate smoothed renderedM positions on all tracks. */
  private lastCenterLat = NaN;
  private lastCenterLon = NaN;
  /** How far in the past we render. Updated via setPollMs() when the server
   *  reports its poll cadence so the delay auto-tunes to any poll rate. */
  private renderDelayMs = DEFAULT_RENDER_DELAY_MS;

  // ── Pan / explore mode ──────────────────────────────────────────────────────
  /** Extra camera offset set by the drag-to-pan gesture (meters, config coords). */
  private panOffset: Meters = { east: 0, north: 0 };
  /** True while the user is actively dragging. */
  private panning = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private getConfig: () => Config,
  ) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  start(): void {
    void this.fetchTles();
    setInterval(() => void this.fetchTles(), 3600_000);
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      // Cap to maxFps via an accumulator: advance a running "due" time by whole
      // frame intervals so the cadence stays anchored to a schedule (even
      // pacing, no drift) rather than to actual draw timestamps. fps <= 0 means
      // uncapped — draw on every rAF tick.
      const fps = this.getConfig().maxFps;
      if (fps > 0) {
        const interval = 1000 / fps;
        if (this.nextFrameDue === 0) this.nextFrameDue = now;
        if (now < this.nextFrameDue) return; // not due yet — skip this tick
        this.nextFrameDue += interval;
        // If we've fallen more than a frame behind (e.g. tab was backgrounded
        // or a draw stalled), resync to avoid a burst of catch-up frames.
        if (now - this.nextFrameDue > interval) this.nextFrameDue = now + interval;
      } else {
        this.nextFrameDue = 0; // reset so re-enabling the cap starts clean
      }
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private async fetchTles(): Promise<void> {
    try {
      const res = await fetch("/api/tle");
      if (res.ok) this.tles = (await res.json()) as Tle[];
    } catch {
      /* keep whatever we had */
    }
  }
  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  /** Called when the server reports its poll cadence. Adjusts the render lag
   *  window so interpolation stays centred between real fixes at any poll rate. */
  setPollMs(pollMs: number): void {
    this.renderDelayMs = pollMs * 1.15;
  }

  /** Must be called from a user-gesture handler (click / keydown) to unlock
   *  the Web Audio context. Safe to call multiple times. */
  initAudio(): void {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    else if (this.audioCtx.state === "suspended") void this.audioCtx.resume();
  }

  /** Live stats for the HUD and diagnostics page. */
  getStats(): { total: number; estimated: number; stale: number } {
    const cfg = this.getConfig();
    let estimated = 0;
    let stale = 0;
    const now = performance.now();
    for (const tr of this.tracks.values()) {
      const ageSec = (now - tr.lastSeen) / 1000;
      if (tr.estimated) estimated++;
      if (ageSec > cfg.staleSec) stale++;
    }
    return { total: this.tracks.size, estimated, stale };
  }

  hitTest(clientX: number, clientY: number): AircraftHit | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: AircraftHit | null = null;
    let bestDistance = 32;
    for (const hit of this.visibleHits) {
      const distance = Math.hypot(hit.x - x, hit.y - y);
      if (distance < bestDistance) {
        best = hit;
        bestDistance = distance;
      }
    }
    return best;
  }

  hitTestAirport(clientX: number, clientY: number): Airport | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const cfg = this.getConfig();
    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    const proj = {
      rotationDeg: cfg.rotationDeg,
      mirrorX: cfg.mirrorX,
      mirrorY: cfg.mirrorY,
      pxPerM,
      screenW: this.w,
      screenH: this.h,
    };

    let best: Airport | null = null;
    let bestDistance = 25; // 25px click radius

    for (const ap of this.nearbyAirports) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const r of ap.runways) {
        const a = this.toScreen(r.le, cfg, proj);
        const b = this.toScreen(r.he, cfg, proj);
        cx += (a.x + b.x) / 2;
        cy += (a.y + b.y) / 2;
        n++;
      }
      if (n) {
        cx /= n;
        cy /= n;
        const distance = Math.hypot(cx - x, cy - y);
        if (distance < bestDistance) {
          best = ap;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  getAircraftHit(hex: string): AircraftHit | null {
    return this.visibleHits.find((hit) => hit.aircraft.hex.toLowerCase() === hex.toLowerCase()) ?? null;
  }

  getAirportScreenPos(icao: string): { x: number; y: number } | null {
    const ap = this.nearbyAirports.find(a => a.icao.toUpperCase() === icao.toUpperCase());
    if (!ap) return null;
    const cfg = this.getConfig();
    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    const proj = {
      rotationDeg: cfg.rotationDeg,
      mirrorX: cfg.mirrorX,
      mirrorY: cfg.mirrorY,
      pxPerM,
      screenW: this.w,
      screenH: this.h,
    };
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const r of ap.runways) {
      const a = this.toScreen(r.le, cfg, proj);
      const b = this.toScreen(r.he, cfg, proj);
      cx += (a.x + b.x) / 2;
      cy += (a.y + b.y) / 2;
      n++;
    }
    if (n) {
      cx /= n;
      cy /= n;
    } else {
      const pt = this.toScreen([ap.lat, ap.lon], cfg, proj);
      cx = pt.x;
      cy = pt.y;
    }
    return { x: cx, y: cy };
  }

  // ── Pan / explore mode ──────────────────────────────────────────────────────

  /**
   * Called on every mousemove/touchmove during a pan gesture.
   * `dx`/`dy` are screen-pixel deltas since the last call.
   * The renderer shifts the view in real-time without touching config.
   */
  applyPanDelta(dx: number, dy: number): void {
    const cfg = this.getConfig();
    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    // Screen delta → local meters.  Note: screen-Y is inverted vs north.
    // We also need to un-rotate and un-mirror to get back to config space.
    const DEG = Math.PI / 180;
    const angle = cfg.rotationDeg * DEG;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Un-mirror first.
    const sdx = cfg.mirrorX ? dx : -dx;
    const sdy = cfg.mirrorY ? -dy : dy;
    // Un-rotate.
    const east  =  (sdx * cos + sdy * sin) / pxPerM;
    const north = (-sdx * sin + sdy * cos) / pxPerM;
    this.panOffset = {
      east:  this.panOffset.east  + east,
      north: this.panOffset.north + north,
    };
    this.panning = true;
  }

  /** Clear the pan offset (e.g. after committing the new center). */
  resetPan(): void {
    this.panOffset = { east: 0, north: 0 };
    this.panning = false;
  }

  /**
   * Convert the current pan offset to a lat/lon delta so the caller
   * can commit the new center to config.
   * Returns { centerLat, centerLon } ready to pass to patchConfig.
   */
  getPannedCenter(): { centerLat: number; centerLon: number } {
    const cfg = this.getConfig();
    const DEG = Math.PI / 180;
    const dLat = this.panOffset.north / 110540;
    const dLon = this.panOffset.east  / (111320 * Math.cos(cfg.centerLat * DEG));
    return {
      centerLat: cfg.centerLat + dLat,
      centerLon: cfg.centerLon + dLon,
    };
  }

  /** Whether a pan is currently in progress. */
  isPanning(): boolean {
    return this.panning;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Feed a fresh snapshot. Stamps each fix with local arrival time. */
  update(aircraft: Aircraft[]): void {
    const cfg = this.getConfig();
    const now = performance.now();
    const seenHexes = new Set<string>();
    /** Hexes that are still in the live feed but now fail the filter (e.g. just
     *  landed). We remove them immediately instead of leaving them as estimated
     *  ghosts on the runway while the next arrival is on final approach. */
    const failedFilterHexes = new Set<string>();

    for (const ac of aircraft) {
      const hex = ac.hex.toLowerCase();
      if (!this.passesFilter(ac, cfg)) {
        // If we were already tracking this aircraft, mark it for immediate removal.
        if (this.tracks.has(hex)) failedFilterHexes.add(hex);
        continue;
      }
      seenHexes.add(hex);
      const hasPos = ac.lat != null && ac.lon != null;
      let tr = this.tracks.get(hex);
      if (!tr) {
        tr = {
          ac,
          history: new CircularBuffer<Sample>(4096),
          firstSeen: now,
          lastSeen: now,
          hasPos,
          life: 0,
          labelLife: 0,
          estimated: false,
          missingCycles: 0,
        };
        this.tracks.set(hex, tr);
      }
      tr.ac = ac;
      tr.lastSeen = now;
      tr.hasPos = hasPos;
      tr.estimated = false;
      tr.missingCycles = 0;
      if (hasPos) {
        const last = tr.history.last();
        // Dedup identical fixes (source sometimes repeats a position).
        if (!last || last.lat !== ac.lat || last.lon !== ac.lon) {
          tr.history.push({ t: now, lat: ac.lat!, lon: ac.lon!, track: ac.track, gs: ac.gs });
          tr.lastFixT = now;
          // Keep the full flight path for the followed aircraft (up to buffer
          // capacity); everyone else is trimmed to the trail window.
          const isFollowed = hex === cfg.followFlightHex.toLowerCase();
          const keep = isFollowed ? Infinity : Math.max(cfg.trailSeconds, 6) * 1000 + 4000;
          let trim = 0;
          while (trim < tr.history.length - 2 && now - tr.history.at(trim).t > keep) trim++;
          tr.history.drop(trim);
        }
        // Pre-seed renderedM on first position so draw() has no cold-start snap.
        // We use the raw lat/lon→meters directly rather than waiting for sampleAt,
        // which needs the history to have at least one entry (which we just pushed).
        if (!tr.renderedM) {
          tr.renderedM = llToMeters(ac.lat!, ac.lon!, cfg.centerLat, cfg.centerLon);
        }
      }
    }

    // Remove tracks that are still present in the live feed but now fail the
    // filter (e.g. the aircraft just landed and crossed the near-ground threshold).
    // Doing this here — before the estimated-memory block — ensures they vanish
    // immediately rather than lingering as dimmed ghosts on the runway.
    for (const hex of failedFilterHexes) {
      this.tracks.delete(hex);
      this.alertedHexes.delete(hex);
    }

    // Mark aircraft absent from this snapshot as estimated (if memory is enabled).
    if (cfg.aircraftMemorySec > 0) {
      for (const [, tr] of this.tracks) {
        if (!seenHexes.has(tr.ac.hex.toLowerCase())) {
          tr.estimated = true;
          tr.missingCycles++;
        }
      }
    }
  }

  private passesFilter(ac: Aircraft, cfg: Config): boolean {
    if (cfg.hideOnGround && ac.onGround) return false;
    const alt = ac.altBaro ?? ac.altGeom;
    if (alt != null) {
      if (alt < cfg.minAltitudeFt) return false;
      if (alt > cfg.maxAltitudeFt) return false;
    }
    // Catch "soft landings": aircraft where the data source hasn't yet flipped
    // onGround=true but the plane is clearly rolling out or taxiing — very low
    // altitude AND very low ground speed. Without this, a freshly-landed flight
    // keeps updating lastSeen and stays rendered on the runway while the next
    // arrival is on short final, creating a phantom collision.
    if (cfg.hideOnGround && alt != null && alt < 400 && (ac.gs ?? 999) < 50) return false;
    return true;
  }

  /** Interpolate a track's position at render time `tt` (perf clock).
   *  Returns meters relative to the current config center, reprojected
   *  fresh each call so pan commits never corrupt trail history. */
  private sampleAt(tr: Track, tt: number, cfg: Config): Meters | null {
    const h = tr.history;
    if (h.length === 0) return null;

    // Helper: sample → meters relative to current center.
    const toM = (s: Sample): Meters =>
      llToMeters(s.lat, s.lon, cfg.centerLat, cfg.centerLon);

    if (tt <= h.at(0).t) return toM(h.at(0));
    const lastS = h.at(h.length - 1);
    if (tt >= lastS.t) {
      // Beyond newest fix — extrapolate gently, capped.
      const dt = Math.min((tt - lastS.t) / 1000, cfg.maxExtrapolationSec);
      const m = toM(lastS);
      return cfg.interpolate ? deadReckon(m, lastS.track, lastS.gs, dt) : m;
    }
    // Binary search for the bracketing pair, then interpolate.
    let lo = 0, hi = h.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (h.at(mid).t <= tt) lo = mid; else hi = mid;
    }
    const a = toM(h.at(lo));
    const b = toM(h.at(hi));
    const f = (tt - h.at(lo).t) / Math.max(1, h.at(hi).t - h.at(lo).t);
    return {
      east:  a.east  + (b.east  - a.east)  * f,
      north: a.north + (b.north - a.north) * f,
    };
  }

  private draw(): void {
    const cfg = this.getConfig();
    const ctx = this.ctx;
    const now = performance.now();
    const frameDt = this.prevFrame ? (now - this.prevFrame) / 1000 : 0.016;
    this.prevFrame = now;
    this.frameT = now / 1000;

    this.weather.update(cfg);

    // Detect pan commits: when centerLat/Lon changes, flush all smoothed
    // renderedM values so trails and positions rebase to the new center cleanly.
    if (cfg.centerLat !== this.lastCenterLat || cfg.centerLon !== this.lastCenterLon) {
      for (const tr of this.tracks.values()) tr.renderedM = undefined;
      this.lastCenterLat = cfg.centerLat;
      this.lastCenterLon = cfg.centerLon;
    }

    if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) {
      this.resize();
    }

    ctx.fillStyle = cfg.palette.bg;
    ctx.fillRect(0, 0, this.w, this.h);

    const pxPerM = pxPerMeter(this.w, this.h, cfg.radiusMiles);
    const proj: ProjOpts = {
      rotationDeg: cfg.rotationDeg,
      mirrorX: cfg.mirrorX,
      mirrorY: cfg.mirrorY,
      pxPerM,
      screenW: this.w,
      screenH: this.h,
    };

    const tt = now - this.renderDelayMs;
    // motionFactor: how much of the gap to close this frame.
    // Formula: time-constant approach — closes ~63% of remaining gap per
    // `tau` seconds. tau = 0.06s at smoothing=0 (near-instant), up to
    // ~0.5s at smoothing=0.9.  Frame-rate independent.
    const tau = 0.04 + cfg.smoothing * 0.5;
    const motionFactor = cfg.smoothing <= 0
      ? 1
      : 1 - Math.exp(-frameDt / tau);
    const followHex = cfg.followFlightHex.toLowerCase();
    const followed = followHex
      ? this.tracks.get(followHex)
      : undefined;
    const followedPosition = followed ? this.sampleAt(followed, tt, cfg) : null;
    if (followed && followedPosition) {
      followed.renderedM ??= followedPosition;
      // Dead-reckon through gaps for the followed aircraft too.
      const newestFixT = followed.history.last()?.t;
      if (
        newestFixT !== undefined &&
        followed.lastFixT !== undefined &&
        newestFixT > followed.lastFixT + 1500 &&
        followed.ac.gs != null && followed.ac.gs > 30 &&
        followed.ac.track != null
      ) {
        const gapSec = Math.min((newestFixT - followed.lastFixT) / 1000, cfg.maxExtrapolationSec);
        followed.renderedM = deadReckon(followed.renderedM, followed.ac.track, followed.ac.gs, gapSec);
        followed.lastFixT = newestFixT; // consumed
      }
      followed.renderedM = {
        east: followed.renderedM.east + (followedPosition.east - followed.renderedM.east) * motionFactor,
        north: followed.renderedM.north + (followedPosition.north - followed.renderedM.north) * motionFactor,
      };
    }
    this.updateFollowCamera(followHex, followed?.renderedM, frameDt);

    this.updateSky(cfg, now);
    this.drawSky(cfg, proj);
    if (followHex && cfg.showFollowContext) this.drawFollowContext(cfg, proj);
    this.drawOverlays(cfg, proj);
    if (cfg.showAirport) this.drawAirport(cfg, proj);
    if (cfg.showAirspace) this.drawAirspace(cfg, proj);
    this.weather.draw(ctx, cfg, proj, (m) => this.relativeToFollow(m));
    if (followHex && cfg.showFollowContext) this.drawFollowPlaceLabels(cfg, proj);
    if (this.panning || (this.panOffset.east !== 0 || this.panOffset.north !== 0)) {
      this.drawPanOverlay(cfg, proj);
    }

    const visible: Visible[] = [];

    for (const [hex, tr] of this.tracks) {
      const stale = (now - tr.lastSeen) / 1000;

      // --- Anti-flicker aircraft memory ---
      // If memory is enabled, keep tracks alive past staleSec, fading them out
      // gracefully instead of blinking them off.
      const memSec = cfg.aircraftMemorySec ?? 0;
      if (memSec > 0) {
        if (stale > cfg.hideOnlyAfterSec) {
          this.tracks.delete(hex);
          this.alertedHexes.delete(hex);
          continue;
        }
      } else {
        // Legacy behaviour: drop after staleSec.
        if (stale > cfg.staleSec) {
          this.tracks.delete(hex);
          this.alertedHexes.delete(hex);
          continue;
        }
      }

      // Fade in on spawn; fade out only when actually estimated/stale.
      let target: number;
      if (memSec > 0) {
        if (!tr.estimated) {
          // Aircraft is live in the feed — full brightness regardless of age.
          target = 1;
        } else if (stale < memSec) {
          // Missing from feed but within memory window — visibly dimmed.
          target = 0.6;
        } else {
          // Past memory window — fade out over fadeOutSec.
          const fadeProgress = Math.min(1, (stale - memSec) / Math.max(1, cfg.fadeOutSec));
          target = (1 - fadeProgress) * 0.6;
        }
      } else {
        // Legacy mode: fade based purely on staleness.
        target = stale > cfg.staleSec * 0.75 ? 0 : 1;
      }
      // Life lerp: use a time-based rate (0.8 of gap per 100ms) so it feels
      // consistent regardless of frame rate.
      const lifeRate = Math.min(1, frameDt * 8);
      tr.life += (target - tr.life) * lifeRate;
      // labelLife lags at half the rate so labels dissolve rather than snap.
      const labelRate = Math.min(1, frameDt * 4);
      tr.labelLife += (tr.life - tr.labelLife) * labelRate;

      if (!tr.hasPos) continue;
      const sampled = this.sampleAt(tr, tt, cfg);
      if (!sampled) continue;
      // renderedM is pre-seeded in update() on first position fix.
      // If somehow still undefined (e.g. center changed), seed it now.
      if (!tr.renderedM) tr.renderedM = sampled;
      if (tr !== followed) {
        // Gap detection: if the newest history fix is significantly newer than
        // the last one we saw, the source was paused (e.g. rate-limited).
        // Dead-reckon renderedM forward through the gap so the lerp only has a
        // tiny residual to close instead of the full multi-second displacement.
        const newestFixT = tr.history.last()?.t;
        if (
          newestFixT !== undefined &&
          tr.lastFixT !== undefined &&
          newestFixT > tr.lastFixT + 1500 &&
          tr.ac.gs != null && tr.ac.gs > 30 &&
          tr.ac.track != null
        ) {
          const gapSec = Math.min((newestFixT - tr.lastFixT) / 1000, cfg.maxExtrapolationSec);
          tr.renderedM = deadReckon(tr.renderedM, tr.ac.track, tr.ac.gs, gapSec);
          tr.lastFixT = newestFixT; // consumed — don't apply again next frame
        }
        tr.renderedM = {
          east:  tr.renderedM.east  + (sampled.east  - tr.renderedM.east)  * motionFactor,
          north: tr.renderedM.north + (sampled.north - tr.renderedM.north) * motionFactor,
        };
      }
      const m = tr.renderedM;

      const relativeM = this.relativeToFollow(m);
      const rangeMi = metersToMiles(rangeMeters(relativeM));
      if (rangeMi > cfg.radiusMiles * 1.08) continue;

      const p = project(relativeM, proj);
      const heading = this.screenHeading(tr, tt, cfg, proj, frameDt);
      const edgeFade = clamp01((cfg.radiusMiles - rangeMi) / (cfg.radiusMiles * 0.14));
      const alpha = clamp01(edgeFade) * tr.life * cfg.brightness;
      const labelAlpha = clamp01(edgeFade) * tr.labelLife * cfg.brightness;
      const alt = tr.ac.altBaro ?? tr.ac.altGeom ?? 0;
      const color = cfg.altitudeColor ? altRamp(alt) : hexToRgb(cfg.palette.glyph);
      const emergency = cfg.highlightEmergency && !!tr.ac.squawk && EMERGENCY_SQUAWKS.has(tr.ac.squawk);

      // ── Alert detection (fires once per hex per session) ──────────────────
      if (!this.alertedHexes.has(hex)) {
        const hasEmergency = !!tr.ac.squawk && EMERGENCY_SQUAWKS.has(tr.ac.squawk);
        const isWatchlist = this.classifyWatchlist(tr.ac);
        const isInteresting = cfg.alertInteresting && this.classifyInteresting(tr.ac);
        if (hasEmergency || isWatchlist || isInteresting) {
          this.alertedHexes.add(hex);
          tr.alertPulseAt = now;
          if (hasEmergency) {
            tr.alertPulseKind = "emergency";
            if (cfg.alertSounds) this.playAlertSound("emergency");
          } else if (isWatchlist) {
            tr.alertPulseKind = "watchlist";
            if (cfg.alertSounds) this.playAlertSound("watchlist");
          } else {
            tr.alertPulseKind = "interesting";
            if (cfg.alertSounds) this.playAlertSound("interesting");
          }
        }
      }

      visible.push({
        tr,
        m: relativeM,
        p,
        heading,
        rangeMi,
        alpha,
        labelAlpha,
        color,
        emergency,
        followed: tr === followed,
        estimated: tr.estimated,
      });
    }

    // Nearest last so it paints on top.
    visible.sort((a, b) => b.rangeMi - a.rangeMi);
    this.visibleHits = visible.map((v) => ({
      aircraft: v.tr.ac,
      x: v.p.x,
      y: v.p.y,
      followed: v.followed,
    }));

    // Trails + glyphs for everyone.
    if (cfg.showDestArc) for (const v of visible) this.drawDestArc(cfg, proj, v);
    for (const v of visible) this.drawTrail(cfg, proj, v, tt);
    if (cfg.showSpeedVectors) for (const v of visible) this.drawSpeedVector(cfg, proj, v);
    for (const v of visible) this.drawAlertPulse(v, now);
    for (const v of visible) this.drawGlyph(cfg, v);

    // Labels: nearest are at the END after the sort.
    const byNear = [...visible].reverse(); // nearest first
    this.drawLabels(cfg, byNear);

    if (cfg.theme === "focus" && byNear.length) this.drawDetailPanel(cfg, byNear[0]);

    if (followed && followed.ac.origin && followed.ac.destination &&
        followed.ac.originLat != null && followed.ac.originLon != null &&
        followed.ac.destLat != null && followed.ac.destLon != null &&
        followed.ac.lat != null && followed.ac.lon != null) {
      this.drawFollowProgressBar(cfg, followed.ac);
    }

    // Stale/estimated indicator (when showStaleIndicator is enabled).
    if (cfg.showStaleIndicator && cfg.aircraftMemorySec > 0) {
      const estimatedVisible = visible.filter((v) => v.tr.estimated);
      if (estimatedVisible.length > 0) {
        this.drawStaleIndicator(cfg, estimatedVisible.length);
      }
    }
  }

  /**
   * Run `draw` with the canvas rotated by `labelRotationDeg` around an anchor,
   * so text reads upright from where the viewer lies without moving the field.
   */
  private withLabelRotation(cfg: Config, ax: number, ay: number, draw: () => void): void {
    if (!cfg.labelRotationDeg) {
      draw();
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate((cfg.labelRotationDeg * Math.PI) / 180);
    ctx.translate(-ax, -ay);
    draw();
    ctx.restore();
  }

  private screenHeading(tr: Track, tt: number, cfg: Config, proj: ProjOpts, frameDt: number): number {
    // Narrow window: ±150 ms straddles a single fix interval at 1 Hz without
    // reaching back into the previous segment (which ±400 ms could do).
    const raw = this.computeRawHeading(tr, tt, cfg, proj);

    // Smooth heading with a short time constant (tau ~120 ms) so per-fix
    // quantisation jitter (~5° ADS-B steps) is absorbed without lag.
    // Uses actual frameDt so the rate is identical at 30 fps and 60 fps.
    if (tr.renderedHeading === undefined) {
      tr.renderedHeading = raw;
    } else {
      // Shortest-arc interpolation — avoids spinning through 360° on wrap.
      let delta = raw - tr.renderedHeading;
      if (delta > Math.PI)  delta -= 2 * Math.PI;
      if (delta < -Math.PI) delta += 2 * Math.PI;
      const headingTau = 0.12;
      const headingFactor = 1 - Math.exp(-frameDt / headingTau);
      tr.renderedHeading += delta * headingFactor;
    }
    return tr.renderedHeading;
  }

  private computeRawHeading(tr: Track, tt: number, cfg: Config, proj: ProjOpts): number {
    const a = this.sampleAt(tr, tt - 150, cfg);
    const b = this.sampleAt(tr, tt + 150, cfg);
    if (a && b) {
      const pa = project(a, proj);
      const pb = project(b, proj);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 0.5) {
        return Math.atan2(pb.y - pa.y, pb.x - pa.x);
      }
    }
    // Fallback: use reported track through the projection.
    const m = this.sampleAt(tr, tt, cfg);
    if (m && tr.ac.track != null) {
      const ahead = deadReckon(m, tr.ac.track, 120, 1);
      const p0 = project(m, proj);
      const p1 = project(ahead, proj);
      return Math.atan2(p1.y - p0.y, p1.x - p0.x);
    }
    return tr.renderedHeading ?? 0;
  }

  // --- overlays: whisper-quiet rings + compass ---
  private drawOverlays(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;

    if (cfg.rangeRings) {
      ctx.save();
      for (let mi = 1; mi <= Math.floor(cfg.radiusMiles); mi++) {
        const r = mi * 1609.34 * proj.pxPerM;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.5 * cfg.brightness);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // Center mark.
      ctx.beginPath();
      ctx.arc(cx, cy, 2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.7 * cfg.brightness);
      ctx.fill();
      ctx.restore();
    }

    if (cfg.compass) {
      ctx.save();
      const R = (Math.min(this.w, this.h) / 2) * 0.965;
      ctx.font = `300 12px ${cfg.fonts.label}`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.32 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "3px";
      } catch {
        /* older browsers */
      }
      for (const [label, deg] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]] as [string, number][]) {
        const dir: Meters = {
          east: Math.sin((deg * Math.PI) / 180) * 1e6,
          north: Math.cos((deg * Math.PI) / 180) * 1e6,
        };
        const p = project(dir, { ...proj, pxPerM: R / 1e6 });
        this.withLabelRotation(cfg, p.x, p.y, () => ctx.fillText(label, p.x, p.y));
      }
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    }
  }

  // --- airport: runways at true geographic position ---
  private drawAirport(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const rwyRgb: [number, number, number] = [150, 180, 220];

    // Only draw airports whose reference point falls within the display radius
    // (with a generous 2× buffer so runways that extend to the edge still show).
    const followEast = Math.round(this.followOffset.east / 1000);
    const followNorth = Math.round(this.followOffset.north / 1000);
    const customKey = cfg.customAirport ? cfg.customAirport.icao : "none";
    const airportKey = `${cfg.centerLat}:${cfg.centerLon}:${cfg.radiusMiles}:${followEast}:${followNorth}:${getAirportRevision()}:${customKey}`;
    if (airportKey !== this.nearbyAirportsKey) {
      const cutoffMi = cfg.radiusMiles * 2;
      const allAirports = cfg.customAirport ? [...AIRPORTS.filter(a => a.icao !== cfg.customAirport?.icao), cfg.customAirport] : AIRPORTS;
      this.nearbyAirports = allAirports.filter((ap) => {
        const m = this.relativeToFollow(llToMeters(ap.lat, ap.lon, cfg.centerLat, cfg.centerLon));
        return metersToMiles(rangeMeters(m)) <= cutoffMi;
      });
      this.nearbyAirportsKey = airportKey;
    }

    for (const ap of this.nearbyAirports) {
      this.drawAirportAreas(ap.aprons, cfg, proj, rwyRgb, 0.07);
      this.drawAirportAreas(ap.terminals, cfg, proj, rwyRgb, 0.13);
      for (const taxiway of ap.taxiways ?? []) {
        const points = taxiway.points.map((point) => this.toScreen(point, cfg, proj));
        if (points.length < 2) continue;
        ctx.save();
        ctx.strokeStyle = rgba(rwyRgb, 0.1 * cfg.brightness);
        ctx.lineWidth = Math.max(1, taxiway.widthFt * 0.3048 * proj.pxPerM);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.restore();
      }
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const r of ap.runways) {
        const a = this.toScreen(r.le, cfg, proj);
        const b = this.toScreen(r.he, cfg, proj);
        // True runway width in px, nudged up a touch so it stays legible.
        const wpx = Math.max(2.5, r.widthFt * 0.3048 * proj.pxPerM * 1.4);

        ctx.save();
        ctx.lineCap = "butt";
        // Asphalt body.
        ctx.strokeStyle = rgba(rwyRgb, 0.16 * cfg.brightness);
        ctx.lineWidth = wpx;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // Dashed centerline.
        ctx.strokeStyle = rgba([210, 226, 255], 0.22 * cfg.brightness);
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();

        if (Math.hypot(b.x - a.x, b.y - a.y) > 75) {
          this.drawRunwayIdent(r.leIdent, a, b, cfg, rwyRgb);
          this.drawRunwayIdent(r.heIdent, b, a, cfg, rwyRgb);
        }

        cx += (a.x + b.x) / 2;
        cy += (a.y + b.y) / 2;
        n++;
      }
      // Airport label at the runway centroid.
      if (n) {
        cx /= n;
        cy /= n;
        ctx.save();
        ctx.font = `300 13px ${cfg.fonts.label}`;
        ctx.fillStyle = rgba(rwyRgb, 0.5 * cfg.brightness);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        try {
          ctx.letterSpacing = "4px";
        } catch {
          /* noop */
        }
        ctx.fillText(`${ap.name}  ${ap.icao}`, cx, cy);
        if (ap.fullName) {
          ctx.font = `300 8px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba(rwyRgb, 0.3 * cfg.brightness);
          try {
            ctx.letterSpacing = "1px";
          } catch {
            /* noop */
          }
          ctx.fillText(ap.fullName, cx, cy + 14);
        }
        try {
          ctx.letterSpacing = "0px";
        } catch {
          /* noop */
        }
        ctx.restore();
      }
    }
  }

  private drawFollowContext(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const radiusM = cfg.radiusMiles * 1609.344;

    let nearestCity: { name: string; distanceM: number } | null = null;
    for (const city of CITIES) {
      const m = llToMeters(city.lat, city.lon, cfg.centerLat, cfg.centerLon);
      const relative = this.relativeToFollow(m);
      const distanceM = rangeMeters(relative);
      if (!nearestCity || distanceM < nearestCity.distanceM) nearestCity = { name: city.name, distanceM };
      if (distanceM > radiusM * 1.2) continue;
      const p = project(relative, proj);
      if (p.x < 20 || p.x > this.w - 20 || p.y < 20 || p.y > this.h - 20) continue;
      this.withLabelRotation(cfg, p.x, p.y, () => {
        ctx.save();
        ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.28 * cfg.brightness);
        ctx.font = `500 10px ${cfg.fonts.label}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(city.name.toUpperCase(), p.x, p.y + 11);
        ctx.restore();
      });
    }
    if (nearestCity && nearestCity.distanceM < 160_934) {
      ctx.save();
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.32 * cfg.brightness);
      ctx.font = `500 10px ${cfg.fonts.mono}`;
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      ctx.fillText(
        `NEAR ${nearestCity.name.toUpperCase()} · ${metersToMiles(nearestCity.distanceM).toFixed(0)} MI`,
        this.w - 18,
        18,
      );
      ctx.restore();
    }
  }

  private drawFollowPlaceLabels(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const radiusM = cfg.radiusMiles * 1609.344;
    let nearestCity: { name: string; distanceM: number } | null = null;

    for (const city of CITIES) {
      const relative = this.relativeToFollow(
        llToMeters(city.lat, city.lon, cfg.centerLat, cfg.centerLon),
      );
      const distanceM = rangeMeters(relative);
      if (!nearestCity || distanceM < nearestCity.distanceM) nearestCity = { name: city.name, distanceM };
      if (distanceM > radiusM * 1.8) continue;
      const p = project(relative, proj);
      if (p.x < 45 || p.x > this.w - 45 || p.y < 35 || p.y > this.h - 35) continue;
      this.withLabelRotation(cfg, p.x, p.y, () => {
        ctx.save();
        ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.72 * cfg.brightness);
        ctx.font = `600 12px ${cfg.fonts.label}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(0,0,0,0.95)";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(city.name.toUpperCase(), p.x, p.y + 14);
        ctx.restore();
      });
    }

    let nearestAirport: { airport: Airport; distanceM: number } | null = null;
    for (const airport of AIRPORTS) {
      const relative = this.relativeToFollow(
        llToMeters(airport.lat, airport.lon, cfg.centerLat, cfg.centerLon),
      );
      const distanceM = rangeMeters(relative);
      if (!nearestAirport || distanceM < nearestAirport.distanceM) {
        nearestAirport = { airport, distanceM };
      }
    }

    ctx.save();
    const x = this.w - 18;
    let y = 18;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.shadowColor = "rgba(0,0,0,0.95)";
    ctx.shadowBlur = 8;
    if (nearestCity) {
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.75 * cfg.brightness);
      ctx.font = `600 12px ${cfg.fonts.mono}`;
      ctx.fillText(
        `NEAR ${nearestCity.name.toUpperCase()} · ${metersToMiles(nearestCity.distanceM).toFixed(0)} MI`,
        x,
        y,
      );
      y += 17;
    }
    if (nearestAirport) {
      ctx.fillStyle = rgba([150, 180, 220], 0.74 * cfg.brightness);
      ctx.font = `500 10px ${cfg.fonts.mono}`;
      ctx.fillText(
        `AIRPORT ${nearestAirport.airport.name} · ${metersToMiles(nearestAirport.distanceM).toFixed(0)} MI`,
        x,
        y,
      );
    }
    ctx.restore();
  }

  private drawAirportAreas(
    areas: AirportArea[] | undefined,
    cfg: Config,
    proj: ProjOpts,
    color: [number, number, number],
    alpha: number,
  ): void {
    for (const area of areas ?? []) {
      const points = area.points.map((point) => this.toScreen(point, cfg, proj));
      if (points.length < 3) continue;
      this.ctx.save();
      this.ctx.fillStyle = rgba(color, alpha * cfg.brightness);
      this.ctx.beginPath();
      this.ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) this.ctx.lineTo(point.x, point.y);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.restore();
    }
  }

  private drawRunwayIdent(
    ident: string,
    end: Point,
    opposite: Point,
    cfg: Config,
    color: [number, number, number],
  ): void {
    const angle = Math.atan2(opposite.y - end.y, opposite.x - end.x);
    this.ctx.save();
    this.ctx.translate(end.x + Math.cos(angle) * 10, end.y + Math.sin(angle) * 10);
    this.ctx.rotate(angle);
    this.ctx.font = `500 8px ${cfg.fonts.label}`;
    this.ctx.fillStyle = rgba(color, 0.42 * cfg.brightness);
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(ident, 0, 0);
    this.ctx.restore();
  }

  private toScreen(ll: [number, number], cfg: Config, proj: ProjOpts): Point {
    return project(
      this.relativeToFollow(llToMeters(ll[0], ll[1], cfg.centerLat, cfg.centerLon)),
      proj,
    );
  }

  private relativeToFollow(m: Meters): Meters {
    return {
      east:  m.east  - this.followOffset.east  - this.panOffset.east,
      north: m.north - this.followOffset.north - this.panOffset.north,
    };
  }

  /** Remaining time (seconds) of the fast-seek spring after a new follow target
   *  is selected. Higher omega during this window gives a smooth accelerating
   *  ease-in rather than an instant teleport. */
  private followSeekTimer = 0;

  // ── Alerts ───────────────────────────────────────────────────────────────────
  /** Hexes that have already triggered an alert this session (dedup). */
  private alertedHexes = new Set<string>();
  /** Web Audio context, created lazily on first user gesture. */
  private audioCtx: AudioContext | null = null;

  private updateFollowCamera(hex: string, target: Meters | undefined, frameDt: number): void {
    if (hex !== this.activeFollowHex) {
      this.activeFollowHex = hex;
      this.followVelocity = { east: 0, north: 0 };
      // Start a fast-seek window so the camera eases to the new target quickly
      // but smoothly, instead of snapping instantly.
      this.followSeekTimer = hex ? 0.8 : 0;
    }
    const destination = hex ? target : { east: 0, north: 0 };
    if (!destination) return;

    const dt = Math.min(frameDt, 0.05);
    // Use a stiffer spring during the seek window for a fast-but-smooth lock-on.
    this.followSeekTimer = Math.max(0, this.followSeekTimer - frameDt);
    const omega = this.followSeekTimer > 0 ? 12 : 4.5;
    const updateAxis = (position: number, velocity: number, destination: number): [number, number] => {
      const acceleration = omega * omega * (destination - position) - 2 * omega * velocity;
      const nextVelocity = velocity + acceleration * dt;
      return [position + nextVelocity * dt, nextVelocity];
    };
    [this.followOffset.east, this.followVelocity.east] = updateAxis(
      this.followOffset.east,
      this.followVelocity.east,
      destination.east,
    );
    [this.followOffset.north, this.followVelocity.north] = updateAxis(
      this.followOffset.north,
      this.followVelocity.north,
      destination.north,
    );
    if (!hex && Math.hypot(this.followOffset.east, this.followOffset.north) < 1) {
      this.followOffset = { east: 0, north: 0 };
      this.followVelocity = { east: 0, north: 0 };
    }
  }

  // --- sky layer (sun / moon / stars / satellites) ---
  private updateSky(cfg: Config, now: number): void {
    const want = cfg.showStars || cfg.showSun || cfg.showMoon || cfg.showSatellites;
    if (!want) {
      this.sky = { stars: [], sats: [], planets: [] };
      return;
    }
    if (now - this.skyComputedAt < 300 && this.skyOffsetUsed === cfg.skyTimeOffsetMin) return;
    this.skyComputedAt = now;
    this.skyOffsetUsed = cfg.skyTimeOffsetMin;
    const date = new Date(Date.now() + cfg.skyTimeOffsetMin * 60000);
    this.sky = computeSky(date, cfg.centerLat, cfg.centerLon, {
      sun: cfg.showSun,
      moon: cfg.showMoon,
      stars: cfg.showStars,
      satellites: cfg.showSatellites,
      magLimit: cfg.starMagLimit,
      tles: this.tles,
    });
  }

  /** Place an (azimuth, altitude) sky point on the field. Zenith=center, horizon=edge.
   *  Applies relativeToFollow so the sky shifts correctly in follow/pan mode. */
  private projectSky(az: number, alt: number, cfg: Config, proj: ProjOpts): Point {
    const R = cfg.radiusMiles * 1609.34;
    const r = (1 - Math.max(0, alt) / 90) * R;
    const a = (az * Math.PI) / 180;
    const m: Meters = { east: Math.sin(a) * r, north: Math.cos(a) * r };
    return project(this.relativeToFollow(m), proj);
  }

  private issVisible = false;

  private drawSky(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const b = cfg.brightness;

    // Asterism lines (faint) — need star screen points by id.
    if (cfg.showStars && this.sky.stars.length) {
      const pts = new Map<string, Point>();
      for (const s of this.sky.stars) {
        if (s.id) pts.set(s.id, this.projectSky(s.az, s.alt, cfg, proj));
      }
      ctx.save();
      ctx.strokeStyle = `rgba(150,170,220,${0.14 * b})`;
      ctx.lineWidth = 1;
      for (const [a, c] of ASTERISMS) {
        const pa = pts.get(a);
        const pc = pts.get(c);
        if (pa && pc) {
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pc.x, pc.y);
          ctx.stroke();
        }
      }
      ctx.restore();

      // Draw constellation names near their respective asterisms
      const CONSTELLATIONS = [
        { name: "ORION", stars: ["betelgeuse", "bellatrix", "alnitak", "alnilam", "mintaka", "saiph", "rigel"] },
        { name: "BIG DIPPER", stars: ["dubhe", "merak", "phecda", "megrez", "alioth", "mizar", "alkaid"] },
        { name: "CASSIOPEIA", stars: ["segin", "ruchbah", "navi", "schedar", "caph"] }
      ];

      for (const constel of CONSTELLATIONS) {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (const starId of constel.stars) {
          const pt = pts.get(starId);
          if (pt) {
            sumX += pt.x;
            sumY += pt.y;
            count++;
          }
        }
        if (count >= 3) {
          const cx = sumX / count;
          const cy = sumY / count;
          this.withLabelRotation(cfg, cx, cy, () => {
            ctx.save();
            ctx.font = `italic 300 9px ${cfg.fonts.label}`;
            ctx.fillStyle = `rgba(150, 170, 220, ${0.32 * b})`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            try {
              ctx.letterSpacing = "2px";
            } catch {
              /* noop */
            }
            ctx.fillText(constel.name, cx, cy);
            ctx.restore();
          });
        }
      }

      // Stars themselves, sized + twinkling by magnitude.
      for (const s of this.sky.stars) {
        const p = pts.get(s.id!)!;
        const mag = s.mag ?? 2;
        const size = Math.max(0.6, 2.6 - mag * 0.7);
        const tw = 0.78 + 0.22 * Math.sin(this.frameT * 3 + s.az);
        const a = clamp01((2.8 - mag) / 3) * b * tw;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(214,224,255,${a})`;
        if (mag < 0.6) {
          ctx.shadowColor = `rgba(200,215,255,${a})`;
          ctx.shadowBlur = size * 3;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (mag < 0.3 && s.name) this.skyLabel(p, s.name, cfg, 0.5 * b);
      }
    }

    if (cfg.showStars && this.sky.planets && this.sky.planets.length) {
      for (const p of this.sky.planets) {
        const pt = this.projectSky(p.az, p.alt, cfg, proj);
        const mag = p.mag ?? 1;
        const size = Math.max(2.0, 3.5 - mag * 0.4);
        const a = 0.95 * b;
        ctx.save();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 253, 245, ${a})`;
        ctx.shadowColor = `rgba(255, 240, 200, ${a * 0.8})`;
        ctx.shadowBlur = size * 3.5;
        ctx.fill();
        ctx.restore();
        if (p.name) this.skyLabel(pt, p.name, cfg, 0.65 * b);
      }
    }

    if (cfg.showMoon && this.sky.moon && this.sky.moon.alt > -2) {
      this.drawMoon(this.projectSky(this.sky.moon.az, this.sky.moon.alt, cfg, proj),
        this.sky.moon.illum ?? 1, this.sky.moon.waning ?? false, b);
    }
    if (cfg.showSun && this.sky.sun && this.sky.sun.alt > -2) {
      this.drawSun(this.projectSky(this.sky.sun.az, this.sky.sun.alt, cfg, proj), b);
    }
    
    let issCurrentlyVisible = false;
    if (cfg.showSatellites && this.sky.sats.length) {
      const now = performance.now();
      for (const sat of this.sky.sats) {
        const p = this.projectSky(sat.az, sat.alt, cfg, proj);
        const iss = sat.kind === "iss";
        if (iss) {
          issCurrentlyVisible = true;
          if (!this.issVisible) {
            this.issPulseAt = now;
            if (cfg.alertSounds) this.playAlertSound("interesting");
          }
          
          if (this.issPulseAt !== undefined) {
            const age = (now - this.issPulseAt) / 1000;
            const duration = 1.8;
            if (age <= duration) {
              const t = age / duration;
              const pulseColor = hexToRgb("#8CFFD6");
              for (const offset of [0, 0.35]) {
                const phase = (t + offset) % 1;
                const r = 10 * (1.8 + phase * 5);
                const a = (1 - phase) * 0.7 * b;
                if (a > 0.01) {
                  ctx.beginPath();
                  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
                  ctx.strokeStyle = rgba(pulseColor, a);
                  ctx.lineWidth = 1.5;
                  ctx.stroke();
                }
              }
            }
          }
        }
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, iss ? 3 : 1.6, 0, Math.PI * 2);
        if (iss) {
          ctx.fillStyle = `rgba(140,255,214,${0.95 * b})`;
          ctx.shadowColor = `rgba(140,255,214,${b})`;
          ctx.shadowBlur = 10;
        } else {
          ctx.fillStyle = `rgba(170,205,255,${0.65 * b})`;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (iss) {
          this.skyLabel({ x: p.x + 6, y: p.y - 6 }, "ISS", cfg, 0.9 * b, "#8CFFD6");
        } else if (sat.name) {
          // Title-case the TLE name (e.g. "STARLINK-1234" → "Starlink-1234")
          // so it reads quietly alongside the aircraft labels.
          const label = sat.name
            .split(/\s+/)
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(" ");
          this.skyLabel({ x: p.x + 4, y: p.y - 4 }, label, cfg, 0.45 * b, "#AAC8FF");
        }
      }
    }
    this.issVisible = issCurrentlyVisible;
  }

  private drawSun(p: Point, b: number): void {
    const ctx = this.ctx;
    ctx.save();
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26);
    g.addColorStop(0, `rgba(255,210,120,${0.9 * b})`);
    g.addColorStop(0.4, `rgba(255,180,80,${0.4 * b})`);
    g.addColorStop(1, "rgba(255,170,70,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,224,150,${b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawMoon(p: Point, illum: number, waning: boolean, b: number): void {
    const ctx = this.ctx;
    const r = 8;
    ctx.save();
    // Soft glow.
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.6);
    g.addColorStop(0, `rgba(220,228,245,${0.35 * b})`);
    g.addColorStop(1, "rgba(220,228,245,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    // Dim full disc (earthshine).
    ctx.fillStyle = `rgba(64,72,90,${0.55 * b})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Lit region: bright limb semicircle + elliptical terminator.
    ctx.translate(p.x, p.y);
    ctx.scale(waning ? -1 : 1, 1); // bright limb on the right (waxing) / left (waning)
    const rx = r * (1 - 2 * illum); // >0 crescent, <0 gibbous, 0 = half
    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.abs(rx), r, 0, Math.PI / 2, -Math.PI / 2, rx > 0);
    ctx.closePath();
    ctx.fillStyle = `rgba(232,238,250,${b})`;
    ctx.fill();
    ctx.restore();
  }

  private skyLabel(p: Point, text: string, cfg: Config, alpha: number, color = "#AEB6C6"): void {
    const ctx = this.ctx;
    this.withLabelRotation(cfg, p.x, p.y, () => {
      ctx.save();
      ctx.font = `300 10px ${cfg.fonts.label}`;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      try {
        ctx.letterSpacing = "1px";
      } catch {
        /* noop */
      }
      ctx.fillText(text, p.x + 5, p.y);
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  // --- flight plan trajectory: full great-circle arc from origin to destination ---
  private drawDestArc(cfg: Config, proj: ProjOpts, v: Visible): void {
    if (!v.followed) return;
    const ac = v.tr.ac;
    if (ac.lat == null || ac.lon == null || ac.destLat == null || ac.destLon == null) return;
    if (!routePlausible(ac, cfg)) return;

    const lat1 = ac.lat;
    const lon1 = ac.lon;
    const lat2 = ac.destLat;
    const lon2 = ac.destLon;

    const φ1 = lat1 * DEG, λ1 = lon1 * DEG;
    const φ2 = lat2 * DEG, λ2 = lon2 * DEG;
    const dφ = φ2 - φ1;
    const dλ = λ2 - λ1;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    const δ = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    if (δ < 1e-6) return;

    const steps = 60;
    const pts: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * δ) / Math.sin(δ);
      const B = Math.sin(f * δ) / Math.sin(δ);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      const latI = Math.atan2(z, Math.sqrt(x * x + y * y)) / DEG;
      const lonI = Math.atan2(y, x) / DEG;

      const m = llToMeters(latI, lonI, cfg.centerLat, cfg.centerLon);
      pts.push(project(this.relativeToFollow(m), proj));
    }

    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = rgba(v.color, 0.18 * v.alpha);
    ctx.lineWidth = 1.4;
    ctx.setLineDash([3, 8]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= steps; i++) {
      // Prevent drawing horizontal lines across the entire screen if it wraps the antimeridian
      if (Math.abs(pts[i].x - pts[i-1].x) > this.w / 2) {
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
      } else {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // --- comet trail ---
  private drawTrail(cfg: Config, proj: ProjOpts, v: Visible, tt: number): void {
    if (cfg.trailSeconds <= 0) return;
    const ctx = this.ctx;
    const h = v.tr.history;
    if (h.length < 2) return;

    // Cache llToMeters results — the expensive trig — keyed by center + history
    // state. Only rebuilt when the center moves or a new fix arrives; between
    // those events just reprojects the cached Meters[] (cheap linear math).
    const lastT = h.at(h.length - 1).t;
    const mKey = `${cfg.centerLat}:${cfg.centerLon}:${h.length}:${lastT}`;
    if (v.tr.trailMeterKey !== mKey) {
      const meters: Meters[] = [];
      for (const s of h) meters.push(llToMeters(s.lat, s.lon, cfg.centerLat, cfg.centerLon));
      v.tr.trailMeters = meters;
      v.tr.trailMeterKey = mKey;
    }
    const cachedM = v.tr.trailMeters!;

    // For the followed aircraft draw the full historical path (everything older
    // than trailSeconds) as a dim dashed line first, then paint the comet on top.
    const windowMs = cfg.trailSeconds * 1000;
    if (v.followed && h.length >= 2) {
      const histPts: Point[] = [];
      for (let i = 0; i < h.length; i++) {
        const s = h.at(i);
        if (s.t > tt - windowMs) {
          // Bridge into the comet window so there's no gap.
          histPts.push(project(this.relativeToFollow(cachedM[i]), proj));
          break;
        }
        histPts.push(project(this.relativeToFollow(cachedM[i]), proj));
      }
      if (histPts.length >= 2) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(histPts[0].x, histPts[0].y);
        for (const p of histPts.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = rgba(v.color, 0.22 * v.alpha);
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 7]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    // Build screen points from cached meters — project + relativeToFollow each frame.
    const pts: { p: Point; age: number }[] = [];
    for (let i = 0; i < h.length; i++) {
      const s = h.at(i);
      if (s.t < tt - windowMs || s.t > tt) continue;
      pts.push({ p: project(this.relativeToFollow(cachedM[i]), proj), age: (tt - s.t) / windowMs });
    }
    // Anchor the head to the smoothed rendered position.
    pts.push({ p: v.p, age: 0 });
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const tail = pts[0].p;
    const head = pts[pts.length - 1].p;
    const gradient = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
    gradient.addColorStop(0, rgba(v.color, 0));
    gradient.addColorStop(1, rgba(v.color, 0.55 * v.alpha));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2 + 1.5 * (cfg.glyphSizePx / 14);
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    for (const point of pts.slice(1)) ctx.lineTo(point.p.x, point.p.y);
    ctx.stroke();
    ctx.restore();
  }

  // --- speed vector: lookahead line ---
  private drawSpeedVector(cfg: Config, proj: ProjOpts, v: Visible): void {
    const ac = v.tr.ac;
    if (!ac.gs || ac.gs < 30 || ac.track == null || !v.tr.renderedM) return;
    const dt = cfg.speedVectorMinutes * 60;
    const aheadAbs = deadReckon(v.tr.renderedM, ac.track, ac.gs, dt);
    const aheadP = project(this.relativeToFollow(aheadAbs), proj);
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(v.p.x, v.p.y);
    ctx.lineTo(aheadP.x, aheadP.y);
    ctx.strokeStyle = rgba(v.color, 0.45 * v.alpha);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // --- alert pulse: expanding ring on first detection ---
  private drawAlertPulse(v: Visible, now: number): void {
    const tr = v.tr;
    if (tr.alertPulseAt === undefined) return;
    const age = (now - tr.alertPulseAt) / 1000;
    const duration = 1.8;
    if (age > duration) { tr.alertPulseAt = undefined; return; }
    const pulseColor = tr.alertPulseKind === "emergency"
      ? hexToRgb("#FF5A47")
      : tr.alertPulseKind === "watchlist"
        ? hexToRgb("#00FFFF")
        : hexToRgb("#9B7ECF");
    const s = (this.getConfig().glyphSizePx) * GLYPH_SCALE[classifyGlyph(tr.ac)];
    const t = age / duration;
    // Two rings at different phases for a ripple effect.
    for (const offset of [0, 0.35]) {
      const phase = (t + offset) % 1;
      const r = s * (1.8 + phase * 5);
      const a = (1 - phase) * 0.7 * v.alpha;
      if (a < 0.01) continue;
      this.ctx.beginPath();
      this.ctx.arc(v.p.x, v.p.y, r, 0, Math.PI * 2);
      this.ctx.strokeStyle = rgba(pulseColor, a);
      this.ctx.lineWidth = 1.5;
      this.ctx.stroke();
    }
  }

  // --- alert helpers ---
  private readonly MILITARY_PREFIXES = [
    "RCH", "RRR", "SAM", "REACH", "GHOST", "SPAR", "DUKE", "JAKE", "STEEL",
    "VENUS", "ARISE", "KNIFE", "HOMER", "ROCKY", "TROLL",
  ];
  private readonly INTERESTING_TYPES = new Set([
    "F16", "F15", "F18", "F22", "F35", "B52", "B1", "B2",
    "C130", "C17", "C5", "E3TF", "E8", "KC135", "KC10", "P8",
    "U2", "A10", "V22", "MQ9", "RQ4", "RC135", "EC130",
    "A388", "A124", "A225", "B748" // giants
  ]);

  private classifyInteresting(ac: Aircraft): boolean {
    const flight = (ac.flight ?? "").toUpperCase().replace(/\s/g, "");
    if (this.MILITARY_PREFIXES.some((p) => flight.startsWith(p))) return true;
    const type = (ac.typeCode ?? "").toUpperCase();
    if (type && this.INTERESTING_TYPES.has(type)) return true;
    return false;
  }

  private classifyWatchlist(ac: Aircraft): boolean {
    const watchlistStr = this.getConfig().watchlist ?? "";
    if (!watchlistStr) return false;
    const items = watchlistStr.toUpperCase().split(",").map(i => i.trim()).filter(Boolean);
    if (items.length === 0) return false;
    const reg = (ac.registration ?? "").toUpperCase().trim();
    const call = (ac.flight ?? "").toUpperCase().trim();
    return items.some(item => reg === item || call === item || reg.startsWith(item) || call.startsWith(item));
  }

  private playAlertSound(kind: "emergency" | "interesting" | "watchlist"): void {
    const ctx = this.audioCtx;
    if (!ctx) return;
    // Emergency: three descending tones. Watchlist: two ascending tones. Interesting: two softer ascending tones.
    const tones = kind === "emergency"
      ? [{ f: 1100, t: 0 }, { f: 880, t: 0.18 }, { f: 660, t: 0.36 }]
      : kind === "watchlist"
        ? [{ f: 523.25, t: 0 }, { f: 659.25, t: 0.12 }]
        : [{ f: 660, t: 0 }, { f: 880, t: 0.20 }];
    const gain = kind === "emergency" ? 0.14 : kind === "watchlist" ? 0.12 : 0.09;
    for (const { f, t } of tones) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.connect(env);
      env.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = f;
      const start = ctx.currentTime + 0.05 + t;
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(gain, start + 0.02);
      env.gain.setValueAtTime(gain, start + 0.10);
      env.gain.linearRampToValueAtTime(0, start + 0.16);
      osc.start(start);
      osc.stop(start + 0.18);
    }
  }

  // --- glyph: type-aware luminous silhouette ---
  private drawGlyph(cfg: Config, v: Visible): void {
    const ctx = this.ctx;
    const color = v.emergency ? hexToRgb(cfg.palette.warn) : v.color;
    const kind = classifyGlyph(v.tr.ac);
    const s = cfg.glyphSizePx * GLYPH_SCALE[kind];

    ctx.save();
    ctx.translate(v.p.x, v.p.y);
    ctx.rotate(v.heading + Math.PI / 2);

    // Soft halo — suppressed for the followed aircraft (the dashed ring serves
    // as its indicator; the halo would create a distracting inner glow circle).
    if (!v.followed) {
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.7);
      halo.addColorStop(0, rgba(color, 0.16 * v.alpha));
      halo.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, s * 1.7, 0, Math.PI * 2);
      ctx.fill();
    }

    if (v.followed) {
      ctx.strokeStyle = rgba(color, 0.75 * v.alpha);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, s * 2.15, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawAircraftGlyph(ctx, kind, s, color, v.alpha, this.frameT, hexSeed(v.tr.ac.hex));
    ctx.restore();
  }

  // --- labels: restrained typography, nearest only ---
  private labelGrid = new Map<string, { x: number; y: number; w: number; h: number }[]>();
  private static readonly LABEL_CELL_SIZE = 160;

  private drawLabels(cfg: Config, nearestFirst: Visible[]): void {
    const limit =
      cfg.labelDensity === "all"
        ? nearestFirst.length
        : cfg.labelDensity === "nearestN"
          ? cfg.nearestN
          : 1;
    this.labelGrid.clear();
    for (let i = 0; i < Math.min(limit, nearestFirst.length); i++) {
      // Nearest labels brightest; gently dim further ones (but keep readable).
      const prom = 1 - i / Math.max(1, nearestFirst.length);
      this.drawLabel(cfg, nearestFirst[i], 0.7 + 0.3 * prom);
    }
  }

  private measureLabel(
    cfg: Config,
    lines: { text: string; kind: "title" | "sub" }[],
  ): { w: number; lh: number; h: number } {
    const ctx = this.ctx;
    const lh = 16;
    let w = 0;
    for (const ln of lines) {
      ctx.font = ln.kind === "title" ? `500 14px ${cfg.fonts.label}` : `400 11px ${cfg.fonts.label}`;
      try {
        ctx.letterSpacing = ln.kind === "title" ? "1.5px" : "0.5px";
      } catch {
        /* noop */
      }
      w = Math.max(w, ctx.measureText(ln.text).width);
    }
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    return { w: w + 2, lh, h: lines.length * lh };
  }

  private collides(b: { x: number; y: number; w: number; h: number }): boolean {
    const pad = 3;
    for (const p of this.labelCandidates(b, pad)) {
      if (
        b.x - pad < p.x + p.w &&
        b.x + b.w + pad > p.x &&
        b.y - pad < p.y + p.h &&
        b.y + b.h + pad > p.y
      ) {
        return true;
      }
    }
    return false;
  }

  private labelCandidates(b: { x: number; y: number; w: number; h: number }, pad = 0) {
    const size = Renderer.LABEL_CELL_SIZE;
    const found = new Set<{ x: number; y: number; w: number; h: number }>();
    for (let x = Math.floor((b.x - pad) / size); x <= Math.floor((b.x + b.w + pad) / size); x++) {
      for (let y = Math.floor((b.y - pad) / size); y <= Math.floor((b.y + b.h + pad) / size); y++) {
        for (const box of this.labelGrid.get(`${x}:${y}`) ?? []) found.add(box);
      }
    }
    return found;
  }

  private placeLabelBox(box: { x: number; y: number; w: number; h: number }): void {
    const size = Renderer.LABEL_CELL_SIZE;
    for (let x = Math.floor(box.x / size); x <= Math.floor((box.x + box.w) / size); x++) {
      for (let y = Math.floor(box.y / size); y <= Math.floor((box.y + box.h) / size); y++) {
        const key = `${x}:${y}`;
        const cell = this.labelGrid.get(key);
        if (cell) cell.push(box);
        else this.labelGrid.set(key, [box]);
      }
    }
  }

  private labelLines(cfg: Config, ac: Aircraft): { text: string; kind: "title" | "sub" }[] {
    const f = cfg.showFields;
    const out: { text: string; kind: "title" | "sub" }[] = [];
    const title = f.flight ? ac.flight ?? ac.hex.toUpperCase() : ac.airline;
    if (title) out.push({ text: title, kind: "title" });

    const sub: string[] = [];
    if (f.type && (ac.typeName || ac.typeCode)) sub.push(ac.typeName ?? ac.typeCode!);
    if (f.altitude) {
      sub.push(formatAltitudeLabel(ac));
    }
    if (f.speed && ac.gs != null) sub.push(`${Math.round(ac.gs)} kt`);
    if (sub.length) out.push({ text: sub.join("   "), kind: "sub" });

    if (f.destination && ac.destination && routePlausible(ac, cfg)) {
      const head = ac.origin ? `${ac.origin} → ${ac.destination}` : `→ ${ac.destination}`;
      out.push({ text: ac.destName ? `${head}   ${ac.destName}` : head, kind: "sub" });
      if (cfg.showRouteDetail && ac.destLat != null && ac.destLon != null) {
        const bits: string[] = [`${localTimeAt(ac.destLon)} local`];
        if (ac.lat != null && ac.lon != null) {
          const mi = Math.round(greatCircleMiles(ac.lat, ac.lon, ac.destLat, ac.destLon));
          if (mi > 1) bits.push(`${mi.toLocaleString("en-US")} mi to go`);
        }
        out.push({ text: bits.join("   ·   "), kind: "sub" });
      }
    }
    if (f.registration && ac.registration) out.push({ text: ac.registration, kind: "sub" });
    return out;
  }

  private drawLabel(cfg: Config, v: Visible, strength: number): void {
    const ctx = this.ctx;
    const lines = this.labelLines(cfg, v.tr.ac);
    if (!lines.length) return;
    const a = v.labelAlpha * strength;
    if (a < 0.04) return;

    const { w, lh, h } = this.measureLabel(cfg, lines);
    const gap = cfg.glyphSizePx * 0.7 + 9;
    const onScreen = (b: { x: number; y: number; w: number; h: number }) =>
      b.x >= 6 && b.x + b.w <= this.w - 6 && b.y >= 6 && b.y + b.h <= this.h - 6;

    // Try four quadrants, then nudge downward, to avoid overlapping other labels.
    const candidates = [
      { x: v.p.x + gap, y: v.p.y - gap - h },
      { x: v.p.x + gap, y: v.p.y + gap },
      { x: v.p.x - gap - w, y: v.p.y - gap - h },
      { x: v.p.x - gap - w, y: v.p.y + gap },
    ];
    let box: { x: number; y: number; w: number; h: number } | null = null;
    for (const c of candidates) {
      const b = { x: c.x, y: c.y, w, h };
      if (onScreen(b) && !this.collides(b)) {
        box = b;
        break;
      }
    }
    if (!box) {
      let b = { x: v.p.x + gap, y: v.p.y - gap - h, w, h };
      for (let k = 0; k < 9 && (this.collides(b) || !onScreen(b)); k++) {
        b = { ...b, y: b.y + lh + 2 };
      }
      box = b;
    }
    box.x = Math.max(6, Math.min(box.x, this.w - 6 - w));
    box.y = Math.max(6, Math.min(box.y, this.h - 6 - h));
    this.placeLabelBox(box);

    // Hairline leader from glyph to the nearest edge of the label.
    const anchorX = box.x + w / 2 < v.p.x ? box.x + w : box.x;
    const anchorY = Math.max(box.y, Math.min(v.p.y, box.y + h));
    // Rotate the whole label (leader + text) around the glyph so it reads
    // upright from where you lie, without disturbing the field.
    this.withLabelRotation(cfg, v.p.x, v.p.y, () => {
      ctx.save();
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.text), 0.24 * a);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(v.p.x, v.p.y);
      ctx.lineTo(anchorX, anchorY);
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 6;
      let y = box.y;
      for (const ln of lines) {
        if (ln.kind === "title") {
          ctx.font = `500 14px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba([245, 247, 255], a);
          try {
            ctx.letterSpacing = "1.5px";
          } catch {
            /* noop */
          }
        } else {
          ctx.font = `400 11px ${cfg.fonts.label}`;
          ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.82 * a);
          try {
            ctx.letterSpacing = "0.5px";
          } catch {
            /* noop */
          }
        }
        ctx.fillText(ln.text, box.x, y);
        y += lh;
      }
      try {
        ctx.letterSpacing = "0px";
      } catch {
        /* noop */
      }
      ctx.restore();
    });
  }

  private drawStaleIndicator(cfg: Config, count: number): void {
    const ctx = this.ctx;
    const x = this.w - 14;
    const y = this.h - 14;
    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.font = `400 11px ${cfg.fonts.mono}`;
    ctx.fillStyle = `rgba(200,180,100,${0.55 * cfg.brightness})`;
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 4;
    ctx.fillText(`Estimated position · ${count} track${count !== 1 ? "s" : ""}`, x, y);
    ctx.restore();
  }

  /** Drawn while a pan offset is active — shows new center coordinates. */
  private drawPanOverlay(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const b  = cfg.brightness;
    const rPx = cfg.radiusMiles * 1609.34 * proj.pxPerM;

    // Animated dashed ring at the current (panned) radius.
    const dashLen   = 10;
    const gapLen    = 7;
    const dashOffset = -(this.frameT * 28) % (dashLen + gapLen);

    ctx.save();

    // Outer vignette — subtly dims outside the radius circle.
    const vig = ctx.createRadialGradient(cx, cy, rPx * 0.7, cx, cy, rPx * 1.2);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, `rgba(0,0,0,${0.36 * b})`);
    ctx.fillStyle = vig;
    ctx.beginPath();
    ctx.rect(0, 0, this.w, this.h);
    ctx.arc(cx, cy, rPx * 1.2, 0, Math.PI * 2, true);
    ctx.fill("evenodd");

    // Dashed radius ring.
    ctx.beginPath();
    ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(155,126,207,${0.65 * b})`;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([dashLen, gapLen]);
    ctx.lineDashOffset = dashOffset;
    ctx.stroke();
    ctx.setLineDash([]);

    // Small crosshair — 4 short arms with a gap at center.
    const arm = 14;
    const gap = 5;
    ctx.strokeStyle = `rgba(155,126,207,${0.85 * b})`;
    ctx.lineWidth = 1;
    for (const [x1, y1, x2, y2] of [
      [cx - arm, cy,       cx - gap, cy      ],
      [cx + gap, cy,       cx + arm, cy      ],
      [cx,       cy - arm, cx,       cy - gap],
      [cx,       cy + gap, cx,       cy + arm],
    ] as [number, number, number, number][]) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Center dot.
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(155,126,207,${b})`;
    ctx.fill();

    // Coordinate label just below the crosshair.
    const { centerLat, centerLon } = this.getPannedCenter();
    const latStr  = `${Math.abs(centerLat).toFixed(4)}°${centerLat >= 0 ? "N" : "S"}`;
    const lonStr  = `${Math.abs(centerLon).toFixed(4)}°${centerLon >= 0 ? "E" : "W"}`;
    ctx.font = `400 11px ${cfg.fonts.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = `rgba(200,188,230,${0.88 * b})`;
    ctx.shadowColor = "rgba(0,0,0,0.95)";
    ctx.shadowBlur = 7;
    ctx.fillText(`${latStr}  ${lonStr}`, cx, cy + gap + arm + 6);

    ctx.restore();
  }

  private drawDetailPanel(cfg: Config, v: Visible): void {    const ac = v.tr.ac;
    const x = 40;
    const y = this.h - 120;
    this.withLabelRotation(cfg, x, y, () => this.drawDetailPanelText(cfg, v, ac, x, y));
  }

  private drawDetailPanelText(cfg: Config, v: Visible, ac: Aircraft, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.9)";
    ctx.shadowBlur = 10;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    try {
      ctx.letterSpacing = "2px";
    } catch {
      /* noop */
    }
    ctx.font = `300 34px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba([245, 247, 255], v.alpha);
    ctx.fillText(ac.flight ?? ac.hex.toUpperCase(), x, y);
    try {
      ctx.letterSpacing = "0.5px";
    } catch {
      /* noop */
    }
    ctx.font = `400 15px ${cfg.fonts.label}`;
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.85 * v.alpha);
    const bits = [
      ac.airline,
      ac.typeName ?? ac.typeCode,
      formatAltitudeLabel(ac, { verboseGround: true, includeFeetAtFlightLevel: true }),
      ac.gs != null ? `${Math.round(ac.gs)} kt` : null,
      ac.origin && ac.destination && routePlausible(ac, cfg) ? `${ac.origin} → ${ac.destination}` : null,
    ].filter(Boolean);
    ctx.fillText(bits.join("    ·    "), x, y + 26);
    try {
      ctx.letterSpacing = "0px";
    } catch {
      /* noop */
    }
    ctx.restore();
  }

  private drawFollowProgressBar(cfg: Config, ac: Aircraft): void {
    const ctx = this.ctx;
    const lat = ac.lat!;
    const lon = ac.lon!;
    const oLat = ac.originLat!;
    const oLon = ac.originLon!;
    const dLat = ac.destLat!;
    const dLon = ac.destLon!;

    const totalDist = greatCircleMiles(oLat, oLon, dLat, dLon);
    if (totalDist < 1) return;
    const remainingDist = greatCircleMiles(lat, lon, dLat, dLon);
    const elapsedDist = Math.max(0, totalDist - remainingDist);
    const progress = clamp01(elapsedDist / totalDist);

    const speedKt = ac.gs ?? 0;
    const speedMph = speedKt * 1.15078;
    const hoursRemaining = speedMph > 50 ? remainingDist / speedMph : null;

    let timeText = "";
    if (hoursRemaining !== null) {
      const h = Math.floor(hoursRemaining);
      const m = Math.floor((hoursRemaining - h) * 60);
      const etaStr = localTimeAt(dLon, hoursRemaining);
      timeText = ` · ${h}h ${m}m left (ETA: ${etaStr})`;
    } else {
      const etaStr = localTimeAt(dLon, 0);
      timeText = ` · Local: ${etaStr}`;
    }

    const panelX = this.w / 2;
    const panelY = this.h - 55;

    this.withLabelRotation(cfg, panelX, panelY, () => {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.9)";
      ctx.shadowBlur = 8;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const barWidth = 260;
      const xStart = panelX - barWidth / 2;
      const xEnd = panelX + barWidth / 2;

      // Draw progress bar background line
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.4 * cfg.brightness);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xStart, panelY);
      ctx.lineTo(xEnd, panelY);
      ctx.stroke();

      // Draw progress line
      ctx.strokeStyle = rgba(hexToRgb(cfg.palette.accent), 0.8 * cfg.brightness);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xStart, panelY);
      ctx.lineTo(xStart + progress * barWidth, panelY);
      ctx.stroke();

      // Draw Origin code
      ctx.font = `500 11px ${cfg.fonts.mono}`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.7 * cfg.brightness);
      ctx.textAlign = "right";
      ctx.fillText(ac.origin!, xStart - 10, panelY);

      // Draw Destination code
      ctx.textAlign = "left";
      ctx.fillText(ac.destination!, xEnd + 10, panelY);

      // Draw Airplane icon
      ctx.font = `14px sans-serif`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.accent), 0.95 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("✈", xStart + progress * barWidth, panelY - 0.5);

      // Draw details text below
      ctx.font = `300 10px ${cfg.fonts.label}`;
      ctx.fillStyle = rgba(hexToRgb(cfg.palette.text), 0.55 * cfg.brightness);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const detailStr = `${Math.round(elapsedDist).toLocaleString()} mi flown · ${Math.round(remainingDist).toLocaleString()} mi to go${timeText}`;
      ctx.fillText(detailStr, panelX, panelY + 10);

      ctx.restore();
    });
  }

  private drawAirspace(cfg: Config, proj: ProjOpts): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.22 * cfg.brightness);
    ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.35 * cfg.brightness);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);

    const centerScreenX = this.w / 2;
    const centerScreenY = this.h / 2;

    // 1. Draw Sector boundaries centered on screen
    const rad1 = 15 * 1609.34 * proj.pxPerM;
    const rad2 = 30 * 1609.34 * proj.pxPerM;
    
    if (rad1 > 50 && rad1 < this.w * 2) {
      ctx.beginPath();
      ctx.arc(centerScreenX, centerScreenY, rad1, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (rad2 > 50 && rad2 < this.w * 2) {
      ctx.beginPath();
      ctx.arc(centerScreenX, centerScreenY, rad2, 0, Math.PI * 2);
      ctx.stroke();
    }

    const angles = [60, 150, 240, 330];
    for (const angle of angles) {
      const radAngle = (angle + proj.rotationDeg) * Math.PI / 180;
      const x1 = centerScreenX + Math.cos(radAngle) * 20;
      const y1 = centerScreenY + Math.sin(radAngle) * 20;
      const x2 = centerScreenX + Math.cos(radAngle) * Math.max(this.w, this.h);
      const y2 = centerScreenY + Math.sin(radAngle) * Math.max(this.w, this.h);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.font = `8px ${cfg.fonts.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const labelOffset = 22 * 1609.34 * proj.pxPerM;
    const labelAngles = [15, 105, 195, 285];
    const sectorLabels = [
      "TMA SECTOR NORTH\nSFC - FL195",
      "TMA SECTOR EAST\nSFC - FL195",
      "TMA SECTOR SOUTH\nSFC - FL195",
      "TMA SECTOR WEST\nSFC - FL195"
    ];

    for (let i = 0; i < labelAngles.length; i++) {
      const angle = labelAngles[i];
      const radAngle = (angle + proj.rotationDeg) * Math.PI / 180;
      const lx = centerScreenX + Math.cos(radAngle) * labelOffset;
      const ly = centerScreenY + Math.sin(radAngle) * labelOffset;

      if (lx > 0 && lx < this.w && ly > 0 && ly < this.h) {
        ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.28 * cfg.brightness);
        const lines = sectorLabels[i].split("\n");
        ctx.fillText(lines[0], lx, ly - 5);
        ctx.fillText(lines[1], lx, ly + 5);
      }
    }

    // 2. Draw CTRs and Airways for nearby airports
    ctx.setLineDash([2, 5]);
    const ctrRad = 5 * 1609.34 * proj.pxPerM;

    const screenAirports: { ap: Airport; x: number; y: number }[] = [];
    for (const ap of this.nearbyAirports.slice(0, 5)) {
      const pos = this.getAirportScreenPos(ap.icao);
      if (pos) {
        screenAirports.push({ ap, x: pos.x, y: pos.y });
      }
    }

    for (const sa of screenAirports) {
      if (sa.x > -100 && sa.x < this.w + 100 && sa.y > -100 && sa.y < this.h + 100) {
        ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.25 * cfg.brightness);
        ctx.beginPath();
        ctx.arc(sa.x, sa.y, ctrRad, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.35 * cfg.brightness);
        ctx.fillText(`${sa.ap.name} CTR`, sa.x, sa.y - ctrRad - 6);
      }
    }

    ctx.strokeStyle = rgba(hexToRgb(cfg.palette.grid), 0.15 * cfg.brightness);
    ctx.setLineDash([3, 10]);
    for (let i = 0; i < screenAirports.length; i++) {
      for (let j = i + 1; j < screenAirports.length; j++) {
        const a = screenAirports[i];
        const b = screenAirports[j];
        
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;

        if (mx > 10 && mx < this.w - 10 && my > 10 && my < this.h - 10) {
          ctx.save();
          ctx.fillStyle = rgba(hexToRgb(cfg.palette.grid), 0.25 * cfg.brightness);
          ctx.beginPath();
          ctx.moveTo(mx, my - 4);
          ctx.lineTo(mx + 4, my + 3);
          ctx.lineTo(mx - 4, my + 3);
          ctx.closePath();
          ctx.fill();

          ctx.font = `6px ${cfg.fonts.mono}`;
          ctx.fillText(`AIRWAY T${100 + i + j}`, mx, my + 10);
          ctx.restore();
        }
      }
    }

    ctx.restore();
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Stable per-aircraft phase offset (0..2π) so props/rotors aren't all in sync. */
function hexSeed(hex: string): number {
  let n = 0;
  for (let i = 0; i < hex.length; i++) n = (n * 31 + hex.charCodeAt(i)) % 360;
  return (n / 360) * Math.PI * 2;
}

const DEG = Math.PI / 180;

/** Initial great-circle bearing (deg from North) from point 1 to point 2. */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const Δλ = (lon2 - lon1) * DEG;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

/** Great-circle distance in statute miles. */
function greatCircleMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = (lat2 - lat1) * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Longitude-based mean solar time at a place (no DST/tz db) as HH:MM. */
function localTimeAt(lon: number, addHours = 0): string {
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes() + addHours * 60;
  let m = (utcMin + (lon / 15) * 60) % 1440;
  if (m < 0) m += 1440;
  const hh = Math.floor(m / 60);
  const mm = Math.floor(m % 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function formatAltitudeLabel(
  ac: Aircraft,
  options: { verboseGround?: boolean; includeFeetAtFlightLevel?: boolean } = {},
): string {
  const { verboseGround = false, includeFeetAtFlightLevel = false } = options;
  if (ac.onGround) return verboseGround ? "on ground" : "GND";

  const alt = ac.altBaro ?? ac.altGeom;
  if (alt == null) return "ALT —";

  const rounded = Math.max(0, Math.round(alt));
  if (rounded >= 18000) {
    const fl = String(Math.round(rounded / 100)).padStart(3, "0");
    if (includeFeetAtFlightLevel) return `FL${fl} (${rounded.toLocaleString("en-US")} ft)`;
    return `FL${fl}`;
  }
  return `${rounded.toLocaleString("en-US")} ft`;
}

/** Cross-track distance (miles) of a point from the great circle p1→p2. */
function crossTrackMiles(
  lat: number, lon: number,
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 3958.8;
  const d13 = greatCircleMiles(lat1, lon1, lat, lon) / R; // angular (rad)
  const θ13 = bearing(lat1, lon1, lat, lon) * DEG;
  const θ12 = bearing(lat1, lon1, lat2, lon2) * DEG;
  return Math.asin(Math.sin(d13) * Math.sin(θ13 - θ12)) * R;
}

/**
 * Is the adsbdb route consistent with where the plane actually is and what it's
 * doing? adsbdb returns the scheduled route for a callsign, which is sometimes
 * the wrong leg. We reject a route if:
 *  (a) it's geographically impossible — the plane is neither near an endpoint
 *      nor roughly on the great-circle path; or
 *  (b) the plane's vertical trend disagrees — a climbing plane near you just
 *      departed the local airport (so that should be the origin); a descending
 *      one is arriving (the destination).
 */
function routePlausible(ac: Aircraft, cfg: Config): boolean {
  if (ac.lat == null || ac.lon == null) return true;
  const haveCoords = ac.originLat != null || ac.destLat != null;
  if (!haveCoords) return true; // legacy cache without coords — don't hide

  // (a) geographic consistency
  const nearPlane = (la?: number, lo?: number) =>
    la != null && lo != null && greatCircleMiles(ac.lat!, ac.lon!, la, lo) < 80;
  let geomOk = nearPlane(ac.originLat, ac.originLon) || nearPlane(ac.destLat, ac.destLon);
  if (
    !geomOk &&
    ac.originLat != null && ac.originLon != null &&
    ac.destLat != null && ac.destLon != null
  ) {
    geomOk = Math.abs(crossTrackMiles(ac.lat, ac.lon, ac.originLat, ac.originLon, ac.destLat, ac.destLon)) < 130;
  } else if (!geomOk && (ac.originLat == null || ac.destLat == null)) {
    geomOk = true; // only one endpoint known and not near — can't judge, allow
  }
  if (!geomOk) return false;

  // (b) vertical-trend consistency for low, nearby traffic
  const alt = ac.altBaro ?? ac.altGeom;
  const localTraffic = greatCircleMiles(ac.lat, ac.lon, cfg.centerLat, cfg.centerLon) < 30;
  const localAirport = (la?: number, lo?: number) =>
    la != null && lo != null && greatCircleMiles(cfg.centerLat, cfg.centerLon, la, lo) < 45;
  if (localTraffic && alt != null && alt < 12000 && ac.baroRate != null && Math.abs(ac.baroRate) > 250) {
    if (ac.baroRate > 0) {
      if (ac.originLat != null && !localAirport(ac.originLat, ac.originLon)) return false; // departing
    } else {
      if (ac.destLat != null && !localAirport(ac.destLat, ac.destLon)) return false; // arriving
    }
  }
  return true;
}

function hexToRgb(hex: string): [number, number, number] {
  const cached = hexRgbCache.get(hex);
  if (cached) return cached;
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const int = parseInt(n, 16);
  const rgb: [number, number, number] = [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  hexRgbCache.set(hex, rgb);
  return rgb;
}

const hexRgbCache = new Map<string, [number, number, number]>();
