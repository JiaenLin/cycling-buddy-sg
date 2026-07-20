// Build data/rideable.lines.geojson — the cycling paths the ROUTER can use that are NOT already
// drawn by the LTA/NParks display layers (cpn/pcn/rail). Rendering these in the SAME colour as the
// cycling-path layer (and UNDER the PCN/LTA layers, so true overlaps hide beneath them) makes the
// map consistent with routing: what you see is what you can ride. Source is the OSM-derived routing
// graph (data/graph.json), so display and routing share one source by construction.
//
// Coverage is a PERPENDICULAR-DISTANCE test (in metres) against the displayed lines: an OSM edge is
// "already shown" only where it runs within TOL metres of a drawn line. A path that runs parallel to
// or diverges from the PCN by more than TOL is kept — that was the v29 miss (a coarse ~33 m grid
// dropped divergent-but-nearby paths). Because the layer draws beneath the PCN/LTA lines, coincident
// bits are hidden anyway, so TOL only needs to catch true duplicates for size, not visual de-dup.
//
// Usage: node build/build_rideable.mjs [--scope=infra|all] [--tol=12]
//   infra = OSM cycleway(0) + any PCN-flagged edge   (clearest cycling infra; default)
//   all   = + OSM path(1) + track(6)                 (fuller, includes informal trails)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const a = process.argv.find(v => v.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const scope = arg('scope', 'infra');
const TOL = Number(arg('tol', '25'));                 // metres: coincident-with-a-shown-line threshold (keeps paths that diverge further)
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/graph.json'), 'utf8'));
const N = g.nodes;

// Local equirectangular metre plane at Singapore (good to <0.1% over the island).
const MLAT = 110574, MLNG = 111320 * Math.cos(1.35 * Math.PI / 180);
const X = lng => lng * MLNG, Y = lat => lat * MLAT;
const dist = (a, b) => Math.hypot(X(a[0]) - X(b[0]), Y(a[1]) - Y(b[1]));

// Spatial index of displayed segments, bucketed on a TOL-metre grid.
const B = TOL; const bkey = (mx, my) => Math.floor(mx / B) + '_' + Math.floor(my / B);
const grid = new Map();
function addSeg(p, q) {
  const seg = [X(p[0]), Y(p[1]), X(q[0]), Y(q[1])];   // ax,ay,bx,by in metres
  const steps = Math.max(1, Math.ceil(Math.hypot(seg[2] - seg[0], seg[3] - seg[1]) / B));
  const seen = new Set();
  for (let s = 0; s <= steps; s++) {
    const mx = seg[0] + (seg[2] - seg[0]) * s / steps, my = seg[1] + (seg[3] - seg[1]) * s / steps, k = bkey(mx, my);
    if (seen.has(k)) continue; seen.add(k);
    (grid.get(k) || grid.set(k, []).get(k)).push(seg);
  }
}
for (const f of ['data/cpn.lines.geojson', 'data/pcn.lines.geojson', 'data/rail.lines.geojson']) {
  const gj = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const ft of gj.features) {
    const gm = ft.geometry; if (!gm) continue;
    const parts = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : [];
    for (const c of parts) for (let i = 1; i < c.length; i++) addSeg(c[i - 1], c[i]);
  }
}
function ptSegDist(px, py, s) {                        // point (metres) to segment distance (metres)
  const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - s[0]) * dx + (py - s[1]) * dy) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
}
function nearDrawn(lng, lat) {                         // within TOL m of any displayed line?
  const px = X(lng), py = Y(lat), bx = Math.floor(px / B), by = Math.floor(py / B);
  for (let ix = -1; ix <= 1; ix++) for (let iy = -1; iy <= 1; iy++) {
    const cell = grid.get((bx + ix) + '_' + (by + iy)); if (!cell) continue;
    for (const s of cell) if (ptSegDist(px, py, s) <= TOL) return true;
  }
  return false;
}
function coveredFraction(coords) {                     // fraction of length within TOL m of a shown line
  let tot = 0, cov = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i], d = dist(a, b), steps = Math.max(1, Math.ceil(d / (TOL * 0.5)));
    for (let s = 0; s <= steps; s++) { const lng = a[0] + (b[0] - a[0]) * s / steps, lat = a[1] + (b[1] - a[1]) * s / steps; tot++; if (nearDrawn(lng, lat)) cov++; }
  }
  return cov / tot;
}

