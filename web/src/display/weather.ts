import { type Config, llToMeters, project, type Meters } from "@shared/index.js";

type ProjOpts = Parameters<typeof project>[1];

interface Tile {
  z: number;
  x: number;
  y: number;
  img: HTMLImageElement;
  loaded: boolean;
  bounds: {
    n: number;
    s: number;
    e: number;
    w: number;
  };
}

export class WeatherRadar {
  private lastFetch = 0;
  private timeStr: number | null = null;
  private tiles = new Map<string, Tile>();
  private activeCenter = "";
  private loadingTiles: Tile[] = [];

  private async fetchTime() {
    try {
      const res = await fetch("https://api.rainviewer.com/public/weather-maps.json");
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.radar && data.radar.past && data.radar.past.length > 0) {
        // Get the latest past timestamp
        this.timeStr = data.radar.past[data.radar.past.length - 1].time;
      }
    } catch {
      // Ignore
    }
  }

  private lon2tile(lon: number, zoom: number): number { return Math.floor((lon + 180) / 360 * Math.pow(2, zoom)); }
  private lat2tile(lat: number, zoom: number): number { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)); }
  private tile2lon(x: number, z: number): number { return x / Math.pow(2, z) * 360 - 180; }
  private tile2lat(y: number, z: number): number {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  private previousTiles = new Map<string, Tile>();
  private transitionStart = 0;
  private readonly TRANSITION_DURATION = 1000; // 1 second

  private checkSwap(list: Tile[]) {
    if (this.loadingTiles === list && list.every(t => t.loaded)) {
      // Move current tiles to previousTiles for cross-fade
      this.previousTiles.clear();
      for (const [key, t] of this.tiles.entries()) {
        this.previousTiles.set(key, t);
      }
      this.transitionStart = Date.now();

      // Set current tiles to the new ones
      this.tiles.clear();
      for (const t of list) {
        const key = `${t.z}/${t.x}/${t.y}`;
        this.tiles.set(key, t);
      }
      this.loadingTiles = [];
    }
  }

  public update(cfg: Config) {
    const now = Date.now();
    if (now - this.lastFetch > 5 * 60 * 1000) {
      this.lastFetch = now;
      this.fetchTime();
    }

    if (!this.timeStr) return;

    // We fetch a 3x3 grid around the center.
    // Zoom 10 usually covers ~20 miles per tile, Zoom 11 ~10 miles.
    const zoom = cfg.radiusMiles > 15 ? 9 : cfg.radiusMiles > 7 ? 10 : 11;
    const centerKey = `${cfg.centerLat.toFixed(3)},${cfg.centerLon.toFixed(3)},${zoom},${this.timeStr}`;
    
    if (this.activeCenter !== centerKey) {
      this.activeCenter = centerKey;
      
      const cx = this.lon2tile(cfg.centerLon, zoom);
      const cy = this.lat2tile(cfg.centerLat, zoom);

      const nextTilesList: Tile[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const tx = cx + dx;
          const ty = cy + dy;
          
          const img = new Image();
          const tile: Tile = {
            z: zoom, x: tx, y: ty, img, loaded: false,
            bounds: {
              n: this.tile2lat(ty, zoom),
              s: this.tile2lat(ty + 1, zoom),
              w: this.tile2lon(tx, zoom),
              e: this.tile2lon(tx + 1, zoom)
            }
          };
          
          img.onload = () => {
            tile.loaded = true;
            this.checkSwap(nextTilesList);
          };
          img.onerror = () => {
            tile.loaded = true; // Mark as done to prevent blocking swap
            this.checkSwap(nextTilesList);
          };
          // Color scheme 2 is good for deep heatmaps. Smooth = 1_1.
          img.src = `https://tilecache.rainviewer.com/v2/radar/${this.timeStr}/512/${zoom}/${tx}/${ty}/2/1_1.png`;
          nextTilesList.push(tile);
        }
      }
      this.loadingTiles = nextTilesList;
    }
  }

  public draw(
    ctx: CanvasRenderingContext2D,
    cfg: Config,
    proj: ProjOpts,
    relativeToFollow: (m: Meters) => Meters
  ) {
    if (!cfg.showWeather || !this.timeStr) return;

    const now = Date.now();
    const age = now - this.transitionStart;
    const isTransitioning = age < this.TRANSITION_DURATION && this.previousTiles.size > 0;
    const progress = isTransitioning ? age / this.TRANSITION_DURATION : 1;

    ctx.save();
    // To make it look like a deep heatmap and blend nicely with pure black.
    ctx.globalCompositeOperation = "screen";

    const baseAlpha = 0.4 * cfg.brightness;

    // 1. Draw previous tiles (fading out)
    if (isTransitioning) {
      ctx.globalAlpha = baseAlpha * (1 - progress);
      this.drawTileMap(ctx, this.previousTiles, cfg, proj, relativeToFollow);
    }

    // 2. Draw current tiles (fading in)
    ctx.globalAlpha = baseAlpha * progress;
    this.drawTileMap(ctx, this.tiles, cfg, proj, relativeToFollow);

    ctx.restore();

    // Clean up previous tiles once transition is complete
    if (!isTransitioning && this.previousTiles.size > 0) {
      this.previousTiles.clear();
    }
  }

  private drawTileMap(
    ctx: CanvasRenderingContext2D,
    tileMap: Map<string, Tile>,
    cfg: Config,
    proj: ProjOpts,
    relativeToFollow: (m: Meters) => Meters
  ) {
    for (const tile of tileMap.values()) {
      if (!tile.loaded) continue;
      
      // The center of the tile in screen space
      const centerLat = (tile.bounds.n + tile.bounds.s) / 2;
      const centerLon = (tile.bounds.e + tile.bounds.w) / 2;
      const centerM = relativeToFollow(llToMeters(centerLat, centerLon, cfg.centerLat, cfg.centerLon));
      const pCenter = project(centerM, proj);
      
      // Width and height in meters
      const widthM = (tile.bounds.e - tile.bounds.w) * Math.cos(centerLat * Math.PI / 180) * 111320;
      const heightM = (tile.bounds.n - tile.bounds.s) * 110540; // positive since n > s
      
      // Draw the image rotated and scaled
      ctx.save();
      ctx.translate(pCenter.x, pCenter.y);
      ctx.rotate(-(cfg.rotationDeg * Math.PI / 180));
      
      const pxW = widthM * proj.pxPerM;
      const pxH = heightM * proj.pxPerM;
      
      if (cfg.mirrorX) ctx.scale(-1, 1);
      if (cfg.mirrorY) ctx.scale(1, -1);
      
      ctx.drawImage(tile.img, -pxW / 2, -pxH / 2, pxW, pxH);
      ctx.restore();
    }
  }
}
