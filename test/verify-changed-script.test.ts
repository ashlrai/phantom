import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { collectChangedPaths, docsCheckPreflight, masterMovedAuthorityDrift, selectChangedFiles } from '../scripts/verify-changed.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

describe('changed verification selection', () => {
  it('selects committed, dirty and untracked candidates once, preserving spaces', () => {
    const changed = ['src/committed.ts', 'scripts/new helper.mjs', 'src/dirty.ts', 'src/dirty.ts', 'README.md', ''];
    expect(selectChangedFiles(changed, changed)).toEqual({
      lintFiles: ['scripts/new helper.mjs', 'src/committed.ts', 'src/dirty.ts'],
      pythonFiles: [],
      shellFiles: [],
      webTypecheck: false,
      authorityDrift: true,
      fleetRegistry: false,
      docsCheck: true,
      quarantineCheck: false,
    });
  });

  it('excludes deleted files from lint while retaining deleted web paths for typecheck', () => {
    expect(selectChangedFiles(['src/gone.ts', 'src/web-ui/old screen.tsx'], [])).toEqual({
      lintFiles: [], pythonFiles: [], shellFiles: [], webTypecheck: true, authorityDrift: true, fleetRegistry: false, docsCheck: true, quarantineCheck: false,
    });
  });

  it('selects authority drift for source, test and CODEOWNERS paths including deletions', () => {
    for (const path of ['src/a.ts', 'test/a.ts', '.github/CODEOWNERS']) {
      expect(selectChangedFiles([path], []).authorityDrift).toBe(true);
    }
    expect(selectChangedFiles(['docs/a.md', 'src-other/a.ts'], []).authorityDrift).toBe(false);
  });

  it('selects authority drift for shipped scripts, which the Tier-1 closure also walks', () => {
    expect(selectChangedFiles(['scripts/evaluators/x.mjs'], []).authorityDrift).toBe(true);
    expect(selectChangedFiles(['scripts-other/x.mjs'], []).authorityDrift).toBe(false);
  });

  it('flags a master that moved a drift-relevant path since the merge-base, and ignores docs-only movement', () => {
    const exec = (out: string) => vi.fn().mockReturnValueOnce('abc123\n').mockReturnValueOnce(out);
    expect(masterMovedAuthorityDrift('/r', exec('docs/a.md\0README.md\0') as never)).toBe(false);
    expect(masterMovedAuthorityDrift('/r', exec('docs/a.md\0src/core/x.ts\0') as never)).toBe(true);
    expect(masterMovedAuthorityDrift('/r', exec('') as never)).toBe(false);
  });

  it('checks web changes including assets, but not similarly named directories', () => {
    expect(selectChangedFiles(['src/web-ui/public/icon.svg'], []).webTypecheck).toBe(true);
    expect(selectChangedFiles(['src/web-ui-other/screen.tsx'], []).webTypecheck).toBe(false);
  });

  it('handles no lintable changes and all ESLint source extensions', () => {
    expect(selectChangedFiles(['notes.md'], ['notes.md']).lintFiles).toEqual([]);
    const paths = ['a.js', 'b.cjs', 'c.mjs', 'd.ts', 'e.cts', 'f.mts', 'g.tsx', 'h.jsx'];
    expect(selectChangedFiles(paths, paths).lintFiles).toEqual(paths);
    expect(selectChangedFiles([], [])).toEqual({ lintFiles: [], pythonFiles: [], shellFiles: [], webTypecheck: false, authorityDrift: false, fleetRegistry: false, docsCheck: false, quarantineCheck: false });
  });

  it('selects the docs check for markdown changes and deletions, not modified code', () => {
    expect(selectChangedFiles(['docs/guide.md'], ['docs/guide.md']).docsCheck).toBe(true);
    expect(selectChangedFiles(['AGENTS.MD'], ['AGENTS.MD']).docsCheck).toBe(true);
    expect(selectChangedFiles(['src/core/x.ts'], ['src/core/x.ts']).docsCheck).toBe(false);
    expect(selectChangedFiles(['src/gone.ts'], []).docsCheck).toBe(true);
    expect(selectChangedFiles(['docs/gone.md'], []).docsCheck).toBe(true);
  });

  it('selects the quarantine ledger check for test files and the ledger, including deletions', () => {
    for (const path of [
      'test/flaky.test.ts', 'test/nested/dir/suite.test.tsx', 'src/web-ui/x.spec.ts',
      'test/component.test.jsx', 'queue/quarantine.tsv',
    ]) {
      expect(selectChangedFiles([path], [path]).quarantineCheck).toBe(true);
    }
    // A deleted test file can stale a ledger row, so deletions still select.
    expect(selectChangedFiles(['test/gone.test.ts'], []).quarantineCheck).toBe(true);
    expect(selectChangedFiles(['queue/quarantine.tsv'], []).quarantineCheck).toBe(true);
  });

  it('skips the quarantine ledger check for non-test paths and near misses', () => {
    for (const path of [
      'src/core/x.ts', 'docs/guide.md', 'test/helper.ts', 'test/fixtures/data.json',
      'queue/quarantine.tsv.bak', 'test/foo.test.ts.snap', 'latest/test.ts', 'contest/x.ts',
    ]) {
      expect(selectChangedFiles([path], [path]).quarantineCheck).toBe(false);
    }
  });
});

describe('docsCheckPreflight preflight check', () => {
  it('returns ok true when node_modules/marked/package.json exists', () => {
    const result = docsCheckPreflight('/fake/root', (() => true) as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(true);
  });

  it('returns ok false naming the marked package manifest when absent', () => {
    const result = docsCheckPreflight('/fake/root', (() => false) as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/marked/package.json');
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
