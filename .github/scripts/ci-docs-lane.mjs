/* global process, console, Buffer */
// Exact-head PR feedback only. Full producer/attestor coverage stays separate.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentationPlan } from './ci-site-lane.mjs';
import { normalizeReport } from './ci-qualification-lane.mjs';

export const DOCUMENTATION_TEST_FILES = Object.freeze([
  'test/documentation-navigation.test.ts',
  'test/authority-release-truth.test.ts',
  'test/m33.release-meta.test.ts',
  'test/m93.service-authority-docs.test.ts',
]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
function plainDirectory(path) {
  assert.ok(isAbsolute(path) && resolve(path) === path, 'Canonical documentation directory required');
  let current = parse(path).root;
  for (const part of [null, ...path.slice(current.length).split(sep).filter(Boolean)]) {
    if (part !== null) current = join(current, part);
    const stat = lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current, 'Unsafe documentation directory parent');
  }
}
function controlledGit(root, args) {
  plainDirectory(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false',
    '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], { cwd: root, env, maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}
/** Pure FD seam: a growing inode cannot allocate or read beyond observed size + 1. */
export function readBoundedDocumentationReportBytes(fd, observedSize) {
  assert.ok(Number.isSafeInteger(observedSize) && observedSize >= 0 && observedSize <= MAX_REPORT_BYTES, 'Unsafe documentation report');
  const buffer = Buffer.alloc(observedSize + 1); let used = 0;
  while (used < buffer.length) {
    const count = readSync(fd, buffer, used, Math.min(64 * 1024, buffer.length - used), used);
    if (!count) break; used += count;
  }
  assert.equal(used, observedSize, 'Documentation report size changed');
  return buffer.subarray(0, used);
}
function boundedReport(path) {
  plainDirectory(dirname(path));
  const before = lstatSync(path);
  const safe = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() &&
    Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= MAX_REPORT_BYTES;
  const same = stat => safe(stat) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid'].every(key => stat[key] === before[key]);
  assert.ok(safe(before) && realpathSync(path) === path, 'Unsafe documentation report');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes;
  try {
    const opened = fstatSync(fd);
    assert.ok(same(opened), 'Documentation report changed');
    bytes = readBoundedDocumentationReportBytes(fd, opened.size);
    assert.ok(same(fstatSync(fd)), 'Documentation report changed');
  } finally { closeSync(fd); }
  plainDirectory(dirname(path));
  assert.ok(same(lstatSync(path)) && realpathSync(path) === path, 'Documentation report reference changed');
  return bytes;
}

export function verifyDocumentationReceipt(receipt, reportBytes, expectedPlan, root, context) {
  keys(receipt, ['schema', 'releaseEligible', 'plan', 'eventSha', 'run', 'checks', 'report']);
  assert.equal(receipt.schema, 'phantom-documentation-pr-receipt/v1');
  assert.equal(receipt.releaseEligible, false);
  assert.equal(expectedPlan.releaseEligible, false);
  assert.deepEqual(receipt.plan, expectedPlan);
  keys(context, ['eventSha', 'run']);
  assert.equal(receipt.eventSha, context.eventSha);
  assert.deepEqual(receipt.run, context.run);
  assert.match(receipt.eventSha, /^[a-f0-9]{40}$/);
  keys(receipt.run, ['id', 'attempt']);
  assert.match(receipt.run.id, /^[1-9][0-9]*$/); assert.match(receipt.run.attempt, /^[1-9][0-9]*$/);
  assert.deepEqual(receipt.checks, ['version', 'documentation', 'documentation-contracts']);
  keys(receipt.report, ['file', 'sha256', 'bytes', 'modules']);
  assert.equal(receipt.report.file, 'documentation.json');
  assert.equal(receipt.report.bytes, reportBytes.length);
  assert.equal(receipt.report.sha256, sha(reportBytes));
  const modules = normalizeReport(JSON.parse(reportBytes.toString('utf8')), root);
  assert.deepEqual(modules.map((item) => item.file).sort(), [...DOCUMENTATION_TEST_FILES].sort(), 'Documentation contract inventory differs');
  assert.deepEqual(receipt.report.modules, modules);
  return receipt;
}

export function collectDocumentationLane({ root, parent, env = process.env, run = spawnSync, reviewedReaderDigest }) {
  plainDirectory(root); plainDirectory(parent);
  assert.equal(env.GITHUB_EVENT_NAME, 'pull_request');
  const input = { eventName: env.GITHUB_EVENT_NAME, cwd: root, base: env.ASHLR_CI_BASE_SHA, head: env.ASHLR_CI_SOURCE_SHA,
    ...(reviewedReaderDigest === undefined ? {} : { reviewedReaderDigest }) };
  const plan = documentationPlan(input);
  assert.match(env.ASHLR_CI_EVENT_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/); assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  // The source binder already checks the actual event tree; retain that check
  // locally as well so a claimed event SHA cannot create accepted PR feedback.
  assert.equal(controlledGit(root, ['rev-parse', `${env.ASHLR_CI_EVENT_SHA}^{tree}`]).toString('utf8').trim(), plan.tree);
  const directory = mkdtempSync(join(parent, 'phantom-documentation-pr-')); plainDirectory(directory); chmodSync(directory, 0o700);
  const report = join(directory, 'documentation.json');
  const commands = [
    ['run', 'check:version'], ['run', 'check:docs'],
    ['run', 'test:ci', '--', '--maxWorkers=1', '--fileParallelism=false', ...DOCUMENTATION_TEST_FILES,
      '--reporter=default', '--reporter=json', `--outputFile.json=${report}`],
  ];
  for (const args of commands) {
    const result = run('npm', args, { cwd: root, env: { ...env }, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) throw new Error('Documentation PR check failed');
  }
  assert.deepEqual(documentationPlan(input), plan, 'Documentation source changed during checks');
  const bytes = boundedReport(report);
  const receipt = { schema: 'phantom-documentation-pr-receipt/v1', releaseEligible: false, plan,
    eventSha: env.ASHLR_CI_EVENT_SHA, run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
    checks: ['version', 'documentation', 'documentation-contracts'],
    report: { file: 'documentation.json', sha256: sha(bytes), bytes: bytes.length, modules: normalizeReport(JSON.parse(bytes), root) } };
  verifyDocumentationReceipt(receipt, bytes, plan, root, { eventSha: env.ASHLR_CI_EVENT_SHA,
    run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT } });
  plainDirectory(directory);
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return directory;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: ci-docs-lane.mjs');
    const directory = collectDocumentationLane({ root: realpathSync(process.cwd()), parent: realpathSync(process.env.RUNNER_TEMP) });
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GitHub step output');
    appendFileSync(process.env.GITHUB_OUTPUT, `lane_dir=${directory}\nrelease_eligible=false\n`);
    console.log('Reviewed documentation PR passed; not eligible for release admission.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
