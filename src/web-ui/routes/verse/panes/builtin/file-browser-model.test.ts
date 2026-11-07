/**
 * panes/builtin/file-browser-model.test.ts — the Files pane browser's pure
 * projection: which fetched directories produce which rows, in what order,
 * and how each directory's load state lands on its row.
 */
import { describe, expect, it } from 'vitest';
import type { VerseFileBrowseEntry } from '../../../../../core/verse/workbench-types.js';
import { rootDirState, visibleFileRows, type DirState } from './file-browser-model.js';

const dir = (path: string): VerseFileBrowseEntry => ({
  name: path.split('/').pop()!, path, kind: 'directory', sizeBytes: null,
});
const file = (path: string, sizeBytes = 1): VerseFileBrowseEntry => ({
  name: path.split('/').pop()!, path, kind: 'file', sizeBytes,
});

describe('visibleFileRows', () => {
  it('is empty until the root listing is ready', () => {
    expect(visibleFileRows({}, new Set())).toEqual([]);
    expect(visibleFileRows({ '': { status: 'loading' } }, new Set())).toEqual([]);
    expect(visibleFileRows({ '': { status: 'error', message: 'x' } }, new Set())).toEqual([]);
  });

  it('flattens only expanded directories, depth-first, carrying child state', () => {
    const dirs: Record<string, DirState> = {
      '': { status: 'ready', entries: [dir('src'), file('README.md', 9)] },
      src: { status: 'ready', entries: [dir('src/lib'), file('src/a.ts', 4), file('src/b.ts', 2)] },
      'src/lib': { status: 'loading' },
    };
    const collapsed = visibleFileRows(dirs, new Set());
    expect(collapsed.map((r) => [r.path, r.depth, r.kind, r.state])).toEqual([
      ['src', 0, 'directory', 'ready'],
      ['README.md', 0, 'file', 'ready'],
    ]);
    const expanded = visibleFileRows(dirs, new Set(['src', 'src/lib']));
    expect(expanded.map((r) => [r.path, r.depth, r.state])).toEqual([
      ['src', 0, 'ready'],
      ['src/lib', 1, 'loading'],   // a fetch in flight reads as loading
      ['src/a.ts', 1, 'ready'],
      ['src/b.ts', 1, 'ready'],
      ['README.md', 0, 'ready'],
    ]);
    // src/lib is expanded but still loading → no children beneath it.
    expect(expanded.some((r) => r.path.startsWith('src/lib/'))).toBe(false);
  });

  it('marks an errored directory on its row and hides its children', () => {
    const dirs: Record<string, DirState> = {
      '': { status: 'ready', entries: [dir('broken')] },
      broken: { status: 'error', message: 'denied' },
    };
    const rows = visibleFileRows(dirs, new Set(['broken']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: 'broken', state: 'error', error: 'denied' });
  });

  it('a never-fetched directory reads ready — its chevron says unopened, not a spinner', () => {
    const dirs: Record<string, DirState> = { '': { status: 'ready', entries: [dir('new')] } };
    expect(visibleFileRows(dirs, new Set())[0]!.state).toBe('ready');
  });
});

describe('rootDirState', () => {
  it('is the root listing’s own state — the tree draws no row for it', () => {
    expect(rootDirState({})).toBeUndefined();
    expect(rootDirState({ '': { status: 'loading' } })).toEqual({ status: 'loading' });
  });
});
