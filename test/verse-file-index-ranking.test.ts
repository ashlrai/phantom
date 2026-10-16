import { describe, expect, it } from 'vitest';

import { fuzzyScore, rankFiles } from '../src/core/verse/file-index.js';

describe('file finder ranking compatibility', () => {
  it.each([
    ['src/FooBar.ts', 'fb', 27],
    ['src/FooBar.ts', 'fbar', 37],
    ['src/FooBar.ts', 'foobar', 102],
    ['src/foo-bar.ts', 'fb', 27],
    ['foo.bar.baz', 'foo.bar', 108],
    ['.hidden', 'hidden', 45],
    ['src/İx.ts', 'ix', 20],
    ['src/İx.ts', 'i̇x', 80],
    ['src/📄file.ts', '📄f', 49],
    ['src/Σigma.ts', 'σi', 44],
    ['src/ß.ts', 'ss', 8],
    ['a/b/c', 'ac', 16],
    ['same/name', 'name', 85],
    ['README', 'readme', 95],
    ['a/b/c', 'zzz', null],
    ['whatever', '', 0],
  ] as const)('preserves the score for %s against %s', (path, query, score) => {
    expect(fuzzyScore(path, query)).toBe(score);
  });

  it('keeps normalized queries, stable equal-path roots and original object identity', () => {
    const entries = Object.freeze([
      Object.freeze({ path: 'src/FooBar.ts', root: '/second' }),
      Object.freeze({ path: 'src/FooBar.ts', root: '/first' }),
      Object.freeze({ path: 'docs/foo-bar-notes.md', root: '/third' }),
      Object.freeze({ path: 'unrelated.txt', root: '/fourth' }),
    ]);
    const result = rankFiles(entries, ' F B ', 2);
    expect(result.files).toEqual([entries[0], entries[1]]);
    expect(result.files[0]).toBe(entries[0]);
    expect(result.files[1]).toBe(entries[1]);
    expect(result.truncated).toBe(true);
    expect(entries.map((entry) => entry.root)).toEqual(['/second', '/first', '/third', '/fourth']);
  });

  it('preserves zero limits and truncation for matching, empty and rejected queries', () => {
    const entries = [{ path: 'file.ts', root: '/a' }, { path: 'README', root: '/b' }];
    expect(rankFiles(entries, 'file', 0)).toEqual({ files: [], truncated: true });
    expect(rankFiles(entries, '', 0)).toEqual({ files: [], truncated: true });
    expect(rankFiles(entries, 'zzz', 0)).toEqual({ files: [], truncated: false });
    expect(rankFiles([], 'file')).toEqual({ files: [], truncated: false });
  });
});
