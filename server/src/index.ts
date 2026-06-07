// Entry point. Wires the config store, data poller, WebSocket hub, REST API,
// and (in production) serves the built web app. Binds 0.0.0.0 so the control
// panel is reachable from your phone on the LAN.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import express from "express";
import type { DataSource } from "@shared/index.js";
import { ConfigStore, ConfigValidationError } from "./config-store.js";
import { RouteEnricher } from "./enrich/routes.js";
import { Poller } from "./datasource.js";
import { Hub } from "./hub.js";
import { TleStore } from "./tle.js";
import { FlightStats } from "./stats.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const WEB_DIST = resolve(__dirname, "../../web/dist");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SOURCE = (process.env.DATA_SOURCE as DataSource) ?? "radio";
const RADIO_URL =
  process.env.AIRCRAFT_JSON_URL ?? "http://localhost:8080/data/aircraft.json";
const API_URL =
  process.env.API_URL ?? "https://api.airplanes.live/v2/point/{lat}/{lon}/{r}";
const POLL_MS = Number(process.env.POLL_MS ?? 1000);
const ROUTE_CACHE_HOURS = Number(process.env.ROUTE_CACHE_HOURS ?? 12);
// When on radio, also poll the API and merge (keeps landing aircraft alive).
const SUPPLEMENT_API = (process.env.SUPPLEMENT_API ?? "1") !== "0";
const API_POLL_MS = Number(process.env.API_POLL_MS ?? 4000);

async function main(): Promise<void> {
  const store = new ConfigStore(resolve(DATA_DIR, "config.json"));
  await store.load();

  const enricher = new RouteEnricher(
    resolve(DATA_DIR, "route-cache.json"),
    ROUTE_CACHE_HOURS,
  );
  await enricher.load();

  const tleStore = new TleStore(resolve(DATA_DIR, "tle-cache.json"));
  await tleStore.load();

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  const server = createServer(app);
  const stats = new FlightStats();
  let hub: Hub;
  const poller = new Poller({
    source: SOURCE,
    radioUrl: RADIO_URL,
    apiUrlTemplate: API_URL,
    pollMs: POLL_MS,
    supplementApi: SUPPLEMENT_API,
    apiPollMs: API_POLL_MS,
    getConfig: () => store.get(),
    enricher,
    onSnapshot: (now, aircraft) => {
      stats.observe(now, aircraft);
      hub.broadcastAircraft(now, aircraft);
    },
    onStatus: (status) => hub.broadcastStatus(status),
  });
  hub = new Hub(server, {
    store,
    getSnapshot: () => poller.getSnapshot(),
    getStatus: () => poller.getStatus(),
  });

  // --- REST API (handy for debugging + non-WS clients) ---
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) => res.json(store.get()));
  app.post("/api/config", (req, res) => {
    try {
      return res.json(store.patch(req.body));
    } catch (error) {
      if (error instanceof ConfigValidationError) return res.status(400).json({ errors: error.errors });
      throw error;
    }
  });
  let lastSourceChange = 0;
  app.post("/api/config/reset", (_req, res) => res.json(store.reset()));
  app.get("/api/setup/status", (_req, res) =>
    res.json({ hasSavedConfig: store.hasSavedConfig() }),
  );
  app.post("/api/setup/location", (req, res) => {
    const centerLat = Number(req.body?.centerLat);
    const centerLon = Number(req.body?.centerLon);
    const radiusMiles = Number(req.body?.radiusMiles);

    if (!Number.isFinite(centerLat) || centerLat < -90 || centerLat > 90) {
      return res.status(400).json({ error: "centerLat must be in range [-90, 90]" });
    }
    if (!Number.isFinite(centerLon) || centerLon < -180 || centerLon > 180) {
      return res.status(400).json({ error: "centerLon must be in range [-180, 180]" });
    }
    if (!Number.isFinite(radiusMiles) || radiusMiles <= 0 || radiusMiles > 200) {
      return res.status(400).json({ error: "radiusMiles must be in range (0, 200]" });
    }

    const config = store.patch({ centerLat, centerLon, radiusMiles });
    return res.json({ config, hasSavedConfig: store.hasSavedConfig() });
  });
  app.get("/api/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length < 2) return res.json({ aircraft: [] });
    const aircraft = await poller.searchByCallsign(q);
    // Seed follow position so the next poll centres on the result immediately.
    const first = aircraft.find((ac) => ac.lat != null && ac.lon != null);
    if (first?.lat != null && first.lon != null) {
      poller.seedFollowPosition(first.lat, first.lon);
    }
    return res.json({ aircraft });
  });
  app.get("/api/aircraft", (_req, res) => res.json(poller.getSnapshot()));
  app.get("/api/status", (_req, res) => res.json(poller.getStatus()));
  app.get("/api/stats", (_req, res) => res.json(stats.get()));
  app.get("/api/tle", async (_req, res) => res.json(await tleStore.get()));
  app.post("/api/source", (req, res) => {
    if (Date.now() - lastSourceChange < 1000) {
      return res.status(429).json({ error: "source may only be changed once per second" });
    }
    const s = req.body?.source;
    if (s !== "radio" && s !== "api") {
      return res.status(400).json({ error: "source must be 'radio' or 'api'" });
    }
    lastSourceChange = Date.now();
    poller.setSource(s);
    res.json(poller.getStatus());
  });

  // --- static web (production build) ---
  if (existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get("/setup", (_req, res) => res.redirect(302, "/setup.html"));
    app.get("/control", (_req, res) => res.redirect(302, "/control.html"));
    app.get("/diagnostics", (_req, res) => res.redirect(302, "/diagnostics.html"));
    app.get("/", (_req, res) => res.redirect(302, "/index.html"));
  } else {
    app.get("/", (_req, res) =>
      res
        .type("text/plain")
        .send("Web build not found. Run `npm run build`, or use the Vite dev server."),
    );
  }

  poller.start();

  server.listen(PORT, HOST, () => {
    console.log(`[server] listening on http://${HOST}:${PORT}`);
    console.log(`[server] data source: ${SOURCE} (${SOURCE === "radio" ? RADIO_URL : API_URL})`);
    console.log(`[server] control panel: http://<this-host>:${PORT}/control`);
  });

  const shutdown = () => {
    poller.stop();
    hub.close();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
