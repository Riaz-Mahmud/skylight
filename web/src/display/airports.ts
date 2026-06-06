// Bundled airport geometry, drawn at true geographic position so departures and
// arrivals visibly line up with the runways.
// Threshold coordinates from OurAirports / AIP public data.

export interface Runway {
  leIdent: string;
  heIdent: string;
  le: [number, number]; // [lat, lon]
  he: [number, number];
  widthFt: number;
}

export interface AirportPath {
  points: [number, number][];
  widthFt: number;
}

export interface AirportArea {
  points: [number, number][];
}

export interface Airport {
  icao: string;
  /** Short display code, normally IATA. */
  name: string;
  fullName?: string;
  /** Airport reference point (used for proximity filtering). */
  lat: number;
  lon: number;
  elevationFt?: number;
  runways: Runway[];
  taxiways?: AirportPath[];
  aprons?: AirportArea[];
  terminals?: AirportArea[];
}

// ── USA ──────────────────────────────────────────────────────────────────────

export const SFO: Airport = {
  icao: "KSFO",
  name: "SFO",
  fullName: "San Francisco International Airport",
  lat: 37.6213,
  lon: -122.379,
  elevationFt: 13,
  runways: [
    { leIdent: "10L", heIdent: "28R", le: [37.628742, -122.39341], he: [37.613538, -122.35716], widthFt: 200 },
    { leIdent: "10R", heIdent: "28L", le: [37.626298, -122.393124], he: [37.61172, -122.358367], widthFt: 200 },
    { leIdent: "1L",  heIdent: "19R", le: [37.607898, -122.38295],  he: [37.626476, -122.37063], widthFt: 200 },
    { leIdent: "1R",  heIdent: "19L", le: [37.606333, -122.381061], he: [37.627346, -122.367124], widthFt: 200 },
  ],
};

export const JFK: Airport = {
  icao: "KJFK",
  name: "JFK",
  fullName: "John F. Kennedy International Airport",
  lat: 40.6413,
  lon: -73.7781,
  elevationFt: 13,
  runways: [
    { leIdent: "4L",  heIdent: "22R", le: [40.620800, -73.789100], he: [40.651600, -73.766900], widthFt: 150 },
    { leIdent: "4R",  heIdent: "22L", le: [40.617200, -73.787500], he: [40.648700, -73.765700], widthFt: 150 },
    { leIdent: "13L", heIdent: "31R", le: [40.657900, -73.778200], he: [40.636700, -73.756900], widthFt: 150 },
    { leIdent: "13R", heIdent: "31L", le: [40.655800, -73.792800], he: [40.627700, -73.761600], widthFt: 150 },
  ],
};

export const LAX: Airport = {
  icao: "KLAX",
  name: "LAX",
  fullName: "Los Angeles International Airport",
  lat: 33.9425,
  lon: -118.4081,
  elevationFt: 128,
  runways: [
    { leIdent: "6L",  heIdent: "24R", le: [33.945900, -118.427600], he: [33.945600, -118.380700], widthFt: 150 },
    { leIdent: "6R",  heIdent: "24L", le: [33.940000, -118.427100], he: [33.939700, -118.380200], widthFt: 150 },
    { leIdent: "7L",  heIdent: "25R", le: [33.934400, -118.418300], he: [33.934100, -118.377000], widthFt: 150 },
    { leIdent: "7R",  heIdent: "25L", le: [33.928500, -118.418900], he: [33.928200, -118.377600], widthFt: 150 },
  ],
};

// ── UK ───────────────────────────────────────────────────────────────────────

export const LHR: Airport = {
  icao: "EGLL",
  name: "LHR",
  fullName: "London Heathrow Airport",
  lat: 51.4775,
  lon: -0.4614,
  elevationFt: 83,
  runways: [
    // Northern runway: 09L/27R — 12,799 ft, width 164 ft (OurAirports EGLL)
    { leIdent: "09L", heIdent: "27R", le: [51.47749, -0.489439], he: [51.477681, -0.433227], widthFt: 164 },
    // Southern runway: 09R/27L — 12,001 ft, width 164 ft (OurAirports EGLL)
    { leIdent: "09R", heIdent: "27L", le: [51.46478, -0.486808], he: [51.464957, -0.434048], widthFt: 164 },
  ],
};

