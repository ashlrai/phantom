import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRange, mergeBase, resolveScanBase, shallowInRange, usableSha } from '../scripts/ci-fetch-range.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('a shallow clone deepens until the merge base exists and fails closed if it cannot', (t) => {
  const origin = mkdtempSync(join(tmpdir(), 'ci-fetch-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'ci-fetch-clone-'));
  t.after(() => { rmSync(origin, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); });
  sh(origin, 'init', '-q', '-b', 'master');
  sh(origin, 'config', 'user.email', 'ci@example.invalid');
  sh(origin, 'config', 'user.name', 'ci');
  sh(origin, 'config', 'commit.gpgsign', 'false');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: origin });
  const base = sh(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'next'], { cwd: origin });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'head'], { cwd: origin });
  const head = sh(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);
  assert.equal(mergeBase(clone, base, head), null);
  const result = ensureRange({ cwd: clone, base, head, baseRef: 'master' });
  assert.equal(mergeBase(clone, base, head), base);
  assert.equal(shallowInRange(clone, base, head).length, 0);
  assert.equal(result.unshallowed, false);
  assert.throws(() => ensureRange({
    cwd: clone,
    base: 'a'.repeat(40),
    head,
    git: () => { throw new Error('fetch failed'); },
  }));
});

test('a shallow commit inside the range is unshallowed or the range fails', (t) => {
  const origin = mkdtempSync(join(tmpdir(), 'ci-shallow-origin-'));
  const clone = mkdtempSync(join(tmpdir(), 'ci-shallow-clone-'));
  t.after(() => { rmSync(origin, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); });
  sh(origin, 'init', '-q', '-b', 'master');
  sh(origin, 'config', 'user.email', 'ci@example.invalid');
  sh(origin, 'config', 'user.name', 'ci');
  sh(origin, 'config', 'commit.gpgsign', 'false');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: origin });
  const base = sh(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'mid'], { cwd: origin });
  const mid = sh(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'head'], { cwd: origin });
  const head = sh(origin, 'rev-parse', 'HEAD');
  execFileSync('git', ['clone', '-q', '--depth', '2', `file://${origin}`, clone]);
  assert.ok(shallowInRange(clone, base, head).includes(mid) || shallowInRange(clone, base, head).length > 0);
  const result = ensureRange({ cwd: clone, base, head, baseRef: 'master' });
  assert.equal(shallowInRange(clone, base, head).length, 0);
  assert.equal(result.unshallowed || !shallowInRange(clone, base, head).length, true);
});

test('a short candidate history deepens before the base ref window is fetched', () => {
  const calls = [];
  let connected = false;
  const dir = mkdtempSync(join(tmpdir(), 'ci-range-short-'));
  const git = (cwd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'merge-base') {
      if (!connected) throw new Error('not yet');
      return 'a'.repeat(40);
    }
    if (args.includes('--deepen=20')) { connected = true; return ''; }
    if (args[0] === 'rev-parse' && args.includes('--git-path')) return join(cwd, 'missing-shallow');
    if (args[0] === 'rev-list') return '';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const settled = ensureRange({ cwd: dir, base: 'b'.repeat(40), head: 'c'.repeat(40), baseRef: 'master', git });
  assert.equal(settled.unshallowed, false);
  assert.equal(settled.deepened, 20);
  assert.ok(calls.some((call) => call.includes('--deepen=20')));
  assert.equal(calls.some((call) => call.includes('--depth=100')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a commit whose parent is present does not force an unshallow', () => {
  const calls = [];
  const head = 'e'.repeat(40);
  const git = (cwd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'merge-base') return 'a'.repeat(40);
    if (args[0] === 'rev-list') return `${head}\n`;
    if (args[0] === 'rev-parse' && args.includes('--verify')) return 'a'.repeat(40);
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const settled = ensureRange({ cwd: '/tmp/unused', base: 'b'.repeat(40), head: 'c'.repeat(40), git });
  assert.equal(settled.unshallowed, false);
  assert.equal(calls.some((call) => call.includes('--unshallow')), false);
  assert.deepEqual(shallowInRange('/tmp/unused', 'b'.repeat(40), 'c'.repeat(40), git), []);
});

test('push and merge-group bases are exact and an all-zero before is refused', () => {
  const before = 'b'.repeat(40);
  const pr = 'c'.repeat(40);
  assert.equal(usableSha('0'.repeat(40)), false);
  assert.equal(resolveScanBase({ event: 'push', pushBefore: before }), before);
  assert.equal(resolveScanBase({ event: 'merge_group', mgBase: before }), before);
  assert.equal(resolveScanBase({ event: 'pull_request', prBase: pr }), pr);
  assert.throws(() => resolveScanBase({ event: 'push', pushBefore: '0'.repeat(40) }), /push before/);
  assert.throws(() => resolveScanBase({ event: 'merge_group', mgBase: '' }), /merge group/);
  assert.throws(() => resolveScanBase({ event: 'schedule' }), /incomplete/);
  const calls = [];
  let unshallowed = false;
  const git = (cwd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'merge-base') return 'd'.repeat(40);
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return join(cwd, 'missing-shallow');
    if (args[0] === 'rev-list') return unshallowed ? '' : `${'e'.repeat(40)}\n`;
    if (args.includes('--unshallow')) { unshallowed = true; return ''; }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const dir = mkdtempSync(join(tmpdir(), 'ci-range-inject-'));
  writeFileSync(join(dir, 'missing-shallow'), `${'e'.repeat(40)}\n`);
  const settled = ensureRange({ cwd: dir, base: 'd'.repeat(40), head: 'f'.repeat(40), git });
  assert.equal(settled.unshallowed, true);
  assert.ok(calls.some((call) => call.includes('--unshallow')));
});
