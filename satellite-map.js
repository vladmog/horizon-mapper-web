"use strict";
// Convert the map's existing Mercator affine to visible XYZ imagery tiles.
function satelliteTiles(view) {
  const { z, k, cx, cy, width, height, dpr = 1 } = view;
  if (!(k > 0 && width > 0 && height > 0)) return [];
  // Follow zoom and screen density through World Imagery's highest tile level.
  // Beyond the service's limit, magnify its finest tiles.
  const level = Math.max(0, Math.min(23, Math.round(z + Math.log2(k * dpr))));
  const factor = 2 ** (z - level), size = 256 * factor * k;
  const left = width / 2 - cx * k, top = height / 2 - cy * k;
  const count = 2 ** level, tiles = [];
  for (let y = Math.max(0, Math.floor(-top / size)); y < Math.min(count, Math.ceil((height - top) / size)); y++) {
    for (let x = Math.floor(-left / size); x < Math.ceil((width - left) / size); x++) {
      const column = ((x % count) + count) % count;
      tiles.push({ key: `${level}/${y}/${column}`, x: left + x * size, y: top + y * size, size });
    }
  }
  return tiles;
}

class SatelliteMap {
  constructor(redraw) {
    this.redraw = redraw;
    this.cache = new Map();
    this.views = new Map();
    this.active = 0;
  }
  load(key) {
    const image = new Image();
    const tile = { image, state: "loading" };
    this.cache.set(key, tile);
    this.active++;
    const finish = state => {
      if (tile.state !== "loading") return;
      clearTimeout(timer);
      tile.state = state;
      if (state === "error" && typeof appDiagnostics !== "undefined")
        appDiagnostics.record("imagery.failed", { message: "Satellite tile failed or timed out" }, "warn");
      image.onload = image.onerror = null;
      if (state === "error") image.removeAttribute("src");
      this.active--;
      this.redraw();
    };
    const timer = setTimeout(() => finish("error"), 15000);
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => finish("ready");
    image.onerror = () => finish("error");
    // Missing coverage must fail instead of loading a "map data not available" image.
    image.src = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${key}?blankTile=false`;
    return tile;
  }
  retry() {
    for (const [key, tile] of this.cache) if (tile.state === "error") this.cache.delete(key);
    this.redraw();
  }
  releaseView(name) { this.views.delete(name); }
  draw(context, view, name = "default") {
    const tiles = satelliteTiles(view), visible = new Set(tiles.map(t => t.key));
    this.views.set(name, visible);
    let ready = 0, failed = 0;
    for (const t of tiles) {
      let tile = this.cache.get(t.key);
      if (!tile && this.active < 6) tile = this.load(t.key);
      if (tile) {
        // Refresh insertion order for bounded least-recently-used caching.
        this.cache.delete(t.key); this.cache.set(t.key, tile);
      }
      if (tile?.state === "ready") {
        context.drawImage(tile.image, t.x, t.y, t.size + 0.5, t.size + 0.5);
        ready++;
      } else {
        const [level, row, column] = t.key.split("/").map(Number);
        let fallback = null, candidate = null;
        for (let parentLevel = level - 1; parentLevel >= 0; parentLevel--) {
          const scale = 2 ** (level - parentLevel);
          const key = `${parentLevel}/${Math.floor(row / scale)}/${Math.floor(column / scale)}`;
          // Retain failed ancestors too: repeatedly evicting them would restart
          // the same missing-coverage requests on every redraw.
          visible.add(key);
          const parent = this.cache.get(key);
          if (parent?.state === "ready") {
            fallback = { key, parent, scale };
            break;
          }
          // Try the nearest available parent even if a much coarser cached
          // ancestor already covers the area.
          if (!candidate && parent?.state !== "error") candidate = { key, parent };
        }
        if (tile?.state === "error" && candidate && !candidate.parent && this.active < 6)
          this.load(candidate.key);
        if (fallback) {
          const { key, parent, scale } = fallback;
          visible.add(key); // Keep the imagery we are displaying in the cache.
          this.cache.delete(key); this.cache.set(key, parent);
          const w = (parent.image.naturalWidth || 256) / scale;
          const h = (parent.image.naturalHeight || 256) / scale;
          context.drawImage(parent.image, (column % scale) * w, (row % scale) * h,
            w, h, t.x, t.y, t.size + 0.5, t.size + 0.5);
          ready++;
        } else {
          if (tile?.state === "error") {
            failed++;
          }
        }
      }
    }
    // The 3D overview and detail patch share this loader. Protect both working
    // sets; their combined visible tiles can exceed the idle-cache budget.
    const retained = new Set([...this.views.values()].flatMap(keys => [...keys]));
    for (const [key, tile] of this.cache) {
      if (this.cache.size <= 128) break;
      if (!retained.has(key) && tile.state !== "loading") this.cache.delete(key);
    }
    return { total: tiles.length, ready, failed };
  }
}
