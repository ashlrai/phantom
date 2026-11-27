import { describe, expect, it } from 'vitest';
import { strayBackupFiles } from '../scripts/verify-changed.mjs';

describe('strayBackupFiles', () => {
  it('flags editor and patch leftover suffixes on changed files still on disk', () => {
    const changed = [
      'docs/CLI-REFERENCE.md.backup',
      'test/fleet-hold-check.test.ts-E',
      'src/core/x.ts.orig',
      'patches/fix.rej',
      'src/y.ts.bak',
      'src/z.ts~',
      'src/w.ts.swp',
      'src/v.ts.swo',
      'src/u.ts.swn',
      'src/t.ts.tmp',
      'src/s.ts.temp',
      'src/r.ts.old',
      'src/q.ts.save',
    ];
    expect(strayBackupFiles(changed, changed)).toEqual([...changed].sort());
  });

  it('flags the <ext>-<letter><digits> tag case-insensitively', () => {
    const changed = ['a/foo.test.ts-E', 'b/bar.md-W2', 'c/baz.JSON-B', 'd/normal.ts'];
    expect(strayBackupFiles(changed, changed)).toEqual(['a/foo.test.ts-E', 'b/bar.md-W2', 'c/baz.JSON-B']);
  });

  it('skips deletions: a stray leaving the tree is the fix, not the offense', () => {
    expect(strayBackupFiles(['docs/gone.md.backup', 'src/gone.ts.orig'], ['src/kept.ts'])).toEqual([]);
  });

  it('exempts test/fixtures payloads that may carry tool-input names', () => {
    const changed = ['test/fixtures/patch/conflict.orig', 'test/fixtures/patch/reject.rej', 'src/real.ts.bak'];
    expect(strayBackupFiles(changed, changed)).toEqual(['src/real.ts.bak']);
  });

  it('ignores real extensions, near-miss names and extensionless letter tags', () => {
    const changed = [
      'src/core/x.test.ts',
      'src/assets/logo.snap',
      'docs/guide.md',
      'assets/app.min-js',
      'CHANGELOG-1',
      'plan-E',
      'dir.name/file-E',
      'foo.v1-rc',
      'data.2024',
      'queue/ready.tsv',
    ];
    expect(strayBackupFiles(changed, changed)).toEqual([]);
  });

  it('does not flag suffixes that only prefix a real extension', () => {
    const changed = ['src/old.ts', 'docs/new.md', 'src/a.bak.ts', 'src/c.orig.test.ts'];
    expect(strayBackupFiles(changed, changed)).toEqual([]);
  });

  it('dedupes and sorts the candidate set', () => {
    const changed = ['b/x.ts~', 'a/y.ts.orig', 'b/x.ts~', ''];
    expect(strayBackupFiles(changed, ['a/y.ts.orig', 'b/x.ts~'])).toEqual(['a/y.ts.orig', 'b/x.ts~']);
  });
});
