import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { masterMovedAuthorityDrift, materializeMasterOverlay } from '../scripts/verify-changed.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}
function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A repo whose origin/master moved after a branch forked: master added src/m.ts, the branch edits src/b.ts. */
function fixture(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), 'overlay-fixture-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'master');
  put(root, 'src/base.ts', 'base\n');
  put(root, 'src/gone.ts', 'gone\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', 'work');
  git(root, 'checkout', '-q', 'master');
  put(root, 'src/m.ts', 'from master\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'master moves');
  git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  git(root, 'checkout', '-q', 'work');
  mkdirSync(join(root, 'node_modules'));
  return { root };
}

describe('verify-changed authority drift on the master overlay', () => {
  it('detects that master moved a drift-relevant path after the fork', () => {
    const { root } = fixture();
    expect(masterMovedAuthorityDrift(root)).toBe(true);
  });

  it('lays committed, dirty, untracked and deleted branch changes over origin/master', () => {
    const { root } = fixture();
    put(root, 'src/b.ts', 'branch\n');
    put(root, 'src/base.ts', 'edited on branch\n');
    rmSync(join(root, 'src/gone.ts'));
    const overlay = materializeMasterOverlay(root, ['src/b.ts', 'src/base.ts', 'src/gone.ts']);
    dirs.push(overlay);
    expect(readFileSync(join(overlay, 'src/m.ts'), 'utf8')).toBe('from master\n');
    expect(readFileSync(join(overlay, 'src/b.ts'), 'utf8')).toBe('branch\n');
    expect(readFileSync(join(overlay, 'src/base.ts'), 'utf8')).toBe('edited on branch\n');
    expect(existsSync(join(overlay, 'src/gone.ts'))).toBe(false);
    expect(existsSync(join(overlay, 'node_modules'))).toBe(true);
  });
});
