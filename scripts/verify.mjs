import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const jsonMode = process.argv.includes('--json');
const SG_BOUNDS = [103.5, 1.1, 104.2, 1.6];
const WEATHER_BOUNDS = [103.5, 1.1, 104.6, 1.6];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function readJson(file) {
  try { return JSON.parse(read(file)); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(directory, predicate, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'playwright-report', 'test-results', '.artifacts'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target, predicate, output);
    else if (predicate(target)) output.push(target);
  }
  return output;
}

function coordinatePairs(geometry) {
  const pairs = [];
  const visit = value => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      pairs.push([value[0], value[1]]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return pairs;
}

function geometryLines(geometry) {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const q = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(q));
}

function lineKilometres(collection) {
  let metres = 0;
  for (const feature of collection.features) {
    for (const line of geometryLines(feature.geometry)) {
      for (let i = 1; i < line.length; i += 1) metres += haversine(line[i - 1], line[i]);
    }
  }
  return metres / 1000;
}

function collectionBounds(collection) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of collection.features) {
    for (const [lng, lat] of coordinatePairs(feature.geometry)) {
      bounds[0] = Math.min(bounds[0], lng); bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng); bounds[3] = Math.max(bounds[3], lat);
    }
  }
  return bounds;
}

function closeTo(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
}

function validateGeometry(geometry, file, index, allowed, guardBounds = SG_BOUNDS) {
  assert(geometry && allowed.includes(geometry.type),
    `${file} feature ${index}: unsupported geometry ${geometry?.type}`);
  const pairs = coordinatePairs(geometry);
  assert(pairs.length > 0, `${file} feature ${index}: geometry is empty`);
  for (const [lng, lat] of pairs) {
    assert(Number.isFinite(lng) && Number.isFinite(lat), `${file} feature ${index}: non-finite coordinate`);
    assert(lng >= guardBounds[0] && lng <= guardBounds[2] && lat >= guardBounds[1] && lat <= guardBounds[3],
      `${file} feature ${index}: coordinate outside Singapore guard bounds (${lng}, ${lat})`);
  }
  if (geometry.type === 'Point') assert(pairs.length === 1, `${file} feature ${index}: invalid Point`);
  for (const line of geometryLines(geometry)) {
    assert(line.length >= 2, `${file} feature ${index}: line has fewer than two points`);
  }
  const rings = geometry.type === 'Polygon' ? geometry.coordinates
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : [];
  for (const ring of rings) {
    assert(ring.length >= 4, `${file} feature ${index}: polygon ring has fewer than four points`);
    assert(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1],
      `${file} feature ${index}: polygon ring is not closed`);
  }
}

function validateBounds(metaBounds, actual, label) {
  const flat = Array.isArray(metaBounds?.[0]) ? [...metaBounds[0], ...metaBounds[1]] : metaBounds;
  assert(Array.isArray(flat) && flat.length === 4, `${label}: invalid metadata bounds`);
  for (let i = 0; i < 4; i += 1) closeTo(actual[i], flat[i], 0.00002, `${label} bounds[${i}]`);
}

