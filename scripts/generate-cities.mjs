/**
 * Generate web/public/data/cities.json from a GeoNames dump.
 *
 * Usage:
 *   1. Download cities5000.zip from https://download.geonames.org/export/dump/
 *   2. Extract cities5000.txt into data/cities5000.txt  (next to this script's
 *      parent directory, i.e. skylight/data/cities5000.txt)
 *   3. Run:  node scripts/generate-cities.mjs
 *
 * The output goes to web/public/data/cities.json and is served statically.
 * It is NOT bundled — the browser fetches it only when the setup/location
 * search opens, so bundle size is unaffected.
 *
 * GeoNames tab-separated column indices (0-based):
 *   0  geonameid
 *   1  name            ← preferred display name
 *   2  asciiname
 *   3  alternatenames
 *   4  latitude
 *   5  longitude
 *   6  feature class   (P = populated place)
 *   7  feature code
 *   8  country code
 *   9  cc2
 *   10 admin1 code
 *   11 admin2 code
 *   12 admin3 code
 *   13 admin4 code
 *   14 population
 *   15 elevation
 *   16 dem
 *   17 timezone
 *   18 modification date
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const INPUT = path.join(ROOT, "data", "cities5000.txt");
const OUTPUT = path.join(ROOT, "web", "public", "data", "cities.json");

if (!fs.existsSync(INPUT)) {
  console.error(`\nInput file not found: ${INPUT}`);
  console.error("Download cities5000.zip from https://download.geonames.org/export/dump/");
  console.error("Extract cities5000.txt into:  skylight/data/cities5000.txt\n");
  process.exit(1);
}

console.log(`Reading ${INPUT} …`);
const raw = fs.readFileSync(INPUT, "utf8");

const cities = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const cols = line.split("\t");
    const name = cols[1]?.trim();
    const lat = Number(cols[4]);
    const lon = Number(cols[5]);
    const country = cols[8]?.trim();
    const population = Number(cols[14] ?? 0);
    return { name, lat, lon, country, population };
  })
  .filter(
    (c) =>
      c.name &&
      Number.isFinite(c.lat) &&
      Number.isFinite(c.lon) &&
      c.lat !== 0 &&
      c.lon !== 0,
  )
  // Sort largest-first so search results surface capitals and major cities first.
  .sort((a, b) => b.population - a.population);

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, JSON.stringify(cities));   // minified — no indent

console.log(`✓ Generated ${cities.length.toLocaleString()} cities → ${OUTPUT}`);
console.log(`  File size: ${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB`);
