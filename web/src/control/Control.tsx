import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Aircraft, Config, ShowFields } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { nextISSPass, type Tle } from "../display/celestial.js";
import { ColorRow, Row, Section, Segmented, Slider, Toggle } from "./components.js";
import { PRESETS } from "./presets.js";
import { LOCATION_PRESETS } from "./locationPresets.js";
import { type City, prefetchCities, searchCities } from "../lib/cities.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function skyTimeLabel(offsetMin: number): string {
  if (offsetMin === 0) return "live";
  const d = new Date(Date.now() + offsetMin * 60000);
  return d.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtIn(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtAlt(ac: Aircraft): string {
  if (ac.onGround) return "Ground";
  const a = ac.altBaro ?? ac.altGeom;
  return a != null ? `${a.toLocaleString("en-US")} ft` : "—";
}

function fmtSpeed(ac: Aircraft): string {
  return ac.gs != null ? `${Math.round(ac.gs)} kt` : "—";
}

function fmtRate(ac: Aircraft): string {
  if (ac.baroRate == null) return "—";
  const sign = ac.baroRate > 0 ? "+" : "";
  return `${sign}${Math.round(ac.baroRate).toLocaleString("en-US")} fpm`;
}

/** Great-circle distance in statute miles (flat-earth approx, accurate within ~50mi). */
function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const DEG = Math.PI / 180;
  const R = 3958.8;
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FIELD_LABELS: Record<keyof ShowFields, string> = {
  airline: "Airline",
  flight: "Flight",
  type: "Type",
  altitude: "Altitude",
  speed: "Speed",
  verticalRate: "Vert. rate",
  destination: "Destination",
  registration: "Registration",
};

// ─── sub-components ───────────────────────────────────────────────────────────

/** Preset picker strip shown at the top of the control panel. */
function PresetPicker({ onApply }: { onApply: (patch: Partial<Config>) => void }) {
  const [applied, setApplied] = useState<string | null>(null);

  const apply = (id: string, patch: Partial<Config>) => {
    onApply(patch);
    setApplied(id);
    setTimeout(() => setApplied(null), 1800);
  };

  return (
    <div className="preset-strip">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          className={`preset-btn ${applied === p.id ? "applied" : ""}`}
          onClick={() => apply(p.id, p.patch)}
          title={p.description}
        >
          {applied === p.id ? "✓" : p.label}
        </button>
      ))}
    </div>
  );
}

/** Closest aircraft card shown just below the topbar. */
function ClosestAircraftCard({
  aircraft,
  cfg,
  onSelect,
}: {
  aircraft: Aircraft[];
  cfg: Config;
  onSelect: (ac: Aircraft) => void;
}) {
  const closest = useMemo(() => {
    const withPos = aircraft.filter(
      (ac) => ac.lat != null && ac.lon != null && !ac.onGround,
    );
    if (!withPos.length) return null;
    let best: Aircraft | null = null;
    let bestDist = Infinity;
    for (const ac of withPos) {
      const d = distanceMiles(cfg.centerLat, cfg.centerLon, ac.lat!, ac.lon!);
      if (d < bestDist) {
        bestDist = d;
        best = ac;
      }
    }
    return best ? { ac: best, dist: bestDist } : null;
  }, [aircraft, cfg.centerLat, cfg.centerLon]);

  if (!closest) return null;
  const { ac, dist } = closest;

  return (
    <button className="closest-card" onClick={() => onSelect(ac)}>
      <div className="closest-header">
        <span className="closest-label">Closest overhead</span>
        <span className="closest-dist">{dist.toFixed(1)} mi away</span>
      </div>
      <div className="closest-flight">{ac.flight ?? ac.hex.toUpperCase()}</div>
      <div className="closest-detail">
        {[ac.airline, ac.typeName ?? ac.typeCode].filter(Boolean).join(" · ")}
      </div>
      {ac.origin && ac.destination && (
        <div className="closest-route">{ac.origin} → {ac.destination}</div>
      )}
      <div className="closest-stats">
        <span>{fmtAlt(ac)}</span>
        <span>{fmtSpeed(ac)}</span>
        {ac.baroRate != null && Math.abs(ac.baroRate) > 100 && (
          <span>{fmtRate(ac)}</span>
        )}
      </div>
    </button>
  );
}

