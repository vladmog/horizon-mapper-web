"use strict";
// The horizon sweep.
//
// A skyline is an argmax, not a ray-march: the visible horizon in a direction
// is simply the largest elevation angle any terrain in that direction attains.
// That is order-independent, so none of the occlusion machinery a ray-casting
// or R2-style sweep exists to provide buys anything here. So instead of casting
// rays outward -- which at 100 km would sample under 7% of the cells at that
// range, with *which* 7% shifting as the observer's GPS jitters by a few metres
// -- every DEM cell is visited exactly once and scattered into the azimuth bins
// it subtends. Nothing can be missed and the result is deterministic.
//
// The skyline is not the only thing you can see, though. Stand anywhere with
// relief and you are looking at a foreground hill, a ridge behind it, and a
// range behind that -- and a plain argmax keeps only whichever won, discarding
// the two lines in front of it. So the scatter now bins by DISTANCE as well as
// azimuth, and a second pass walks each bearing outward to pull out every crest
// that is actually visible.
//
// The visibility rule is one line: walking outward, a crest is visible exactly
// when its elevation angle exceeds the running maximum of everything nearer.
// That is not an approximation of line-of-sight, it IS line-of-sight -- the ray
// from the eye to a point holds a constant elevation angle, so it clears the
// ground at every nearer distance iff that angle beats all of them. Note this
// is an angle, never an altitude: el() already folds in the observer's own
// height, the range, and the curvature drop, so a 500 m peak at 20 km sits
// BELOW a 100 m hill at 1 km and is correctly hidden behind it.
//
// The one thing needing care is that on a continuously climbing slope every
// sample sets a new running maximum, which would emit a layer per sample. What
// separates two hilltops from one slope is that the land must fall back down in
// between, so a crest is kept only if the profile dips PROM below it before the
// next higher crest rises -- angular topographic prominence, measured from where
// you stand.

const R_EARTH = 6371008.8;
const DEG = 180 / Math.PI, RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// Distance shells for the scatter. Log-spaced, so resolution is a constant
// FRACTION of range -- the same reasoning that gives the tile tiers their three
// zooms. 256 shells from 10 m to 262 km is about 4% per shell, which separates
// a hill at 2 km from a range at 34 km by 68 of them.
const DBINS = 256;
const D0 = 10, DMAX = 262144;
const KQ = DBINS / Math.log(DMAX / D0), INV_D0 = 1 / D0;
function qOf(d) {
  const q = Math.log(d * INV_D0) * KQ | 0;
  return q < 0 ? 0 : q >= DBINS ? DBINS - 1 : q;
}

// Purely a payload guard -- the terrain decides the real count, and it is
// usually one or two. When it bites, the NEAREST layers go: they are the lowest
// on the chart and the least informative.
const MAX_LAYERS = 8;

// How close a crest may be and still open a line of its own.
//
// Nothing stops the walk from finding crests a few tens of metres away, and
// measured from Twin Peaks the median was 39 m -- which is not a landform, it is
// the ground underfoot. Two things conspire there. The DEM's finest tier is 15 m
// cells, so a "hilltop" at 40 m is two or three samples of interpolation noise;
// and a cell that close subtends about 19 deg, so the splat paints one elevation
// across dozens of azimuth bins and neighbouring cells at slightly different
// ranges lay overlapping arcs that read as a staircase. Neither is terrain.
//
// 200 m is about thirteen cells of the finest tier, the point where a shape is
// actually resolved rather than inferred. Near ground still OCCLUDES from minD
// outward -- it is only barred from being called a hilltop -- and the skyline
// itself is exempt, so layer 0 is bit-for-bit what the single-line sweep gave.
const LAYER_MIN_D = 200;
const SEA = -2;          // cMos sentinel for the analytic sea horizon

const wrapPi = a => {
  a %= TWO_PI;
  if (a > Math.PI) a -= TWO_PI; else if (a < -Math.PI) a += TWO_PI;
  return a;
};

