import fs from 'node:fs';

const governance = JSON.parse(fs.readFileSync(new URL('../release/governance.json', import.meta.url), 'utf8'));
const ownership = JSON.parse(fs.readFileSync(new URL('../release/ownership.json', import.meta.url), 'utf8'));
const channels = JSON.parse(fs.readFileSync(new URL('../release/channels.json', import.meta.url), 'utf8'));
const regressions = JSON.parse(fs.readFileSync(new URL('../release/regressions.json', import.meta.url), 'utf8'));
const nowArg = process.argv.find(argument => argument.startsWith('--date='))?.slice(7);
const today = new Date(`${nowArg || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const due = new Date(`${governance.nextReviewDueOn}T23:59:59Z`);
const failures = [];

if (today > due) failures.push(`policy review overdue since ${governance.nextReviewDueOn}`);
const last = new Date(`${governance.lastReviewedOn}T00:00:00Z`);
const interval = Math.round((due - last) / 86_400_000);
if (interval > governance.maximumIntervalDays + 1) failures.push(`review interval is ${interval} days`);
if (Object.keys(ownership.categories).length < 5) failures.push('ownership categories are incomplete');
if (!ownership.reviewPolicy.ownerReviewRequiredForTier3) failures.push('Tier 3 owner review is not required');
if (channels.channels.previewCanary.minimumTier3SoakHours < 24) failures.push('Tier 3 canary soak is below 24 hours');
if (channels.promotion.rebuildAllowed) failures.push('channel promotion permits rebuilding');
for (const record of regressions.records) {
  if (!record.missedSignal || !record.prevention || record.status !== 'closed') {
    failures.push(`${record.id}: missing learning or still open`);
  }
}

if (failures.length) {
  failures.forEach(failure => console.error(`FAIL  ${failure}`));
  console.error(`\nGOVERNANCE AUDIT FAILED: ${failures.length} issue(s)`);
  process.exitCode = 1;
} else {
  console.log(`GOVERNANCE AUDIT PASSED: next review ${governance.nextReviewDueOn}; ownership, canary and regression learning enforced`);
}
