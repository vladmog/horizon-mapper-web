"use strict";

importScripts("./horizon-core.js");

const BASE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TS = 256;
const CONCURRENCY = 8;
const DB_NAME = "horizon-mapper-terrain-v1";
const STORE = "tiles";
const MAX_CACHE_BYTES = 180 * 1024 * 1024;
const SEA_TILE = new Int16Array(TS * TS);

const lon2px = (lon, z) => (lon + 180) / 360 * (TS * 2 ** z);
function lat2px(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (TS * 2 ** z);
}
function px2lat(py, z) {
  const n = Math.PI * (1 - 2 * py / (TS * 2 ** z));
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}
const px2lon = (px, z) => px / (TS * 2 ** z) * 360 - 180;
const mPerPx = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;
const clamp = (v, a, b) => (!Number.isFinite(v) ? a : v < a ? a : v > b ? b : v);

function planTiers(radius) {
  const spec = [[13, 6000], [12, 25000], [11, Infinity]];
  const tiers = [];
  let inner = 0;
  for (const [z, outer] of spec) {
    if (inner >= radius) break;
    const rOut = Math.min(outer, radius);
    tiers.push({ z, rIn: inner * 0.95, rOut });
    inner = rOut;
  }
  return tiers;
}

function mosaicBounds(lat, lon, halfSpan, z) {
  const dLat = halfSpan / 110574;
  const dLon = halfSpan / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
  return {
    x0: Math.floor(lon2px(lon - dLon, z) / TS) - 1,
    x1: Math.floor(lon2px(lon + dLon, z) / TS) + 1,
    y0: Math.floor(lat2px(Math.min(85, lat + dLat), z) / TS) - 1,
    y1: Math.floor(lat2px(Math.max(-85, lat - dLat), z) / TS) + 1,
  };
}

function tileCount(lat, lon, halfSpan, z) {
  const b = mosaicBounds(lat, lon, halfSpan, z);
  return (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1);
}

let dbPromise;
function openTileDB() {
  if (!self.indexedDB) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: "url" });
      store.createIndex("used", "used");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function cacheRead(url) {
  const db = await openTileDB();
  if (!db) return null;
  return new Promise(resolve => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(url);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => resolve(null);
  });
}

async function cacheWrite(url, blob) {
  const db = await openTileDB();
  if (!db) return;
  await new Promise(resolve => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ url, blob, size: blob.size, used: Date.now() });
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

async function trimCache() {
  const db = await openTileDB();
  if (!db) return;
  const rows = await new Promise(resolve => {
    const out = [];
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).index("used").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(out);
      out.push({ key: cursor.primaryKey, size: cursor.value.size || 0 });
      cursor.continue();
    };
    request.onerror = () => resolve([]);
  });
  let total = rows.reduce((sum, row) => sum + row.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  await new Promise(resolve => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const row of rows) {
      if (total <= MAX_CACHE_BYTES * 0.8) break;
      store.delete(row.key);
      total -= row.size;
    }
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

async function decodeTerrarium(blob) {
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function")
    throw new Error("This browser cannot decode terrain tiles. Update Safari, Chrome, or Firefox and try again.");
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const out = new Int16Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const elevation = rgba[j] * 256 + rgba[j + 1] + rgba[j + 2] / 256 - 32768;
    out[i] = elevation > 0 ? Math.round(elevation) : 0;
  }
  return out;
}

async function fetchTile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return SEA_TILE;
  x = ((x % n) + n) % n;
  const url = `${BASE}/${z}/${x}/${y}.png`;
  let blob = await cacheRead(url);
  if (!blob) {
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok) throw new Error(`Terrain tile ${z}/${x}/${y}: HTTP ${response.status}`);
    blob = await response.blob();
    await cacheWrite(url, blob);
  }
  return decodeTerrarium(blob);
}