// Great-circle distance, for resolving a surviving crest's exact range. The
// shell it landed in is only 4% precise; the cell itself is not.
function gcDist(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const sdp = Math.sin((p2 - p1) / 2);
  const sdl = Math.sin(wrapPi((lon2 - lon1) * RAD) / 2);
  const a = sdp * sdp + Math.cos(p1) * Math.cos(p2) * sdl * sdl;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * @param mosaics  tier mosaics from terrain.loadMosaic(), each tagged {rIn,rOut}
 * @param lat,lon  observer
 * @param hObs     eye elevation above sea level, metres
 * @param rays     azimuth bins (1440 = 0.25 deg)
 * @param k        refraction coefficient (0.13 = standard atmosphere)
 * @param prom     angular prominence a crest needs to count, degrees
 */
function sweep(mosaics, { lat, lon, hObs, rays = 1440, k = 0.13, prom = 0.15 }) {
  // Light bends downward, so the earth behaves flatter than it is. This
  // effective radius belongs ONLY in the curvature drop -- arc distances are
  // physical and must use the true radius. Conflating the two inflates every
  // distance by 15% and sinks marginal distant features below the horizon.
  const rEff = R_EARTH / (1 - k);
  const PROM = prom * RAD;

  // Laid out [q * rays + b], NOT [b * DBINS + q]. One cell has one distance, so
  // the splat's inner loop walks b with q fixed; this way those writes are
  // sequential instead of striding by DBINS every time.
  // Float64, not Float32. The angles themselves would survive the narrower type
  // -- the payload rounds to 0.001 deg and the error is 1e-7 -- but rounding to
  // Float32 makes near-equal cells compare EQUAL, which changes which one wins a
  // bin. Measured at Ocean Beach that moved the named ground on 53 of 1440
  // bearings. Layer 0 has to stay the old sweep's answer exactly, so the extra
  // 1.5 MB buys tie-break parity.
  const N = DBINS * rays;
  const cAng = new Float64Array(N).fill(-Infinity);
  const cSrc = new Int32Array(N);
  const cMos = new Int8Array(N).fill(-1);

  const phi1 = lat * RAD;
  const sinP1 = Math.sin(phi1), cosP1 = Math.cos(phi1);
  const binsPerRad = rays / TWO_PI;
  const maxSpan = rays >> 2;

  for (let mi = 0; mi < mosaics.length; mi++) {
    const m = mosaics[mi];
    const { W, H, data, rowLat, colLon, rIn, rOut } = m;

    // Per-column longitude terms. Longitude is linear in the mosaic, so these
    // are shared by every row.
    const sinDl = new Float64Array(W), cosDl = new Float64Array(W);
    const hvLon = new Float64Array(W);
    for (let c = 0; c < W; c++) {
      const dl = wrapPi((colLon[c] - lon) * RAD);
      sinDl[c] = Math.sin(dl); cosDl[c] = Math.cos(dl);
      const s = Math.sin(dl / 2);
      hvLon[c] = s * s;
    }

    for (let r = 0; r < H; r++) {
      const phi2 = rowLat[r] * RAD;
      const sinP2 = Math.sin(phi2), cosP2 = Math.cos(phi2);
      const sdp = Math.sin((phi2 - phi1) / 2);
      const hvLat = sdp * sdp;
      const cc = cosP1 * cosP2;
      const A = cosP1 * sinP2, B = sinP1 * cosP2;

      // Cheap row reject: the closest point in this row is directly north or
      // south of the observer.
      const rowD = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(hvLat)));
      if (rowD > rOut) continue;

      // Cell size in metres at this latitude, for the angular width below.
      const cell = m.mPerPx * (cosP2 / Math.max(1e-6, Math.cos(lat * RAD)));
      const halfDiag = cell * 0.7071;
      const minD = cell * 1.5;      // never let the observer's own cell occlude

      const base = r * W;
      for (let c = 0; c < W; c++) {
        const h = data[base + c];

        const a = hvLat + cc * hvLon[c];
        const d = 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
        if (d < rIn || d > rOut || d < minD) continue;

        // Curvature plus refraction. The flat-drop form is accurate to 0.015
        // deg worst case (short range to a high target), a fraction of one bin.
        const el = Math.atan2(h - hObs - (d * d) / (2 * rEff), d);

        // True great-circle bearing. A local flat frame would accumulate 0.46
        // deg of meridian convergence at 100 km -- about two bins of systematic
        // azimuth error -- and Mercator gives a rhumb line, not a sight line.
        const th = Math.atan2(sinDl[c] * cosP2, A - B * cosDl[c]);

        const cf = th * binsPerRad;
        // A cell subtends real angular width. Splatting only its centre bin
        // leaves the near field full of holes: at 1 km a 30 m cell covers 6.5
        // bins, and inside ~100 m there are fewer cells than bins.
        let hs = (halfDiag / d) * binsPerRad;
        if (hs > maxSpan) hs = maxSpan;

        // One log per surviving cell, against the asin, sqrt and two atan2s
        // already here. It is not the cost driver.
        const off = qOf(d) * rays, idx = base + c;

        let i0 = Math.floor(cf - hs), i1 = Math.ceil(cf + hs);
        for (let i = i0; i <= i1; i++) {
          const b = ((i % rays) + rays) % rays;
          const s = off + b;
          if (el > cAng[s]) { cAng[s] = el; cSrc[s] = idx; cMos[s] = mi; }
        }
      }
    }
  }

  // The sea horizon, injected as a synthetic cell at its own distance rather
  // than stamped over the finished result.
  //
  // With terrain clamped at sea level the dip emerges on its own only where the
  // grid reaches past the geometric horizon -- which it does not for a high
  // observer. At 2000 m with a 100 km radius the sweep alone would report
  // -0.24 deg where the truth is -1.34 deg.
  //
  // Putting it in BEFORE the crest walk rather than after it is what makes the
  // coastal case come out right. Stamped over the top, near land lower than the
  // distant sea horizon -- a beach at -1.5 deg under a dip of -1.34 deg -- was
  // simply overwritten and vanished. Injected, the walk sees both and keeps the
  // beach as its own nearer layer below the horizon line, which is what you
  // actually see from a cliff. Land BEYOND the dip distance and below it is
  // occluded by the sea crest and correctly dropped.
  const dip = Math.acos(rEff / (rEff + Math.max(0, hObs)));
  const dipDist = Math.sqrt(Math.max(0, 2 * rEff * hObs));
  {
    const off = qOf(Math.max(D0, dipDist)) * rays;
    for (let b = 0; b < rays; b++) {
      const s = off + b;
      if (-dip > cAng[s]) { cAng[s] = -dip; cMos[s] = SEA; cSrc[s] = 0; }
    }
  }

  // Walk each bearing outward and pull out the visible crests.
  const perBin = new Array(rays);
  let maxL = 1;
  const qs = new Int32Array(DBINS);
  const qMin = qOf(LAYER_MIN_D);
  for (let b = 0; b < rays; b++) {
    let mmax = -Infinity, peakQ = -1, low = Infinity, n = 0;

    for (let q = 0; q < DBINS; q++) {
      const a = cAng[q * rays + b];
      if (a === -Infinity) continue;          // no data in this shell
      if (a > mmax) {
        // Something has risen above everything nearer, so it is visible. The
        // crest we were holding was a real hilltop only if the land fell PROM
        // below it before this rose -- otherwise it was a shoulder on one
        // continuous climb and belongs to the same line.
        if (peakQ >= qMin && mmax - low >= PROM) qs[n++] = peakQ;
        mmax = a; peakQ = q; low = a;
      } else if (a < low) low = a;
    }
    if (peakQ >= 0) qs[n++] = peakQ;          // the skyline, always

    // Far to near, so index 0 is the skyline and the array reads top-down the
    // way the chart draws it. The cap drops the nearest.
    const out = [];
    for (let j = n - 1; j >= 0 && out.length < MAX_LAYERS; j--) {
      const q = qs[j], s = q * rays + b, mi = cMos[s], ang = cAng[s];
      if (mi === SEA) {
        const [la, lo] = destination(lat, lon, b / binsPerRad, dipDist, R_EARTH);
        out.push({ ang, dist: dipDist, elev: 0, lat: la, lon: lo, z: 0 });
      } else {
        const m = mosaics[mi], idx = cSrc[s];
        const rr = (idx / m.W) | 0, cc2 = idx - rr * m.W;
        const la = m.rowLat[rr], lo = m.colLon[cc2];
        out.push({
          ang, dist: gcDist(lat, lon, la, lo),
          elev: m.data[idx], lat: la, lon: lo, z: m.z,
        });
      }
    }
    if (out.length > maxL) maxL = out.length;
    perBin[b] = out;
  }

  // Struct-of-arrays. Layer 0 keeps the exact shape the single-line sweep had,
  // so everything downstream that only wants the skyline is untouched.
  const ang = new Float64Array(rays);
  const dst = new Float64Array(rays);
  const elv = new Float64Array(rays);
  const bLat = new Float64Array(rays);
  const bLon = new Float64Array(rays);
  const bZ = new Int16Array(rays);

  // The nearer layers ride along ragged rather than as maxL parallel arrays
  // padded with nulls. Layer count varies hugely with terrain -- from Mt
  // Davidson most bearings carry one or two and a handful carry eight -- so the
  // padded shape would size every array to the worst bearing and spend two
  // thirds of the payload saying "null". n[b] is the count for bearing b and the
  // value arrays are bearing-major, top-down within a bearing.
  const sn = new Int16Array(rays);
  let tot = 0;
  for (let b = 0; b < rays; b++) tot += perBin[b].length - 1;
  const sAng = new Float64Array(tot), sDst = new Float64Array(tot);
  const sElv = new Float64Array(tot), sLat = new Float64Array(tot);
  const sLon = new Float64Array(tot), sZ = new Int16Array(tot);

  let p = 0;
  for (let b = 0; b < rays; b++) {
    const out = perBin[b], t = out[0];
    ang[b] = t.ang; dst[b] = t.dist; elv[b] = t.elev;
    bLat[b] = t.lat; bLon[b] = t.lon; bZ[b] = t.z;
    sn[b] = out.length - 1;
    for (let s = 1; s < out.length; s++, p++) {
      const o = out[s];
      sAng[p] = o.ang; sDst[p] = o.dist; sElv[p] = o.elev;
      sLat[p] = o.lat; sLon[p] = o.lon; sZ[p] = o.z;
    }
  }

  return {
    rays, k, prom, hObs, subMax: maxL - 1,
    ang, dist: dst, elev: elv, lat: bLat, lon: bLon, z: bZ,
    sub: { n: sn, ang: sAng, dist: sDst, elev: sElv, lat: sLat, lon: sLon, z: sZ },
  };
}

