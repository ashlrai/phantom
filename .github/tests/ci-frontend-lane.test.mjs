/* global process, structuredClone, URL */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { classifySiteLane, frontendCandidate, frontendPlan, frontendReaderInventory, frontendImportInventory, FRONTEND_ONLY_PATHS, FRONTEND_POLICY_INPUTS } from '../scripts/ci-site-lane.mjs';
import { collectFrontendLane, FRONTEND_CONTRACT_FILES, verifyFrontendReceipt } from '../scripts/ci-frontend-lane.mjs';

function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-frontend-lane-test-'))); const root = join(parent, 'repo'); mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/nonexistent', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'maintenance.auto', 'false'); git('config', 'gc.auto', '0');
  for (const path of FRONTEND_ONLY_PATHS) put(path, path.endsWith('.css') ? 'body { color: red; }\n' : 'export const fixture = 1;\n');
  for (const path of FRONTEND_POLICY_INPUTS) put(path, 'inert policy input\n');
  put('.gitignore', '/dist/\n'); put('src/core/guard.ts', 'export const guard = true;\n');
  put('src/web-ui/fixture.test.ts', 'inert'); put('src/web-ui/fixture.test.tsx', 'inert');
  for (const path of FRONTEND_CONTRACT_FILES) put(path, 'inert');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const base = commit(); const reviewedFrontendReaderDigest = frontendReaderInventory(root, base).digest;
  const reviewedFrontendImportDigest = frontendImportInventory(root, base).digest;
  put(FRONTEND_ONLY_PATHS[0], 'export const fixture = 2;\n'); const head = commit();
  const input = () => ({ cwd: root, base, head: git('rev-parse', 'HEAD'), eventName: 'pull_request', reviewedFrontendReaderDigest, reviewedFrontendImportDigest });
  const env = { GITHUB_EVENT_NAME: 'pull_request', ASHLR_CI_BASE_SHA: base, ASHLR_CI_SOURCE_SHA: head, ASHLR_CI_EVENT_SHA: head, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  const raw = (files) => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, numTotalTests: files.length, numPassedTests: files.length, numPendingTests: 0, numTodoTests: 0,
    testResults: files.map((file) => ({ name: join(root, file), status: 'passed', assertionResults: [{ fullName: 'inert case', status: 'passed', failureMessages: [] }] })) });
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    const report = args.find((arg) => arg.startsWith('--outputFile.json='));
    if (report) writeFileSync(report.slice('--outputFile.json='.length), JSON.stringify(raw(args.includes('test:web')
      ? ['src/web-ui/fixture.test.ts', 'src/web-ui/fixture.test.tsx'] : FRONTEND_CONTRACT_FILES)));
    if (args.includes('build:web')) { put('dist/core/web/public/next/index.html', '<div/>'); put('dist/core/web/public/next/.vite/manifest.json', '{}'); }
    return { status: 0 };
  };
  const accepted = () => readdirSync(parent).filter((name) => name.startsWith('phantom-frontend-pr-')).some((name) => readdirSync(join(parent, name)).includes('receipt.json'));
  return { parent, root, git, put, commit, base, head, input, env, raw, calls, run, accepted, reviewedFrontendReaderDigest, reviewedFrontendImportDigest };
}