export function readShellContract() {
  const source = read('sw.js');
  const version = source.match(/const VERSION\s*=\s*['"]([^'"]+)['"]/m)?.[1];
  const body = source.match(/const SHELL_ASSETS\s*=\s*\[([\s\S]*?)\];/m)?.[1];
  assert(version, 'sw.js: VERSION was not found');
  assert(body, 'sw.js: SHELL_ASSETS was not found');
  const assets = [...body.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  return { version, assets, source };
}

function deployAssetFiles() {
  const { assets } = readShellContract();
  return [...new Set(['sw.js', ...assets.map(asset => asset === './' ? 'index.html' : asset.replace(/^\.\//, ''))])].sort();
}

function runtimeSnapshot() {
  return Object.fromEntries(deployAssetFiles().map(file => [file, sha256File(path.join(ROOT, file))]));
}

function checkSyntax() {
  const files = walk(ROOT, file => /\.(?:js|mjs)$/.test(file) && !rel(file).startsWith('vendor/'));
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert(result.status === 0, `${rel(file)}: ${result.stderr || result.stdout}`);
  }
  const pythonFiles = walk(path.join(ROOT, 'build'), file => file.endsWith('.py'));
  const candidates = process.platform === 'win32'
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];
  let python = null;
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (probe.status === 0) { python = [command, prefix]; break; }
  }
  assert(python, 'Python 3 is required to validate build-script syntax');
  for (const file of pythonFiles) {
    const script = "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'), sys.argv[1], 'exec')";
    const result = spawnSync(python[0], [...python[1], '-c', script, file], { encoding: 'utf8' });
    assert(result.status === 0, `${rel(file)}: ${result.stderr || result.stdout}`);
  }
  return `${files.length} JavaScript and ${pythonFiles.length} Python files`;
}

function checkMarkdownLinks() {
  const files = walk(ROOT, file => file.endsWith('.md'));
  let links = 0;
  for (const file of files) {
    const markdown = fs.readFileSync(file, 'utf8');
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|tel:|#)/i.test(target)) continue;
      let decoded;
      try { decoded = decodeURIComponent(target.split('#')[0]); }
      catch { throw new Error(`${rel(file)}: malformed local link ${target}`); }
      if (!decoded) continue;
      const absolute = path.resolve(path.dirname(file), decoded);
      assert(fs.existsSync(absolute), `${rel(file)}: broken local link ${target}`);
      links += 1;
    }
  }
  return `${files.length} Markdown files; ${links} existing local links`;
}

function checkJson() {
  const files = walk(ROOT, file => /(?:\.json|\.geojson|\.webmanifest)$/.test(file));
  for (const file of files) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`${rel(file)}: ${error.message}`); }
  }
  return `${files.length} JSON/GeoJSON/manifest files`;
}

