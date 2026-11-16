import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRange, mergeBase } from '../scripts/ci-fetch-range.mjs';

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
  assert.equal(result.unshallowed, false);
  assert.throws(() => ensureRange({
    cwd: clone,
    base: 'a'.repeat(40),
    head,
    git: () => { throw new Error('fetch failed'); },
  }));
});
