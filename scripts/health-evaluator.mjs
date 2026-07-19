import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const objectives = JSON.parse(fs.readFileSync(path.join(root, 'release', 'reliability-objectives.json'), 'utf8'));

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value);

export function updateLoopCount(hadControllerAtObservationStart, controllerChanges) {
  if (!Number.isInteger(controllerChanges) || controllerChanges < 0) {
    throw new Error('controllerChanges must be a non-negative integer');
  }
  return Math.max(0, controllerChanges - (hadControllerAtObservationStart ? 0 : 1));
}

export function evaluateHealth(report, config = objectives) {
  const reasons = [];
  const checks = report?.checks || {};
  const add = code => { if (!reasons.includes(code)) reasons.push(code); };

  if (!checks.appLoad?.ok) add('APP_LOAD_FAILED');
  if (finiteNumber(checks.appLoad?.durationMs) && checks.appLoad.durationMs > config.objectives.appLoad.maxDurationMs) {
    add('DURATION_BUDGET_EXCEEDED');
  }

  const assets = checks.requiredAssets || {};
  if (!assets.ok || assets.available < config.objectives.requiredAssets.minimumAvailable) add('ASSET_MISSING');
  if ((assets.hashMismatches || 0) > config.objectives.requiredAssets.maximumHashMismatches) add('ASSET_HASH_MISMATCH');

  if (!checks.serviceWorker?.ok) add('SERVICE_WORKER_FAILED');
  if ((checks.serviceWorker?.updateLoops || 0) > config.objectives.serviceWorker.maximumUpdateLoops) add('UPDATE_LOOP');

  if (!checks.routing?.ok) add('ROUTING_FAILED');
  if (finiteNumber(checks.routing?.durationMs) && checks.routing.durationMs > config.objectives.routing.maxDurationMs) {
    add('DURATION_BUDGET_EXCEEDED');
  }

  if (!checks.clientErrors?.ok || (checks.clientErrors?.count || 0) > config.objectives.clientErrors.maximumCount) {
    add('CLIENT_ERROR');
  }
  if (!checks.liveDependencies?.ok || (checks.liveDependencies?.failures || 0) > config.objectives.liveDependencies.maximumFailures) {
    add('LIVE_API_FAILED');
  }

  const criticalCodes = new Set(config.alertPolicy.immediate);
  const warningCodes = new Set(config.alertPolicy.warning);
  const critical = reasons.filter(code => criticalCodes.has(code));
  const warnings = reasons.filter(code => warningCodes.has(code));
  return {
    schemaVersion: 1,
    status: critical.length ? 'critical' : warnings.length ? 'warning' : 'pass',
    releaseFreeze: critical.length >= config.alertPolicy.releaseFreeze.criticalFailureCount,
    reasons,
    critical,
    warnings
  };
}

const indicatorGood = {
  appLoad: (checks, objective) => checks.appLoad?.ok
    && (!finiteNumber(checks.appLoad.durationMs) || checks.appLoad.durationMs <= objective.maxDurationMs),
  requiredAssets: (checks, objective) => checks.requiredAssets?.ok
    && checks.requiredAssets.available >= objective.minimumAvailable
    && (checks.requiredAssets.hashMismatches || 0) <= objective.maximumHashMismatches,
  serviceWorker: (checks, objective) => checks.serviceWorker?.ok
    && (checks.serviceWorker.updateLoops || 0) <= objective.maximumUpdateLoops,
  routing: (checks, objective) => checks.routing?.ok
    && (!finiteNumber(checks.routing.durationMs) || checks.routing.durationMs <= objective.maxDurationMs),
  clientErrors: (checks, objective) => checks.clientErrors?.ok
    && (checks.clientErrors.count || 0) <= objective.maximumCount,
  liveDependencies: (checks, objective) => checks.liveDependencies?.ok
    && (checks.liveDependencies.failures || 0) <= objective.maximumFailures
};