function checkDatasets() {
  const specs = [
    ['pcn.lines.geojson', 'pcn.meta.json', ['LineString'], ['loop', 'name'], 'seg_count'],
    ['cpn.lines.geojson', 'cpn.meta.json', ['LineString'], ['area'], 'seg_count'],
    ['rail.lines.geojson', 'rail.meta.json', ['LineString'], ['status'], 'seg_count'],
    ['parks.polys.geojson', 'parks.meta.json', ['Polygon', 'MultiPolygon'], ['name', 'kind', 'ha'], 'count'],
    ['racks.points.geojson', 'racks.meta.json', ['Point'], ['n', 'sh', 't'], 'count']
  ];
  const loaded = {};
  for (const [geoFile, metaFile, types, required, countKey] of specs) {
    const collection = readJson(`data/${geoFile}`);
    const meta = readJson(`data/${metaFile}`);
    assert(collection.type === 'FeatureCollection' && Array.isArray(collection.features),
      `${geoFile}: expected FeatureCollection`);
    assert(meta[countKey] === collection.features.length,
      `${geoFile}: ${collection.features.length} features != ${metaFile} ${countKey} ${meta[countKey]}`);
    collection.features.forEach((feature, index) => {
      assert(feature.type === 'Feature' && feature.properties && feature.geometry,
        `${geoFile} feature ${index}: invalid Feature`);
      validateGeometry(feature.geometry, geoFile, index, types);
      for (const property of required) assert(feature.properties[property] !== undefined,
        `${geoFile} feature ${index}: missing property ${property}`);
    });
    validateBounds(meta.bounds, collectionBounds(collection), geoFile);
    loaded[geoFile] = { collection, meta };
  }

  const pcn = loaded['pcn.lines.geojson'];
  assert(pcn.meta.loops.length === 7, 'pcn.meta.json: expected seven loops');
  assert(new Set(pcn.meta.loops.map(loop => loop.name)).size === 7, 'pcn.meta.json: duplicate loop name');
  for (const feature of pcn.collection.features) {
    assert(Number.isInteger(feature.properties.loop) && feature.properties.loop >= 0 && feature.properties.loop < 7,
      'pcn.lines.geojson: loop index outside 0..6');
    assert(feature.properties.name === pcn.meta.loops[feature.properties.loop].name,
      'pcn.lines.geojson: loop name/index disagreement');
  }
  closeTo(Number(lineKilometres(pcn.collection).toFixed(1)), pcn.meta.total_km,
    Math.max(0.1, pcn.meta.total_km * 0.005), 'PCN total_km');
  closeTo(Number(lineKilometres(loaded['cpn.lines.geojson'].collection).toFixed(1)),
    loaded['cpn.lines.geojson'].meta.total_km,
    Math.max(0.1, loaded['cpn.lines.geojson'].meta.total_km * 0.005), 'CPN total_km');
  closeTo(Number(lineKilometres(loaded['rail.lines.geojson'].collection).toFixed(1)),
    loaded['rail.lines.geojson'].meta.total_km,
    Math.max(0.1, loaded['rail.lines.geojson'].meta.total_km * 0.005), 'Rail total_km');

  for (const feature of loaded['rail.lines.geojson'].collection.features) {
    assert(['open', 'closed'].includes(feature.properties.status), 'rail.lines.geojson: invalid status');
  }
  for (const feature of loaded['parks.polys.geojson'].collection.features) {
    assert(['park', 'reserve'].includes(feature.properties.kind) && feature.properties.ha > 0,
      'parks.polys.geojson: invalid kind or area');
  }
  for (const feature of loaded['racks.points.geojson'].collection.features) {
    assert(Number.isInteger(feature.properties.n) && feature.properties.n >= 0,
      'racks.points.geojson: invalid capacity');
    assert([0, 1].includes(feature.properties.sh), 'racks.points.geojson: invalid sheltered flag');
  }

  const closures = readJson('data/closures.geojson');
  const closureMeta = readJson('data/closures.meta.json');
  assert(closures.type === 'FeatureCollection' && closures.features.length === closureMeta.count + 1,
    'closures.geojson: risk count plus one marker must match metadata');
  const risks = closures.features.filter(feature => feature.properties?.kind === 'risk');
  const markers = closures.features.filter(feature => feature.properties?.kind === 'marker');
  assert(risks.length === closureMeta.count && markers.length === 1,
    'closures.geojson: expected metadata risk count and one marker');
  risks.forEach((feature, index) => validateGeometry(feature.geometry, 'closures.geojson', index, ['LineString']));
  validateGeometry(markers[0].geometry, 'closures.geojson', risks.length, ['Point']);
  closeTo(Number(lineKilometres({ features: risks }).toFixed(2)), closureMeta.risk_km, 0.01, 'closures risk_km');
  closeTo(markers[0].geometry.coordinates[0], closureMeta.marker[0], 0.000001, 'closure marker longitude');
  closeTo(markers[0].geometry.coordinates[1], closureMeta.marker[1], 0.000001, 'closure marker latitude');
  assert(/^https:\/\//.test(closureMeta.active?.[0]?.url || ''), 'closures.meta.json: missing HTTPS source URL');

  const wx = readJson('data/wx.zones.geojson');
  assert(wx.type === 'FeatureCollection' && wx.features.length === 47, 'wx.zones.geojson: expected 47 areas');
  const areaNames = new Set();
  wx.features.forEach((feature, index) => {
    validateGeometry(feature.geometry, 'wx.zones.geojson', index, ['Polygon', 'MultiPolygon'], WEATHER_BOUNDS);
    const { area, cx, cy } = feature.properties || {};
    assert(typeof area === 'string' && Number.isFinite(cx) && Number.isFinite(cy),
      `wx.zones.geojson feature ${index}: invalid area/anchor`);
    areaNames.add(area);
  });
  assert(areaNames.size === 47, 'wx.zones.geojson: duplicate area names');
  return '10 production data/meta files; counts, schemas, bounds, lengths, properties and sources';
}

function checkGraphAndRouter() {
  const graph = readJson('data/graph.json');
  assert(Array.isArray(graph.nodes) && Array.isArray(graph.edges), 'graph.json: nodes/edges arrays required');
  assert(graph.nodes.length === 116331 && graph.edges.length === 172325,
    `graph.json: fixture counts changed (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
  graph.nodes.forEach((node, index) => {
    assert(Array.isArray(node) && node.length === 2 && node.every(Number.isFinite),
      `graph.json node ${index}: invalid coordinate`);
    assert(node[0] >= SG_BOUNDS[0] && node[0] <= SG_BOUNDS[2] && node[1] >= SG_BOUNDS[1] && node[1] <= SG_BOUNDS[3],
      `graph.json node ${index}: outside guard bounds`);
  });
  let selfLoops = 0;
  graph.edges.forEach((edge, index) => {
    assert(Array.isArray(edge) && edge.length === 5, `graph.json edge ${index}: invalid tuple`);
    assert(Number.isInteger(edge[0]) && edge[0] >= 0 && edge[0] < graph.nodes.length
      && Number.isInteger(edge[1]) && edge[1] >= 0 && edge[1] < graph.nodes.length,
    `graph.json edge ${index}: invalid endpoint`);
    if (edge[0] === edge[1]) selfLoops += 1;
    assert(Number.isInteger(edge[2]) && edge[2] >= 0 && edge[2] <= 9,
      `graph.json edge ${index}: invalid road class`);
    assert(edge[3] === 0 || edge[3] === 1, `graph.json edge ${index}: invalid PCN flag`);
    assert(Array.isArray(edge[4]) && edge[4].length % 2 === 0 && edge[4].every(Number.isFinite),
      `graph.json edge ${index}: invalid interior geometry`);
  });
  assert(selfLoops === 315, `graph.json: self-loop fixture count changed (${selfLoops}); router intentionally ignores these`);

  const routerPath = path.join(ROOT, 'router.js');
  delete require.cache[require.resolve(routerPath)];
  const Router = require(routerPath);
  const loaded = Router.load(graph);
  assert(loaded.nodes === graph.nodes.length && loaded.edges === graph.edges.length, 'router load count mismatch');
  const fixtures = [
    {
      name: 'Bay South boundary', start: [103.86283, 1.28569], end: [103.87133, 1.28062],
      maxMetres: 1757.91, balancedMetres: 1757.91, maxCycling: 0.986854, carWay: false
    },
    {
      name: 'Woodlands to Punggol', start: [103.7859, 1.4370], end: [103.9040, 1.4043],
      maxMetres: 21429.25, balancedMetres: 21004.98, maxCycling: 0.979343, carWay: true
    }
  ];
  for (const fixture of fixtures) {
    const result = Router.routeTwo(fixture.start, fixture.end);
    assert(result?.max?.ok && result?.balanced?.ok, `${fixture.name}: route missing`);
    closeTo(result.max.meters, fixture.maxMetres, 0.2, `${fixture.name} max distance`);
    closeTo(result.balanced.meters, fixture.balancedMetres, 0.2, `${fixture.name} balanced distance`);
    closeTo(result.max.cyclingPct, fixture.maxCycling, 0.000002, `${fixture.name} cycling share`);
    assert(result.max.directions.at(-1)?.type === 'arrive', `${fixture.name}: directions do not arrive`);
    assert(result.max.hasCarWay === fixture.carWay, `${fixture.name}: car-way warning changed`);
  }
  return `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${fixtures.length} fixed route fixtures`;
}

function checkHtmlAndManifest() {
  const html = read('index.html');
  const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
  assert(ids.length === new Set(ids).size, 'index.html: duplicate DOM id');
  const referencedIds = new Set([
    ...[...read('app.js').matchAll(/\$\(["']([^"']+)["']\)/g)].map(match => match[1]),
    ...[...read('app.js').matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1])
  ]);
  for (const id of referencedIds) assert(ids.includes(id), `app.js references missing DOM id #${id}`);
  for (const match of html.matchAll(/\b(?:aria-controls|aria-labelledby|for)\s*=\s*["']([^"']+)["']/g)) {
    for (const id of match[1].split(/\s+/)) assert(ids.includes(id), `index.html references missing DOM id #${id}`);
  }

  const localAssets = new Set();
  for (const match of html.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1];
    if (/^(?:https?:|\/\/|#|data:|mailto:|tel:)/i.test(value)) continue;
    localAssets.add(value.split(/[?#]/)[0].replace(/^\.\//, ''));
  }
  const manifest = readJson('manifest.webmanifest');
  assert(manifest.name && manifest.short_name && manifest.start_url === './' && manifest.scope === './',
    'manifest.webmanifest: name/start/scope contract changed');
  assert(manifest.display === 'standalone' && manifest.icons?.length === 4,
    'manifest.webmanifest: standalone/four-icon contract changed');
  for (const icon of manifest.icons) localAssets.add(icon.src.replace(/^\.\//, ''));
  for (const asset of localAssets) assert(fs.existsSync(path.join(ROOT, asset)), `missing HTML/manifest asset: ${asset}`);

  const structured = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert(structured, 'index.html: structured data block missing');
  JSON.parse(structured);
  const pcn = readJson('data/pcn.meta.json');
  const parks = readJson('data/parks.meta.json');
  const racks = readJson('data/racks.meta.json');
  for (const fact of [String(pcn.loops.length), String(pcn.total_km), String(parks.count), String(racks.count)]) {
    assert(html.includes(fact), `index.html: metadata fact ${fact} is not represented`);
  }
  for (const attribution of ['NParks', 'LTA', 'NEA', 'OpenStreetMap', 'OpenFreeMap']) {
    assert(html.includes(attribution), `index.html: missing ${attribution} attribution`);
  }
  assert(html.includes('Your location stays on your device'), 'index.html: local-only location statement missing');
  return `${ids.length} unique DOM ids, ${referencedIds.size} app references, ${localAssets.size} local assets`;
}

function checkServiceWorker() {
  const { version, assets, source } = readShellContract();
  assert(/^cbsg-v\d+$/.test(version), `sw.js: invalid VERSION ${version}`);
  assert(assets.length === 27 && new Set(assets).size === assets.length,
    `sw.js: expected 27 unique shell assets, received ${assets.length}`);
  for (const asset of assets) {
    const file = asset === './' ? 'index.html' : asset.replace(/^\.\//, '');
    assert(fs.existsSync(path.join(ROOT, file)), `sw.js: missing shell asset ${asset}`);
  }
  const required = [
    './', 'index.html', 'style.css', 'app.js', 'router.js', 'manifest.webmanifest',
    'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css',
    'data/pcn.lines.geojson', 'data/pcn.meta.json', 'data/cpn.lines.geojson', 'data/cpn.meta.json',
    'data/rail.lines.geojson', 'data/rail.meta.json', 'data/parks.polys.geojson', 'data/parks.meta.json',
    'data/racks.points.geojson', 'data/racks.meta.json', 'data/closures.geojson', 'data/closures.meta.json',
    'data/wx.zones.geojson'
  ];
  for (const asset of required) assert(assets.includes(asset), `sw.js: required shell asset omitted: ${asset}`);
  assert(!assets.includes('data/graph.json'), 'sw.js: graph.json must not be eagerly precached');
  assert((source.match(/self\.skipWaiting\(\)/g) || []).length === 1
    && /message[\s\S]*SKIP_WAITING[\s\S]*self\.skipWaiting\(\)/.test(source),
  'sw.js: skipWaiting must occur only after the explicit update message');
  assert(/new Request\(u, \{cache: 'reload'\}\)/.test(source), 'sw.js: atomic reload precache guard missing');
  return `${version}; ${assets.length} existing shell assets; opt-in update contract`;
}

function checkClosureReproducibility() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cbsg-closure-'));
  try {
    fs.mkdirSync(path.join(temporary, 'build'));
    fs.mkdirSync(path.join(temporary, 'data'));
    fs.copyFileSync(path.join(ROOT, 'build', 'build_closures.js'), path.join(temporary, 'build', 'build_closures.js'));
    fs.copyFileSync(path.join(ROOT, 'data', 'pcn.lines.geojson'), path.join(temporary, 'data', 'pcn.lines.geojson'));
    const result = spawnSync(process.execPath, [path.join(temporary, 'build', 'build_closures.js')], {
      cwd: temporary, encoding: 'utf8'
    });
    assert(result.status === 0, `closure generator failed in clean fixture: ${result.stderr || result.stdout}`);
    for (const file of ['closures.geojson', 'closures.meta.json']) {
      const expected = sha256File(path.join(ROOT, 'data', file));
      const actual = sha256File(path.join(temporary, 'data', file));
      assert(actual === expected, `${file}: generator output differs from production`);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return 'clean temporary rebuild reproduces both closure outputs byte-for-byte';
}

function checkReleaseTooling() {
  const pkg = readJson('package.json');
  for (const script of [
    'risk:classify', 'verify', 'verify:unit', 'verify:data', 'verify:security',
    'verify:governance', 'verify:performance', 'verify:browser', 'verify:accessibility',
    'verify:performance:browser', 'verify:recovery', 'verify:deterministic', 'verify:all',
    'health:production', 'data:rebuild', 'release:manifest', 'release:verify-deployment'
  ]) {
    assert(pkg.scripts?.[script], `package.json: missing ${script} command`);
  }
  assert(pkg.devDependencies?.['@playwright/test'] === '1.61.1', 'package.json: Playwright must be exactly pinned');
  assert(pkg.devDependencies?.['@axe-core/playwright'] === '4.12.1', 'package.json: axe must be exactly pinned');
  const risk = readJson('release/risk-tiers.json');
  assert(Object.keys(risk.tiers || {}).join(',') === '0,1,2,3', 'risk-tiers.json: tiers 0..3 required');
  assert(risk.rules.some(rule => rule.tier === 3), 'risk-tiers.json: Tier 3 paths missing');
  const preview = readJson('release/preview.json');
  assert(/^JiaenLin\/[A-Za-z0-9._-]+$/.test(preview.repository || ''), 'preview.json: repository is invalid');
  assert(preview.branch === 'main' && /^https:\/\//.test(preview.url || ''), 'preview.json: main/HTTPS target required');
  assert(preview.productionRepository === 'JiaenLin/cycling-buddy-sg',
    'preview.json: production repository must be explicit');
  assert(preview.productionBranch === 'production' && /^https:\/\//.test(preview.productionUrl || ''),
    'preview.json: protected production branch/HTTPS target required');
  assert(preview.promotion === 'same-commit-fast-forward-to-production',
    'preview.json: immutable protected-branch promotion rule required');
  const attributes = read('.gitattributes');
  for (const pattern of ['*.json text eol=lf', '*.geojson text eol=lf', '*.js text eol=lf', '*.mjs text eol=lf']) {
    assert(attributes.includes(pattern), `.gitattributes: missing canonical rule ${pattern}`);
  }
  return 'risk tiers, two exact dev dependencies, immutable preview target, and 17 release commands';
}

function checkMaturityContracts() {
  const reliability = readJson('release/reliability-objectives.json');
  const referenceBaseline = readJson(`release/baselines/${reliability.referenceRelease}.json`);
  const privacy = readJson('release/health-privacy.json');
  const performance = readJson('release/performance-budgets.json');
  const ownership = readJson('release/ownership.json');
  const channels = readJson('release/channels.json');
  const governance = readJson('release/governance.json');
  const regressions = readJson('release/regressions.json');
  const sources = readJson('release/data-sources.json');
  const deployment = readJson('release/deployment-assets.json');
  assert(reliability.observationWindowDays === 28 && reliability.syntheticCadenceHours <= 6,
    'reliability objectives must use a 28-day window and at least six-hour cadence');
  assert(referenceBaseline.release?.id === reliability.referenceRelease
    && referenceBaseline.release?.serviceWorkerVersion === reliability.referenceRelease,
  'configured reliability release must resolve to its matching approved baseline');
  assert(reliability.objectives.requiredAssets.minimumAvailable === Object.keys(referenceBaseline.assets || {}).length,
    'required-asset floor must match the configured release baseline');
  assert(reliability.alertPolicy.releaseFreeze.criticalFailureCount === 1,
    'one critical reliability failure must freeze release');
  assert(Array.isArray(privacy.forbiddenFields)
    && privacy.forbiddenFields.some(field => field.includes('user location')),
    'health privacy contract must forbid precise location');
  assert(performance.referenceProfile.name.includes('Pixel 7') && performance.timingsMs.coldRouteMax > 0,
    'named performance profile and absolute routing budget required');
  assert(Object.keys(ownership.categories).length >= 5 && ownership.reviewPolicy.ownerReviewRequiredForTier3,
    'ownership categories and Tier 3 review required');
  assert(channels.promotion.mode === 'same-commit-fast-forward' && !channels.promotion.rebuildAllowed,
  'exact-SHA fast-forward promotion without rebuild required');
  assert(governance.maximumIntervalDays <= 184 && governance.eventTriggeredReviews.length >= 4,
    'six-month and event-triggered governance review required');
  assert(regressions.records.every(record => record.missedSignal && record.prevention),
    'regression records must identify missed signals and prevention');
  assert(['pcn', 'cpn', 'rail'].every(name => sources.sources[name]?.productionSha256),
    'PCN, CPN and Rail source locks required');
  assert(deployment.supplementalRuntimeAssets.includes('data/graph.json'),
    'routing graph must be included in immutable deployment assets');
  for (const file of [
    '.github/CODEOWNERS', 'SECURITY.md', 'docs/ACCESSIBILITY.md',
    'docs/architecture/PLATFORM_EVOLUTION.md', 'docs/data/NETWORK_REPRODUCIBILITY.md',
    'docs/operations/INCIDENT_RESPONSE.md', 'docs/operations/RELEASE_CHANNELS.md',
    'docs/security/THREAT_MODEL.md', 'contracts/v1/route-request.schema.json',
    'contracts/v1/route-result.schema.json', 'contracts/v1/platform-capabilities.json'
  ]) assert(fs.existsSync(path.join(ROOT, file)), `${file}: maturity contract missing`);
  return 'P1/P2 reliability, privacy, security, accessibility, performance, recovery, data, ownership, canary, learning and platform contracts';
}

export function runVerification() {
  const checks = [];
  const failures = [];
  const before = runtimeSnapshot();
  const run = (name, operation) => {
    try {
      const detail = operation();
      checks.push({ name, status: 'pass', detail });
      if (!jsonMode) console.log(`PASS  ${name} — ${detail}`);
    } catch (error) {
      failures.push({ name, status: 'fail', detail: error.message });
      if (!jsonMode) console.error(`FAIL  ${name} — ${error.message}`);
    }
  };

  run('First-party syntax', checkSyntax);
  run('JSON parsing', checkJson);
  run('Documentation links', checkMarkdownLinks);
  run('Production data contracts', checkDatasets);
  run('Routing graph and smoke fixtures', checkGraphAndRouter);
  run('HTML, DOM, assets, facts and attribution', checkHtmlAndManifest);
  run('Service-worker release boundary', checkServiceWorker);
  run('Closure generator reproducibility', checkClosureReproducibility);
  run('Release tooling contract', checkReleaseTooling);
  run('Maturity contracts', checkMaturityContracts);
  run('Verifier is non-mutating', () => {
    const after = runtimeSnapshot();
    assert(JSON.stringify(after) === JSON.stringify(before), 'runtime asset hashes changed during verification');
    return `${Object.keys(after).length} runtime asset hashes unchanged`;
  });

  const shell = readShellContract();
  return { ok: failures.length === 0, serviceWorkerVersion: shell.version, checks, failures };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  const result = runVerification();
  if (jsonMode) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else console.log(`\n${result.ok ? 'VERIFICATION PASSED' : 'VERIFICATION FAILED'}: ${result.checks.length} passed, ${result.failures.length} failed`);
  if (!result.ok) process.exitCode = 1;
}
