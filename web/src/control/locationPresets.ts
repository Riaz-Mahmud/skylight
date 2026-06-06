// Location presets — quick-pick airport locations with sensible defaults.

export interface LocationPreset {
  code: string;   // IATA
  name: string;
  lat: number;
  lon: number;
  /** Suggested display radius in miles. */
  radiusMiles: number;
}

export const LOCATION_PRESETS: LocationPreset[] = [
  // UK
  { code: "LHR", name: "London Heathrow",  lat: 51.4775,  lon: -0.4614,   radiusMiles: 10 },
  { code: "LGW", name: "London Gatwick",   lat: 51.1537,  lon: -0.1821,   radiusMiles: 10 },
  { code: "LCY", name: "London City",      lat: 51.5053,  lon:  0.0553,   radiusMiles: 5  },
  { code: "MAN", name: "Manchester",       lat: 53.3650,  lon: -2.2722,   radiusMiles: 10 },
  { code: "BHX", name: "Birmingham",       lat: 52.4539,  lon: -1.7480,   radiusMiles: 8  },
  { code: "EDI", name: "Edinburgh",        lat: 55.9508,  lon: -3.3615,   radiusMiles: 8  },
  // USA
  { code: "SFO", name: "San Francisco",    lat: 37.6213,  lon: -122.3790, radiusMiles: 8  },
  { code: "JFK", name: "New York JFK",     lat: 40.6413,  lon: -73.7781,  radiusMiles: 10 },
  { code: "LAX", name: "Los Angeles",      lat: 33.9425,  lon: -118.4081, radiusMiles: 10 },
  { code: "ORD", name: "Chicago O'Hare",   lat: 41.9742,  lon: -87.9073,  radiusMiles: 10 },
  // Middle East
  { code: "DXB", name: "Dubai",            lat: 25.2532,  lon:  55.3657,  radiusMiles: 10 },
  // Asia
  { code: "SIN", name: "Singapore",        lat:  1.3644,  lon: 103.9915,  radiusMiles: 8  },
  { code: "DAC", name: "Dhaka",            lat: 23.8433,  lon:  90.4008,  radiusMiles: 8  },
];
