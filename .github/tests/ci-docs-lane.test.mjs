/* global process, URL */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, truncateSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { collectDocumentationLane, DOCUMENTATION_TEST_FILES, verifyDocumentationReceipt } from '../scripts/ci-docs-lane.mjs';
import * as documentationCollector from '../scripts/ci-docs-lane.mjs';
import { documentationPlan, documentationReaderInventory, DOCUMENTATION_POLICY_INPUTS, DOCUMENTATION_ONLY_PATHS } from '../scripts/ci-site-lane.mjs';

function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-documentation-lane-test-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'source'); mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'maintenance.auto', 'false'); git('config', 'gc.auto', '0');
  const put = (path, bytes) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); };
  for (const path of DOCUMENTATION_ONLY_PATHS) put(path, '# Guide\n');
  for (const path of DOCUMENTATION_POLICY_INPUTS) put(path, 'inert policy fixture\n');
  put('src/core/inert.ts', 'export const reader = 0;\n');
  const commit = () => { git('add', '-A'); git('-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(parent, 'absent-hooks')}`, 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); put(DOCUMENTATION_ONLY_PATHS[0], '# Guide updated\n'); const head = commit();
  const reviewedReaderDigest = documentationReaderInventory(root, base).digest;
  const env = { GITHUB_EVENT_NAME: 'pull_request', ASHLR_CI_BASE_SHA: base, ASHLR_CI_SOURCE_SHA: head,
    ASHLR_CI_EVENT_SHA: head, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' };
  const plan = () => documentationPlan({ cwd: root, eventName: env.GITHUB_EVENT_NAME, base: env.ASHLR_CI_BASE_SHA, head: env.ASHLR_CI_SOURCE_SHA, reviewedReaderDigest });
  const raw = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0,
    numTotalTests: DOCUMENTATION_TEST_FILES.length, numPassedTests: DOCUMENTATION_TEST_FILES.length, numPendingTests: 0, numTodoTests: 0,
    testResults: DOCUMENTATION_TEST_FILES.map((file) => ({ name: join(root, file), status: 'passed', assertionResults: [
      { fullName: 'actual fixture case', status: 'passed', failureMessages: [] },
    ] })) });
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    const output = args.find((arg) => arg.startsWith('--outputFile.json='));
    if (output) writeFileSync(output.slice('--outputFile.json='.length), JSON.stringify(raw()));
    return { status: 0 };
  };
  const accepted = () => readdirSync(parent).filter((name) => name.startsWith('phantom-documentation-pr-'))
    .some((name) => readdirSync(join(parent, name)).includes('receipt.json'));
  const context = () => ({ eventSha: env.ASHLR_CI_EVENT_SHA, run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT } });
  return { root, parent, git, put, commit, env, plan, raw, calls, run, accepted, context, reviewedReaderDigest };
}

test('PR lane runs exactly the existing contracts once and emits no release qualification', (t) => {
  const f = fixture(t); const directory = collectDocumentationLane(f);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.slice(0, 2).map((row) => row.args), [['run', 'check:version'], ['run', 'check:docs']]);
  assert.equal(f.calls.every((row) => row.command === 'npm'), true);
  assert.deepEqual(f.calls[2].args.slice(0, 5), ['run', 'test:ci', '--', '--maxWorkers=1', '--fileParallelism=false']);
  assert.deepEqual(f.calls[2].args.slice(5, 9), [...DOCUMENTATION_TEST_FILES]);
  assert.equal(f.calls.some((row) => row.args.includes('build') || row.args.includes('pack') || row.args.includes('publish')), false);
  const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  assert.equal(receipt.releaseEligible, false); assert.equal(receipt.schema, 'phantom-documentation-pr-receipt/v1');
  assert.deepEqual(readdirSync(directory).sort(), ['documentation.json', 'receipt.json']);
  verifyDocumentationReceipt(receipt, readFileSync(join(directory, 'documentation.json')), f.plan(), f.root, f.context());
});

test('held report FD refuses real same-inode growth and shrinkage within the original byte cap', (t) => {
  const f = fixture(t); const path = join(f.parent, 'bounded-report.json'); writeFileSync(path, '{}');
  const fd = openSync(path, 'r');
  try {
    const observed = fstatSync(fd);
    assert.equal(documentationCollector.readBoundedDocumentationReportBytes(fd, observed.size).toString(), '{}');
    appendFileSync(path, 'x'.repeat(5 * 1024 * 1024));
    assert.equal(fstatSync(fd).ino, observed.ino);
    assert.throws(() => documentationCollector.readBoundedDocumentationReportBytes(fd, observed.size), /size changed/);
    truncateSync(path, 1);
    assert.throws(() => documentationCollector.readBoundedDocumentationReportBytes(fd, observed.size), /size changed/);
    assert.throws(() => documentationCollector.readBoundedDocumentationReportBytes(fd, 32 * 1024 * 1024 + 1), /Unsafe/);
  } finally { closeSync(fd); }
});

