import { useEffect, useRef, useState } from "react";
import type { Aircraft, Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { loadRuntimeAirports } from "./airports.js";
import { Renderer, type AircraftHit } from "./renderer.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

export function Display() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const [rendererStats, setRendererStats] = useState({ total: 0, estimated: 0, stale: 0 });
  const [rendererError, setRendererError] = useState<string | null>(null);
  const [selectedHit, setSelectedHit] = useState<AircraftHit | null>(null);

  // Keep the latest config in a ref so the RAF loop always reads fresh values.
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Create renderer once.
  useEffect(() => {
    if (!canvasRef.current) return;
    void loadRuntimeAirports();
    let r: Renderer;
    try {
      r = new Renderer(canvasRef.current, () => configRef.current);
    } catch (error) {
      setRendererError(error instanceof Error ? error.message : "Renderer failed to start");
      return;
    }
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    // Poll renderer stats for HUD display every 2s.
    const statsInterval = setInterval(() => {
      if (configRef.current.showHud) setRendererStats(r.getStats());
    }, 2000);
    return () => {
      window.removeEventListener("resize", onResize);
      clearInterval(statsInterval);
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // Feed snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  useEffect(() => {
    if (!selectedHit) return;
    let raf = 0;
    const updateAnchor = () => {
      const hit = rendererRef.current?.getAircraftHit(selectedHit.aircraft.hex) ?? null;
      setSelectedHit((current) => {
        if (!current || !hit) return current;
        if (Math.abs(current.x - hit.x) < 0.5 && Math.abs(current.y - hit.y) < 0.5) return current;
        return hit;
      });
      raf = requestAnimationFrame(updateAnchor);
    };
    raf = requestAnimationFrame(updateAnchor);
    return () => cancelAnimationFrame(raf);
  }, [selectedHit?.aircraft.hex]);

  // Keyboard calibration (handy when a keyboard is plugged into the Pi).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r":
          conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "m":
          conn.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          conn.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const cfg = state.config;
  const selectedAircraft: Aircraft | null = selectedHit
    ? state.aircraft.find((ac) => ac.hex.toLowerCase() === selectedHit.aircraft.hex.toLowerCase())
      ?? selectedHit.aircraft
    : null;
  const following = !!selectedAircraft
    && cfg?.followFlightHex.toLowerCase() === selectedAircraft.hex.toLowerCase();
  const actions = selectedAircraft && cfg
    ? [
        {
          id: "follow",
          label: following ? "Stop following" : "Follow this flight",
          primary: true,
          run: () => conn.patchConfig({ followFlightHex: following ? "" : selectedAircraft.hex.toLowerCase() }),
        },
        {
          id: "close",
          label: "Close",
          primary: false,
          run: () => setSelectedHit(null),
        },
      ]
    : [];

  return (
    <div className="display-root">
      <canvas
        ref={canvasRef}
        className="display-canvas"
        onClick={(event) => setSelectedHit(rendererRef.current?.hitTest(event.clientX, event.clientY) ?? null)}
      />
      {cfg?.followFlightHex && (
        <>
          <div className="follow-reticle" aria-hidden="true" />
          <div className="follow-status">
            <span>TRACKING</span>
            {state.aircraft.find((ac) => ac.hex.toLowerCase() === cfg.followFlightHex.toLowerCase())?.flight
              ?? cfg.followFlightHex.toUpperCase()}
          </div>
        </>
      )}
      {selectedHit && selectedAircraft && (
        <div
          className="aircraft-action-popover"
          style={{
            left: Math.max(12, Math.min(selectedHit.x, window.innerWidth - 232)),
            top: Math.max(12, Math.min(selectedHit.y + 28, window.innerHeight - 210)),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="aircraft-action-kicker">Selected aircraft</div>
          <div className="aircraft-action-flight">{selectedAircraft.flight ?? selectedAircraft.hex.toUpperCase()}</div>
          <div className="aircraft-action-meta">
            {[selectedAircraft.typeName ?? selectedAircraft.typeCode, selectedAircraft.altBaro != null
              ? `${selectedAircraft.altBaro.toLocaleString("en-US")} ft`
              : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
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
      {rendererError && <div className="reconnect">display error: {rendererError}</div>}
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {cfg.radiusMiles}mi · {cfg.theme}
            {rendererStats.estimated > 0 && ` · ${rendererStats.estimated} est`}
            {rendererStats.stale > 0 && ` · ${rendererStats.stale} stale`}
            {cfg.followFlightHex && ` · following ${cfg.followFlightHex.toUpperCase()}`}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
    </div>
  );
}
