import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Gap-fill fusion: make the displayed NParks/LTA/rail networks routable.
//
// Input is the OSM-derived contracted graph from build_graph.py (data/graph.json). For each
// displayed official line (PCN, LTA cycling paths, OPEN rail corridor) this adds only the
// stretches the OSM graph does not already cover within COVER metres, welding their endpoints
// to the nearest existing node within WELD metres so gaps (notably the rail corridor) connect to
// the network. Covered stretches are left to the existing OSM edges, so paths OSM already has are
// not duplicated. Output uses the same edge schema, so router.js is unchanged.
//
// Usage: node build/fuse_graph.mjs [--output <path>]   (default output: data/graph.json)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outArg = (() => { const i = args.indexOf('--output'); return i < 0 ? null : args[i + 1]; })();
const OUT = outArg ? path.resolve(outArg) : path.join(ROOT, 'data', 'graph.json');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const COVER = 18;  // a vertex within this many metres of existing edge geometry is already routable
const WELD = 35;   // connect a gap-fill endpoint to an existing node within this many metres

const R = 6371000, D = Math.PI / 180;
const hav = (a, b) => { const dLa = (b[1]-a[1])*D, dLo = (b[0]-a[0])*D; const s = Math.sin(dLa/2)**2 + Math.cos(a[1]*D)*Math.cos(b[1]*D)*Math.sin(dLo/2)**2; return 2*R*Math.asin(Math.sqrt(s)); };
const r5 = x => Math.round(x * 1e5) / 1e5;

const G = readJson('data/graph.json');
const nodes = G.nodes.map(c => [c[0], c[1]]);
const edges = G.edges.map(e => e.slice());
const origNodes = nodes.length, origEdges = edges.length;

const CELL = 0.0006;
const gkey = (x, y) => x + ':' + y;
const cellOf = ll => [Math.floor(ll[0] / CELL), Math.floor(ll[1] / CELL)];
function gAdd(grid, ll, payload) { const [x, y] = cellOf(ll); const k = gkey(x, y); let a = grid.get(k); if (!a) { a = []; grid.set(k, a); } a.push(payload); }
function gNear(grid, ll) { const [x, y] = cellOf(ll); const out = []; for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) { const a = grid.get(gkey(x+dx, y+dy)); if (a) for (const p of a) out.push(p); } return out; }

// Coverage index: existing edge geometry (nodes + interior shape points), frozen before adding.
const coverGrid = new Map();
for (const e of edges) {
  const gi = e[4] || [];
  gAdd(coverGrid, nodes[e[0]], nodes[e[0]]);
  for (let k = 0; k < gi.length; k += 2) gAdd(coverGrid, [gi[k], gi[k+1]], [gi[k], gi[k+1]]);
  gAdd(coverGrid, nodes[e[1]], nodes[e[1]]);
}
const coverDist = ll => { let best = Infinity; for (const p of gNear(coverGrid, ll)) { const d = hav(ll, p); if (d < best) best = d; } return best; };

const nodeGrid = new Map();
for (let i = 0; i < nodes.length; i++) gAdd(nodeGrid, nodes[i], i);
function nearestNode(ll, maxD) { let bi = -1, bd = maxD; for (const i of gNear(nodeGrid, ll)) { const d = hav(ll, nodes[i]); if (d <= bd) { bd = d; bi = i; } } return bi < 0 ? null : { id: bi, dist: bd }; }
function addNode(ll) { const id = nodes.length; nodes.push([r5(ll[0]), r5(ll[1])]); gAdd(nodeGrid, nodes[id], id); return id; }
function weldNode(ll) { const n = nearestNode(ll, WELD); return n ? n.id : addNode(ll); }

const ekey = (a, b) => a < b ? a + ':' + b : b + ':' + a;
const edgeSet = new Set(edges.map(e => ekey(e[0], e[1])));

function addRun(run, cls, pcn) {
  if (run.length < 2) return;
  const jointAt = new Array(run.length).fill(-1);
  for (let k = 0; k < run.length; k++) { const n = nearestNode(run[k], WELD); if (n) jointAt[k] = n.id; }
  if (jointAt[0] < 0) jointAt[0] = weldNode(run[0]);
  if (jointAt[run.length-1] < 0) jointAt[run.length-1] = weldNode(run[run.length-1]);
  const jIdx = []; for (let k = 0; k < run.length; k++) if (jointAt[k] >= 0) jIdx.push(k);
  for (let m = 1; m < jIdx.length; m++) {
    const ka = jIdx[m-1], kb = jIdx[m], a = jointAt[ka], b = jointAt[kb];
    if (a === b) continue;
    const key = ekey(a, b); if (edgeSet.has(key)) continue;
    const interior = []; for (let t = ka+1; t < kb; t++) { interior.push(r5(run[t][0]), r5(run[t][1])); }
    edges.push([a, b, cls, pcn, interior]); edgeSet.add(key);
  }
}

// PCN and LTA paths are cycling infrastructure; the open rail corridor is a shared path.
const specs = [
  { file: 'data/pcn.lines.geojson', cls: 1, pcn: 1 },
  { file: 'data/cpn.lines.geojson', cls: 0, pcn: 0 },
  { file: 'data/rail.lines.geojson', cls: 1, pcn: 0, openOnly: true },
];
for (const spec of specs) {
  for (const f of readJson(spec.file).features) {
    if (spec.openOnly && f.properties?.status === 'closed') continue;
    const g = f.geometry; if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      if (line.length < 2) continue;
      const cov = line.map(v => coverDist(v) <= COVER);
      let i = 0;
      while (i < line.length) {
        if (cov[i]) { i++; continue; }
        let e = i; while (e + 1 < line.length && !cov[e+1]) e++;
        const s0 = i > 0 ? i - 1 : i, e0 = e + 1 < line.length ? e + 1 : e;
        addRun(line.slice(s0, e0 + 1), spec.cls, spec.pcn);
        i = e + 1;
      }
    }
  }
}

fs.writeFileSync(OUT, JSON.stringify({ nodes, edges }));
console.error(`fused: nodes ${origNodes}->${nodes.length} (+${nodes.length-origNodes}), edges ${origEdges}->${edges.length} (+${edges.length-origEdges}) -> ${path.relative(ROOT, OUT)}`);
