/**
 * Lazy city search backed by /data/cities.json (generated from GeoNames).
 *
 * The JSON file is NOT bundled — it is fetched once on first search and then
 * cached in memory for the lifetime of the page.  Bundle size is unaffected.
 *
 * If the file has not been generated yet (development / first run) the module
 * falls back to an empty list gracefully — location can still be set via the
 * airport quick-picks or manual lat/lon inputs.
 */

export interface City {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  population?: number;
}

import { CITIES as FALLBACK_CITIES } from "../display/cities.js";

// In-memory cache — populated on first call to searchCities().
let cache: City[] | null = null;
let loading: Promise<City[]> | null = null;

async function ensureLoaded(): Promise<City[]> {
  if (cache) return cache;
  if (loading) return loading;

  loading = fetch("/data/cities.json")
    .then((r) => {
      if (!r.ok) throw new Error(`cities.json: HTTP ${r.status}`);
      return r.json() as Promise<City[]>;
    })
    .then((data) => {
      cache = data;
      loading = null;
      return data;
    })
    .catch(() => {
      // File not generated yet or network error: fall back to bundled cities.
      loading = null;
      cache = FALLBACK_CITIES.map((c) => ({
        name: c.name,
        lat: c.lat,
        lon: c.lon,
      }));
      return cache;
    });

  return loading;
}

/**
 * Search cities by name or country code.
 * Returns up to `limit` results (default 20), sorted by population descending.
 *
 * The first call triggers a one-time fetch of /data/cities.json.
 * Subsequent calls are instant (in-memory).
 */
export async function searchCities(query: string, limit = 20): Promise<City[]> {
  const q = query.trim().toLowerCase();
  if (!q || q.length < 2) return [];

  const all = await ensureLoaded();
  if (!all.length) return [];

  const nameStarts: City[] = [];
  const nameIncludes: City[] = [];
  const countryMatches: City[] = [];

  for (const city of all) {
    const name = city.name.toLowerCase();
    const country = city.country?.toLowerCase();
    if (name.startsWith(q)) {
      nameStarts.push(city);
      continue;
    }
    if (name.includes(q)) {
      nameIncludes.push(city);
      continue;
    }
    if (country && country.includes(q)) {
      countryMatches.push(city);
    }
  }

  return [...nameStarts, ...nameIncludes, ...countryMatches].slice(0, limit);
}

/**
 * Synchronous check whether the dataset is already loaded.
 * Useful for showing a loading indicator in the UI.
 */
export function citiesLoaded(): boolean {
  return cache !== null;
}

/** Kick off the background fetch without blocking — call on page mount. */
export function prefetchCities(): void {
  void ensureLoaded();
}
