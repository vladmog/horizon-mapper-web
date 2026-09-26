"use strict";
const NamedPeaks = (() => {
  const RAD = Math.PI / 180;
  function distance(a, b) {
    const x = Math.sin((b.lat - a.lat) * RAD / 2), y = Math.sin((b.lon - a.lon) * RAD / 2);
    return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(x*x + Math.cos(a.lat*RAD)*Math.cos(b.lat*RAD)*y*y)));
  }
  // Match actual visible DEM crest coordinates, never just a similar bearing.
  // A hidden mountain behind the selected ridge must not lend that ridge its name.
  function match(profile, peaks) {
    const records = [], result = [];
    let j = 0;
    for (let b = 0; b < profile.rays; b++) {
      for (let layer = 0; layer <= profile.sub.n[b]; layer++) {
        const source = layer ? profile.sub : profile, i = layer ? j++ : b;
        const tier = profile.tiers.find(t => t.z === source.z[i]);
        if (!tier || tier.failed) continue; // Missing terrain cannot establish a match.
        records.push({ bin: b, layer, lat: source.lat[i], lon: source.lon[i],
          ang: source.ang[i], dist: source.dist[i], elev: source.elev[i],
          tolerance: Math.min(300, Math.max(60, tier.mPerPx * 2)) });
      }
    }
    const origin = { lat: profile.lat0, lon: profile.lon0 };
    for (const peak of peaks) {
      const range = distance(origin, peak);
      if (range < 200 || range > profile.radius) continue;
      let best = null, error = Infinity;
      for (const record of records) {
        if (Math.abs(record.dist - range) > record.tolerance) continue;
        const gap = distance(peak, record);
        if (gap <= record.tolerance && gap < error) { best = record; error = gap; }
      }
      if (best) result.push({ ...peak, ...best, summitLat: peak.lat, summitLon: peak.lon,
        bearing: best.bin * 360 / profile.rays, matchDistance: Math.round(error) });
    }
    // Resolve two names competing for the same displayed crest conservatively.
    result.sort((a,b) => a.matchDistance - b.matchDistance);
    const used = new Set();
    return result.filter(p => {
      const key = `${p.bin}/${p.layer}`;
      if (used.has(key)) return false;
      used.add(key); return true;
    }).sort((a,b) => a.bearing - b.bearing);
  }
  function layout(peaks, projectX, projectY, width, height, measure, selectedId) {
    const boxes = [];
    for (const peak of [...peaks].sort((a,b) => (b.id === selectedId) - (a.id === selectedId) || a.dist-b.dist)) {
      const x = projectX(peak.bearing), y = projectY(peak.ang);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 5 || x > width-5 || y < 35 || y > height-5) continue;
      const label = peak.name.length > 24 ? peak.name.slice(0,23) + "…" : peak.name;
      const w = Math.min(width-12, measure(label)+14), left = Math.max(6, Math.min(width-w-6, x-w/2));
      for (let row = 0; row < 3; row++) {
        const top = Math.max(28, y-30-row*24);
        if (top+20 > y-5 || boxes.some(b => left < b.left+b.w+5 && left+w+5 > b.left && top < b.top+24 && top+24 > b.top)) continue;
        boxes.push({ peak, label, x, y, left, top, w }); break;
      }
    }
    return boxes;
  }
  return { match, layout, distance };
})();
if (typeof module !== "undefined") module.exports = NamedPeaks;
