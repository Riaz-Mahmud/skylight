import { DEFAULT_CONFIG, type Config } from "./config.js";

export interface ConfigValidation {
  patch: Partial<Config>;
  errors: string[];
}

const ranges: Partial<Record<keyof Config, [number, number]>> = {
  centerLat: [-90, 90],
  centerLon: [-180, 180],
  radiusMiles: [0.1, 200],
  rotationDeg: [-360, 360],
  labelRotationDeg: [-360, 360],
  minAltitudeFt: [-2000, 100000],
  maxAltitudeFt: [-2000, 100000],
  maxExtrapolationSec: [0, 120],
  staleSec: [0, 3600],
  smoothing: [0, 0.99],
  maxFps: [0, 240],
  aircraftMemorySec: [0, 3600],
  fadeOutSec: [0, 3600],
  hideOnlyAfterSec: [0, 7200],
  glyphSizePx: [1, 200],
  trailSeconds: [0, 3600],
  brightness: [0, 1],
  nearestN: [1, 500],
  starMagLimit: [-2, 12],
  skyTimeOffsetMin: [-525600, 525600],
};

function validateObject(
  input: unknown,
  template: Record<string, unknown>,
  path: string,
  errors: string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    errors.push(`${path || "config"} must be an object`);
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const expected = template[key];
    const field = path ? `${path}.${key}` : key;
    if (expected === undefined) {
      errors.push(`${field} is not a recognized config field`);
      continue;
    }
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      result[key] = validateObject(value, expected as Record<string, unknown>, field, errors);
      continue;
    }
    if (typeof value !== typeof expected) {
      errors.push(`${field} must be a ${typeof expected}`);
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      errors.push(`${field} must be finite`);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function validateConfigPatch(input: unknown): ConfigValidation {
  const errors: string[] = [];
  const patch = validateObject(
    input,
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    "",
    errors,
  ) as Partial<Config>;

  for (const [key, range] of Object.entries(ranges) as [keyof Config, [number, number]][]) {
    const value = patch[key];
    if (typeof value !== "number") continue;
    if (value < range[0] || value > range[1]) {
      errors.push(`${key} must be in range [${range[0]}, ${range[1]}]`);
      delete patch[key];
    }
  }
  if (patch.theme && !["ambient", "telemetry", "focus"].includes(patch.theme)) {
    errors.push("theme is invalid");
    delete patch.theme;
  }
  if (patch.labelDensity && !["all", "nearestN", "nearestOnly"].includes(patch.labelDensity)) {
    errors.push("labelDensity is invalid");
    delete patch.labelDensity;
  }
  return { patch, errors };
}
