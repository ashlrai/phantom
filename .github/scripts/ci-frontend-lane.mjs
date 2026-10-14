/* global process, console, Buffer */
// Fresh PR feedback. It never replaces original producer/attestor coverage.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontendPlan } from './ci-site-lane.mjs';
import { normalizeReport } from './ci-qualification-lane.mjs';

export const FRONTEND_CONTRACT_FILES = Object.freeze([
  'test/web-ui-browser-safe-imports.test.ts', 'test/web-console-layout-contract.test.ts',
  'test/projection-authority-architecture-contract.test.ts', 'test/authority-tier1-closure-310b.test.ts',
  'test/verse-contracts-310.test.ts', 'test/verse-api-mount-310.test.ts', 'test/verse-control-api.test.ts',
  'test/web-read-session-revocations.test.ts', 'test/web-read-projection-api.test.ts', 'test/verse-mobile-static.test.ts',
]);
const CHECKS = Object.freeze(['version', 'web-types', 'web-lint', 'web-complete', 'web-build', 'first-paint-built', 'frontend-contracts']);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
function controlledGit(root, args) {
  assert.ok(isAbsolute(root) && realpathSync(root) === root, 'Canonical frontend source required');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}
function boundedBytes(path, maximum) {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid() && before.size <= maximum, 'Unsafe frontend evidence');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes;
  try {
    const opened = fstatSync(fd);
    assert.ok(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size &&
      opened.mtimeMs === before.mtimeMs && opened.ctimeMs === before.ctimeMs, 'Frontend evidence changed');
    const buffer = Buffer.alloc(opened.size + 1); let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, Math.min(64 * 1024, buffer.length - used), used);
      if (!count) break; used += count;
    }
    assert.equal(used, opened.size, 'Frontend evidence size changed');
    const after = fstatSync(fd);
    assert.ok(after.size === opened.size && after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs, 'Frontend evidence changed');
    bytes = buffer.subarray(0, used);
  } finally { closeSync(fd); }
  const after = lstatSync(path);
  assert.ok(after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
    after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs, 'Frontend evidence reference changed');
  return bytes;
}
export function frontendBuiltInventory(root) {
  assert.ok(isAbsolute(root) && realpathSync(root) === root, 'Canonical frontend source required');
  let parent = root;
  for (const part of ['dist', 'core', 'web', 'public', 'next']) {
    parent = join(parent, part); const stat = lstatSync(parent);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(parent) === parent, 'Unsafe frontend output parent');
  }
  const directory = parent; const entries = []; let total = 0;
  const walk = (path, relative = '') => {
    const stat = lstatSync(path); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Unsafe frontend output directory');
    for (const name of readdirSync(path).sort()) {
      assert.ok(name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\'), 'Unsafe frontend output name');
      const child = join(path, name); const rel = relative ? `${relative}/${name}` : name; const leaf = lstatSync(child);
      if (leaf.isDirectory() && !leaf.isSymbolicLink()) walk(child, rel);
      else {
        const bytes = boundedBytes(child, 32 * 1024 * 1024); total += bytes.length;
        assert.ok(total <= 256 * 1024 * 1024 && entries.length < 10_000, 'Frontend output exceeds bound');
        entries.push({ path: rel, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }; walk(directory);
  assert.ok(entries.some((entry) => entry.path === 'index.html') && entries.some((entry) => entry.path === '.vite/manifest.json'), 'Incomplete frontend build');
  return { entries, bytes: total, sha256: sha(JSON.stringify(entries)) };
}
function webModules(root, head) {
  const output = controlledGit(root, ['ls-tree', '-rz', '--name-only', head, '--', 'src/web-ui']).toString();
  assert.ok(output.endsWith('\0'), 'Incomplete frontend test inventory');
  return output.slice(0, -1).split('\0').filter((path) => /^src\/web-ui\/.*\.test\.(?:ts|tsx)$/.test(path) &&
    !/(?:^|\/)(?:node_modules|dist)\//.test(path)).sort();
}
export function verifyFrontendReceipt(receipt, reports, expectedPlan, root, context) {
  keys(receipt, ['schema', 'releaseEligible', 'plan', 'eventSha', 'run', 'checks', 'reports', 'build', 'budgetsKiB']);
  assert.equal(receipt.schema, 'phantom-frontend-pr-receipt/v1'); assert.equal(receipt.releaseEligible, false);
  assert.equal(expectedPlan.releaseEligible, false); assert.deepEqual(receipt.plan, expectedPlan);
  keys(context, ['eventSha', 'run']); assert.equal(receipt.eventSha, context.eventSha); assert.deepEqual(receipt.run, context.run);
  assert.match(receipt.eventSha, /^[a-f0-9]{40}$/); keys(receipt.run, ['id', 'attempt']);
  assert.match(receipt.run.id, /^[1-9][0-9]*$/); assert.match(receipt.run.attempt, /^[1-9][0-9]*$/);
  assert.deepEqual(receipt.checks, CHECKS); assert.deepEqual(receipt.budgetsKiB, { desktop: 354, mobile: 250 });
  assert.deepEqual(Object.keys(reports).sort(), ['contracts.json', 'web.json']);
  assert.deepEqual(receipt.reports.map((report) => report.file), ['web.json', 'contracts.json']);
  for (const report of receipt.reports) {
    keys(report, ['file', 'sha256', 'bytes', 'modules']); const bytes = reports[report.file];
    assert.equal(report.sha256, sha(bytes)); assert.equal(report.bytes, bytes.length);
    const modules = normalizeReport(JSON.parse(bytes), root); assert.deepEqual(report.modules, modules);
    assert.deepEqual(modules.map((item) => item.file).sort(), report.file === 'web.json'
      ? webModules(root, expectedPlan.head) : [...FRONTEND_CONTRACT_FILES].sort(), 'Frontend module inventory differs');
  }
  assert.deepEqual(receipt.build, frontendBuiltInventory(root), 'Frontend built bytes differ');
  return receipt;
}
export function collectFrontendLane({ root, parent, env = process.env, run = spawnSync,
  reviewedFrontendReaderDigest, reviewedFrontendImportDigest }) {
  assert.ok(isAbsolute(root) && realpathSync(root) === root && isAbsolute(parent) && realpathSync(parent) === parent);
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  const input = { eventName: env.GITHUB_EVENT_NAME, cwd: root, base: env.ASHLR_CI_BASE_SHA, head: env.ASHLR_CI_SOURCE_SHA,
    ...(reviewedFrontendReaderDigest === undefined ? {} : { reviewedFrontendReaderDigest }),
    ...(reviewedFrontendImportDigest === undefined ? {} : { reviewedFrontendImportDigest }) };
  const plan = frontendPlan(input); assert.match(env.ASHLR_CI_EVENT_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(controlledGit(root, ['rev-parse', `${env.ASHLR_CI_EVENT_SHA}^{tree}`]).toString('utf8').trim(), plan.tree);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/); assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  const directory = realpathSync(mkdtempSync(join(parent, 'phantom-frontend-pr-'))); chmodSync(directory, 0o700);
  const commands = [ ['run', 'check:version'], ['run', 'typecheck:web'], ['exec', '--offline', '--no', '--', 'eslint', 'src/web-ui'],
    ['run', 'test:web', '--', '--reporter=default', '--reporter=json', `--outputFile.json=${join(directory, 'web.json')}`],
    ['run', 'build:web'], ['run', 'check:first-paint:built'],
    ['run', 'test:ci', '--', '--maxWorkers=1', '--fileParallelism=false', ...FRONTEND_CONTRACT_FILES,
      '--reporter=default', '--reporter=json', `--outputFile.json=${join(directory, 'contracts.json')}`] ];
  for (const args of commands) {
    const child = run('npm', args, { cwd: root, env: { ...env }, stdio: 'inherit' });
    if (child.error || child.signal || child.status !== 0) throw new Error('Frontend PR check failed');
  }
  assert.deepEqual(frontendPlan(input), plan, 'Frontend source changed during checks');
  const reports = Object.fromEntries(['web.json', 'contracts.json'].map((file) => [file, boundedBytes(join(directory, file), 32 * 1024 * 1024)]));
  const receipt = { schema: 'phantom-frontend-pr-receipt/v1', releaseEligible: false, plan,
    eventSha: env.ASHLR_CI_EVENT_SHA, run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT }, checks: [...CHECKS],
    reports: Object.entries(reports).map(([file, bytes]) => ({ file, sha256: sha(bytes), bytes: bytes.length, modules: normalizeReport(JSON.parse(bytes), root) })),
    build: frontendBuiltInventory(root), budgetsKiB: { desktop: 354, mobile: 250 } };
  verifyFrontendReceipt(receipt, reports, plan, root, { eventSha: env.ASHLR_CI_EVENT_SHA, run: receipt.run });
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return directory;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: ci-frontend-lane.mjs');
    const directory = collectFrontendLane({ root: realpathSync(process.cwd()), parent: realpathSync(process.env.RUNNER_TEMP) });
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output');
    appendFileSync(process.env.GITHUB_OUTPUT, `lane_dir=${directory}\nrelease_eligible=false\n`);
    console.log('Reviewed frontend PR passed; not eligible for release admission.');
  } catch { console.error('Frontend PR qualification failed.'); process.exitCode = 1; }
}