test('collector rejects real report growth before opening without an unbounded readFileSync', (t) => {
  const f = fixture(t); const stat = fs.lstatSync; const read = fs.readFileSync;
  let grew = false; let unboundedReportReads = 0;
  t.after(() => { fs.lstatSync = stat; fs.readFileSync = read; syncBuiltinESMExports(); });
  fs.lstatSync = (...args) => {
    const before = stat(...args);
    if (!grew && typeof args[0] === 'string' && args[0].endsWith('/documentation.json')) {
      grew = true; appendFileSync(args[0], 'x'.repeat(5 * 1024 * 1024));
      assert.equal(stat(args[0]).ino, before.ino);
    }
    return before;
  };
  fs.readFileSync = (...args) => {
    if (typeof args[0] === 'string' && args[0].endsWith('/documentation.json')) unboundedReportReads++;
    return read(...args);
  };
  syncBuiltinESMExports();
  assert.throws(() => collectDocumentationLane(f), /report changed/);
  assert.equal(grew, true); assert.equal(unboundedReportReads, 0); assert.equal(f.accepted(), false);
});

test('event tree reads ignore inherited Git overrides and do not execute fsmonitor hooks', (t) => {
  const f = fixture(t); const hook = join(f.parent, 'fsmonitor.sh'); const marker = join(f.parent, 'fsmonitor-called');
  writeFileSync(hook, `#!/bin/sh\nprintf called > '${marker}'\nexit 1\n`, { mode: 0o700 });
  f.git('config', 'core.fsmonitor', hook);
  const changed = { GIT_DIR: join(f.parent, 'unrelated-git'), GIT_WORK_TREE: f.parent,
    GIT_INDEX_FILE: join(f.parent, 'unrelated-index'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: hook };
  const saved = Object.fromEntries(Object.keys(changed).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, changed);
    const directory = collectDocumentationLane(f); const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
    assert.equal(receipt.eventSha, f.env.ASHLR_CI_EVENT_SHA); assert.equal(receipt.releaseEligible, false);
    assert.equal(readdirSync(f.parent).includes('fsmonitor-called'), false);
    assert.equal(readdirSync(f.parent).includes('unrelated-index'), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('event tree binding uses original objects despite a local replacement ref', (t) => {
  const f = fixture(t);
  f.git('replace', f.env.ASHLR_CI_SOURCE_SHA, f.env.ASHLR_CI_BASE_SHA);
  const directory = collectDocumentationLane(f); const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  assert.equal(receipt.plan.tree, f.git('--no-replace-objects', 'rev-parse', `${f.env.ASHLR_CI_SOURCE_SHA}^{tree}`));
  assert.equal(receipt.releaseEligible, false);
});

test('unchanged report bytes behind a replaced directory symlink cannot create a receipt', (t) => {
  const f = fixture(t);
  const run = (command, args) => {
    const result = f.run(command, args); const output = args.find(arg => arg.startsWith('--outputFile.json='));
    if (output) {
      const directory = dirname(output.slice('--outputFile.json='.length));
      const relocated = join(f.parent, 'relocated-report'); renameSync(directory, relocated); symlinkSync(relocated, directory);
    }
    return result;
  };
  assert.throws(() => collectDocumentationLane({ ...f, run }), /directory parent/);
  assert.equal(f.accepted(), false);
});

test('documentation reader refuses post-stat nonregular replacement without blocking', (t) => {
  const f = fixture(t);
  const report = join(f.parent, 'documentation.json'); writeFileSync(report, JSON.stringify(f.raw()));
  // Expose the actual private reader only in a fixture module so unrelated Git
  // plan scans do not consume the bounded child's FIFO detection window.
  const subject = readFileSync(new URL('../scripts/ci-docs-lane.mjs', import.meta.url), 'utf8')
    .replace("from './ci-site-lane.mjs'", `from ${JSON.stringify(new URL('../scripts/ci-site-lane.mjs', import.meta.url).href)}`)
    .replace("from './ci-qualification-lane.mjs'", `from ${JSON.stringify(new URL('../scripts/ci-qualification-lane.mjs', import.meta.url).href)}`)
    + '\nexport { boundedReport };\n';
  const script = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { boundedReport } from ${JSON.stringify('data:text/javascript,' + encodeURIComponent(subject))};
const report = ${JSON.stringify(report)};
let swapped = false, targetFd = null, targetReads = 0;
const stat = fs.lstatSync, open = fs.openSync, read = fs.readSync;
fs.lstatSync = (...args) => {
  const before = stat(...args);
  if (!swapped && typeof args[0] === 'string' && args[0].endsWith('/documentation.json')) {
    fs.unlinkSync(args[0]);
    if (process.platform === 'win32') fs.mkdirSync(args[0]);
    else execFileSync('mkfifo', ['-m', '600', args[0]]);
    swapped = true; fs.writeSync(2, 'nonregular-installed\\n');
  }
  return before;
};
fs.openSync = (...args) => { const fd = open(...args); if (typeof args[0] === 'string' && args[0].endsWith('/documentation.json')) targetFd = fd; return fd; };
fs.readSync = (...args) => { if (args[0] === targetFd) targetReads++; return read(...args); };
syncBuiltinESMExports();
try { boundedReport(report); process.exitCode = 2; }
catch (error) { if (!swapped || targetReads !== 0 || !/Documentation report changed/.test(error.message)) process.exitCode = 3; else process.stdout.write('nonregular-refused'); }
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.root, env: { ...process.env }, encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  assert.equal(child.stderr, 'nonregular-installed\n'); assert.equal(child.error, undefined, child.stderr); assert.equal(child.status, 0); assert.equal(child.stdout, 'nonregular-refused');
  assert.equal(f.accepted(), false);
});

for (const mutate of [
  (f) => { f.env.GITHUB_EVENT_NAME = 'push'; },
  (f) => { f.env.ASHLR_CI_SOURCE_SHA = f.env.ASHLR_CI_BASE_SHA; },
  (f) => { f.env.ASHLR_CI_EVENT_SHA = f.env.ASHLR_CI_BASE_SHA; },
  (f) => { f.env.GITHUB_RUN_ATTEMPT = '0'; },
  (f) => { f.put('package.json', '{}'); f.env.ASHLR_CI_SOURCE_SHA = f.commit(); },
]) {
  test('unqualified source/event/run state refuses before any check', (t) => {
    const f = fixture(t); mutate(f);
    assert.throws(() => collectDocumentationLane(f)); assert.equal(f.calls.length, 0); assert.equal(f.accepted(), false);
  });
}

for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('inert startup failure') }]) {
  test('failed/cancelled checks cannot create an accepted receipt', (t) => {
    const f = fixture(t); assert.throws(() => collectDocumentationLane({ ...f, run: () => result }), /check failed/);
    assert.equal(f.accepted(), false);
  });
}

for (const kind of ['source-drift', 'missing-module', 'extra-module', 'failed-case', 'symlink', 'hardlink']) {
  test(`refuses ${kind} without an accepted receipt`, (t) => {
    const f = fixture(t);
    const run = (command, args) => {
      const output = args.find((arg) => arg.startsWith('--outputFile.json='));
      if (!output) return { status: 0 };
      const path = output.slice('--outputFile.json='.length); const raw = f.raw();
      if (kind === 'source-drift') f.put(DOCUMENTATION_ONLY_PATHS[0], '# Drift\n');
      if (kind === 'missing-module') { raw.testResults.pop(); raw.numTotalTests--; raw.numPassedTests--; }
      if (kind === 'extra-module') { raw.testResults.push({ ...raw.testResults[0], name: join(f.root, 'test/unexpected.test.ts') }); raw.numTotalTests++; raw.numPassedTests++; }
      if (kind === 'failed-case') raw.testResults[0].assertionResults[0].status = 'failed';
      if (kind === 'symlink' || kind === 'hardlink') {
        const original = join(f.parent, 'report-copy.json'); writeFileSync(original, JSON.stringify(raw));
        if (kind === 'symlink') symlinkSync(original, path); else linkSync(original, path);
      } else writeFileSync(path, JSON.stringify(raw));
      return { status: 0 };
    };
    assert.throws(() => collectDocumentationLane({ ...f, run })); assert.equal(f.accepted(), false);
  });
}

for (const mutate of [
  (r) => { r.releaseEligible = true; }, (r) => { r.schema = 'phantom-release-qualification/v1'; },
  (r) => { r.plan.head = '0'.repeat(40); }, (r) => { r.plan.changes[0].headBlob = '0'.repeat(40); },
  (r) => { r.plan.readerInventory.digest = '0'.repeat(64); }, (r) => { r.plan.policyInputs[0].blob = '0'.repeat(40); },
  (r) => { r.eventSha = '0'.repeat(40); }, (r) => { r.run.id = '101'; }, (r) => { r.run.attempt = '2'; },
  (r) => { r.report.sha256 = '0'.repeat(64); }, (r) => { r.report.bytes++; },
  (r) => { r.report.modules[0].cases[0].state = 'skipped'; }, (r) => { r.checks.pop(); },
  (r) => { r.extra = 'unreviewed'; },
]) {
  test('receipt or coverage tampering refuses acceptance', (t) => {
    const f = fixture(t); const directory = collectDocumentationLane(f);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'))); mutate(receipt);
    assert.throws(() => verifyDocumentationReceipt(receipt, readFileSync(join(directory, 'documentation.json')), f.plan(), f.root, f.context()));
  });
}
