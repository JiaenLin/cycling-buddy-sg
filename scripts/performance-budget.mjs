import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readShellContract } from './verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const bytes = file => fs.statSync(path.join(root, file)).size;
const budget = readJson('release/performance-budgets.json');
const supplemental = readJson('release/deployment-assets.json').supplementalRuntimeAssets;
const shell = readShellContract();
const shellFiles = [...new Set(['sw.js', ...shell.assets.filter(file => file !== './').map(file => file.replace(/^\.\//, ''))])];
const allFiles = [...new Set([...shellFiles, ...supplemental])];
const totals = {
  allApprovedRuntime: allFiles.reduce((total, file) => total + bytes(file), 0),
  offlineShell: shellFiles.reduce((total, file) => total + bytes(file), 0),
  routingGraph: bytes('data/graph.json'),
  vendoredRuntime: ['vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'vendor/goatcounter-count.js'].reduce((total, file) => total + bytes(file), 0),
  firstPartyJavaScript: ['app.js', 'router.js', 'sw.js'].reduce((total, file) => total + bytes(file), 0)
};
const limits = {
  allApprovedRuntime: budget.assetBytes.allApprovedRuntimeMax,
  offlineShell: budget.assetBytes.offlineShellMax,
  routingGraph: budget.assetBytes.routingGraphMax,
  vendoredRuntime: budget.assetBytes.vendoredRuntimeMax,
  firstPartyJavaScript: budget.assetBytes.firstPartyJavaScriptMax
};
const failures = [];
for (const [name, value] of Object.entries(totals)) {
  const limit = limits[name];
  const ok = value <= limit;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value} / ${limit} bytes`);
  if (!ok) failures.push(`${name} exceeds ${limit}`);
}
const tileMatch = fs.readFileSync(path.join(root, 'sw.js'), 'utf8').match(/const TILE_MAX\s*=\s*(\d+)/);
const tileMax = Number(tileMatch?.[1]);
if (tileMax !== budget.storage.tileCacheMaximumEntries) failures.push('Service-worker tile cap differs from approved storage budget');
else console.log(`PASS  tile cache entry cap: ${tileMax}`);

const result = { schemaVersion: 1, profile: budget.referenceProfile.name, totals, limits, tileMax, status: failures.length ? 'fail' : 'pass' };
const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex >= 0) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
} else console.log('\nPERFORMANCE BUDGET PASSED');