export const LGW: Airport = {
  icao: "EGKK",
  name: "LGW",
  fullName: "London Gatwick Airport",
  lat: 51.1537,
  lon: -0.1821,
  elevationFt: 203,
  runways: [
    // Main runway: 08R/26L — 10,883 ft, width 148 ft (OurAirports EGKK)
    { leIdent: "08R", heIdent: "26L", le: [51.145103, -0.212345], he: [51.151493, -0.165992], widthFt: 148 },
    // Standby runway: 08L/26R — 8,402 ft, width 148 ft (OurAirports EGKK)
    { leIdent: "08L", heIdent: "26R", le: [51.146893, -0.212599], he: [51.151825, -0.176795], widthFt: 148 },
  ],
};

export const MAN: Airport = {
  icao: "EGCC",
  name: "MAN",
  fullName: "Manchester Airport",
  lat: 53.3650,
  lon: -2.2722,
  elevationFt: 257,
  runways: [
    // 05L/23R — 3,048 m, width 150 ft
    { leIdent: "05L", heIdent: "23R", le: [53.352000, -2.287500], he: [53.378300, -2.255400], widthFt: 150 },
    // 05R/23L — 3,048 m, width 150 ft
    { leIdent: "05R", heIdent: "23L", le: [53.347800, -2.281900], he: [53.374100, -2.249800], widthFt: 150 },
  ],
};

export const BHX: Airport = {
  icao: "EGBB",
  name: "BHX",
  fullName: "Birmingham Airport",
  lat: 52.4539,
  lon: -1.7480,
  elevationFt: 327,
  runways: [
    // 15/33 — 2,605 m, width 148 ft
    { leIdent: "15",  heIdent: "33",  le: [52.465600, -1.742400], he: [52.441500, -1.756800], widthFt: 148 },
  ],
};

export const LCY: Airport = {
  icao: "EGLC",
  name: "LCY",
  fullName: "London City Airport",
  lat: 51.5053,
  lon: 0.0553,
  elevationFt: 19,
  runways: [
    // 09/27 — 4,948 ft, width 98 ft (OurAirports EGLC)
    { leIdent: "09", heIdent: "27", le: [51.505576, 0.044333], he: [51.504894, 0.066026], widthFt: 98 },
  ],
};

// ── Bangladesh ───────────────────────────────────────────────────────────────

export const DAC: Airport = {
  icao: "VGHS",
  name: "DAC",
  fullName: "Hazrat Shahjalal International Airport",
  lat: 23.8433,
  lon: 90.4008,
  elevationFt: 27,
  runways: [
    // 14/32 — 3,200 m / 10,499 ft, width 148 ft, heading ~140°/320°
    { leIdent: "14", heIdent: "32", le: [23.8620, 90.3880], he: [23.8246, 90.4136], widthFt: 148 },
  ],
};

// ── UAE ──────────────────────────────────────────────────────────────────────

export const DXB: Airport = {
  icao: "OMDB",
  name: "DXB",
  fullName: "Dubai International Airport",
  lat: 25.2532,
  lon: 55.3657,
  elevationFt: 62,
  runways: [
    // 12L/30R — 4,000 m, width 197 ft
    { leIdent: "12L", heIdent: "30R", le: [25.263700, 55.337700], he: [25.239900, 55.391200], widthFt: 197 },
    // 12R/30L — 4,000 m, width 197 ft
    { leIdent: "12R", heIdent: "30L", le: [25.257600, 55.338900], he: [25.233900, 55.392400], widthFt: 197 },
  ],
};

// ── Singapore ────────────────────────────────────────────────────────────────

