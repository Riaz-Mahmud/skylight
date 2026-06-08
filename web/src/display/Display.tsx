import { useEffect, useRef, useState, useMemo } from "react";
import { type Aircraft, type Config, type Theme, DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { loadRuntimeAirports, registerAirports, type Airport } from "./airports.js";
import { fetchNearbyAirports } from "../components/ourairports.js";
import { Renderer, type AircraftHit } from "./renderer.js";

function greatCircleMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const DEG = Math.PI / 180;
  const φ1 = lat1 * DEG;
  const φ2 = lat2 * DEG;
  const dφ = (lat2 - lat1) * DEG;
  const dλ = (lon2 - lon1) * DEG;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

// How many pixels the pointer must move before we treat it as a drag rather
// than a click for aircraft selection.
const DRAG_THRESHOLD_PX = 6;

// Inertia friction: velocity multiplied by this each frame (0.88 = ~88% kept).
// Higher = longer glide. Lower = snappier stop.
const FRICTION = 0.88;

// Minimum speed (px/frame) below which inertia stops.
const MIN_SPEED = 0.4;

// Wheel zoom: each notch changes radius by this factor.
const WHEEL_ZOOM_FACTOR = 0.92;

// Debounce for committing radius after scroll ends (ms).
const WHEEL_COMMIT_DELAY = 220;

function TelemetryGraph({ history }: { history: { ts: number; alt: number; gs: number }[] }) {
  if (history.length < 2) {
    return (
      <div className="telemetry-graph-empty">
        <span>Awaiting telemetry updates…</span>
      </div>
    );
  }

  const width = 194;
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
    <div className="telemetry-graph-wrapper">
      <svg width={width} height={height} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(155, 126, 207, 0.35)" />
            <stop offset="100%" stopColor="rgba(155, 126, 207, 0)" />
          </linearGradient>
        </defs>
        <line x1={pad} y1={height / 2} x2={width - pad} y2={height / 2} stroke="rgba(255, 255, 255, 0.05)" strokeWidth="1" />
        <path d={altAreaPath} fill="url(#altGrad)" />
        <path d={altPath} fill="none" stroke="#9B7ECF" strokeWidth="1.5" />
        <path d={speedPath} fill="none" stroke="#00FFFF" strokeWidth="1" strokeDasharray="1,1" />
      </svg>
      <div className="telemetry-legend">
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

export function Display() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  const [rendererStats, setRendererStats] = useState({ total: 0, estimated: 0, stale: 0 });
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [selectedHit, setSelectedHit] = useState<AircraftHit | null>(null);

  const [selectedAirport, setSelectedAirport] = useState<Airport | null>(null);
  const [selectedAirportPos, setSelectedAirportPos] = useState<{ x: number; y: number } | null>(null);
  const [aircraftPhoto, setAircraftPhoto] = useState<{ url: string; photographer: string; link: string } | null>(null);
  const [photoLoading, setPhotoLoading] = useState(false);
  const [airportBoardTab, setAirportBoardTab] = useState<"arrivals" | "departures">("arrivals");
  const telemetryHistory = useRef<Map<string, { ts: number; alt: number; gs: number }[]>>(new Map());

  const selectedAircraft: Aircraft | null = selectedHit
    ? state.aircraft.find(
        (ac) => ac.hex.toLowerCase() === selectedHit.aircraft.hex.toLowerCase(),
      ) ?? selectedHit.aircraft
    : null;

  // connRef lets closures in the renderer useEffect (empty deps) always reach
  // the latest conn without going stale.
  const connRef = useRef(conn);
  connRef.current = conn;

  // ── Drag / inertia state (all in refs — no re-renders needed) ───────────────
  const drag = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    movedPx: number;       // total pixels moved since mousedown (for click guard)
    velX: number;          // px/frame velocity at moment of release
    velY: number;
    lastTime: number;
  }>({
    active: false, startX: 0, startY: 0, lastX: 0, lastY: 0,
    movedPx: 0, velX: 0, velY: 0, lastTime: 0,
  });

  // Inertia rAF handle.
  const inertiaRaf = useRef(0);

  // ── Wheel / zoom state ──────────────────────────────────────────────────────
  // We accumulate radius changes locally and commit after scrolling stops.
  const wheelRadius = useRef<number | null>(null);   // null = use config value
  const wheelTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Renderer setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;
    void loadRuntimeAirports();
    let r: Renderer;
    try {
      r = new Renderer(canvasRef.current, () => {
        // While zooming via wheel, override radiusMiles with the local value
        // so the renderer reflects changes before the debounce commits them.
        if (wheelRadius.current !== null) {
          return { ...configRef.current, radiusMiles: wheelRadius.current };
        }
        return configRef.current;
      });
    } catch (err) {
      setRendererError(err instanceof Error ? err.message : "Renderer failed to start");
      return;
    }
    rendererRef.current = r;
    r.start();

    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);

    // Unlock Web Audio on the first user gesture so alert sounds can play.
    const unlockAudio = () => r.initAudio();
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown",     unlockAudio, { once: true });

    // ── Mouse wheel zoom — attached here where canvas is guaranteed valid ──
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();

      // Current radius: use local accumulator if already mid-scroll, else config.
      const base = wheelRadius.current ?? configRef.current.radiusMiles;

      // Normalise delta across deltaMode values.
      let delta = e.deltaY;
      if (e.deltaMode === 1) delta *= 18;   // line mode  → pixel approx
      if (e.deltaMode === 2) delta *= 300;  // page mode  → pixel approx

      // Each 100 px of scroll = one zoom step.
      const steps  = delta / 100;
      const factor = Math.pow(WHEEL_ZOOM_FACTOR, steps);
      const next   = Math.max(0.5, Math.min(250, base * factor));

      wheelRadius.current = next;

      // Debounce the config commit so we don't flood the server mid-scroll.
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = setTimeout(() => {
        if (wheelRadius.current !== null) {
          const rounded = Math.round(wheelRadius.current * 10) / 10;
          connRef.current?.patchConfig({ radiusMiles: rounded });
          wheelRadius.current = null;
        }
        wheelTimer.current = null;
      }, WHEEL_COMMIT_DELAY);
    };

    // Use window so the event fires even if the canvas doesn't have focus,
    // and add { passive: false } so we can call preventDefault().
    window.addEventListener("wheel", onWheel, { passive: false });

    const statsInterval = setInterval(() => {
      if (configRef.current.showHud) setRendererStats(r.getStats());
    }, 2000);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", onWheel);
      clearInterval(statsInterval);
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // Feed aircraft snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Self-tune render delay from server poll cadence.
  useEffect(() => {
    const pollMs = state.status?.pollMs;
    if (pollMs && pollMs > 0) rendererRef.current?.setPollMs(pollMs);
  }, [state.status?.pollMs]);

  // Automatically fetch and register nearby airports when the center or radius changes.
  useEffect(() => {
    if (!state.config) return;
    const { centerLat, centerLon, radiusMiles } = state.config;
    let active = true;

    const fetchRadius = Math.max(150, radiusMiles);
    fetchNearbyAirports(centerLat, centerLon, fetchRadius)
      .then((airports) => {
        if (active && airports.length > 0) {
          registerAirports(airports);
        }
      })
      .catch((err) => {
        console.error("Failed to dynamically load nearby airports:", err);
      });

    return () => {
      active = false;
    };
  }, [state.config?.centerLat, state.config?.centerLon, state.config?.radiusMiles]);


  // Track telemetry history (altitude & speed profile) for visible planes
  useEffect(() => {
    const history = telemetryHistory.current;
    const currentHexes = new Set(state.aircraft.map((ac) => ac.hex.toLowerCase()));

    // Prune gone aircraft
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

  // Keep popover anchor live while aircraft is selected.
  useEffect(() => {
    if (!selectedHit) return;
    let raf = 0;
    const tick = () => {
      const hit = rendererRef.current?.getAircraftHit(selectedHit.aircraft.hex) ?? null;
      setSelectedHit((cur) => {
        if (!cur || !hit) return cur;
        if (Math.abs(cur.x - hit.x) < 0.5 && Math.abs(cur.y - hit.y) < 0.5) return cur;
        return hit;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedHit?.aircraft.hex]);

  // Keep airport popover anchor live
  useEffect(() => {
    if (!selectedAirport) {
      setSelectedAirportPos(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      const pos = rendererRef.current?.getAirportScreenPos(selectedAirport.icao) ?? null;
      setSelectedAirportPos((cur) => {
        if (!pos) return null;
        if (cur && Math.abs(cur.x - pos.x) < 0.5 && Math.abs(cur.y - pos.y) < 0.5) return cur;
        return pos;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedAirport?.icao]);

  // Planespotters photo fetch
  useEffect(() => {
    if (!selectedAircraft) {
      setAircraftPhoto(null);
      setPhotoLoading(false);
      return;
    }
    setPhotoLoading(true);
    setAircraftPhoto(null);

    const reg = selectedAircraft.registration?.trim();
    const hex = selectedAircraft.hex.trim();
    const fetchUrl = reg
      ? `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`
      : `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(hex)}`;

    let active = true;
    fetch(fetchUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        if (data && data.photos && data.photos.length > 0) {
          const photo = data.photos[0];
          setAircraftPhoto({
            url: photo.thumbnail_large.src,
            photographer: photo.photographer,
            link: photo.link,
          });
        } else {
          setAircraftPhoto(null);
        }
      })
      .catch((err) => {
        console.error("Photo fetch failed:", err);
        if (active) setAircraftPhoto(null);
      })
      .finally(() => {
        if (active) setPhotoLoading(false);
      });

    return () => {
      active = false;
    };
  }, [selectedAircraft?.hex, selectedAircraft?.registration]);

  // ── Inertia loop ────────────────────────────────────────────────────────────
  const stopInertia = () => {
    cancelAnimationFrame(inertiaRaf.current);
    inertiaRaf.current = 0;
  };

  const startInertia = () => {
    stopInertia();
    const r = rendererRef.current;
    if (!r) return;

    const tick = () => {
      const d = drag.current;
      const speed = Math.hypot(d.velX, d.velY);
      if (speed < MIN_SPEED) {
        // Commit the final position.
        const { centerLat, centerLon } = r.getPannedCenter();
        connRef.current.patchConfig({ centerLat, centerLon });
        r.resetPan();
        canvasRef.current?.classList.remove("dragging");
        return;
      }
      r.applyPanDelta(d.velX, d.velY);
      d.velX *= FRICTION;
      d.velY *= FRICTION;
      inertiaRaf.current = requestAnimationFrame(tick);
    };

    inertiaRaf.current = requestAnimationFrame(tick);
  };

  // ── Mouse handlers (attached to window to capture outside-canvas releases) ──
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;  // left button only
      stopInertia();
      rendererRef.current?.resetPan();
      const d = drag.current;
      d.active   = true;
      d.startX   = e.clientX;
      d.startY   = e.clientY;
      d.lastX    = e.clientX;
      d.lastY    = e.clientY;
      d.movedPx  = 0;
      d.velX     = 0;
      d.velY     = 0;
      d.lastTime = performance.now();
    };

    const onMouseMove = (e: MouseEvent) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      d.movedPx += Math.hypot(dx, dy);

      const now = performance.now();
      const dt  = Math.max(1, now - d.lastTime);
      // Exponential smoothing on velocity (stable even when dt varies).
      const alpha = Math.min(1, dt / 16);
      d.velX = d.velX * (1 - alpha) + (dx / dt * 16) * alpha;
      d.velY = d.velY * (1 - alpha) + (dy / dt * 16) * alpha;
      d.lastTime = now;

      rendererRef.current?.applyPanDelta(dx, dy);

      if (d.movedPx > DRAG_THRESHOLD_PX) canvasRef.current?.classList.add("dragging");
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const d = drag.current;
      if (!d.active) return;
      d.active = false;

      if (d.movedPx <= DRAG_THRESHOLD_PX) {
        // It was a click — do aircraft and airport hit test.
        rendererRef.current?.resetPan();
        canvasRef.current?.classList.remove("dragging");
        
        const acHit = rendererRef.current?.hitTest(e.clientX, e.clientY) ?? null;
        if (acHit) {
          setSelectedHit(acHit);
          setSelectedAirport(null);
        } else {
          const apHit = rendererRef.current?.hitTestAirport(e.clientX, e.clientY) ?? null;
          setSelectedAirport(apHit);
          setSelectedHit(null);
        }
        return;
      }

      // It was a real drag — launch inertia.
      startInertia();
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  }, []);

  // ── Touch handlers ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    // Pinch state — tracked separately from the pan drag.
    let pinchDist = 0; // initial finger separation

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        // Two fingers: start a pinch-to-zoom gesture.
        stopInertia();
        rendererRef.current?.resetPan();
        drag.current.active = false;
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        pinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        return;
      }
      if (e.touches.length !== 1) return;
      stopInertia();
      rendererRef.current?.resetPan();
      const t = e.touches[0];
      const d = drag.current;
      d.active   = true;
      d.startX   = t.clientX;
      d.startY   = t.clientY;
      d.lastX    = t.clientX;
      d.lastY    = t.clientY;
      d.movedPx  = 0;
      d.velX     = 0;
      d.velY     = 0;
      d.lastTime = performance.now();
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t0 = e.touches[0];
        const t1 = e.touches[1];
        const newDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        if (pinchDist > 0) {
          const scale = pinchDist / newDist; // >1 = fingers closer = zoom in
          const base = wheelRadius.current ?? configRef.current.radiusMiles;
          const next = Math.max(0.5, Math.min(250, base * scale));
          wheelRadius.current = next;
          if (wheelTimer.current) clearTimeout(wheelTimer.current);
          wheelTimer.current = setTimeout(() => {
            if (wheelRadius.current !== null) {
              const rounded = Math.round(wheelRadius.current * 10) / 10;
              connRef.current?.patchConfig({ radiusMiles: rounded });
              wheelRadius.current = null;
            }
            wheelTimer.current = null;
          }, WHEEL_COMMIT_DELAY);
        }
        pinchDist = newDist;
        return;
      }
      if (e.touches.length !== 1) return;
      const d = drag.current;
      if (!d.active) return;
      e.preventDefault();
      const t  = e.touches[0];
      const dx = t.clientX - d.lastX;
      const dy = t.clientY - d.lastY;
      d.lastX = t.clientX;
      d.lastY = t.clientY;
      d.movedPx += Math.hypot(dx, dy);

      const now  = performance.now();
      const dt   = Math.max(1, now - d.lastTime);
      const alpha = Math.min(1, dt / 16);
      d.velX = d.velX * (1 - alpha) + (dx / dt * 16) * alpha;
      d.velY = d.velY * (1 - alpha) + (dy / dt * 16) * alpha;
      d.lastTime = now;

      rendererRef.current?.applyPanDelta(dx, dy);
      if (d.movedPx > DRAG_THRESHOLD_PX) canvasRef.current?.classList.add("dragging");
    };

    const onTouchEnd = (e: TouchEvent) => {
      pinchDist = 0;
      const d = drag.current;
      if (!d.active) return;
      d.active = false;

      if (d.movedPx <= DRAG_THRESHOLD_PX) {
        rendererRef.current?.resetPan();
        canvasRef.current?.classList.remove("dragging");
        if (e.changedTouches.length) {
          const t = e.changedTouches[0];
          const acHit = rendererRef.current?.hitTest(t.clientX, t.clientY) ?? null;
          if (acHit) {
            setSelectedHit(acHit);
            setSelectedAirport(null);
          } else {
            const apHit = rendererRef.current?.hitTestAirport(t.clientX, t.clientY) ?? null;
            setSelectedAirport(apHit);
            setSelectedHit(null);
          }
        }
        return;
      }

      startInertia();
    };

    el.addEventListener("touchstart",  onTouchStart, { passive: true });
    el.addEventListener("touchmove",   onTouchMove,  { passive: false });
    el.addEventListener("touchend",    onTouchEnd,   { passive: true });
    el.addEventListener("touchcancel", onTouchEnd,   { passive: true });
    return () => {
      el.removeEventListener("touchstart",  onTouchStart);
      el.removeEventListener("touchmove",   onTouchMove);
      el.removeEventListener("touchend",    onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "Escape":
          stopInertia();
          rendererRef.current?.resetPan();
          canvasRef.current?.classList.remove("dragging");
          setSelectedHit(null);
          setSelectedAirport(null);
          break;
        case "r":
          connRef.current.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          connRef.current.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "0":
          connRef.current.patchConfig({ rotationDeg: 0 });
          break;
        case "v":
          connRef.current.patchConfig({ showSpeedVectors: !c.showSpeedVectors });
          break;
        case "m":
          connRef.current.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          connRef.current.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          connRef.current.patchConfig({ theme: next });
          break;
        }
        case "[":
          connRef.current.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          connRef.current.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          connRef.current.patchConfig({ showHud: !c.showHud });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────
  const cfg = state.config;

  // selectedAircraft moved to top of component

  const following =
    !!selectedAircraft &&
    cfg?.followFlightHex.toLowerCase() === selectedAircraft.hex.toLowerCase();

  const actions =
    selectedAircraft && cfg
      ? [
          {
            id: "follow",
            label: following ? "Stop following" : "Follow this flight",
            primary: true,
            run: () =>
              conn.patchConfig({
                followFlightHex: following ? "" : selectedAircraft.hex.toLowerCase(),
              }),
          },
          {
            id: "close",
            label: "Close",
            primary: false,
            run: () => setSelectedHit(null),
          },
        ]
      : [];

  // Arrivals & Departures board matching
  const arrivals = useMemo(() => {
    if (!selectedAirport) return [];
    return state.aircraft
      .filter(
        (ac) =>
          ac.lat != null &&
          ac.lon != null &&
          (ac.destination?.toUpperCase() === selectedAirport.icao.toUpperCase() ||
            ac.destination?.toUpperCase() === selectedAirport.name.toUpperCase()),
      )
      .map((ac) => ({
        ac,
        dist: greatCircleMiles(ac.lat!, ac.lon!, selectedAirport.lat, selectedAirport.lon),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);
  }, [state.aircraft, selectedAirport]);

  const departures = useMemo(() => {
    if (!selectedAirport) return [];
    return state.aircraft
      .filter(
        (ac) =>
          ac.lat != null &&
          ac.lon != null &&
          (ac.origin?.toUpperCase() === selectedAirport.icao.toUpperCase() ||
            ac.origin?.toUpperCase() === selectedAirport.name.toUpperCase()),
      )
      .map((ac) => ({
        ac,
        dist: greatCircleMiles(ac.lat!, ac.lon!, selectedAirport.lat, selectedAirport.lon),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);
  }, [state.aircraft, selectedAirport]);

  const centerOnAirport = () => {
    if (!selectedAirport) return;
    conn.patchConfig({ centerLat: selectedAirport.lat, centerLon: selectedAirport.lon });
  };

  // Emergency & Watchlist alerts scanning
  const emergencyPlanes = useMemo(() => {
    if (!cfg?.highlightEmergency) return [];
    return state.aircraft.filter((ac) => ac.squawk && ["7500", "7600", "7700"].includes(ac.squawk));
  }, [state.aircraft, cfg?.highlightEmergency]);

  const watchlistPlanes = useMemo(() => {
    if (!cfg?.watchlist) return [];
    const items = cfg.watchlist.toUpperCase().split(",").map((i) => i.trim()).filter(Boolean);
    if (items.length === 0) return [];
    return state.aircraft.filter((ac) => {
      const reg = (ac.registration ?? "").toUpperCase().trim();
      const call = (ac.flight ?? "").toUpperCase().trim();
      return items.some((item) => reg === item || call === item || reg.startsWith(item) || call.startsWith(item));
    });
  }, [state.aircraft, cfg?.watchlist]);

  return (
    <div className="display-root">
      <canvas
        ref={canvasRef}
        className="display-canvas"
      />

      {cfg?.followFlightHex && (
        <>
          <div className="follow-status">
            <span>TRACKING</span>
            {state.aircraft.find(
              (ac) => ac.hex.toLowerCase() === cfg.followFlightHex.toLowerCase(),
            )?.flight ?? cfg.followFlightHex.toUpperCase()}
          </div>
        </>
      )}

      {(emergencyPlanes.length > 0 || watchlistPlanes.length > 0) && (
        <div className={`alert-banner ${emergencyPlanes.length > 0 ? "emergency" : "watchlist"}`}>
          {emergencyPlanes.length > 0 ? (
            <span>
              🚨 EMERGENCY ALERT: {emergencyPlanes.map(ac => `${ac.flight ?? ac.hex.toUpperCase()} (Squawk ${ac.squawk})`).join(", ")}
            </span>
          ) : (
            <span>
              ★ WATCHLIST SIGHTING: {watchlistPlanes.map(ac => `${ac.flight ?? ac.hex.toUpperCase()} (${ac.registration ?? "No Reg"})`).join(", ")}
            </span>
          )}
        </div>
      )}

      {selectedHit && selectedAircraft && (
        <div
          className="aircraft-action-popover"
          style={{
            left: Math.max(12, Math.min(selectedHit.x, window.innerWidth - 232)),
            top:  Math.max(12, Math.min(selectedHit.y + 28, window.innerHeight - 380)),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="aircraft-action-kicker">Selected aircraft</div>
          <div className="aircraft-action-flight">
            {selectedAircraft.flight ?? selectedAircraft.hex.toUpperCase()}
          </div>
          <div className="aircraft-action-meta">
            {[
              selectedAircraft.typeName ?? selectedAircraft.typeCode,
              selectedAircraft.altBaro != null
                ? `${selectedAircraft.altBaro.toLocaleString("en-US")} ft`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>

          {photoLoading && (
            <div className="aircraft-photo-skeleton">
              <div className="skeleton-pulse" />
            </div>
          )}
          {!photoLoading && aircraftPhoto && (
            <div className="aircraft-photo-container">
              <img src={aircraftPhoto.url} alt="Aircraft" />
              <div className="aircraft-photo-credit">© {aircraftPhoto.photographer}</div>
            </div>
          )}

          <TelemetryGraph history={telemetryHistory.current.get(selectedAircraft.hex.toLowerCase()) ?? []} />

          <div className="aircraft-action-buttons">
            {actions.map((action) => (
              <button
                key={action.id}
                className={action.primary ? "primary" : ""}
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedAirport && selectedAirportPos && (
        <div
          className="airport-action-popover"
          style={{
            left: Math.max(12, Math.min(selectedAirportPos.x, window.innerWidth - 292)),
            top:  Math.max(12, Math.min(selectedAirportPos.y + 28, window.innerHeight - 380)),
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="airport-action-kicker">Selected airport</div>
          <div className="airport-action-name">{selectedAirport.fullName ?? selectedAirport.name}</div>
          <div className="airport-action-codes">{selectedAirport.icao} · IATA: {selectedAirport.name}</div>
          
          <div className="airport-action-info-grid">
            <div>
              <span className="info-label">Elevation:</span>
              <span className="info-val">{selectedAirport.elevationFt} ft</span>
            </div>
            <div>
              <span className="info-label">Runways:</span>
              <span className="info-val">{selectedAirport.runways.map(r => r.leIdent).join(", ") || "None"}</span>
            </div>
          </div>

          <div className="airport-board">
            <div className="airport-board-tabs">
              <button
                className={airportBoardTab === "arrivals" ? "active" : ""}
                onClick={() => setAirportBoardTab("arrivals")}
              >
                Arrivals ({arrivals.length})
              </button>
              <button
                className={airportBoardTab === "departures" ? "active" : ""}
                onClick={() => setAirportBoardTab("departures")}
              >
                Departures ({departures.length})
              </button>
            </div>
            <div className="airport-board-list">
              {airportBoardTab === "arrivals" ? (
                arrivals.length === 0 ? (
                  <div className="board-empty">No active arrivals</div>
                ) : (
                  arrivals.map(({ ac, dist }) => (
                    <div key={ac.hex} className="board-item">
                      <span className="board-flight">{ac.flight ?? ac.hex.toUpperCase()}</span>
                      <span className="board-route">{ac.origin ?? "???"} ➔ {selectedAirport.name}</span>
                      <span className="board-meta">{Math.round(dist)} mi · {ac.altBaro != null ? `${ac.altBaro.toLocaleString()} ft` : "GND"}</span>
                    </div>
                  ))
                )
              ) : (
                departures.length === 0 ? (
                  <div className="board-empty">No active departures</div>
                ) : (
                  departures.map(({ ac, dist }) => (
                    <div key={ac.hex} className="board-item">
                      <span className="board-flight">{ac.flight ?? ac.hex.toUpperCase()}</span>
                      <span className="board-route">{selectedAirport.name} ➔ {ac.destination ?? "???"}</span>
                      <span className="board-meta">{Math.round(dist)} mi · {ac.altBaro != null ? `${ac.altBaro.toLocaleString()} ft` : "GND"}</span>
                    </div>
                  ))
                )
              )}
            </div>
          </div>

          <div className="airport-action-buttons">
            <button className="primary" onClick={centerOnAirport}>
              Center Map Here
            </button>
            <button onClick={() => setSelectedAirport(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {rendererError && (
        <div className="reconnect">display error: {rendererError}</div>
      )}

      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {cfg.radiusMiles}mi · {cfg.theme}
            {rendererStats.estimated > 0 && ` · ${rendererStats.estimated} est`}
            {rendererStats.stale > 0 && ` · ${rendererStats.stale} stale`}
            {cfg.followFlightHex &&
              ` · following ${cfg.followFlightHex.toUpperCase()}`}
          </span>
        </div>
      )}

      {!state.connected && (
        <div className="reconnect">connecting…</div>
      )}
    </div>
  );
}
