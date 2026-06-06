import { useEffect, useMemo, useState } from "react";
import type { Aircraft, Config, ShowFields } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { nextISSPass, type Tle } from "../display/celestial.js";
import { ColorRow, Row, Section, Segmented, Slider, Toggle } from "./components.js";
import { PRESETS } from "./presets.js";
import { LOCATION_PRESETS } from "./locationPresets.js";

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

/** Full-screen flight detail popup. */
function FlightDetailPopup({
  ac,
  cfg,
  onClose,
}: {
  ac: Aircraft;
  cfg: Config;
  onClose: () => void;
}) {
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
          {rows.map(([label, value]) => (
            <div key={label} className="popup-row">
              <span className="popup-label">{label}</span>
              <span className="popup-value">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Location preset picker — airport quick-pick chips + manual lat/lon inputs. */
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

  // Keep local inputs in sync when config changes from elsewhere.
  useEffect(() => {
    setLat(String(cfg.centerLat));
    setLon(String(cfg.centerLon));
    setDirty(false);
  }, [cfg.centerLat, cfg.centerLon]);

  const applyLocation = (newLat: number, newLon: number, newRadius?: number) => {
    const patch: Partial<Config> = { centerLat: newLat, centerLon: newLon };
    if (newRadius != null) patch.radiusMiles = newRadius;
    onPatch(patch);
  };

  const commitManual = () => {
    const parsedLat = parseFloat(lat);
    const parsedLon = parseFloat(lon);
    if (!isFinite(parsedLat) || !isFinite(parsedLon)) return;
    if (parsedLat < -90 || parsedLat > 90) return;
    if (parsedLon < -180 || parsedLon > 180) return;
    applyLocation(parsedLat, parsedLon);
    setDirty(false);
  };

  return (
    <>
      <Row label="Radius">
        <Slider
          value={cfg.radiusMiles}
          min={0.5}
          max={50}
          step={0.5}
          unit="mi"
          onChange={(v) => onPatch({ radiusMiles: v })}
        />
      </Row>

      {/* Airport quick-picks */}
      <div className="location-airports">
        <span className="location-airports-label">Airport quick-pick</span>
        <div className="location-chips">
          {LOCATION_PRESETS.map((lp) => {
            const active =
              Math.abs(cfg.centerLat - lp.lat) < 0.01 &&
              Math.abs(cfg.centerLon - lp.lon) < 0.01;
            return (
              <button
                key={lp.code}
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
          <input
            className="location-input"
            type="number"
            step="0.0001"
            min="-90"
            max="90"
            value={lat}
            onChange={(e) => { setLat(e.target.value); setDirty(true); }}
            onBlur={commitManual}
            onKeyDown={(e) => e.key === "Enter" && commitManual()}
          />
        </div>
        <div className="location-field">
          <label className="location-field-label">Longitude</label>
          <input
            className="location-input"
            type="number"
            step="0.0001"
            min="-180"
            max="180"
            value={lon}
            onChange={(e) => { setLon(e.target.value); setDirty(true); }}
            onBlur={commitManual}
            onKeyDown={(e) => e.key === "Enter" && commitManual()}
          />
        </div>
        {dirty && (
          <button className="location-apply" onClick={commitManual}>
            Apply
          </button>
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
          onClose={() => setSelectedAc(null)}
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

      {/* Closest aircraft card — always visible when aircraft are present */}
      {state.aircraft.length > 0 && (
        <div className="closest-wrap">
          <ClosestAircraftCard
            aircraft={state.aircraft}
            cfg={cfg}
            onSelect={setSelectedAc}
          />
        </div>
      )}

      <main>
        {/* Preset strip */}
        <div className="preset-section">
          <div className="section-title" style={{ margin: "0 0 8px 4px" }}>Presets</div>
          <PresetPicker onApply={set} />
        </div>

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
