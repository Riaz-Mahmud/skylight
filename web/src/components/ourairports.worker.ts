const CACHE_NAME = "ourairports-cache-v1";
const AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv";

// Simple CSV parser to handle quotes
function parseCsv(text: string) {
  const lines = text.split('\n');
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  const data = [];
  
  const re = /,(?=(?:(?:[^"]*"){2})*[^"]*$)/;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = line.split(re);
    const obj: any = {};
    headers.forEach((h, idx) => {
      let val = row[idx];
      if (val) {
        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        obj[h] = val;
      } else {
        obj[h] = null;
      }
    });
    data.push(obj);
  }
  return data;
}

async function fetchWithCache(url: string): Promise<string> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(url);
    if (cachedResponse) {
      return await cachedResponse.text();
    }
    const response = await fetch(url);
    if (response.ok) {
      await cache.put(url, response.clone());
      return await response.text();
    }
  } catch (e) {
    console.error("Cache fetch failed for", url, e);
  }
  // Fallback to normal fetch if caches fail
  const response = await fetch(url);
  return await response.text();
}

self.onmessage = async (e: MessageEvent) => {
  const { lat, lon, mode, radiusMiles } = e.data;
  try {
    const [airportsText, runwaysText] = await Promise.all([
      fetchWithCache(AIRPORTS_URL),
      fetchWithCache(RUNWAYS_URL),
    ]);

    const airports = parseCsv(airportsText);
    const runways = parseCsv(runwaysText);

    // Group runways by airport_ref for O(N) lookup instead of O(N*M) filters
    const runwaysByAirportRef = new Map<string, any[]>();
    for (const r of runways) {
      if (!r.airport_ref || !r.le_latitude_deg || !r.he_latitude_deg) continue;
      let list = runwaysByAirportRef.get(r.airport_ref);
      if (!list) {
        list = [];
        runwaysByAirportRef.set(r.airport_ref, list);
      }
      list.push(r);
    }

    if (mode === "nearby") {
      const radiusRad = (radiusMiles || 150) / 3958.8;
      const matches = [];

      for (const a of airports) {
        if (a.type !== "large_airport" && a.type !== "medium_airport") continue;
        const alat = parseFloat(a.latitude_deg);
        const alon = parseFloat(a.longitude_deg);
        if (isNaN(alat) || isNaN(alon)) continue;

        const dLat = (alat - lat) * Math.PI / 180;
        const dLon = (alon - lon) * Math.PI / 180;
        const x = dLon * Math.cos((lat + alat) / 2 * Math.PI / 180);
        const d = Math.sqrt(x*x + dLat*dLat);

        if (d <= radiusRad) {
          matches.push({
            id: a.id,
            ident: a.ident,
            type: a.type,
            name: a.name,
            latitude_deg: alat,
            longitude_deg: alon,
            elevation_ft: a.elevation_ft ? parseFloat(a.elevation_ft) : null,
            iata_code: a.iata_code || a.ident
          });
        }
      }

      const results = matches.map(m => {
        const airportRunways = runwaysByAirportRef.get(m.id) || [];
        const customRunways = airportRunways.map(r => ({
          leIdent: r.le_ident || "",
          heIdent: r.he_ident || "",
          le: [parseFloat(r.le_latitude_deg!), parseFloat(r.le_longitude_deg!)],
          he: [parseFloat(r.he_latitude_deg!), parseFloat(r.he_longitude_deg!)],
          widthFt: r.width_ft ? parseFloat(r.width_ft) : 150
        })).filter(r => !isNaN(r.le[0]) && !isNaN(r.le[1]) && !isNaN(r.he[0]) && !isNaN(r.he[1]));

        return {
          icao: m.ident,
          name: m.iata_code || m.ident,
          fullName: m.name,
          lat: m.latitude_deg,
          lon: m.longitude_deg,
          elevationFt: m.elevation_ft || 0,
          runways: customRunways
        };
      });

      self.postMessage({ success: true, airports: results });
      return;
    }

    // Default: closest mode
    let closest: any = null;
    let minDist = Infinity;

    for (const a of airports) {
      if (a.type !== "large_airport" && a.type !== "medium_airport") continue;
      const alat = parseFloat(a.latitude_deg);
      const alon = parseFloat(a.longitude_deg);
      if (isNaN(alat) || isNaN(alon)) continue;

      const dLat = (alat - lat) * Math.PI / 180;
      const dLon = (alon - lon) * Math.PI / 180;
      const x = dLon * Math.cos((lat + alat) / 2 * Math.PI / 180);
      const d = Math.sqrt(x*x + dLat*dLat);

      if (d < minDist) {
        minDist = d;
        closest = {
          id: a.id,
          ident: a.ident,
          type: a.type,
          name: a.name,
          latitude_deg: alat,
          longitude_deg: alon,
          elevation_ft: a.elevation_ft ? parseFloat(a.elevation_ft) : null,
          iata_code: a.iata_code || a.ident
        };
      }
    }

    if (!closest) {
      self.postMessage({ success: true, airport: null });
      return;
    }

    const airportRunways = runwaysByAirportRef.get(closest.id) || [];
    const customRunways = airportRunways.map(r => ({
      leIdent: r.le_ident || "",
      heIdent: r.he_ident || "",
      le: [parseFloat(r.le_latitude_deg!), parseFloat(r.le_longitude_deg!)],
      he: [parseFloat(r.he_latitude_deg!), parseFloat(r.he_longitude_deg!)],
      widthFt: r.width_ft ? parseFloat(r.width_ft) : 150
    })).filter(r => !isNaN(r.le[0]) && !isNaN(r.le[1]) && !isNaN(r.he[0]) && !isNaN(r.he[1]));

    const result = {
      icao: closest.ident,
      name: closest.iata_code || closest.ident,
      fullName: closest.name,
      lat: closest.latitude_deg,
      lon: closest.longitude_deg,
      elevationFt: closest.elevation_ft || 0,
      runways: customRunways
    };

    self.postMessage({ success: true, airport: result });
  } catch (err) {
    self.postMessage({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
};
