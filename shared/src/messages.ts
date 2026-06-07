// WebSocket message contracts between clients (display + control) and server.

import type { Config } from "./config.js";
import type { Aircraft } from "./aircraft.js";
import type { DataSource } from "./config.js";

export const PROTOCOL_VERSION = 1;

export interface SourceStatus {
  source: DataSource;
  /** Whether the most recent poll succeeded. */
  ok: boolean;
  /** Number of aircraft in the last snapshot. */
  count: number;
  /** Last successful poll (ms epoch), or null. */
  lastOk: number | null;
  /** Human-readable note (e.g. last error). */
  message?: string;
  /** Server poll interval in ms — lets the renderer self-tune its render delay. */
  pollMs?: number;
}

/** Server -> client. */
export type ServerMessage =
  | { type: "config"; config: Config }
  | { type: "aircraft"; now: number; seq: number; aircraft: Aircraft[] }
  | { type: "aircraftDelta"; now: number; seq: number; upsert: Aircraft[]; remove: string[]; alive: string[] }
  | { type: "status"; status: SourceStatus }
  | { type: "ack"; requestId: string }
  | { type: "pong" }
  | { type: "error"; requestId?: string; message: string };

/** Client -> server. */
export type ClientMessage =
  | { type: "hello"; role: "display" | "control"; protocolVersion: number }
  | { type: "patchConfig"; patch: Partial<Config>; requestId?: string }
  | { type: "setConfig"; config: Config; requestId?: string }
  | { type: "resetConfig"; requestId?: string }
  | { type: "requestSnapshot" }
  | { type: "ping" };
