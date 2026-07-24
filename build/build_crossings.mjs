// Build data/crossings.json — the points where a park connector / cycling path BRIDGES a river or
// canal, or dips into a road UNDERPASS. These annotate a planned route ("Bridge over Kallang River",
// "Underpass ahead"); they are NOT a map layer.
//
//   bridges     = the app's own cycling network (cpn + pcn lines) geometrically crossing an OSM
//                 waterway=river|canal → guaranteed complete, named by the waterway. This is the
//                 PCN's OWN canal/river bridge, not a road structure.
//   underpasses = OSM cycle/foot ways tagged tunnel=yes (road/rail underpasses), kept only where they
//                 coincide with the app network (drops building void-deck passages off the PCN and
//                 anything across the Johor border, since cpn/pcn are Singapore-only).
//
// OSM data © OpenStreetMap contributors, ODbL 1.0. Overpass fetch is a build-time step; the committed
// output is the reviewed snapshot (same contract as data/rail.lines.geojson and data/rideable.lines).
//
// Usage: node build/build_crossings.mjs   (needs network; writes data/crossings.json + crossings.meta.json)

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BBOX = [1.20, 103.60, 1.48, 104.05];              // s,w,n,e — SG + a Johor margin, clipped later
const NEAR_M = 40;                                       // underpass must sit within this of the PCN network
const DEC = 5;                                           // coordinate decimals (matches network transform)
const EPS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
             'https://overpass.private.coffee/api/interpreter'];

function overpass(query) {
  const body = 'data=' + encodeURIComponent(query);
  const attempt = ep => new Promise((res, rej) => {
    const u = new URL(ep);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'cbsg-crossings/1.0' } },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { if (d[0] !== '{') return rej(new Error('non-json: ' + d.slice(0, 60))); try { res(JSON.parse(d)); } catch (e) { rej(e); } }); });
    req.on('error', rej); req.write(body); req.end();
  });
  return (async () => {
    // overpass-api.de rate-limits back-to-back queries; retry it with backoff before falling back
    for (let round = 0; round < 4; round++) {
      for (const ep of EPS) {
        try { process.stdout.write(`  overpass ${ep.split('/')[2]} … `); const d = await attempt(ep); console.log('ok'); return d; }
        catch (e) { console.log('fail:', e.message.slice(0, 40)); }
      }
      const wait = 15000 * (round + 1);
      console.log(`  all endpoints busy — waiting ${wait / 1000}s`); await new Promise(r => setTimeout(r, wait));
    }
    throw new Error('all overpass endpoints failed');
  })();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = n => +n.toFixed(DEC);
// nearest distance (m) from a point to a polyline
function distPtWay(p, way) { let d = Infinity; for (let i = 1; i < way.length; i++) d = Math.min(d, distPtSegM(p, way[i - 1], way[i])); return d; }
// do open segments a-b and c-d cross?
function segCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
// point-to-segment distance in metres (local equirectangular around the SG latitude)
const MLAT = 110540, MLNG = 111320 * Math.cos(1.35 * Math.PI / 180);
function distPtSegM(p, a, b) {
  const ax = a[0] * MLNG, ay = a[1] * MLAT, bx = b[0] * MLNG, by = b[1] * MLAT, px = p[0] * MLNG, py = p[1] * MLAT;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function loadNetwork() {
  const segs = [];
  for (const f of ['data/pcn.lines.geojson', 'data/cpn.lines.geojson']) {
    const g = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const feat of g.features) {
      if (feat.geometry?.type !== 'LineString') continue;
      const cs = feat.geometry.coordinates;
      for (let i = 1; i < cs.length; i++) segs.push([cs[i - 1], cs[i]]);
    }
  }
  return segs;
}
// coarse grid index over segments for fast neighbour queries
function gridIndex(segs, cell) {
  const g = new Map();
  const put = (k, s) => { let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(s); };
  for (const s of segs) {
    const x0 = Math.min(s[0][0], s[1][0]) / cell | 0, x1 = Math.max(s[0][0], s[1][0]) / cell | 0;
    const y0 = Math.min(s[0][1], s[1][1]) / cell | 0, y1 = Math.max(s[0][1], s[1][1]) / cell | 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(x + ',' + y, s);
  }
  return { g, cell };
}
function near(idx, p, radiusCells = 1) {
  const cx = p[0] / idx.cell | 0, cy = p[1] / idx.cell | 0, out = new Set();
  for (let x = cx - radiusCells; x <= cx + radiusCells; x++) for (let y = cy - radiusCells; y <= cy + radiusCells; y++) {
    const a = idx.g.get(x + ',' + y); if (a) for (const s of a) out.add(s);
  }
  return out;
}

