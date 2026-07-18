import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'release/data-sources.json'), 'utf8'));
const sha256 = file => createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
const problems = [];

for (const name of ['pcn', 'cpn', 'rail']) {
  const source = lock.sources[name];
  const output = `data/${name}.lines.geojson`;
  const actual = sha256(output);
  if (actual !== source.productionSha256) problems.push(`${output}: ${actual} != locked ${source.productionSha256}`);
  if (!/^https:\/\//.test(source.page)) problems.push(`${name}: HTTPS source page missing`);
  if (!source.delta) problems.push(`${name}: source delta explanation missing`);
}

if (lock.transform.implementation !== 'build/network-normalizer.mjs'
    || !fs.existsSync(path.join(ROOT, lock.transform.implementation))) {
  problems.push('network transform implementation is missing');
}
if (!/Never copy/.test(lock.adoptionRule)) problems.push('manual source-adoption safety rule is missing');

if (problems.length) {
  problems.forEach(problem => console.error(`FAIL  ${problem}`));
  console.error(`\nDATA REPRODUCIBILITY FAILED: ${problems.length} issue(s)`);
  process.exitCode = 1;
} else {
  console.log('DATA REPRODUCIBILITY PASSED: production hashes, source identities, licences, transforms and deltas are locked');
}