async function loadMosaic({ lat, lon, halfSpan, z, onTile }) {
  const { x0, x1, y0, y1 } = mosaicBounds(lat, lon, halfSpan, z);
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  const W = cols * TS, H = rows * TS;
  const data = new Int16Array(W * H);
  const jobs = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
  let failed = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      let tile;
      try { tile = await fetchTile(z, tx, ty); }
      catch { tile = SEA_TILE; failed++; }
      const ox = (tx - x0) * TS, oy = (ty - y0) * TS;
      for (let r = 0; r < TS; r++) data.set(tile.subarray(r * TS, r * TS + TS), (oy + r) * W + ox);
      onTile?.();
    }
  }));
  const px0 = x0 * TS, py0 = y0 * TS;
  const rowLat = new Float64Array(H), colLon = new Float64Array(W);
  for (let r = 0; r < H; r++) rowLat[r] = px2lat(py0 + r + 0.5, z);
  for (let c = 0; c < W; c++) colLon[c] = px2lon(px0 + c + 0.5, z);
  function sampleAtPx(gx, gy) {
    const fx = gx - px0, fy = gy - py0;
    if (fx < 0 || fy < 0 || fx >= W - 1 || fy >= H - 1) return 0;
    const xi = fx | 0, yi = fy | 0, tx = fx - xi, ty = fy - yi;
    const i = yi * W + xi;
    const a = data[i], b = data[i + 1], c = data[i + W], d = data[i + W + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
  return {
    z, W, H, px0, py0, data, rowLat, colLon, failed, tiles: jobs.length,
    mPerPx: mPerPx(lat, z), sampleAtPx,
    sample: (la, lo) => sampleAtPx(lon2px(lo, z), lat2px(la, z)),
  };
}

function buildTerrainModel(mosaics, { lat, lon, radius, n = 257, nested = true }) {
  const z = mosaics[mosaics.length - 1].z;
  const scale = mPerPx(lat, z), half = radius / scale;
  const cx = lon2px(lon, z), cy = lat2px(lat, z);
  const heights = new Array(n * n);
  const tiers = [...mosaics].sort((a, b) => b.z - a.z);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (2 * x / (n - 1) - 1) * half;
    const dy = (2 * y / (n - 1) - 1) * half;
    const la = px2lat(cy + dy, z), lo = px2lon(cx + dx, z);
    const distance = Math.hypot(dx, dy) * scale;
    const tier = tiers.find(t => distance <= t.rOut) || tiers[tiers.length - 1];
    heights[y * n + x] = Math.round(Math.max(0, tier.sample(la, lo)));
  }
  const patches = [];
  const nativeSpacing = mPerPx(lat, tiers[0].z);
  if (nested && n === 257) {
    for (let span = radius / 2; span * 2 >= 128 * nativeSpacing && patches.length < 8; span /= 2) {
      const patch = buildTerrainModel(mosaics, { lat, lon, radius: span, n, nested: false });
      patches.push({ radius: span, heights: patch.heights });
    }
  }
  return { n, z, cx, cy, half, radius, lat0: lat, lon0: lon, heights, patches,
    failed: mosaics.reduce((sum, m) => sum + m.failed, 0) };
}

function resolveObserver(ground, eye, photoAltitude) {
  const floor = ground + eye;
  if (!Number.isFinite(photoAltitude)) return { altitude: floor, source: "ground" };
  return { altitude: Math.max(floor, photoAltitude), source: photoAltitude < floor ? "ground-clamped" : "photo" };
}

async function computeProfile(options) {
  const lat = Number(options.lat), lon = Number(options.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 80)
    throw new Error("Latitude must be within +/-80 degrees.");
  const radius = clamp(Number(options.radius ?? 50000), 2000, 250000);
  const eye = clamp(Number(options.eye ?? 1.6), 0, 5000);
  const rays = clamp(Number(options.rays ?? 1440), 180, 5760) | 0;
  const k = clamp(Number(options.k ?? 0.13), 0, 0.5);
  const prom = clamp(Number(options.prom ?? 0.15), 0, 10);
  const tiers = planTiers(radius);
  const total = tiers.reduce((n, t) => n + tileCount(lat, lon, t.rOut, t.z), 0);
  let done = 0, lastProgress = 0;
  postMessage({ type: "progress", data: { phase: "tiles", done, total } });
  const started = performance.now(), mosaics = [];
  for (const tier of tiers) {
    const mosaic = await loadMosaic({ lat, lon, halfSpan: tier.rOut, z: tier.z, onTile: () => {
      done++;
      const now = performance.now();
      if (done === total || now - lastProgress > 120) {
        lastProgress = now;
        postMessage({ type: "progress", data: { phase: "tiles", done, total } });
      }
    } });
    mosaics.push(Object.assign(mosaic, { rIn: tier.rIn, rOut: tier.rOut }));
  }
  const tileMs = performance.now() - started;
  const ground = mosaics[0].sample(lat, lon);
  const baseGround = Number.isFinite(Number(options.groundOverride)) ? Number(options.groundOverride) : ground;
  const observer = resolveObserver(baseGround, eye, Number(options.photoAltitude));
  postMessage({ type: "progress", data: { phase: "sweep" } });
  const sweepStarted = performance.now();
  const sweep = HorizonCore.sweep(mosaics, { lat, lon, hObs: observer.altitude, rays, k, prom });
  const sweepMs = performance.now() - sweepStarted;
  const profile = HorizonCore.toJSON(sweep, {
    lat0: +lat.toFixed(6), lon0: +lon.toFixed(6), radius, eye,
    ground: +ground.toFixed(1), observerSource: observer.source,
    tiers: tiers.map((tier, i) => ({ z: tier.z, rIn: Math.round(tier.rIn), rOut: Math.round(tier.rOut),
      tiles: mosaics[i].tiles, failed: mosaics[i].failed, mPerPx: +mosaics[i].mPerPx.toFixed(1) })),
    ms: { tiles: Math.round(tileMs), sweep: Math.round(sweepMs), relief: 0 },
  });
  const terrain = buildTerrainModel(mosaics, { lat, lon, radius });
  return { profile, terrain };
}

self.onmessage = async event => {
  if (event.data?.type !== "compute") return;
  try {
    const result = await computeProfile(event.data.options || {});
    postMessage({ type: "result", data: result.profile });
    postMessage({ type: "terrain", data: result.terrain });
    postMessage({ type: "complete" });
    trimCache().catch(() => {});
  } catch (error) {
    postMessage({ type: "failed", data: { error: error?.message || String(error) } });
  }
};
