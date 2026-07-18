import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { normalizeCpn, normalizePcn, normalizeRail, TRANSFORM } from './network-normalizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
const outputDir = path.resolve(ROOT, value('--output-dir') || '.artifacts/data-rebuild');
if (outputDir === ROOT || !outputDir.startsWith(`${ROOT}${path.sep}`)) {
  throw new Error('--output-dir must be a child of the repository');
}

const sourceSpecs = {
  pcn: {
    id: 'd_a69ef89737379f231d2ae93fd1c5707f',
    filename: 'pcn.raw.geojson',
    normalize: normalizePcn,
    output: 'pcn.lines.geojson'
  },
  cpn: {
    id: 'd_8f468b25193f64be8a16fa7d8f60f553',
    filename: 'cpn.raw.geojson',
    normalize: normalizeCpn,
    output: 'cpn.lines.geojson'
  }
};

async function downloadDataGov(spec) {
  const pollUrl = `https://api-open.data.gov.sg/v1/public/api/datasets/${spec.id}/poll-download`;
  const catalogue = await fetch(pollUrl, { headers: { accept: 'application/json' } });
  if (!catalogue.ok) throw new Error(`${spec.id}: catalogue returned HTTP ${catalogue.status}`);
  const body = await catalogue.json();
  if (body.code !== 0 || !body.data?.url) throw new Error(`${spec.id}: ${body.errMsg || 'download URL missing'}`);
  const response = await fetch(body.data.url);
  if (!response.ok) throw new Error(`${spec.id}: download returned HTTP ${response.status}`);
  return response.text();
}

async function downloadRail() {
  const query = '[out:json][timeout:90];rel(3871697);out body;way(r);out tags geom;';
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const failures = [];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'cycling-buddy-sg-reproducibility/1.0'
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(100_000)
      });
      if (response.ok) return response.text();
      failures.push(`${new URL(endpoint).host}: HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${new URL(endpoint).host}: ${error.name}`);
    }
  }
  throw new Error(`Rail Corridor Overpass query failed (${failures.join('; ')})`);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function productionDelta(outputName, normalized) {
  const productionText = fs.readFileSync(path.join(ROOT, 'data', outputName), 'utf8');
  const production = JSON.parse(productionText);
  const remaining = new Map();
  for (const feature of production.features) {
    const key = JSON.stringify(feature);
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  let exactFeatures = 0;
  for (const feature of normalized.features) {
    const key = JSON.stringify(feature);
    if (remaining.get(key)) {
      exactFeatures += 1;
      remaining.set(key, remaining.get(key) - 1);
    }
  }
  return {
    productionSha256: hash(productionText),
    productionFeatures: production.features.length,
    exactFeatures,
    candidateOnly: normalized.features.length - exactFeatures,
    productionOnly: production.features.length - exactFeatures
  };
}

function readInput(filename) {
  const inputDir = value('--input-dir');
  if (!inputDir) throw new Error('Use --download or provide --input-dir with the three raw source files');
  return fs.readFileSync(path.resolve(ROOT, inputDir, filename), 'utf8');
}

fs.mkdirSync(outputDir, { recursive: true });
const report = { schemaVersion: 1, transform: TRANSFORM, generatedAt: new Date().toISOString(), sources: {} };

for (const [name, spec] of Object.entries(sourceSpecs)) {
  const raw = args.includes('--download') ? await downloadDataGov(spec) : readInput(spec.filename);
  const collection = spec.normalize(JSON.parse(raw));
  const normalized = JSON.stringify(collection);
  fs.writeFileSync(path.join(outputDir, spec.output), normalized);
  report.sources[name] = {
    sourceSha256: hash(raw),
    outputSha256: hash(normalized),
    features: collection.features.length,
    explicitUnspecifiedLabels: collection.features.filter(feature => Object.values(feature.properties).includes('Unspecified')).length,
    deltaFromProduction: productionDelta(spec.output, collection)
  };
}

const railRaw = args.includes('--download') ? await downloadRail() : readInput('rail.raw.json');
const railSource = JSON.parse(railRaw);
const railCollection = normalizeRail(railSource);
const railNormalized = JSON.stringify(railCollection);
fs.writeFileSync(path.join(outputDir, 'rail.lines.geojson'), railNormalized);
report.sources.rail = {
  sourceElementsSha256: hash(JSON.stringify(railSource.elements)),
  outputSha256: hash(railNormalized),
  features: railCollection.features.length,
  deltaFromProduction: productionDelta('rail.lines.geojson', railCollection)
};
fs.writeFileSync(path.join(outputDir, 'rebuild-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Network layers and provenance report written to ${path.relative(ROOT, outputDir)}`);
