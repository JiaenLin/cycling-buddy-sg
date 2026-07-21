import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { evaluateHealth, updateLoopCount } from './health-evaluator.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const after = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const baseUrl = new URL(after('--url') || process.env.HEALTH_URL || 'https://jiaenlin.github.io/cycling-buddy-sg/');
if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
const output = path.resolve(after('--output') || path.join(root, '.artifacts', 'production-health.json'));
const reliability = JSON.parse(fs.readFileSync(path.join(root, 'release', 'reliability-objectives.json'), 'utf8'));
const configuredBaseline = path.join(root, 'release', 'baselines', `${reliability.referenceRelease}.json`);
const baselinePath = path.resolve(after('--baseline') || configuredBaseline);
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const channel = after('--channel') || process.env.HEALTH_CHANNEL || 'stable';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const statusClass = status => `${Math.floor(status / 100)}xx`;
const rounded = value => Math.max(0, Math.round(value / 10) * 10);

const report = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  release: baseline.release.id,
  channel,
  checks: {
    appLoad: { ok: false, durationMs: null },
    requiredAssets: { ok: false, expected: Object.keys(baseline.assets).length, available: 0, hashMismatches: 0 },
    serviceWorker: { ok: false, installed: false, updateLoops: 0 },
    routing: { ok: false, durationMs: null },
    clientErrors: { ok: true, count: 0, codes: [] },
    liveDependencies: { ok: false, failures: 0, statusClasses: [] }
  }
};

async function fetchWithTimeout(url, timeoutMs = 20000) {
  return fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
}

async function checkAssets() {
  let available = 0;
  let hashMismatches = 0;
  for (const [file, expected] of Object.entries(baseline.assets)) {
    try {
      const response = await fetchWithTimeout(new URL(file, baseUrl));
      if (!response.ok) continue;
      available += 1;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha256(bytes) !== expected.sha256) hashMismatches += 1;
    } catch {
      // The finite aggregate below is intentionally the only persisted signal.
    }
  }
  Object.assign(report.checks.requiredAssets, {
    ok: available === report.checks.requiredAssets.expected && hashMismatches === 0,
    available,
    hashMismatches
  });
}

async function checkLiveDependencies() {
  const endpoints = [
    'https://tiles.openfreemap.org/styles/positron',
    'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'
  ];
  const statuses = [];
  let failures = 0;
  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint);
      statuses.push(statusClass(response.status));
      if (!response.ok) failures += 1;
    } catch {
      statuses.push('network-error');
      failures += 1;
    }
  }
  Object.assign(report.checks.liveDependencies, { ok: failures === 0, failures, statusClasses: statuses });
}

async function checkBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    serviceWorkers: 'allow',
    geolocation: { longitude: 103.85, latitude: 1.30 },
    permissions: ['geolocation'],
    colorScheme: 'light'
  });
  const page = await context.newPage();
  const errorCodes = [];
  page.on('pageerror', () => errorCodes.push('PAGE_ERROR'));
  page.on('console', message => { if (message.type() === 'error') errorCodes.push('CONSOLE_ERROR'); });

  const deterministicStyle = {
    version: 8,
    name: 'Synthetic health style',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ede7' } }]
  };
  const deterministicWeather = {
    code: 0,
    data: {
      area_metadata: [{ name: 'Marina South', label_location: { latitude: 1.28, longitude: 103.86 } }],
      items: [{ valid_period: { text: 'synthetic' }, forecasts: [{ area: 'Marina South', forecast: 'Fair' }] }]
    }
  };
  await page.route('https://tiles.openfreemap.org/styles/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(deterministicStyle)
  }));
  await page.route('https://api-open.data.gov.sg/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(deterministicWeather)
  }));
  await page.route('https://gc.zgo.at/**', route => route.fulfill({ status: 204, body: '' }));
  await page.route('https://*.goatcounter.com/**', route => route.fulfill({ status: 204, body: '' }));

  try {
    const loadStarted = performance.now();
    await page.goto(baseUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => typeof map !== 'undefined' && Boolean(map.getLayer('closed-marker')), null, { timeout: 20000 });
    Object.assign(report.checks.appLoad, { ok: true, durationMs: rounded(performance.now() - loadStarted) });

    const workerObservation = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) {
        return { installed: false, hadControllerAtObservationStart: false, controllerChanges: 0 };
      }
      const registration = await navigator.serviceWorker.ready;
      const hadControllerAtObservationStart = Boolean(navigator.serviceWorker.controller);
      let controllerChanges = 0;
      navigator.serviceWorker.addEventListener('controllerchange', () => { controllerChanges += 1; });
      await registration.update();
      await registration.update();
      await new Promise(resolve => setTimeout(resolve, 1500));
      return { installed: Boolean(registration.active), hadControllerAtObservationStart, controllerChanges };
    });
    const worker = {
      installed: workerObservation.installed,
      updateLoops: updateLoopCount(
        workerObservation.hadControllerAtObservationStart,
        workerObservation.controllerChanges
      )
    };
    Object.assign(report.checks.serviceWorker, { ok: worker.installed && worker.updateLoops === 0, ...worker });

    const routeStarted = performance.now();
    await page.getByRole('button', { name: 'Plan a ride' }).click();
    await page.evaluate(() => {
      handleRouteClick([103.7859, 1.4370]);
      handleRouteClick([103.9040, 1.4043]);
    });
    await page.locator('#rtDirs').waitFor({ state: 'visible', timeout: 30000 });
    Object.assign(report.checks.routing, { ok: true, durationMs: rounded(performance.now() - routeStarted) });
  } catch {
    if (!report.checks.appLoad.ok) errorCodes.push('APP_LOAD_ERROR');
    else if (!report.checks.routing.ok) errorCodes.push('ROUTING_ERROR');
  } finally {
    const uniqueCodes = [...new Set(errorCodes)].sort();
    Object.assign(report.checks.clientErrors, { ok: uniqueCodes.length === 0, count: uniqueCodes.length, codes: uniqueCodes });
    await context.close();
    await browser.close();
  }
}

await Promise.all([checkAssets(), checkLiveDependencies(), checkBrowser()]);
const evaluation = evaluateHealth(report);
const result = { ...report, evaluation };
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (evaluation.status !== 'pass') process.exitCode = 1;