test('frontend artifact reader refuses post-stat nonregular replacement without blocking', (t) => {
  const f = fixture(t); f.run('npm', ['run', 'build:web']);
  const target = join(f.root, 'dist/core/web/public/next/index.html');
  const script = `import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { frontendBuiltInventory } from ${JSON.stringify(new URL('../scripts/ci-frontend-lane.mjs', import.meta.url).href)};
const root = ${JSON.stringify(f.root)}, target = ${JSON.stringify(target)};
let targetStats = 0, swapped = false, targetFd = null, targetReads = 0;
const stat = fs.lstatSync, open = fs.openSync, read = fs.readSync;
fs.lstatSync = (...args) => {
  const before = stat(...args);
  if (args[0] === target && ++targetStats === 2) {
    fs.unlinkSync(target);
    if (process.platform === 'win32') fs.mkdirSync(target);
    else execFileSync('mkfifo', ['-m', '600', target]);
    swapped = true; fs.writeSync(2, 'nonregular-installed\\n');
  }
  return before;
};
fs.openSync = (...args) => { const fd = open(...args); if (args[0] === target) targetFd = fd; return fd; };
fs.readSync = (...args) => { if (args[0] === targetFd) targetReads++; return read(...args); };
syncBuiltinESMExports();
try { frontendBuiltInventory(root); process.exitCode = 2; }
catch (error) { if (!swapped || targetReads !== 0 || !/Frontend evidence changed/.test(error.message)) process.exitCode = 3; else process.stdout.write('nonregular-refused'); }
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.root, env: { ...process.env }, encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  assert.equal(child.stderr, 'nonregular-installed\n'); assert.equal(child.error, undefined, child.stderr); assert.equal(child.status, 0); assert.equal(child.stdout, 'nonregular-refused');
  assert.equal(f.accepted(), false);
});

test('fresh frontend PR feedback runs complete web once and bounded actual contracts, never release coverage', (t) => {
  const f = fixture(t); assert.equal(frontendCandidate(f.input()), true); assert.equal(classifySiteLane(f.input()), 'frontend');
  const directory = collectFrontendLane(f); const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  assert.equal(receipt.releaseEligible, false); assert.equal(f.calls.length, 7);
  assert.equal(f.calls.filter((call) => call.args.includes('test:web')).length, 1);
  assert.equal(f.calls.filter((call) => call.args.includes('build:web')).length, 1);
  assert.equal(f.calls.some((call) => call.args.some((arg) => ['build', 'pack', 'publish', 'test:ci:sharded'].includes(arg))), false);
  assert.deepEqual(receipt.reports.map((report) => report.modules.length), [2, FRONTEND_CONTRACT_FILES.length]);
  assert.deepEqual(receipt.budgetsKiB, { desktop: 354, mobile: 250 });
});

for (const path of ['src/core/guard.ts', 'src/web-ui/data/client.ts', 'src/web-ui/app/desktop-shell.ts',
  'src/web-ui/routes/verse/shell/guard-store.ts', 'src/web-ui/routes/verse/resources/resource-display-model.ts',
  'src/web-ui/components/primitives/Meter.tsx', 'src/web-ui/fixture.test.ts', 'package.json', 'desktop/x.rs', 'docs/DEMO.md', 'unknown.ts', ...FRONTEND_POLICY_INPUTS]) {
  test(`mixed or unreviewed ${path} remains full`, (t) => {
    const f = fixture(t); f.put(path, 'changed\n'); f.commit(); assert.equal(classifySiteLane(f.input()), 'full');
  });
}
for (const kind of ['mode', 'symlink', 'delete', 'rename', 'new', 'import', 'computed', 'alias', 'import-meta', 'css-url', 'invalid-reader-pin', 'invalid-import-pin']) {
  test(`frontend ${kind} cannot skip full qualification`, (t) => {
    const f = fixture(t); const path = join(f.root, FRONTEND_ONLY_PATHS[0]);
    if (kind === 'mode') chmodSync(path, 0o755);
    if (kind === 'symlink') { rmSync(path); symlinkSync('BarStack.tsx', path); }
    if (kind === 'delete') rmSync(path);
    if (kind === 'rename') renameSync(path, join(f.root, 'renamed.tsx'));
    if (kind === 'new') f.put('src/web-ui/components/charts/new.tsx', 'export {};');
    if (kind === 'import') writeFileSync(path, "import '../unknown.js'; export {};\n");
    if (kind === 'computed') writeFileSync(path, 'export const x = import(globalThis.path);\n');
    if (kind === 'alias') writeFileSync(path, 'const load = require; export const x = load(globalThis.path);\n');
    if (kind === 'import-meta') writeFileSync(path, 'export const x = import.meta.glob("./**");\n');
    if (kind === 'css-url') f.put('src/web-ui/design/global.css', 'body { background:url(https://example.invalid/new); }');
    if (!kind.startsWith('invalid-')) f.commit();
    const input = f.input();
    if (kind === 'invalid-reader-pin') input.reviewedFrontendReaderDigest = 'unknown';
    if (kind === 'invalid-import-pin') input.reviewedFrontendImportDigest = 'unknown';
    assert.equal(classifySiteLane(input), 'full');
  });
}
test('new explicit and generic readers invalidate the seal even without known frontend imports', (t) => {
  const f = fixture(t); f.put('scripts/new-reader.mjs', "readFileSync(root + genericName);\n"); f.commit();
  assert.equal(classifySiteLane(f.input()), 'full');
});
test('non-PR, wrong source, dirty plan and wrong event tree cannot create fast proof', (t) => {
  const f = fixture(t);
  for (const eventName of ['push', 'workflow_call']) assert.equal(classifySiteLane({ ...f.input(), eventName }), 'full');
  assert.throws(() => frontendPlan({ ...f.input(), head: f.base }), /checkout/);
  f.put('untracked.txt', 'dirty'); assert.throws(() => frontendPlan(f.input()), /dirty/); rmSync(join(f.root, 'untracked.txt'));
  assert.throws(() => collectFrontendLane({ ...f, env: { ...f.env, ASHLR_CI_EVENT_SHA: f.base } })); assert.equal(f.calls.length, 0);
});
for (const kind of ['failed-command', 'source-drift', 'missing-web-module', 'missing-contract', 'symlink-report', 'hardlink-report', 'output-link']) {
  test(`frontend ${kind} refuses a receipt`, (t) => {
    const f = fixture(t); const run = (command, args) => {
      if (kind === 'failed-command') return { status: 1 };
      const result = f.run(command, args); const output = args.find((arg) => arg.startsWith('--outputFile.json='));
      if (kind === 'source-drift') f.put(FRONTEND_ONLY_PATHS[0], 'export const drift = true;');
      if (output && (kind === 'missing-web-module' || kind === 'missing-contract')) {
        const path = output.slice('--outputFile.json='.length); const raw = JSON.parse(readFileSync(path));
        if ((kind === 'missing-web-module' && args.includes('test:web')) || (kind === 'missing-contract' && args.includes('test:ci'))) {
          raw.testResults.pop(); raw.numTotalTests--; raw.numPassedTests--; writeFileSync(path, JSON.stringify(raw));
        }
      }
      if (output && (kind === 'symlink-report' || kind === 'hardlink-report')) {
        const path = output.slice('--outputFile.json='.length); renameSync(path, `${path}.actual`);
        if (kind === 'symlink-report') symlinkSync(`${path}.actual`, path); else linkSync(`${path}.actual`, path);
      }
      if (kind === 'output-link' && args.includes('build:web')) symlinkSync('/etc/passwd', join(f.root, 'dist/core/web/public/next/unsafe'));
      return result;
    };
    assert.throws(() => collectFrontendLane({ ...f, run })); assert.equal(f.accepted(), false);
  });
}
test('tampered report, source, case inventory, run, budget and built bytes never verify', (t) => {
  const f = fixture(t); const directory = collectFrontendLane(f); const original = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  const reports = Object.fromEntries(['web.json', 'contracts.json'].map((file) => [file, readFileSync(join(directory, file))]));
  const context = { eventSha: f.head, run: { id: '123', attempt: '1' } }; const plan = frontendPlan(f.input());
  for (const mutate of [
    (receipt) => { receipt.releaseEligible = true; }, (receipt) => { receipt.plan.head = f.base; },
    (receipt) => { receipt.run.attempt = '2'; }, (receipt) => { receipt.budgetsKiB.desktop = 999; },
    (receipt) => { receipt.reports[0].sha256 = '0'.repeat(64); }, (receipt) => { receipt.reports[0].modules.pop(); },
    (receipt) => { receipt.build.entries[0].sha256 = '0'.repeat(64); },
  ]) { const receipt = structuredClone(original); mutate(receipt); assert.throws(() => verifyFrontendReceipt(receipt, reports, plan, f.root, context)); }
  f.put('dist/core/web/public/next/index.html', 'changed'); assert.throws(() => verifyFrontendReceipt(original, reports, plan, f.root, context));
});

test('collector source/module/event reads ignore inherited Git overrides and fsmonitor hooks', (t) => {
  const f = fixture(t); const hook = join(f.parent, 'fsmonitor.sh'); const marker = join(f.parent, 'fsmonitor-called');
  writeFileSync(hook, `#!/bin/sh\necho called > "${marker}"\n`); chmodSync(hook, 0o700); f.git('config', 'core.fsmonitor', hook);
  const old = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = join(f.parent, 'unrelated-git');
    const directory = collectFrontendLane(f);
    const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
    assert.equal(receipt.plan.head, f.head); assert.equal(receipt.eventSha, f.head);
    assert.deepEqual(receipt.reports[0].modules.map((item) => item.file), ['src/web-ui/fixture.test.ts', 'src/web-ui/fixture.test.tsx']);
    assert.equal(readdirSync(f.parent).includes('fsmonitor-called'), false);
  } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
});
test('built inventory refuses a symlinked dist parent even when its files are unchanged', (t) => {
  const f = fixture(t); const directory = collectFrontendLane(f); const receipt = JSON.parse(readFileSync(join(directory, 'receipt.json')));
  const reports = Object.fromEntries(['web.json', 'contracts.json'].map((file) => [file, readFileSync(join(directory, file))]));
  const plan = frontendPlan(f.input());
  renameSync(join(f.root, 'dist'), join(f.parent, 'relocated-dist')); symlinkSync(join(f.parent, 'relocated-dist'), join(f.root, 'dist'));
  assert.throws(() => verifyFrontendReceipt(receipt, reports, plan, f.root,
    { eventSha: f.head, run: { id: '123', attempt: '1' } }), /output parent/);
});
