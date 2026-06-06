import type { Aircraft } from "@shared/index.js";

export interface FlightLogEntry {
  hex: string;
  flight?: string;
  registration?: string;
  firstSeen: number;
  lastSeen: number;
  maxAltitudeFt: number | null;
}

export interface FlightStatsSnapshot {
  day: string;
  uniqueAircraft: number;
  activeAircraft: number;
  flights: FlightLogEntry[];
}

export class FlightStats {
  private day = this.dayKey(Date.now());
  private flights = new Map<string, FlightLogEntry>();

  observe(now: number, aircraft: Aircraft[]): void {
    this.rollDay(now);
    for (const ac of aircraft) {
      const altitude = ac.altBaro ?? ac.altGeom ?? null;
      const entry = this.flights.get(ac.hex);
      if (entry) {
        entry.lastSeen = now;
        entry.flight = ac.flight ?? entry.flight;
        entry.registration = ac.registration ?? entry.registration;
        if (altitude != null) entry.maxAltitudeFt = Math.max(entry.maxAltitudeFt ?? altitude, altitude);
      } else {
        this.flights.set(ac.hex, {
          hex: ac.hex,
          flight: ac.flight,
          registration: ac.registration,
          firstSeen: now,
          lastSeen: now,
          maxAltitudeFt: altitude,
        });
      }
    }
  }

  get(now = Date.now()): FlightStatsSnapshot {
    this.rollDay(now);
    const flights = [...this.flights.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return {
      day: this.day,
      uniqueAircraft: flights.length,
      activeAircraft: flights.filter((flight) => now - flight.lastSeen < 120_000).length,
      flights,
    };
  }

  private rollDay(now: number): void {
    const day = this.dayKey(now);
    if (day === this.day) return;
    this.day = day;
    this.flights.clear();
  }

  private dayKey(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }
}
