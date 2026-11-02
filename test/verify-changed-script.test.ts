import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { collectChangedPaths, selectChangedFiles } from '../scripts/verify-changed.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

describe('changed verification selection', () => {
  it('selects committed, dirty and untracked candidates once, preserving spaces', () => {
    const changed = ['src/committed.ts', 'scripts/new helper.mjs', 'src/dirty.ts', 'src/dirty.ts', 'README.md', ''];
    expect(selectChangedFiles(changed, changed)).toEqual({
      lintFiles: ['scripts/new helper.mjs', 'src/committed.ts', 'src/dirty.ts'],
      webTypecheck: false,
    });
  });

  it('excludes deleted files from lint while retaining deleted web paths for typecheck', () => {
    expect(selectChangedFiles(['src/gone.ts', 'src/web-ui/old screen.tsx'], [])).toEqual({
      lintFiles: [], webTypecheck: true,
    });
  });

  it('checks web changes including assets, but not similarly named directories', () => {
    expect(selectChangedFiles(['src/web-ui/public/icon.svg'], []).webTypecheck).toBe(true);
    expect(selectChangedFiles(['src/web-ui-other/screen.tsx'], []).webTypecheck).toBe(false);
  });

  it('handles no lintable changes and all ESLint source extensions', () => {
    expect(selectChangedFiles(['notes.md'], ['notes.md']).lintFiles).toEqual([]);
    const paths = ['a.js', 'b.cjs', 'c.mjs', 'd.ts', 'e.cts', 'f.mts', 'g.tsx', 'h.jsx'];
    expect(selectChangedFiles(paths, paths).lintFiles).toEqual(paths);
    expect(selectChangedFiles([], [])).toEqual({ lintFiles: [], webTypecheck: false });
  });
});


describe('Git changed-path discovery', () => {
  it('combines merge-base, index, worktree and untracked NUL-delimited paths', () => {
    const outputs = [
      'base-commit\n',
      'committed.ts\0',
      'staged.ts\0old name.ts\0new name.ts\0reverted.ts\0',
      'dirty.ts\0deleted.ts\0reverted.ts\0',
      'untracked space.ts\0',
    ];
    vi.mocked(execFileSync).mockImplementation(() => outputs.shift()!);
    expect(collectChangedPaths('/fixture')).toEqual([
      'committed.ts', 'staged.ts', 'old name.ts', 'new name.ts', 'reverted.ts',
      'dirty.ts', 'deleted.ts', 'reverted.ts', 'untracked space.ts',
    ]);
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([
      ['merge-base', 'HEAD', 'origin/master'],
      ['diff', '--name-only', '--no-renames', '-z', 'base-commit', 'HEAD', '--'],
      ['diff', '--cached', '--name-only', '--no-renames', '-z', '--'],
      ['diff', '--name-only', '--no-renames', '-z', '--'],
      ['ls-files', '--others', '--exclude-standard', '-z'],
    ]);
  });
});
