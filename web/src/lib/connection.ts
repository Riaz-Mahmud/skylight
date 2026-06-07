// Single auto-reconnecting WebSocket connection shared within a page.
// Receives config / aircraft / status; sends config patches.

import { PROTOCOL_VERSION } from "@shared/index.js";
import type {
  Aircraft,
  ClientMessage,
  Config,
  ServerMessage,
  SourceStatus,
} from "@shared/index.js";

export interface StreamState {
  connected: boolean;
  config: Config | null;
  now: number;
  aircraft: Aircraft[];
  status: SourceStatus | null;
  error: string | null;
}

type Listener = (state: StreamState) => void;

export class Connection {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private aircraftByHex = new Map<string, Aircraft>();
  private aircraftSeq = 0;
  private queuedPatch: Partial<Config> | null = null;
  private queue: ClientMessage[] = [];
  private patchTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  state: StreamState = {
    connected: false,
    config: null,
    now: 0,
    aircraft: [],
    status: null,
    error: null,
  };

  constructor(private role: "display" | "control") {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private url(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  private open(): void {
    try {
      this.ws = new WebSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.lastMessageAt = Date.now();
      this.sendNow({ type: "hello", role: this.role, protocolVersion: PROTOCOL_VERSION });
      this.flushQueue();
      this.startHeartbeat();
      this.update({ connected: true, error: null });
    };
    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.update({ connected: false, config: null });
      this.scheduleReconnect();
    };
    this.ws.onerror = () => this.ws?.close();
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, Math.min(30_000, 1500 * 2 ** this.reconnectAttempt++));
  }

  private onMessage(raw: string): void {
    this.lastMessageAt = Date.now();
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "config":
        this.update({ config: msg.config });
        break;
      case "aircraft":
        this.aircraftByHex = new Map(msg.aircraft.map((ac) => [ac.hex, ac]));
        this.aircraftSeq = msg.seq;
        this.update({ now: msg.now, aircraft: msg.aircraft });
        break;
      case "aircraftDelta":
        if (msg.seq !== this.aircraftSeq + 1) {
          this.send({ type: "requestSnapshot" });
          break;
        }
        for (const hex of msg.remove) this.aircraftByHex.delete(hex);
        for (const ac of msg.upsert) this.aircraftByHex.set(ac.hex, ac);
        // Refresh ts on unchanged aircraft so the renderer knows they are
        // still alive — prevents them drifting into the estimated/stale state
        // just because their position didn't change between polls.
        for (const hex of msg.alive) {
          const existing = this.aircraftByHex.get(hex);
          if (existing) this.aircraftByHex.set(hex, { ...existing, ts: msg.now });
        }
        this.aircraftSeq = msg.seq;
        this.update({ now: msg.now, aircraft: [...this.aircraftByHex.values()] });
        break;
      case "status":
        this.update({ status: msg.status });
        break;
      case "ack":
      case "pong":
        break;
      case "error":
        this.update({ error: msg.message });
        break;
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendNow(msg);
    } else if (msg.type !== "hello" && msg.type !== "requestSnapshot") {
      this.queue.push(msg);
    }
  }

  patchConfig(patch: Partial<Config>): void {
    this.queuedPatch = { ...this.queuedPatch, ...patch };
    if (this.patchTimer) clearTimeout(this.patchTimer);
    this.patchTimer = setTimeout(() => {
      this.patchTimer = null;
      if (this.ws?.readyState === WebSocket.OPEN && this.queuedPatch) {
        this.sendNow({ type: "patchConfig", patch: this.queuedPatch });
        this.queuedPatch = null;
      }
    }, 60);
  }
  resetConfig(): void {
    this.send({ type: "resetConfig" });
  }

  private sendNow(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private flushQueue(): void {
    if (this.queuedPatch) {
      this.sendNow({ type: "patchConfig", patch: this.queuedPatch });
      this.queuedPatch = null;
    }
    for (const msg of this.queue.splice(0)) this.sendNow(msg);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > 45_000) {
        this.ws?.close();
        return;
      }
      this.sendNow({ type: "ping" });
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(partial: Partial<StreamState>): void {
    this.state = { ...this.state, ...partial };
    for (const fn of this.listeners) fn(this.state);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.patchTimer) clearTimeout(this.patchTimer);
    this.stopHeartbeat();
    this.ws?.close();
  }
}
