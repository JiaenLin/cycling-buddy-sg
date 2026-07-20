// Build data/rideable.lines.geojson — the cycling paths the ROUTER can use that are NOT already
// drawn by the LTA/NParks display layers (cpn/pcn/rail). Rendering these "missing" segments in the
// SAME colour as the cycling-path layer makes the map consistent with routing: what you see is what
// you can ride. Source is the OSM-derived routing graph (data/graph.json), so display and routing
// share one source by construction.
//
// Usage: node build/build_rideable.mjs [--scope all|infra]
//   all   = OSM cycleway(0) + path(1) + track(6) + any PCN-flagged edge   (fullest coverage)
//   infra = OSM cycleway(0) + PCN-flagged only                            (clearest cycling infra)
//
// The output is optimised for size: missing edges are stitched into long polylines at degree-2
// joins, simplified (Douglas–Peucker ~4 m), and rounded to 5 dp (~1 m). Prints the byte size so the
// asset budget decision is explicit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scope = (process.argv.find(a => a.startsWith('--scope='))?.slice(8)) || 'all';
const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/graph.json'), 'utf8'));
const N = g.nodes;

const CELL = 0.0002;                                   // ~22 m grid; dilated ±1 cell → ~40 m tolerance
const occ = new Set();
const km = (a, b) => { const R = 6371000, r = Math.PI / 180, dx = (b[0]-a[0])*r*Math.cos((a[1]+b[1])/2*r), dy = (b[1]-a[1])*r; return Math.hypot(dx, dy) * R; };
function markLine(coords) {
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i-1], b = coords[i], d = Math.max(Math.hypot(b[0]-a[0], b[1]-a[1]), 1e-9), steps = Math.ceil(d / (CELL*0.5));
    for (let s = 0; s <= steps; s++) {
      const x = a[0]+(b[0]-a[0])*s/steps, y = a[1]+(b[1]-a[1])*s/steps, cx = Math.round(x/CELL), cy = Math.round(y/CELL);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) occ.add((cx+dx)+'_'+(cy+dy));
    }
  }
}
for (const f of ['data/cpn.lines.geojson', 'data/pcn.lines.geojson', 'data/rail.lines.geojson']) {
  const gj = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const ft of gj.features) {
    const gm = ft.geometry; if (!gm) continue;
    const parts = gm.type === 'LineString' ? [gm.coordinates] : gm.type === 'MultiLineString' ? gm.coordinates : [];
    for (const c of parts) markLine(c);
  }
}
const key = (x, y) => Math.round(x/CELL)+'_'+Math.round(y/CELL);
function coverage(coords) {
  let tot = 0, cov = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i-1], b = coords[i], d = Math.max(Math.hypot(b[0]-a[0], b[1]-a[1]), 1e-9), steps = Math.ceil(d / (CELL*0.5));
    for (let s = 0; s <= steps; s++) { const x = a[0]+(b[0]-a[0])*s/steps, y = a[1]+(b[1]-a[1])*s/steps; tot++; if (occ.has(key(x, y))) cov++; }
  }
  return cov / tot;
}

const inScope = (cls, pcn) => scope === 'infra' ? (cls === 0 || pcn) : (cls === 0 || cls === 1 || cls === 6 || pcn);
// Collect the "missing" edges as node-pair chains keyed by endpoints so we can stitch them.
const missEdges = [];                                  // {a,b, coords}
for (const e of g.edges) {
  const cls = e[2]|0, pcn = e[3]?1:0; if (!inScope(cls, pcn)) continue;
  const co = [N[e[0]]]; const gi = e[4]||[]; for (let k = 0; k < gi.length; k += 2) co.push([gi[k], gi[k+1]]); co.push(N[e[1]]);
  if (coverage(co) < 0.5) missEdges.push({ a: e[0], b: e[1], coords: co });
}