function NearbyAircraftList({
  aircraft,
  cfg,
  onSelect,
}: {
  aircraft: Aircraft[];
  cfg: Config;
  onSelect: (ac: Aircraft) => void;
}) {
  const followed = aircraft.find(
    (ac) => ac.hex.toLowerCase() === cfg.followFlightHex.toLowerCase(),
  );
  const refLat = followed?.lat ?? cfg.centerLat;
  const refLon = followed?.lon ?? cfg.centerLon;
  const nearby = useMemo(
    () =>
      aircraft
        .filter((ac) => ac.lat != null && ac.lon != null && !ac.onGround)
        .map((ac) => ({
          ac,
          distance: distanceMiles(refLat, refLon, ac.lat!, ac.lon!),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8),
    [aircraft, refLat, refLon],
  );
  if (!nearby.length) return null;

  return (
    <div className="nearby-flights">
      <div className="nearby-flights-title">Choose a flight to follow</div>
      <div className="nearby-flights-list">
        {nearby.map(({ ac, distance }) => (
          <button key={ac.hex} onClick={() => onSelect(ac)}>
            <strong>{ac.flight ?? ac.hex.toUpperCase()}</strong>
            <span>{distance.toFixed(1)} mi</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TelemetryGraph({ history }: { history: { ts: number; alt: number; gs: number }[] }) {
  if (history.length < 2) {
    return (
      <div className="telemetry-graph-empty" style={{ margin: "8px 0", height: "40px", fontSize: "10px", display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: "6px", color: "#6b7280" }}>
        <span>Awaiting telemetry updates…</span>
      </div>
    );
  }

  const width = 270;
  const height = 45;
  const pad = 2;

  const alts = history.map((p) => p.alt);
  const speeds = history.map((p) => p.gs);
  const maxAlt = Math.max(...alts, 1000);
  const minAlt = Math.min(...alts, 0);
  const maxSpeed = Math.max(...speeds, 100);
  const minSpeed = Math.min(...speeds, 0);

  const pointsAlt = history.map((p, idx) => {
    const x = pad + (idx / (history.length - 1)) * (width - 2 * pad);
    const y = height - pad - ((p.alt - minAlt) / Math.max(1, maxAlt - minAlt)) * (height - 2 * pad);
    return { x, y };
  });

  const pointsSpeed = history.map((p, idx) => {
    const x = pad + (idx / (history.length - 1)) * (width - 2 * pad);
    const y = height - pad - ((p.gs - minSpeed) / Math.max(1, maxSpeed - minSpeed)) * (height - 2 * pad);
    return { x, y };
  });

  const altPath = pointsAlt.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const altAreaPath = `${altPath} L ${pointsAlt[pointsAlt.length - 1].x} ${height - pad} L ${pointsAlt[0].x} ${height - pad} Z`;
  const speedPath = pointsSpeed.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <div className="telemetry-graph-wrapper" style={{ margin: "8px 0", background: "rgba(255, 255, 255, 0.02)", border: "1px solid rgba(255, 255, 255, 0.04)", borderRadius: "6px", padding: "6px", display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width={width} height={height} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="altGradCtrl" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(155, 126, 207, 0.35)" />
            <stop offset="100%" stopColor="rgba(155, 126, 207, 0)" />
          </linearGradient>
        </defs>
        <line x1={pad} y1={height / 2} x2={width - pad} y2={height / 2} stroke="rgba(255, 255, 255, 0.05)" strokeWidth="1" />
        <path d={altAreaPath} fill="url(#altGradCtrl)" />
        <path d={altPath} fill="none" stroke="#9B7ECF" strokeWidth="1.5" />
        <path d={speedPath} fill="none" stroke="#00FFFF" strokeWidth="1" strokeDasharray="1,1" />
      </svg>
      <div className="telemetry-legend" style={{ width: "100%", display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "9px", fontWeight: "bold" }}>
        <span className="legend-item" style={{ color: "#9B7ECF" }}>
          ALT: {Math.round(alts[alts.length - 1]).toLocaleString()} ft
        </span>
        <span className="legend-item" style={{ color: "#00FFFF" }}>
          SPD: {Math.round(speeds[speeds.length - 1])} kt
        </span>
      </div>
    </div>
  );
}

/** Full-screen flight detail popup. */
function FlightDetailPopup({
  ac,
  cfg,
  history,
  onClose,
  onToggleFollow,
}: {
  ac: Aircraft;
  cfg: Config;
  history: { ts: number; alt: number; gs: number }[];
  onClose: () => void;
  onToggleFollow: () => void;
}) {
  const following = cfg.followFlightHex.toLowerCase() === ac.hex.toLowerCase();
  const dist =
    ac.lat != null && ac.lon != null
      ? distanceMiles(cfg.centerLat, cfg.centerLon, ac.lat, ac.lon)
      : null;

  const rows: [string, string][] = [
    ["Flight", ac.flight ?? "—"],
    ["Airline", ac.airline ?? "—"],
    ["Type", ac.typeName ?? ac.typeCode ?? "—"],
    ["Registration", ac.registration ?? "—"],
    ["Origin", ac.origin ?? "—"],
    ["Destination", ac.destination ?? "—"],
    ["Altitude", fmtAlt(ac)],
    ["Speed", fmtSpeed(ac)],
    ["Vertical rate", fmtRate(ac)],
    ["Heading", ac.track != null ? `${Math.round(ac.track)}°` : "—"],
    ["Distance", dist != null ? `${dist.toFixed(2)} mi` : "—"],
    ["Squawk", ac.squawk ?? "—"],
    ["ICAO", ac.hex.toUpperCase()],
  ];

  return (
    <div className="popup-overlay" onClick={onClose}>
      <div className="popup" onClick={(e) => e.stopPropagation()}>
        <div className="popup-header">
          <div>
            <div className="popup-flight">{ac.flight ?? ac.hex.toUpperCase()}</div>
            {ac.origin && ac.destination && (
              <div className="popup-route">{ac.origin} → {ac.destination}</div>
            )}
          </div>
          <button className="popup-close" onClick={onClose}>✕</button>
        </div>
        <div className="popup-body">
          <TelemetryGraph history={history} />
          {rows.map(([label, value]) => (
            <div key={label} className="popup-row">
              <span className="popup-label">{label}</span>
              <span className="popup-value">{value}</span>
            </div>
          ))}
        </div>
        <button className={`follow-flight-btn ${following ? "active" : ""}`} onClick={onToggleFollow}>
          {following ? "Stop following flight" : "Follow flight on display"}
        </button>
      </div>
    </div>
  );
}

/** Flight number search — filters live aircraft feed, falls back to worldwide API search. */
function FlightSearch({
  aircraft,
  cfg,
  onFollow,
}: {
  aircraft: Aircraft[];
  cfg: Config;
  onFollow: (hex: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<Aircraft[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();

  const localResults = useMemo(() => {
    const q = norm(query);
    if (q.length < 2) return [];
    return aircraft
      .filter((ac) => norm(ac.flight ?? "").includes(q) || ac.hex.toUpperCase().includes(q))
      .slice(0, 8);
  }, [aircraft, query]);

  // Worldwide fallback: query the server when there are no local hits.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = norm(query);
    if (q.length < 3 || localResults.length > 0) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (res.ok) {
          const data = await res.json() as { aircraft: Aircraft[] };
          setRemoteResults(data.aircraft ?? []);
        }
      } catch {
        // network error — stay silent
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, localResults.length]);

  const handleSelect = (ac: Aircraft) => {
    onFollow(ac.hex.toLowerCase());
    setQuery("");
    setRemoteResults([]);
    inputRef.current?.blur();
  };

  const clear = () => {
    setQuery("");
    setRemoteResults([]);
    inputRef.current?.focus();
  };

  const results = localResults.length > 0 ? localResults : remoteResults;
  const isWorldwide = localResults.length === 0 && remoteResults.length > 0;

  return (
    <div className="flight-search">
      <div className="flight-search-wrap">
        <input
          ref={inputRef}
          className="location-input flight-search-input"
          type="text"
          placeholder="Search flight number…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
        {searching && <span className="flight-search-spinner" />}
        {query && !searching && (
          <button className="flight-search-clear" onClick={clear} aria-label="Clear">✕</button>
        )}
      </div>
      {query.length >= 2 && !searching && (
        <ul className="flight-search-results">
          {isWorldwide && (
            <li className="flight-search-section">Worldwide — not yet in range</li>
          )}
          {results.length === 0 ? (
            <li className="flight-search-empty">No matching flights found</li>
          ) : (
            results.map((ac) => {
              const following = cfg.followFlightHex.toLowerCase() === ac.hex.toLowerCase();
              const dist =
                ac.lat != null && ac.lon != null
                  ? distanceMiles(cfg.centerLat, cfg.centerLon, ac.lat, ac.lon).toFixed(0) + " mi away"
                  : null;
              return (
                <li key={ac.hex}>
                  <button
                    className={`flight-search-item ${following ? "active" : ""}`}
                    onClick={() => handleSelect(ac)}
                  >
                    <span className="flight-search-callsign">
                      {ac.flight ?? ac.hex.toUpperCase()}
                    </span>
                    <span className="flight-search-meta">
                      {[ac.typeName ?? ac.typeCode, dist].filter(Boolean).join(" · ")}
                    </span>
                    {following && <span className="flight-search-badge">Following</span>}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

/** Location section: city search + airport quick-picks + manual lat/lon. */
function LocationSection({
  cfg,
  onPatch,
}: {
  cfg: Config;
  onPatch: (patch: Partial<Config>) => void;
}) {
  const [lat, setLat] = useState(String(cfg.centerLat));
  const [lon, setLon] = useState(String(cfg.centerLon));
  const [dirty, setDirty] = useState(false);
  const [cityQuery, setCityQuery] = useState("");
  const [cityResults, setCityResults] = useState<City[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Prefetch cities dataset as soon as this section mounts.
  useEffect(() => { prefetchCities(); }, []);

  // Keep lat/lon inputs in sync when config changes from elsewhere.
  useEffect(() => {
    setLat(String(cfg.centerLat));
    setLon(String(cfg.centerLon));
    setDirty(false);
  }, [cfg.centerLat, cfg.centerLon]);

  const applyLocation = useCallback((newLat: number, newLon: number, newRadius?: number) => {
    const patch: Partial<Config> = { centerLat: newLat, centerLon: newLon };
    if (newRadius != null) patch.radiusMiles = newRadius;
    onPatch(patch);
    setCityQuery("");
    setCityResults([]);
  }, [onPatch]);

  const commitManual = () => {
    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    if (!isFinite(parsedLat) || !isFinite(parsedLon)) return;
    if (parsedLat < -90 || parsedLat > 90) return;
    if (parsedLon < -180 || parsedLon > 180) return;
    applyLocation(parsedLat, parsedLon);
    setDirty(false);
  };

  // Debounced city search.
  const handleCityInput = (q: string) => {
    setCityQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) { setCityResults([]); return; }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      const results = await searchCities(q);
      setCityResults(results);
      setSearching(false);
    }, 200);
  };

  return (
    <>
      <Row label="Radius">
        <Slider value={cfg.radiusMiles} min={0.5} max={50} step={0.5} unit="mi"
          onChange={(v) => onPatch({ radiusMiles: v })} />
      </Row>

      {/* City search */}
      <div className="location-search">
        <div className="location-search-wrap">
          <input
            className="location-input location-search-input"
            type="text"
            placeholder="Search city…"
            value={cityQuery}
            onChange={(e) => handleCityInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <span className="location-search-spinner" />}
        </div>
        {cityResults.length > 0 && (
          <ul className="city-results">
            {cityResults.map((c, i) => (
              <li key={i}>
                <button
                  className="city-result-btn"
                  onClick={() => applyLocation(c.lat, c.lon)}
                >
                  <span className="city-result-name">{c.name}</span>
                  {c.country && <span className="city-result-country">{c.country}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        {cityResults.length === 0 && cityQuery.trim().length >= 2 && !searching && (
          <div className="city-no-results">No cities found — try the airport quick-picks or set coordinates manually</div>
        )}
      </div>

      {/* Airport quick-picks */}
      <div className="location-airports">
        <span className="location-airports-label">Airport quick-pick</span>
        <div className="location-chips">
          {LOCATION_PRESETS.map((lp) => {
            const active =
              Math.abs(cfg.centerLat - lp.lat) < 0.01 &&
              Math.abs(cfg.centerLon - lp.lon) < 0.01;
            return (
              <button key={lp.code}
                className={`chip ${active ? "on" : ""}`}
                onClick={() => applyLocation(lp.lat, lp.lon, lp.radiusMiles)}
                title={lp.name}
              >
                {lp.code}
              </button>
            );
          })}
        </div>
      </div>

      {/* Manual lat/lon */}
      <div className="location-manual">
        <div className="location-field">
          <label className="location-field-label">Latitude</label>
          <input className="location-input" type="number" step="0.0001" min="-90" max="90"
            value={lat}
            onChange={(e) => { setLat(e.target.value); setDirty(true); }}
            onBlur={commitManual}
            onKeyDown={(e) => e.key === "Enter" && commitManual()}
          />
        </div>
        <div className="location-field">
          <label className="location-field-label">Longitude</label>
          <input className="location-input" type="number" step="0.0001" min="-180" max="180"
            value={lon}
            onChange={(e) => { setLon(e.target.value); setDirty(true); }}
            onBlur={commitManual}
            onKeyDown={(e) => e.key === "Enter" && commitManual()}
          />
        </div>
        {dirty && (
          <button className="location-apply" onClick={commitManual}>Apply</button>
        )}
      </div>
    </>
  );
}


// ─── main control component ───────────────────────────────────────────────────

export function Control() {
  const { state, conn } = useStream("control");
  const cfg = state.config;

  const [selectedAc, setSelectedAc] = useState<Aircraft | null>(null);


  const telemetryHistory = useRef<Map<string, { ts: number; alt: number; gs: number }[]>>(new Map());

  // Track telemetry history for aircraft
  useEffect(() => {
    const history = telemetryHistory.current;
    const currentHexes = new Set(state.aircraft.map((ac) => ac.hex.toLowerCase()));

    for (const hex of history.keys()) {
      if (!currentHexes.has(hex)) history.delete(hex);
    }

    const now = Date.now();
    for (const ac of state.aircraft) {
      if (ac.lat == null || ac.lon == null) continue;
      const hex = ac.hex.toLowerCase();
      let list = history.get(hex);
      if (!list) {
        list = [];
        history.set(hex, list);
      }
      const lastPoint = list[list.length - 1];
      if (!lastPoint || now - lastPoint.ts >= 5000) {
        list.push({
          ts: now,
          alt: ac.altBaro ?? 0,
          gs: ac.gs ?? 0,
        });
        if (list.length > 60) list.shift();
      }
    }
  }, [state.aircraft]);

  useEffect(() => {
    let active = true;
    fetch("/api/setup/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((status) => {
        if (!active) return;
        if (status && status.hasSavedConfig === false) {
          location.assign("/setup");
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // ISS pass finder.
  const [tles, setTles] = useState<Tle[]>([]);
  useEffect(() => {
    let on = true;
    fetch("/api/tle")
      .then((r) => (r.ok ? r.json() : []))
      .then((t) => on && setTles(t as Tle[]))
      .catch(() => {});
    return () => { on = false; };
  }, []);
  const nextPass = useMemo(
    () =>
      tles.length && cfg
        ? nextISSPass(Date.now(), cfg.centerLat, cfg.centerLon, tles)
        : null,
    [tles, cfg?.centerLat, cfg?.centerLon],
  );

  if (!cfg) {
    return (
      <div className="loading">
        <div className={`dot ${state.connected ? "ok" : "bad"}`} />
        {state.connected ? "Loading config…" : "Connecting to tracker…"}
      </div>
    );
  }

  const set = (patch: Partial<Config>) => conn.patchConfig(patch);
  const setField = (k: keyof ShowFields, v: boolean) =>
    conn.patchConfig({ showFields: { ...cfg.showFields, [k]: v } });

  // Close detail popup if selected aircraft disappears from feed.
  const selectedStillPresent =
    selectedAc && state.aircraft.some((a) => a.hex === selectedAc.hex);
  const activeAc = selectedStillPresent
    ? state.aircraft.find((a) => a.hex === selectedAc!.hex) ?? selectedAc
    : selectedAc;

  return (
    <div className="control">
      {/* Flight detail popup */}
      {selectedAc && (
        <FlightDetailPopup
          ac={activeAc!}
          cfg={cfg}
          history={telemetryHistory.current.get(activeAc!.hex.toLowerCase()) ?? []}
          onClose={() => setSelectedAc(null)}
          onToggleFollow={() =>
            set({
              followFlightHex:
                cfg.followFlightHex.toLowerCase() === activeAc!.hex.toLowerCase()
                  ? ""
                  : activeAc!.hex.toLowerCase(),
            })
          }
        />
      )}

      <header className="topbar">
        <div className="brand">
          <span className={`dot ${state.connected ? "ok" : "bad"}`} />
          Ceiling Tracker
        </div>
        <div className="stat">
          {state.status?.source ?? "—"} · {state.aircraft.length} overhead
        </div>
      </header>

      {cfg.followFlightHex && (
        <div className="follow-banner">
          <span>
            Following{" "}
            {state.aircraft.find((ac) => ac.hex.toLowerCase() === cfg.followFlightHex.toLowerCase())?.flight
              ?? cfg.followFlightHex.toUpperCase()}
          </span>
          <button onClick={() => set({ followFlightHex: "" })}>Stop</button>
        </div>
      )}

      {/* Closest aircraft card — always visible when aircraft are present */}
      {state.aircraft.length > 0 && (
        <div className="closest-wrap">
          <ClosestAircraftCard
            aircraft={state.aircraft}
            cfg={cfg}
            onSelect={setSelectedAc}
          />
          <NearbyAircraftList aircraft={state.aircraft} cfg={cfg} onSelect={setSelectedAc} />
        </div>
      )}

      <main>
        {/* Preset strip */}
        <div className="preset-section">
          <div className="section-title" style={{ margin: "0 0 8px 4px" }}>Presets</div>
          <PresetPicker onApply={set} />
        </div>

        <Section title="Follow flight">
          <div className="follow-search-wrap">
            <FlightSearch
              aircraft={state.aircraft}
              cfg={cfg}
              onFollow={(hex) => set({ followFlightHex: hex })}
            />
          </div>
          <Row label="Status">
            <span className={cfg.followFlightHex ? "follow-setting-active" : "follow-setting-idle"}>
              {cfg.followFlightHex
                ? `Following ${
                    state.aircraft.find(
                      (ac) => ac.hex.toLowerCase() === cfg.followFlightHex.toLowerCase(),
                    )?.flight ?? cfg.followFlightHex.toUpperCase()
                  }`
                : "Not following"}
            </span>
          </Row>
          <Row label="Moving city context" hint="grid and nearby city names">
            <Toggle
              value={cfg.showFollowContext}
              onChange={(v) => set({ showFollowContext: v })}
            />
          </Row>
          {cfg.followFlightHex && (
            <button className="follow-setting-stop" onClick={() => set({ followFlightHex: "" })}>
              Stop following and return home
            </button>
          )}
        </Section>

        <Section title="Watchlist">
          <div style={{ padding: "4px" }}>
            <input
              className="location-input"
              type="text"
              placeholder="e.g. UAL1234, N12345, A380 (comma-separated)"
              value={cfg.watchlist ?? ""}
              onChange={(e) => set({ watchlist: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%", boxSizing: "border-box" }}
            />
            <div style={{ fontSize: "10px", color: "#6b7280", marginTop: "6px", lineHeight: "1.4" }}>
              Highlights callsigns/registrations with a cyan pulse and custom synth alert chime on the display when they pass overhead.
            </div>
          </div>
        </Section>

        <Section title="Location">
          <LocationSection cfg={cfg} onPatch={set} />
        </Section>

        <Section title="Calibration">
          <Row label="Rotation" hint="align field to ceiling">
            <Slider value={cfg.rotationDeg} min={0} max={355} step={5} unit="°"
              onChange={(v) => set({ rotationDeg: v })} />
          </Row>
          <Row label="Mirror horizontally" hint="looking-up flip">
            <Toggle value={cfg.mirrorX} onChange={(v) => set({ mirrorX: v })} />
          </Row>
          <Row label="Mirror vertically">
            <Toggle value={cfg.mirrorY} onChange={(v) => set({ mirrorY: v })} />
          </Row>
          <Row label="Label rotation" hint="text only, not the map">
            <Slider value={cfg.labelRotationDeg} min={0} max={355} step={5} unit="°"
              onChange={(v) => set({ labelRotationDeg: v })} />
          </Row>
        </Section>

        <Section title="View">
          <Row label="Theme">
            <Segmented
              value={cfg.theme}
              options={[
                { value: "ambient", label: "Ambient" },
                { value: "telemetry", label: "Telemetry" },
                { value: "focus", label: "Focus" },
              ]}
              onChange={(v) => set({ theme: v })}
            />
          </Row>
          <Row label="Brightness">
            <Slider value={cfg.brightness} min={0.1} max={1} step={0.05}
              onChange={(v) => set({ brightness: v })} />
          </Row>
          <Row label="Glyph size">
            <Slider value={cfg.glyphSizePx} min={6} max={40} step={1} unit="px"
              onChange={(v) => set({ glyphSizePx: v })} />
          </Row>
          <Row label="Trail length">
            <Slider value={cfg.trailSeconds} min={0} max={120} step={5} unit="s"
              onChange={(v) => set({ trailSeconds: v })} />
          </Row>
          <Row label="Color by altitude">
            <Toggle value={cfg.altitudeColor} onChange={(v) => set({ altitudeColor: v })} />
          </Row>
        </Section>

        <Section title="Labels">
          <Row label="Density">
            <Segmented
              value={cfg.labelDensity}
              options={[
                { value: "all", label: "All" },
                { value: "nearestN", label: "Nearest N" },
                { value: "nearestOnly", label: "Nearest" },
              ]}
              onChange={(v) => set({ labelDensity: v })}
            />
          </Row>
          {cfg.labelDensity === "nearestN" && (
            <Row label="N">
              <Slider value={cfg.nearestN} min={1} max={20} step={1}
                onChange={(v) => set({ nearestN: v })} />
            </Row>
          )}
          <div className="chips">
            {(Object.keys(FIELD_LABELS) as (keyof ShowFields)[]).map((k) => (
              <button
                key={k}
                className={`chip ${cfg.showFields[k] ? "on" : ""}`}
                onClick={() => setField(k, !cfg.showFields[k])}
              >
                {FIELD_LABELS[k]}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Filters">
          <Row label="Min altitude" hint="hide ground/taxi">
            <Slider value={cfg.minAltitudeFt} min={0} max={10000} step={100} unit="ft"
              onChange={(v) => set({ minAltitudeFt: v })} />
          </Row>
          <Row label="Max altitude">
            <Slider value={cfg.maxAltitudeFt} min={1000} max={60000} step={1000} unit="ft"
              onChange={(v) => set({ maxAltitudeFt: v })} />
          </Row>
          <Row label="Hide aircraft on ground">
            <Toggle value={cfg.hideOnGround} onChange={(v) => set({ hideOnGround: v })} />
          </Row>
        </Section>

        <Section title="Motion">
          <Row label="Interpolate">
            <Toggle value={cfg.interpolate} onChange={(v) => set({ interpolate: v })} />
          </Row>
          <Row label="Smoothing" hint="0 snap · 1 slow">
            <Slider value={cfg.smoothing} min={0} max={0.9} step={0.02}
              onChange={(v) => set({ smoothing: v })} />
          </Row>
          <Row label="Max extrapolation">
            <Slider value={cfg.maxExtrapolationSec} min={0} max={15} step={1} unit="s"
              onChange={(v) => set({ maxExtrapolationSec: v })} />
          </Row>
          <Row label="Drop after" hint="legacy — overridden by memory">
            <Slider value={cfg.staleSec} min={5} max={60} step={1} unit="s"
              onChange={(v) => set({ staleSec: v })} />
          </Row>
          <Row label="Max FPS" hint="0 = uncapped">
            <Slider value={cfg.maxFps} min={0} max={120} step={5} unit="fps"
              onChange={(v) => set({ maxFps: v })} />
          </Row>
        </Section>

        <Section title="Anti-flicker memory">
          <Row label="Keep in memory" hint="hold stale aircraft">
            <Slider value={cfg.aircraftMemorySec} min={0} max={300} step={10} unit="s"
              onChange={(v) => set({ aircraftMemorySec: v })} />
          </Row>
          <Row label="Fade out over">
            <Slider value={cfg.fadeOutSec} min={5} max={120} step={5} unit="s"
              onChange={(v) => set({ fadeOutSec: v })} />
          </Row>
          <Row label="Remove after">
            <Slider value={cfg.hideOnlyAfterSec} min={30} max={600} step={10} unit="s"
              onChange={(v) => set({ hideOnlyAfterSec: v })} />
          </Row>
          <Row label="Show estimated indicator">
            <Toggle value={cfg.showStaleIndicator} onChange={(v) => set({ showStaleIndicator: v })} />
          </Row>
        </Section>

        <Section title="Overlays">
          <Row label="Range rings">
            <Toggle value={cfg.rangeRings} onChange={(v) => set({ rangeRings: v })} />
          </Row>
          <Row label="Compass">
            <Toggle value={cfg.compass} onChange={(v) => set({ compass: v })} />
          </Row>
          <Row label="Airport runways">
            <Toggle value={cfg.showAirport} onChange={(v) => set({ showAirport: v })} />
          </Row>
          <Row label="Airspace sectors">
            <Toggle value={cfg.showAirspace} onChange={(v) => set({ showAirspace: v })} />
          </Row>
          <Row label="Live weather radar">
            <Toggle value={cfg.showWeather} onChange={(v) => set({ showWeather: v })} />
          </Row>
          <Row label="Highlight emergency">
            <Toggle value={cfg.highlightEmergency} onChange={(v) => set({ highlightEmergency: v })} />
          </Row>
          <Row label="On-screen HUD (display)">
            <Toggle value={cfg.showHud} onChange={(v) => set({ showHud: v })} />
          </Row>
        </Section>

        <Section title="Sky">
          <Row label="Stars">
            <Toggle value={cfg.showStars} onChange={(v) => set({ showStars: v })} />
          </Row>
          <Row label="Sun">
            <Toggle value={cfg.showSun} onChange={(v) => set({ showSun: v })} />
          </Row>
          <Row label="Moon">
            <Toggle value={cfg.showMoon} onChange={(v) => set({ showMoon: v })} />
          </Row>
          <Row label="Satellites & ISS">
            <Toggle value={cfg.showSatellites} onChange={(v) => set({ showSatellites: v })} />
          </Row>
          <Row label="Star density">
            <Slider value={cfg.starMagLimit} min={1} max={4} step={0.1}
              onChange={(v) => set({ starMagLimit: v })} />
          </Row>
          <Row label="Sky time" hint={skyTimeLabel(cfg.skyTimeOffsetMin)}>
            <Slider value={cfg.skyTimeOffsetMin} min={-720} max={720} step={5} unit="m"
              onChange={(v) => set({ skyTimeOffsetMin: v })} />
          </Row>
          <div className="chips">
            <button
              className={`chip ${cfg.skyTimeOffsetMin === 0 ? "on" : ""}`}
              onClick={() => set({ skyTimeOffsetMin: 0 })}
            >
              Live
            </button>
            {nextPass && (
              <button
                className="chip on"
                onClick={() =>
                  set({ skyTimeOffsetMin: Math.round((nextPass - Date.now()) / 60000) })
                }
              >
                ISS pass in {fmtIn(nextPass - Date.now())} → jump
              </button>
            )}
          </div>
        </Section>

        <Section title="Window to elsewhere">
          <Row label="Destination arcs" hint="great-circle toward dest">
            <Toggle value={cfg.showDestArc} onChange={(v) => set({ showDestArc: v })} />
          </Row>
          <Row label="Local time & distance">
            <Toggle value={cfg.showRouteDetail} onChange={(v) => set({ showRouteDetail: v })} />
          </Row>
        </Section>

        <Section title="Palette">
          <div className="palette">
            <ColorRow label="Background" value={cfg.palette.bg}
              onChange={(v) => set({ palette: { ...cfg.palette, bg: v } })} />
            <ColorRow label="Glyph" value={cfg.palette.glyph}
              onChange={(v) => set({ palette: { ...cfg.palette, glyph: v } })} />
            <ColorRow label="Trail" value={cfg.palette.trail}
              onChange={(v) => set({ palette: { ...cfg.palette, trail: v } })} />
            <ColorRow label="Accent" value={cfg.palette.accent}
              onChange={(v) => set({ palette: { ...cfg.palette, accent: v } })} />
            <ColorRow label="Warn" value={cfg.palette.warn}
              onChange={(v) => set({ palette: { ...cfg.palette, warn: v } })} />
            <ColorRow label="Grid" value={cfg.palette.grid}
              onChange={(v) => set({ palette: { ...cfg.palette, grid: v } })} />
            <ColorRow label="Text" value={cfg.palette.text}
              onChange={(v) => set({ palette: { ...cfg.palette, text: v } })} />
          </div>
        </Section>


        <Section title="System">
          <button className="reset" onClick={() => location.assign("/setup")}>
            Run location setup wizard
          </button>
          <button
            className="reset"
            style={{ color: "var(--accent)" }}
            onClick={() => location.assign("/diagnostics")}
          >
            Open diagnostics
          </button>
          <button className="reset" onClick={() => conn.resetConfig()}>
            Reset all to defaults
          </button>
        </Section>
      </main>
    </div>
  );
}
