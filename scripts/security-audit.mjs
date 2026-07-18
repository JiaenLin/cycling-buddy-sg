import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const failures = [];
const pass = message => console.log(`PASS  ${message}`);
const fail = message => failures.push(message);

const inventory = JSON.parse(read('release/security-inventory.json'));
for (const component of inventory.vendoredRuntime) {
  for (const [file, expected] of Object.entries(component.files)) {
    if (!fs.existsSync(path.join(root, file))) fail(`${file}: missing vendored file`);
    else if (sha256(file) !== expected) fail(`${file}: checksum differs from reviewed inventory`);
  }
}
if (!failures.length) pass('Vendored runtime checksums and provenance');

const packageJson = JSON.parse(read('package.json'));
if (Object.keys(packageJson.dependencies || {}).length) fail('Runtime npm dependencies are prohibited without a Tier 3 review');
for (const dependency of inventory.developmentDependencies) {
  if (packageJson.devDependencies?.[dependency.name] !== dependency.version) {
    fail(`${dependency.name}: package.json must pin reviewed version ${dependency.version}`);
  }
}
if (!failures.some(message => message.includes('package.json'))) pass('Exact reviewed development dependencies; zero runtime packages');

const workflows = [];
const workflowRoot = path.join(root, '.github', 'workflows');
if (fs.existsSync(workflowRoot)) {
  for (const entry of fs.readdirSync(workflowRoot)) {
    if (/\.ya?ml$/i.test(entry)) workflows.push(path.join('.github', 'workflows', entry).replaceAll('\\', '/'));
  }
}
for (const workflow of workflows) {
  for (const [index, line] of read(workflow).split(/\r?\n/).entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith('./') || match[1].startsWith('docker://')) continue;
    const ref = match[1].split('@')[1] || '';
    if (!/^[0-9a-f]{40}$/.test(ref)) fail(`${workflow}:${index + 1}: action must be pinned to a 40-character commit`);
  }
}
if (!failures.some(message => message.includes('action must be pinned'))) pass('GitHub Actions immutable commit pins');

const ignoredRoots = new Set(['.git', 'node_modules', 'vendor', 'data', 'icons', '.artifacts', 'playwright-report', 'test-results']);
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.txt', '.webmanifest', '.py']);
const scanFiles = [];
function walk(directory, relative = '') {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredRoots.has(entry.name) || entry.name.startsWith('UsersLinDesktop')) continue;
    const childRelative = path.join(relative, entry.name);
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(child, childRelative);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase()) || ['LICENSE', 'SECURITY.md'].includes(entry.name)) {
      scanFiles.push(childRelative.replaceAll('\\', '/'));
    }
  }
}
walk(root);
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[opusr]_[A-Za-z0-9_]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/]
];
for (const file of scanFiles) {
  const content = read(file);
  for (const [label, pattern] of secretPatterns) if (pattern.test(content)) fail(`${file}: possible ${label}`);
}
if (!failures.some(message => message.includes('possible'))) pass(`Secret patterns — ${scanFiles.length} first-party text files`);

for (const required of ['SECURITY.md', 'docs/security/THREAT_MODEL.md', 'docs/security/CSP_ASSESSMENT.md', 'release/security-review.json']) {
  if (!fs.existsSync(path.join(root, required))) fail(`${required}: required security record missing`);
}
if (!failures.some(message => message.includes('security record missing'))) pass('Threat model, CSP assessment, vulnerability review and private reporting path');

try {
  const command = process.platform === 'win32' ? process.env.ComSpec : 'npm';
  const commandArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd audit --json --audit-level=high']
    : ['audit', '--json', '--audit-level=high'];
  const status = execFileSync(command, commandArgs, { cwd: root, encoding: 'utf8' });
  const audit = JSON.parse(status);
  if ((audit.metadata?.vulnerabilities?.high || 0) + (audit.metadata?.vulnerabilities?.critical || 0) > 0) {
    fail('npm audit reports high/critical vulnerabilities');
  } else pass('npm audit — no high/critical vulnerabilities');
} catch (error) {
  try {
    const audit = JSON.parse(error.stdout || '{}');
    if ((audit.metadata?.vulnerabilities?.high || 0) + (audit.metadata?.vulnerabilities?.critical || 0) > 0) {
      fail('npm audit reports high/critical vulnerabilities');
    } else fail('npm audit could not be evaluated');
  } catch { fail('npm audit could not be evaluated'); }
}

if (failures.length) {
  for (const message of failures) console.error(`FAIL  ${message}`);
  console.error(`\nSECURITY AUDIT FAILED: ${failures.length} issue(s)`);
  process.exitCode = 1;
} else {
  console.log('\nSECURITY AUDIT PASSED');
}