const inScope = (cls, pcn) => scope === 'all' ? (cls === 0 || cls === 1 || cls === 6 || pcn) : (cls === 0 || pcn);
const missEdges = [];
for (const e of g.edges) {
  const cls = e[2]|0, pcn = e[3]?1:0; if (!inScope(cls, pcn)) continue;
  const co = [N[e[0]]]; const gi = e[4]||[]; for (let k = 0; k < gi.length; k += 2) co.push([gi[k], gi[k+1]]); co.push(N[e[1]]);
  if (coveredFraction(co) < 0.7) missEdges.push({ a: e[0], b: e[1], coords: co });   // keep unless mostly coincident
}

// Stitch chains at degree-2 joins → long polylines instead of thousands of stubs (size + render win).
const deg = new Map(); for (const e of missEdges) { deg.set(e.a, (deg.get(e.a)||0)+1); deg.set(e.b, (deg.get(e.b)||0)+1); }
const byNode = new Map(); const add = (n, i) => (byNode.get(n) || byNode.set(n, []).get(n)).push(i);
missEdges.forEach((e, i) => { add(e.a, i); add(e.b, i); });
const used = new Array(missEdges.length).fill(false);
function walk(idx, node) {
  const line = [];
  for (;;) {
    used[idx] = true;
    const e = missEdges[idx], seg = e.a === node ? e.coords : e.coords.slice().reverse();
    if (line.length) seg.shift(); line.push(...seg);
    const next = e.a === node ? e.b : e.a;
    if (deg.get(next) !== 2) break;
    const cand = byNode.get(next).find(j => !used[j]);
    if (cand == null) break;
    idx = cand; node = next;
  }
  return line;
}
const chains = [];
for (let i = 0; i < missEdges.length; i++) { if (used[i]) continue; const e = missEdges[i]; if (deg.get(e.a) !== 2) chains.push(walk(i, e.a)); else if (deg.get(e.b) !== 2) chains.push(walk(i, e.b)); }
for (let i = 0; i < missEdges.length; i++) if (!used[i]) chains.push(walk(i, missEdges[i].a));

// Douglas–Peucker (~SIMP m) then round to 5 dp.
const TOLD = Number(arg('simp', '8')) / 111320;
function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0; const a = pts[0], b = pts[pts.length-1], dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx+dy*dy || 1e-18;
  for (let i = 1; i < pts.length-1; i++) { const t = ((pts[i][0]-a[0])*dx + (pts[i][1]-a[1])*dy) / L2, px = a[0]+t*dx, py = a[1]+t*dy, d = Math.hypot(pts[i][0]-px, pts[i][1]-py); if (d > maxD) { maxD = d; idx = i; } }
  if (maxD <= tol) return [a, b];
  return rdp(pts.slice(0, idx+1), tol).slice(0, -1).concat(rdp(pts.slice(idx), tol));
}
const r5 = v => Math.round(v*1e5)/1e5;
let totalM = 0;
const features = chains.map(line => {
  const s = rdp(line, TOLD).map(p => [r5(p[0]), r5(p[1])]);
  for (let i = 1; i < s.length; i++) totalM += dist(s[i-1], s[i]);
  return { type: 'Feature', properties: { kind: 'cycling' }, geometry: { type: 'LineString', coordinates: s } };
}).filter(f => f.geometry.coordinates.length >= 2);

fs.writeFileSync(path.join(ROOT, 'data/rideable.lines.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
const meta = {
  source: 'OpenStreetMap via the routing graph (data/graph.json)',
  licence: 'ODbL 1.0 (OpenStreetMap contributors)',
  description: 'Cycling paths usable for routing that are not covered by the LTA/NParks display layers; rendered in the cycling-path colour so the map matches what the router can ride.',
  scope, coverageTolerance_m: TOL, features: features.length, km: Math.round(totalM / 1000), simplify_m: 4, builtFrom: 'data/graph.json'
};
fs.writeFileSync(path.join(ROOT, 'data/rideable.meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`scope=${scope} tol=${TOL}m: ${missEdges.length} missing edges → ${features.length} polylines, ${meta.km} km`);
console.log(`rideable.lines.geojson: ${fs.statSync(path.join(ROOT, 'data/rideable.lines.geojson')).size.toLocaleString()} bytes`);