// Stitch chains: join edges at nodes where exactly two missing edges meet (degree 2), so the output
// is a handful of long polylines instead of thousands of 2-point stubs (big size + render win).
const deg = new Map(); for (const e of missEdges) { deg.set(e.a, (deg.get(e.a)||0)+1); deg.set(e.b, (deg.get(e.b)||0)+1); }
const byNode = new Map(); const add = (n, i) => { (byNode.get(n) || byNode.set(n, []).get(n)).push(i); };
missEdges.forEach((e, i) => { add(e.a, i); add(e.b, i); });
const used = new Array(missEdges.length).fill(false);
function walk(startIdx, startNode) {
  const line = []; let node = startNode, idx = startIdx;
  for (;;) {
    used[idx] = true;
    const e = missEdges[idx], seg = e.a === node ? e.coords : e.coords.slice().reverse();
    if (line.length) seg.shift(); line.push(...seg);
    const next = e.a === node ? e.b : e.a;
    if (deg.get(next) !== 2) break;                    // stop at junctions and dead-ends
    const cand = byNode.get(next).find(j => !used[j]);
    if (cand == null) break;
    idx = cand; node = next;
  }
  return line;
}
const chains = [];
// start chains at non-degree-2 endpoints first, then mop up any pure loops
for (let i = 0; i < missEdges.length; i++) {
  if (used[i]) continue; const e = missEdges[i];
  if (deg.get(e.a) !== 2) chains.push(walk(i, e.a));
  else if (deg.get(e.b) !== 2) chains.push(walk(i, e.b));
}
for (let i = 0; i < missEdges.length; i++) if (!used[i]) chains.push(walk(i, missEdges[i].a));

// Douglas–Peucker simplify (~4 m) then round to 5 dp.
const TOL = 4 / 111320;                                 // ~4 m in degrees
function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0; const a = pts[0], b = pts[pts.length-1];
  const dx = b[0]-a[0], dy = b[1]-a[1], L2 = dx*dx+dy*dy || 1e-18;
  for (let i = 1; i < pts.length-1; i++) {
    const t = ((pts[i][0]-a[0])*dx + (pts[i][1]-a[1])*dy) / L2, px = a[0]+t*dx, py = a[1]+t*dy;
    const d = Math.hypot(pts[i][0]-px, pts[i][1]-py); if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [a, b];
  return rdp(pts.slice(0, idx+1), tol).slice(0, -1).concat(rdp(pts.slice(idx), tol));
}
const r5 = v => Math.round(v*1e5)/1e5;
let totalKm = 0;
const features = chains.map(line => {
  const s = rdp(line, TOL).map(p => [r5(p[0]), r5(p[1])]);
  for (let i = 1; i < s.length; i++) totalKm += km(s[i-1], s[i]);
  return { type: 'Feature', properties: { kind: 'cycling' }, geometry: { type: 'LineString', coordinates: s } };
}).filter(f => f.geometry.coordinates.length >= 2);

const fc = { type: 'FeatureCollection', features };
const out = path.join(ROOT, 'data/rideable.lines.geojson');
fs.writeFileSync(out, JSON.stringify(fc));
const meta = {
  source: 'OpenStreetMap via the routing graph (data/graph.json)',
  licence: 'ODbL 1.0 (OpenStreetMap contributors)',
  description: 'Cycling paths usable for routing that are not covered by the LTA/NParks display layers; rendered in the cycling-path colour so the map matches what the router can ride.',
  scope, features: features.length, km: Math.round(totalKm / 1000),
  tolerance_m: 4, coverageGrid_m: 22, builtFrom: 'data/graph.json'
};
fs.writeFileSync(path.join(ROOT, 'data/rideable.meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(`scope=${scope}: ${missEdges.length} missing edges → ${features.length} stitched polylines, ${meta.km} km`);
console.log(`rideable.lines.geojson: ${fs.statSync(out).size.toLocaleString()} bytes`);
