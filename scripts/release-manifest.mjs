import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ROOT, readShellContract, runVerification } from './verify.mjs';

const args = process.argv.slice(2);
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const git = command => execFileSync('git', [
  '-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, '-C', ROOT, ...command
], { encoding: 'utf8' }).trim();
const gitBlob = (commit, file) => execFileSync('git', [
  '-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, '-C', ROOT, 'show', `${commit}:${file}`
], { maxBuffer: 32 * 1024 * 1024 });
const required = (flag, fallback = null) => {
  const value = valueAfter(flag) || fallback;
  if (!value) throw new Error(`Missing required ${flag}`);
  return value;
};

export function generateManifest(options = {}) {
  const shell = readShellContract();
  const deploymentContract = JSON.parse(fs.readFileSync(path.join(ROOT, 'release', 'deployment-assets.json'), 'utf8'));
  const tier = Number(options.tier ?? required('--tier'));
  const justification = options.justification ?? required('--justification');
  const deploymentUrl = options.deploymentUrl ?? required('--deployment-url', 'https://jiaenlin.github.io/cycling-buddy-sg/');
  const rollbackCommit = options.rollbackCommit ?? required('--rollback');
  const candidateCommit = options.candidateCommit ?? valueAfter('--commit') ?? git(['rev-parse', 'HEAD']);
  if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('--tier must be 0, 1, 2, or 3');
  if (!/^https:\/\//.test(deploymentUrl)) throw new Error('--deployment-url must use HTTPS');
  git(['cat-file', '-e', `${candidateCommit}^{commit}`]);
  git(['cat-file', '-e', `${rollbackCommit}^{commit}`]);

  const assetFiles = [...new Set([
    'sw.js',
    ...shell.assets.filter(asset => asset !== './').map(asset => asset.replace(/^\.\//, '')),
    ...deploymentContract.supplementalRuntimeAssets
  ])].sort();
  const diff = spawnSync('git', [
    '-c', `safe.directory=${ROOT.replaceAll('\\', '/')}`, '-C', ROOT,
    'diff', '--quiet', candidateCommit, '--', ...assetFiles
  ]);
  if (diff.status !== 0) throw new Error('Runtime assets differ from the candidate commit; commit them before generating a baseline');

  const verification = runVerification();
  if (!verification.ok) throw new Error('Deterministic verification failed; baseline not generated');
  const assets = Object.fromEntries(assetFiles.map(file => {
    const blob = gitBlob(candidateCommit, file);
    return [file, { bytes: blob.length, sha256: createHash('sha256').update(blob).digest('hex') }];
  }));
  const featureCount = file => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8')).features.length;
  const metadata = file => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
  const pcn = metadata('pcn.meta.json');
  const cpn = metadata('cpn.meta.json');
  const rail = metadata('rail.meta.json');
  const parks = metadata('parks.meta.json');
  const racks = metadata('racks.meta.json');
  const closures = metadata('closures.meta.json');

  return {
    schemaVersion: 1,
    release: {
      id: shell.version,
      candidateCommit: git(['rev-parse', candidateCommit]),
      candidateCommitTime: git(['show', '-s', '--format=%cI', candidateCommit]),
      serviceWorkerVersion: shell.version,
      riskTier: tier,
      riskJustification: justification,
      deploymentUrl: deploymentUrl.endsWith('/') ? deploymentUrl : `${deploymentUrl}/`,
      rollbackCommit: git(['rev-parse', rollbackCommit]),
      previewUrl: options.previewUrl ?? valueAfter('--preview-url') ?? null,
      approval: options.approval ?? valueAfter('--approval') ?? null
    },
    datasets: {
      pcn: { features: featureCount('pcn.lines.geojson'), totalKm: pcn.total_km, loops: pcn.loops.length },
      cpn: { features: featureCount('cpn.lines.geojson'), totalKm: cpn.total_km },
      rail: { features: featureCount('rail.lines.geojson'), totalKm: rail.total_km },
      parks: { features: featureCount('parks.polys.geojson'), count: parks.count },
      racks: { features: featureCount('racks.points.geojson'), count: racks.count, spaces: racks.spaces },
      closures: { features: featureCount('closures.geojson'), risks: closures.count, riskKm: closures.risk_km },
      weatherZones: { features: featureCount('wx.zones.geojson') },
      routingGraph: {
        nodes: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')).nodes.length,
        edges: JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'graph.json'), 'utf8')).edges.length
      }
    },
    verification: {
      command: 'npm run verify',
      status: 'pass',
      checks: verification.checks.map(check => ({ name: check.name, detail: check.detail }))
    },
    assets
  };
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isCli) {
  try {
    const manifest = generateManifest();
    const output = valueAfter('--output') || path.join('release', 'baselines', `${manifest.release.id}.json`);
    const absolute = path.resolve(ROOT, output);
    if (absolute !== ROOT && !absolute.startsWith(`${ROOT}${path.sep}`)) throw new Error('--output must stay inside the repository');
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Release baseline written: ${path.relative(ROOT, absolute).replaceAll('\\', '/')}`);
  } catch (error) {
    console.error(`Release baseline failed: ${error.message}`);
    process.exitCode = 1;
  }
}
