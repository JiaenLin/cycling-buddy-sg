import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateHealth, evaluateWindow, simulatedReport, updateLoopCount
} from '../../scripts/health-evaluator.mjs';

test('initial service-worker control is not counted as an update loop', () => {
  assert.equal(updateLoopCount(false, 0), 0);
  assert.equal(updateLoopCount(false, 1), 0);
  assert.equal(updateLoopCount(false, 2), 1);
  assert.equal(updateLoopCount(true, 1), 1);
  assert.throws(() => updateLoopCount(false, -1), /non-negative integer/);
});

test('healthy synthetic report passes without freezing release', () => {
  const result = evaluateHealth(simulatedReport('healthy'));
  assert.equal(result.status, 'pass');
  assert.equal(result.releaseFreeze, false);
  assert.deepEqual(result.reasons, []);
});

test('missing release asset raises the expected critical freeze signal', () => {
  const result = evaluateHealth(simulatedReport('missing-asset'));
  assert.equal(result.status, 'critical');
  assert.equal(result.releaseFreeze, true);
  assert.ok(result.reasons.includes('ASSET_MISSING'));
});

test('service-worker update loop raises the expected critical freeze signal', () => {
  const result = evaluateHealth(simulatedReport('update-loop'));
  assert.equal(result.status, 'critical');
  assert.equal(result.releaseFreeze, true);
  assert.ok(result.reasons.includes('UPDATE_LOOP'));
});

test('two consecutive upstream warnings freeze a 28-day release window', () => {
  const reports = Array.from({ length: 10 }, (_, index) => {
    const report = simulatedReport('healthy');
    report.observedAt = `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`;
    if (index >= 8) Object.assign(report.checks.liveDependencies, { ok: false, failures: 1 });
    return report;
  });
  const result = evaluateWindow(reports);
  assert.equal(result.releaseFreeze, true);
  assert.equal(result.consecutiveWarnings, 2);
  assert.ok(result.reasons.includes('CONSECUTIVE_WARNINGS'));
  assert.equal(result.indicators.appLoad.successPercent, 100);
});
