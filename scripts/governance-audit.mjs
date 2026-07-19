import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

const governance = readJson('release/governance.json');
const ownership = readJson('release/ownership.json');
const channels = readJson('release/channels.json');
const regressions = readJson('release/regressions.json');
const nowArg = process.argv.find(argument => argument.startsWith('--date='))?.slice(7);
const today = new Date(`${nowArg || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const due = new Date(`${governance.nextReviewDueOn}T23:59:59Z`);
const failures = [];

// --- Review cadence, ownership, canary and regression learning (existing policy) ---
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

// --- Private-file boundary (UPDATE_RULES §1) -------------------------------------
// Private operating docs must never be tracked in the public repository. .gitignore
// is defence-in-depth; this tripwire is the enforcement: if a private file is ever
// committed it turns protected-branch CI red instead of relying on human vigilance.
const PRIVATE_POLICY_PATTERNS = [
  /(^|\/)UPDATE_RULES\.md$/i,
  /(^|\/)LAUNCH_CHECKLIST\.md$/i,
  /\.private\.md$/i,
  /(^|\/)notes\//i,
];
const gitTracked = args => execFileSync('git', ['ls-files', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).split('\n').filter(Boolean);

let trackedFiles = null;
try {
  trackedFiles = gitTracked([]);
  const leaked = trackedFiles.filter(file => PRIVATE_POLICY_PATTERNS.some(rx => rx.test(file)));
  for (const file of leaked) failures.push(`private policy file is tracked in the public repo: ${file}`);
} catch (error) {
  const stderr = (error.stderr || '').toString();
  if (/not a git repository/i.test(stderr)) {
    console.log('NOTE  private-file boundary not checked (not a git checkout)');
  } else {
    failures.push(`private-file boundary check could not run: ${error.message}`);
  }
}

// --- Documented-command integrity ------------------------------------------------
// Every `npm run <script>` cited in a tracked doc must resolve to a defined script,
// so the operating guide cannot silently drift from the tooling as the app grows.
const definedScripts = new Set(Object.keys(readJson('package.json').scripts || {}));
if (trackedFiles) {
  const docFiles = trackedFiles.filter(file => file.endsWith('.md') || file === 'llms.txt');
  const commandRef = /npm run ([a-zA-Z][\w:-]*)/g;
  for (const rel of docFiles) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const match of text.matchAll(commandRef)) {
      if (!definedScripts.has(match[1])) {
        failures.push(`${rel}: references undefined script "npm run ${match[1]}"`);
      }
    }
  }
}

if (failures.length) {
  failures.forEach(failure => console.error(`FAIL  ${failure}`));
  console.error(`\nGOVERNANCE AUDIT FAILED: ${failures.length} issue(s)`);
  process.exitCode = 1;
} else {
  console.log('GOVERNANCE AUDIT PASSED: next review '
    + `${governance.nextReviewDueOn}; ownership, canary, regression learning, `
    + 'private-file boundary and documented-command integrity enforced');
}