export function evaluateWindow(reports, config = objectives) {
  if (!Array.isArray(reports) || !reports.length) throw new Error('At least one health report is required');
  const ordered = [...reports].sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
  const latest = new Date(ordered.at(-1).observedAt);
  if (!Number.isFinite(latest.getTime())) throw new Error('Health reports require observedAt timestamps');
  const cutoff = latest.getTime() - config.observationWindowDays * 86_400_000;
  const windowReports = ordered.filter(report => new Date(report.observedAt).getTime() >= cutoff);
  const indicators = {};
  let maximumErrorBudgetConsumedPercent = 0;
  for (const [name, objective] of Object.entries(config.objectives)) {
    const good = windowReports.filter(report => indicatorGood[name](report.checks || {}, objective)).length;
    const failures = windowReports.length - good;
    const successPercent = 100 * good / windowReports.length;
    const permittedFailurePercent = 100 - objective.targetPercent;
    const errorBudgetConsumedPercent = failures === 0 ? 0
      : permittedFailurePercent === 0 ? Number.POSITIVE_INFINITY
        : (100 - successPercent) / permittedFailurePercent * 100;
    maximumErrorBudgetConsumedPercent = Math.max(maximumErrorBudgetConsumedPercent, errorBudgetConsumedPercent);
    indicators[name] = {
      samples: windowReports.length,
      good,
      failures,
      successPercent: Number(successPercent.toFixed(4)),
      targetPercent: objective.targetPercent,
      errorBudgetConsumedPercent: Number.isFinite(errorBudgetConsumedPercent)
        ? Number(errorBudgetConsumedPercent.toFixed(1)) : 'infinite'
    };
  }
  const runEvaluations = windowReports.map(report => evaluateHealth(report, config));
  let consecutiveWarnings = 0;
  for (const evaluation of [...runEvaluations].reverse()) {
    if (evaluation.status !== 'warning') break;
    consecutiveWarnings += 1;
  }
  const criticalRuns = runEvaluations.filter(evaluation => evaluation.status === 'critical').length;
  const budgetFreeze = maximumErrorBudgetConsumedPercent >= config.alertPolicy.releaseFreeze.errorBudgetConsumedPercent;
  const warningFreeze = consecutiveWarnings >= config.alertPolicy.releaseFreeze.consecutiveWarningRuns;
  const releaseFreeze = criticalRuns >= config.alertPolicy.releaseFreeze.criticalFailureCount
    || budgetFreeze || warningFreeze;
  return {
    schemaVersion: 1,
    observationWindowDays: config.observationWindowDays,
    from: windowReports[0].observedAt,
    through: windowReports.at(-1).observedAt,
    samples: windowReports.length,
    status: criticalRuns ? 'critical' : releaseFreeze ? 'warning' : 'pass',
    releaseFreeze,
    reasons: [
      ...(criticalRuns ? ['CRITICAL_RUN'] : []),
      ...(budgetFreeze ? ['ERROR_BUDGET_CONSUMED'] : []),
      ...(warningFreeze ? ['CONSECUTIVE_WARNINGS'] : [])
    ],
    criticalRuns,
    consecutiveWarnings,
    indicators
  };
}

export function simulatedReport(mode = 'healthy') {
  const report = {
    schemaVersion: 1,
    observedAt: '2026-07-18T00:00:00.000Z',
    release: 'synthetic-fixture',
    channel: 'test',
    checks: {
      appLoad: { ok: true, durationMs: 1000 },
      requiredAssets: { ok: true, expected: 27, available: 27, hashMismatches: 0 },
      serviceWorker: { ok: true, installed: true, updateLoops: 0 },
      routing: { ok: true, durationMs: 500 },
      clientErrors: { ok: true, count: 0, codes: [] },
      liveDependencies: { ok: true, failures: 0, statusClasses: ['2xx', '2xx'] }
    }
  };
  if (mode === 'missing-asset') {
    Object.assign(report.checks.requiredAssets, { ok: false, available: 26 });
  } else if (mode === 'update-loop') {
    Object.assign(report.checks.serviceWorker, { ok: false, updateLoops: 2 });
  } else if (mode !== 'healthy') {
    throw new Error(`Unknown simulation: ${mode}`);
  }
  return report;
}

function readReports(args) {
  const simulated = args.indexOf('--simulate');
  if (simulated >= 0) return [simulatedReport(args[simulated + 1])];
  const files = args.filter(value => !value.startsWith('--'));
  if (!files.length) throw new Error('Usage: node scripts/health-evaluator.mjs <report.json...> | --simulate <mode>');
  return files.flatMap(file => {
    const value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    return Array.isArray(value) ? value : [value];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reports = readReports(process.argv.slice(2));
  const result = reports.length === 1 ? {
    observedAt: reports[0].observedAt,
    release: reports[0].release,
    ...evaluateHealth(reports[0])
  } : evaluateWindow(reports);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'pass') process.exitCode = 1;
}