async function main() {
  const netSegs = loadNetwork();
  const CELL = 0.004;
  const netIdx = gridIndex(netSegs, CELL);
  console.log(`network segments: ${netSegs.length}`);

  // ---- bridges: network × waterway crossings ----
  console.log('fetching waterways (river|canal)…');
  const wData = await overpass(`[out:json][timeout:90];(way["waterway"~"^(river|canal)$"](${BBOX.join(',')}););(._;>;);out body qt;`);
  const wNode = {}; for (const el of wData.elements) if (el.type === 'node') wNode[el.id] = [el.lon, el.lat];
  const wSegs = [];
  for (const el of wData.elements) if (el.type === 'way' && el.nodes) {
    const nm = el.tags?.name || null, c = el.nodes.map(n => wNode[n]).filter(Boolean);
    for (let i = 1; i < c.length; i++) wSegs.push({ a: c[i - 1], b: c[i], name: nm });
  }
  const wIdx = { g: new Map(), cell: CELL };
  for (const s of wSegs) {
    const x0 = Math.min(s.a[0], s.b[0]) / CELL | 0, x1 = Math.max(s.a[0], s.b[0]) / CELL | 0;
    const y0 = Math.min(s.a[1], s.b[1]) / CELL | 0, y1 = Math.max(s.a[1], s.b[1]) / CELL | 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + ',' + y; let a = wIdx.g.get(k); if (!a) { a = []; wIdx.g.set(k, a); } a.push(s); }
  }
  // crossing POINTS: the app's network crossing a waterway (complete set + waterway name)
  const bridgePts = []; const seenB = new Set();
  for (const s of netSegs) {
    const mid = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
    for (const w of near(wIdx, mid)) {
      if (segCross(s[0], s[1], w.a, w.b)) {
        const lng = round(mid[0]), lat = round(mid[1]), key = lng + ',' + lat;
        if (!seenB.has(key)) { seenB.add(key); bridgePts.push({ lng, lat, name: w.name }); }
      }
    }
  }

  // bridge SPANS: OSM cycle/foot ways tagged bridge=yes carry the structure's real end-to-end
  // geometry. Match each crossing point to the bridge way it lies on (prefer a cycleway, then the
  // longest) and keep that way's two ENDS, so the planner can drop the icon at the entrance the
  // rider approaches — not a fixed distance, not the far end.
  console.log('pausing 20s to avoid the Overpass rate limit…'); await sleep(20000);
  console.log('fetching bridge=yes cycle/foot ways…');
  const brData = await overpass(`[out:json][timeout:90];(way["highway"~"^(cycleway|path|footway|pedestrian)$"]["bridge"="yes"](${BBOX.join(',')}););(._;>;);out body qt;`);
  const brNode = {}; for (const el of brData.elements) if (el.type === 'node') brNode[el.id] = [el.lon, el.lat];
  const brWays = [];
  for (const el of brData.elements) if (el.type === 'way' && el.nodes) {
    const c = el.nodes.map(n => brNode[n]).filter(Boolean); if (c.length < 2) continue;
    const cyc = el.tags?.highway === 'cycleway' || el.tags?.bicycle === 'designated';
    let len = 0; for (let i = 1; i < c.length; i++) len += Math.hypot((c[i][0] - c[i - 1][0]) * MLNG, (c[i][1] - c[i - 1][1]) * MLAT);
    brWays.push({ c, ends: [c[0], c[c.length - 1]], cyc, len });
  }
  console.log(`  bridge=yes ways: ${brWays.length}`);
  const bridges = []; const seenSpan = new Set(); let spanned = 0;
  for (const bp of bridgePts) {
    const p = [bp.lng, bp.lat];
    let best = null;
    for (const bw of brWays) {
      if (distPtWay(p, bw.c) > 20) continue;                          // the crossing must lie on this bridge way
      if (!best || (bw.cyc && !best.cyc) || (bw.cyc === best.cyc && bw.len > best.len)) best = bw;
    }
    const e = best ? best.ends : [[bp.lng, bp.lat], [bp.lng, bp.lat]];  // no OSM bridge way → degenerate (point)
    if (best) spanned++;
    const rec = [round(e[0][0]), round(e[0][1]), round(e[1][0]), round(e[1][1]), bp.name];
    const key = rec.slice(0, 4).join(',');
    if (!seenSpan.has(key)) { seenSpan.add(key); bridges.push(rec); }
  }

  // ---- underpasses: OSM tunnel=yes cycle/foot ways on the network → store the tunnel's two ENDS ----
  console.log('pausing 20s to avoid the Overpass rate limit…'); await sleep(20000);
  console.log('fetching tunnel=yes cycle/foot ways…');
  const tData = await overpass(`[out:json][timeout:90];(way["highway"~"^(cycleway|path|footway|pedestrian)$"]["tunnel"="yes"](${BBOX.join(',')}););(._;>;);out body qt;`);
  const tNode = {}; for (const el of tData.elements) if (el.type === 'node') tNode[el.id] = [el.lon, el.lat];
  const underpasses = []; const seenU = new Set();
  for (const el of tData.elements) if (el.type === 'way' && el.nodes) {
    const c = el.nodes.map(n => tNode[n]).filter(Boolean); if (c.length < 2) continue;
    const mid = c[Math.floor(c.length / 2)];
    // keep only tunnels that sit on the PCN/CPN network (drops off-network + Johor)
    let onNet = false;
    for (const s of near(netIdx, mid)) { if (distPtSegM(mid, s[0], s[1]) <= NEAR_M) { onNet = true; break; } }
    if (!onNet) continue;
    const e1 = c[0], e2 = c[c.length - 1], key = round(mid[0]) + ',' + round(mid[1]);
    if (!seenU.has(key)) { seenU.add(key); underpasses.push([round(e1[0]), round(e1[1]), round(e2[0]), round(e2[1])]); }
  }

  // deterministic ordering by the first endpoint
  const byXY = (p, q) => p[0] - q[0] || p[1] - q[1];
  bridges.sort(byXY); underpasses.sort(byXY);

  const out = { bridge: bridges, underpass: underpasses };
  fs.writeFileSync(path.join(ROOT, 'data/crossings.json'), JSON.stringify(out));
  const named = bridges.filter(b => b[4]).length;
  const pts = [...bridges.flatMap(b => [[b[0], b[1]], [b[2], b[3]]]), ...underpasses.flatMap(u => [[u[0], u[1]], [u[2], u[3]]])];
  const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1]);
  const meta = {
    source: 'OpenStreetMap via Overpass: waterway=river|canal intersected with the LTA/NParks cycling network (bridge crossings, named by the waterway), each spanned by its OSM bridge=yes cycle/foot way; highway cycle/foot ways tagged tunnel=yes on the network (underpasses, spanned by the tunnel way).',
    licence: 'ODbL 1.0 (OpenStreetMap contributors); cycling network under the Singapore Open Data Licence',
    description: "Route-annotation spans (not a map layer): each entry is the structure's two ENDS [lng1,lat1,lng2,lat2(,name)], so the planner drops the icon at the entrance the rider approaches. Bridges add the waterway name.",
    snapshotAt: new Date().toISOString().slice(0, 10),
    builtFrom: 'data/cpn.lines.geojson + data/pcn.lines.geojson + OSM waterways/bridges/tunnels',
    format: '{ bridge:[[lng1,lat1,lng2,lat2,name],…], underpass:[[lng1,lat1,lng2,lat2],…] }',
    bridges: bridges.length, bridgesNamed: named, bridgesSpanned: spanned, underpasses: underpasses.length,
    count: bridges.length + underpasses.length,
    bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)].map(round)
  };
  fs.writeFileSync(path.join(ROOT, 'data/crossings.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const bytes = fs.statSync(path.join(ROOT, 'data/crossings.json')).size;
  console.log(`\ncrossings.json: ${bridges.length} bridges (${named} named, ${spanned} spanned by an OSM bridge way) + ${underpasses.length} underpasses, ${bytes.toLocaleString()} bytes`);
}
main().catch(e => { console.error(e); process.exit(1); });
