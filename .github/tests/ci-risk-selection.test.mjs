import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { classifyRisk, ownerPatterns } from '../scripts/ci-risk-selection.mjs';

const root = resolve(import.meta.dirname, '../..');
const owners = readFileSync(join(root, '.github/CODEOWNERS'), 'utf8');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const put = (cwd, path, content) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), content);
};

test('generated ownership map protects security docs, config and Tier-1 tests', () => {
  const patterns = ownerPatterns(owners);
  for (const path of ['docs/AUTHORITY.md', '.github/workflows/ci.yml', 'package.json',
    'nested/package-lock.json', 'test/authority-codeowners-310b.test.ts']) {
    assert.ok(patterns.some(p => p.test(path)), path);
  }
  for (const text of ['', '/docs/*', '!docs/* @owner', '/docs/[ab] @owner', '/docs/* invalid']) {
    assert.throws(() => ownerPatterns(text));
  }
  assert.ok(ownerPatterns('/docs/** @owner\n/docs/a.md @other')[0].test('docs/a.md'));
});

test('real Git diffs include removed paths, modes and base ownership', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-risk-'));
  try {
    git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    put(cwd, '.github/CODEOWNERS', owners);
    put(cwd, 'docs/AUTHORITY.md', 'protected'); put(cwd, 'docs/guide.md', 'base');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
    const base = git(cwd, 'rev-parse', 'HEAD');
    const check = (change, expected) => {
      git(cwd, 'reset', '--hard', base); git(cwd, 'clean', '-fdq');
      change(); git(cwd, 'add', '-A'); git(cwd, 'commit', '--allow-empty', '-qm', 'candidate');
      const head = git(cwd, 'rev-parse', 'HEAD');
      for (const eventName of ['pull_request', 'merge_group']) {
        assert.equal(classifyRisk({ cwd, base, head, eventName }), expected);
      }
      assert.throws(() => classifyRisk({ cwd, base, head: 'bad', eventName: 'pull_request' }));
      assert.throws(() => classifyRisk({ cwd, base, head: base, eventName: 'pull_request' }));
    };
    check(() => put(cwd, 'docs/new guide.md', 'new'), 'smoke');
    check(() => put(cwd, 'test/ordinary-example.test.ts', 'test'), 'smoke');
    check(() => rmSync(join(cwd, 'docs/guide.md')), 'smoke');
    check(() => put(cwd, 'docs/AUTHORITY.md', 'changed'), 'full');
    check(() => { git(cwd, 'mv', 'docs/AUTHORITY.md', 'docs/renamed.md'); }, 'full');
    check(() => { rmSync(join(cwd, 'docs/guide.md')); symlinkSync('AUTHORITY.md', join(cwd, 'docs/guide.md')); }, 'full');
    check(() => chmodSync(join(cwd, 'docs/guide.md'), 0o755), 'full');
    check(() => put(cwd, 'src/example.ts', 'source'), 'full');
    check(() => put(cwd, '.github/CODEOWNERS', '/unused @owner'), 'full');
    check(() => {}, 'full');
    // A behind PR must use current base ownership, not the older merge base map.
    const head = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '--detach', base);
    put(cwd, '.github/CODEOWNERS', owners + '\n/docs/guide.md @owner\n');
    git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'new protection');
    const newerBase = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'checkout', '--detach', head);
    put(cwd, 'docs/guide.md', 'changed'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'docs');
    const behind = { cwd, base: newerBase, head: git(cwd, 'rev-parse', 'HEAD') };
    assert.equal(classifyRisk({ ...behind, eventName: 'pull_request' }), 'full');
    assert.throws(() => classifyRisk({ ...behind, eventName: 'merge_group' }));
    for (const eventName of ['schedule', 'push', 'workflow_dispatch']) assert.equal(classifyRisk({ eventName }), 'full');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('advisory patch applies and preserves secret gates, actions and permissions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-risk-patch-'));
  try {
    const original = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    put(cwd, '.github/workflows/ci.yml', original);
    execFileSync('git', ['apply', join(root, 'docs/strategy/ci-rightsizing.patch')], { cwd });
    const before = parse(original), after = parse(readFileSync(join(cwd, '.github/workflows/ci.yml'), 'utf8'));
    for (const key of ['secret-shape', 'secret-scan']) assert.deepEqual(after.jobs[key], before.jobs[key]);
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(Object.keys(after.on), Object.keys(before.on));
    assert.deepEqual(after.jobs['release-build'], before.jobs['release-build']);
    const gate = after.jobs['merge-gate'];
    const script = gate.steps[0].run.split("node <<'NODE'\n")[1].split('\nNODE')[0];
    const platform = ['ci-shared-macos', 'mac-general', 'mac-isolated', 'native-macos-broker-foundation', 'windows-service-authority'];
    const evaluate = (event, risk, mutations = {}, schedule = '') => {
      const fast = ['pull_request', 'merge_group', 'push'].includes(event);
      const full = !fast || (event !== 'push' && risk === 'full');
      const jobs = Object.fromEntries(gate.needs.map(name => [name, { result: 'skipped' }]));
      for (const name of ['secret-shape', 'secret-scan', 'classify', ...(fast ? ['quick'] : []), ...(full ? ['ci'] : []),
        ...(full && schedule !== '17 * * * *' ? platform : [])]) jobs[name].result = 'success';
      jobs.classify.outputs = { risk, lane: 'full', release_gate: 'false' };
      if (risk) for (const name of ['ci', ...platform]) {
        const scheduled = runInNewContext(after.jobs[name].if, { needs: { classify: jobs.classify },
          github: { event_name: event, ref: 'refs/heads/master', event: { schedule } } });
        assert.equal(scheduled, jobs[name].result === 'success', name);
      }
      for (const [key, value] of Object.entries(mutations)) jobs[key].result = value;
      runInNewContext(script, { process: { env: { EVENT_NAME: event, REF: 'refs/heads/master', SCHEDULE: schedule, GATE_NEEDS: JSON.stringify(jobs) } }, console: { log() {} } });
    };
    for (const event of ['pull_request', 'merge_group']) {
      evaluate(event, 'smoke'); evaluate(event, 'full');
      for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
        for (const job of ['quick', 'secret-shape', 'secret-scan', 'classify']) assert.throws(() => evaluate(event, 'smoke', { [job]: result }));
        for (const job of ['ci', ...platform]) assert.throws(() => evaluate(event, 'full', { [job]: result }));
      }
      assert.throws(() => evaluate(event, undefined));
    }
    evaluate('push', 'full'); evaluate('schedule', 'full', {}, '17 * * * *');
    evaluate('schedule', 'full', {}, '47 3 * * *'); evaluate('workflow_dispatch', 'full');
    for (const job of Object.values(after.jobs)) for (const step of job.steps ?? []) {
      if (step.uses && !step.uses.startsWith('./')) assert.match(step.uses, /@[a-f0-9]{40}$/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
