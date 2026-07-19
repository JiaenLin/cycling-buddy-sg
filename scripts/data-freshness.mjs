import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deterministic staleness gate over source snapshots and active closures. This is
// distinct from data-reproducibility (which locks output hashes) and verify.mjs
// (which locks counts/bounds/geometry): it is the only gate that reads provenance
// and closure dates and asks "is any of this too old to ship?". The highest real
// product risk is a stale or expired closure/route reaching a rider.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// A fixed system date is used in production/CI; --date=YYYY-MM-DD overrides it for tests.
const dateArg = process.argv.find(arg => arg.startsWith('--date='))?.slice(7);
const today = new Date(`${dateArg || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const parseDay = value => (ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null);
const ageDays = from => Math.floor((today - from) / DAY_MS);

const failures = [];
const warnings = [];
const fail = message => failures.push(message);
const warn = message => warnings.push(message);

const lock = readJson('release/data-sources.json');

// --- 1. Source snapshot freshness ------------------------------------------------
const freshness = lock.freshness;
if (!freshness?.sources || !freshness.defaults) {
  fail('release/data-sources.json: missing freshness policy block');
} else {
  const { warnAfterDays, failAfterDays } = freshness.defaults;
  for (const [name, config] of Object.entries(freshness.sources)) {
    const captured = parseDay(config.capturedOn);
    if (!captured) {
      fail(`freshness ${name}: capturedOn must be YYYY-MM-DD, got ${JSON.stringify(config.capturedOn)}`);
      continue;
    }
    if (captured > today) {
      fail(`freshness ${name}: capturedOn ${config.capturedOn} is in the future`);
      continue;
    }
    const age = ageDays(captured);
    const failAfter = config.failAfterDays ?? failAfterDays;
    const warnAfter = config.warnAfterDays ?? warnAfterDays;
    if (age > failAfter) {
      fail(`freshness ${name}: source snapshot is ${age}d old (> ${failAfter}d) — re-check against the source before release`);
    } else if (age > warnAfter) {
      warn(`freshness ${name}: source snapshot is ${age}d old (> ${warnAfter}d) — schedule a refresh`);
    }
  }
}

// --- 2. Closure temporal validity ------------------------------------------------
const closurePolicy = lock.closures;
const closureMeta = readJson('data/closures.meta.json');
const active = closureMeta.active || [];
if (closureMeta.count !== active.length) {
  fail(`closures.meta.json: count ${closureMeta.count} != active entries ${active.length}`);
}

let hasOpenEnded = false;
active.forEach((closure, index) => {
  const label = closure.name || `#${index}`;
  const from = parseDay(closure.from);
  if (!from) fail(`closure ${label}: "from" must be YYYY-MM-DD, got ${JSON.stringify(closure.from)}`);
  else if (from > today) fail(`closure ${label}: starts in the future (${closure.from}) but is listed active`);

  const until = parseDay(closure.until);
  if (until) {
    if (until < today) fail(`closure ${label}: ended ${closure.until} but is still shipped as active — remove it and rebuild`);
  } else if (typeof closure.until === 'string' && closure.until.trim()) {
    hasOpenEnded = true; // e.g. "~2028": governed by the review cadence below
  } else {
    fail(`closure ${label}: missing an "until" end date or open-ended marker`);
  }
});

if (hasOpenEnded) {
  const reviewed = parseDay(closurePolicy?.lastReviewedOn);
  if (!reviewed) {
    fail('release/data-sources.json: open-ended closures require closures.lastReviewedOn as YYYY-MM-DD');
  } else {
    const interval = closurePolicy.reviewIntervalDays ?? 120;
    const since = ageDays(reviewed);
    if (since > interval) {
      fail(`open-ended closures last verified ${since}d ago (> ${interval}d) — re-confirm against the official source and update closures.lastReviewedOn`);
    }
  }
}

// --- report ----------------------------------------------------------------------
warnings.forEach(message => console.log(`WARN  ${message}`));
if (failures.length) {
  failures.forEach(message => console.error(`FAIL  ${message}`));
  console.error(`\nDATA FRESHNESS FAILED: ${failures.length} issue(s)`);
  process.exitCode = 1;
} else {
  const suffix = warnings.length ? ` (${warnings.length} warning(s))` : '';
  console.log(`DATA FRESHNESS PASSED: source snapshot ages and closure validity windows within policy${suffix}`);
}