export const SIN: Airport = {
  icao: "WSSS",
  name: "SIN",
  fullName: "Singapore Changi Airport",
  lat: 1.3644,
  lon: 103.9915,
  elevationFt: 22,
  runways: [
    // 02L/20R — 4,000 m, width 197 ft
    { leIdent: "02L", heIdent: "20R", le: [1.342200, 103.985800], he: [1.387700, 103.997400], widthFt: 197 },
    // 02C/20C — 4,000 m, width 197 ft
    { leIdent: "02C", heIdent: "20C", le: [1.341600, 103.988400], he: [1.387100, 103.999900], widthFt: 197 },
    // 02R/20L — 2,748 m, width 148 ft
    { leIdent: "02R", heIdent: "20L", le: [1.350600, 103.993900], he: [1.375900, 103.999800], widthFt: 148 },
  ],
};

/** All known airports. The renderer filters this to those within the display radius. */
export const AIRPORTS: Airport[] = [
  SFO, JFK, LAX,
  LHR, LGW, MAN, BHX, LCY,
  DAC,
  DXB, SIN,
];

const airportByIcao = new Map<string, Airport>();
let airportRevision = 0;

function rebuildAirportIndex(): void {
  airportByIcao.clear();
  for (const airport of AIRPORTS) airportByIcao.set(airport.icao.toUpperCase(), airport);
}

rebuildAirportIndex();

/** Fast lookup for route and display features that already have an ICAO code. */
export function getAirportByIcao(icao: string): Airport | undefined {
  return airportByIcao.get(icao.toUpperCase());
}

export function getAirportRevision(): number {
  return airportRevision;
}

/** Replace or extend bundled geometry with airports loaded at runtime. */
export function registerAirports(airports: Airport[], replace = false): void {
  if (replace) AIRPORTS.length = 0;

  for (const airport of airports) {
    const existing = AIRPORTS.findIndex(
      (candidate) => candidate.icao.toUpperCase() === airport.icao.toUpperCase(),
    );
    if (existing >= 0) AIRPORTS[existing] = airport;
    else AIRPORTS.push(airport);
  }
  rebuildAirportIndex();
  airportRevision++;
}

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value)
    && value.length === 2
    && value.every((part) => typeof part === "number" && Number.isFinite(part));
}

function isArea(value: unknown): value is AirportArea {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as AirportArea).points)
    && (value as AirportArea).points.every(isCoordinate);
}

function isPath(value: unknown): value is AirportPath {
  return isArea(value)
    && typeof (value as AirportPath).widthFt === "number"
    && Number.isFinite((value as AirportPath).widthFt);
}

function isAirport(value: unknown): value is Airport {
  if (!value || typeof value !== "object") return false;
  const airport = value as Partial<Airport>;
  return typeof airport.icao === "string"
    && typeof airport.name === "string"
    && typeof airport.lat === "number" && Number.isFinite(airport.lat)
    && typeof airport.lon === "number" && Number.isFinite(airport.lon)
    && Array.isArray(airport.runways)
    && airport.runways.every((runway) =>
      typeof runway?.leIdent === "string"
      && typeof runway.heIdent === "string"
      && isCoordinate(runway.le)
      && isCoordinate(runway.he)
      && typeof runway.widthFt === "number" && Number.isFinite(runway.widthFt))
    && (!airport.taxiways || airport.taxiways.every(isPath))
    && (!airport.aprons || airport.aprons.every(isArea))
    && (!airport.terminals || airport.terminals.every(isArea));
}

/**
 * Load optional airport geometry from `/airports.json`.
 * The file may contain an Airport[] or `{ "replace": true, "airports": Airport[] }`.
 */
export async function loadRuntimeAirports(url = "/airports.json"): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) return;
    const payload: unknown = await response.json();
    const values = Array.isArray(payload)
      ? payload
      : payload && typeof payload === "object" && Array.isArray((payload as { airports?: unknown }).airports)
        ? (payload as { airports: unknown[] }).airports
        : [];
    const airports = values.filter(isAirport);
    if (!airports.length) return;
    const replace = !Array.isArray(payload) && (payload as { replace?: unknown }).replace === true;
    registerAirports(airports, replace);
  } catch {
    // Runtime geometry is optional; bundled airports remain available offline.
  }
}