// Great-circle destination point, for the sea-horizon bins.
function destination(lat, lon, azRad, d, R) {
  const p1 = lat * RAD, l1 = lon * RAD, dr = d / R;
  const sp = Math.sin(p1), cp = Math.cos(p1);
  const sd = Math.sin(dr), cd = Math.cos(dr);
  const p2 = Math.asin(sp * cd + cp * sd * Math.cos(azRad));
  const l2 = l1 + Math.atan2(Math.sin(azRad) * sd * cp, cd - sp * Math.sin(p2));
  return [p2 * DEG, ((l2 * DEG + 540) % 360) - 180];
}

// Struct-of-arrays, trimmed to what the display can use. Azimuth is implicit --
// bin i is i * 360 / rays. The nearer layers ride along in `sub`, indexed from
// the TOP within each bearing: the first is the line just below the skyline.
// Indexing from the top is what keeps layer 0 byte-identical to the old
// single-line payload, so nothing that only wants the skyline has to learn about
// layers at all.
function toJSON(s, extra = {}) {
  const S = s.sub;
  return Object.assign({
    rays: s.rays,
    k: s.k,
    prom: s.prom,
    hObs: +s.hObs.toFixed(1),
    ang: Array.from(s.ang, v => +(v * DEG).toFixed(3)),
    dist: Array.from(s.dist, v => Math.round(v)),
    elev: Array.from(s.elev, v => Math.round(v)),
    lat: Array.from(s.lat, v => +v.toFixed(5)),
    lon: Array.from(s.lon, v => +v.toFixed(5)),
    z: Array.from(s.z),
    subMax: s.subMax,
    sub: {
      n: Array.from(S.n),
      ang: Array.from(S.ang, v => +(v * DEG).toFixed(3)),
      dist: Array.from(S.dist, v => Math.round(v)),
      elev: Array.from(S.elev, v => Math.round(v)),
      lat: Array.from(S.lat, v => +v.toFixed(5)),
      lon: Array.from(S.lon, v => +v.toFixed(5)),
      z: Array.from(S.z),
    },
  }, extra);
}

self.HorizonCore = { sweep, toJSON, destination, R_EARTH };
