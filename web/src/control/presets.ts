// Display presets — opinionated bundles of config values for common scenarios.
// Applying a preset overwrites only the fields it defines; calibration
// (rotation, mirror, location) is intentionally left untouched.

import type { Config } from "@shared/index.js";

export interface Preset {
  id: string;
  label: string;
  description: string;
  patch: Partial<Config>;
}

export const PRESETS: Preset[] = [
  {
    id: "home",
    label: "Home",
    description: "Ceiling display over a house — nearby traffic, clean labels",
    patch: {
      radiusMiles: 5,
      hideOnGround: true,
      minAltitudeFt: 500,
      maxAltitudeFt: 60000,
      theme: "focus",
      labelDensity: "nearestN",
      nearestN: 5,
      trailSeconds: 60,
      altitudeColor: true,
      rangeRings: true,
      compass: true,
      showAirport: true,
      showDestArc: true,
      showRouteDetail: true,
      aircraftMemorySec: 120,
      fadeOutSec: 30,
      hideOnlyAfterSec: 180,
      showStaleIndicator: true,
      staleSec: 30,
    },
  },
  {
    id: "airport",
    label: "Airport",
    description: "Near a busy airport — wide radius, high label density",
    patch: {
      radiusMiles: 15,
      hideOnGround: false,
      minAltitudeFt: 0,
      maxAltitudeFt: 60000,
      theme: "telemetry",
      labelDensity: "nearestN",
      nearestN: 10,
      trailSeconds: 45,
      altitudeColor: true,
      rangeRings: true,
      compass: true,
      showAirport: true,
      showDestArc: true,
      showRouteDetail: true,
      aircraftMemorySec: 120,
      fadeOutSec: 30,
      hideOnlyAfterSec: 180,
      showStaleIndicator: true,
      staleSec: 30,
    },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Clean projector look — glyphs and trails only",
    patch: {
      radiusMiles: 8,
      hideOnGround: true,
      minAltitudeFt: 1000,
      maxAltitudeFt: 60000,
      theme: "ambient",
      labelDensity: "nearestOnly",
      nearestN: 1,
      trailSeconds: 30,
      altitudeColor: false,
      rangeRings: false,
      compass: false,
      showAirport: false,
      showDestArc: false,
      showRouteDetail: false,
      showHud: false,
      showStaleIndicator: false,
      staleSec: 20,
    },
  },
  {
    id: "debug",
    label: "Debug",
    description: "All labels, HUD, long memory — for troubleshooting",
    patch: {
      radiusMiles: 10,
      hideOnGround: false,
      minAltitudeFt: 0,
      maxAltitudeFt: 60000,
      theme: "telemetry",
      labelDensity: "all",
      nearestN: 20,
      trailSeconds: 90,
      altitudeColor: true,
      rangeRings: true,
      compass: true,
      showAirport: true,
      showHud: true,
      showDestArc: true,
      showRouteDetail: true,
      aircraftMemorySec: 300,
      fadeOutSec: 60,
      hideOnlyAfterSec: 600,
      showStaleIndicator: true,
      staleSec: 60,
    },
  },
];
