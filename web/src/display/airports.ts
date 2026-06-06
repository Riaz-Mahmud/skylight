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

export interface Airport {
  icao: string;
  name: string;
  /** Airport reference point (used for proximity filtering). */
  lat: number;
  lon: number;
  runways: Runway[];
}

// ── USA ──────────────────────────────────────────────────────────────────────

export const SFO: Airport = {
  icao: "KSFO",
  name: "SFO",
  lat: 37.6213,
  lon: -122.379,
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
  lat: 40.6413,
  lon: -73.7781,
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
  lat: 33.9425,
  lon: -118.4081,
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
  lat: 51.4775,
  lon: -0.4614,
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
  lat: 51.1537,
  lon: -0.1821,
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
  lat: 53.3650,
  lon: -2.2722,
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
  lat: 52.4539,
  lon: -1.7480,
  runways: [
    // 15/33 — 2,605 m, width 148 ft
    { leIdent: "15",  heIdent: "33",  le: [52.465600, -1.742400], he: [52.441500, -1.756800], widthFt: 148 },
  ],
};

export const LCY: Airport = {
  icao: "EGLC",
  name: "LCY",
  lat: 51.5053,
  lon: 0.0553,
  runways: [
    // 09/27 — 4,948 ft, width 98 ft (OurAirports EGLC)
    { leIdent: "09", heIdent: "27", le: [51.505576, 0.044333], he: [51.504894, 0.066026], widthFt: 98 },
  ],
};

// ── Bangladesh ───────────────────────────────────────────────────────────────

export const DAC: Airport = {
  icao: "VGHS",
  name: "DAC",
  lat: 23.8433,
  lon: 90.4008,
  runways: [
    // 14/32 — 3,200 m / 10,499 ft, width 148 ft, heading ~140°/320°
    { leIdent: "14", heIdent: "32", le: [23.8620, 90.3880], he: [23.8246, 90.4136], widthFt: 148 },
  ],
};

// ── UAE ──────────────────────────────────────────────────────────────────────

export const DXB: Airport = {
  icao: "OMDB",
  name: "DXB",
  lat: 25.2532,
  lon: 55.3657,
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
  lat: 1.3644,
  lon: 103.9915,
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
