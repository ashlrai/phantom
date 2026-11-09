/**
 * routes/verse/panes/builtin/file-browser-model.ts — the Files pane browser's
 * pure state → rows projection. No React, no fetch.
 *
 * The browser is a lazy tree over POST /api/verse/files/browse: each
 * directory's entries are fetched the first time it is expanded and kept in
 * `dirs` (keyed by the entry's root-relative `path`, '' = the root itself).
 * `visibleFileRows` flattens the EXPANDED tree into render rows in DFS order,
 * carrying each directory's load state so the component can draw spinners and
 * errors inline instead of as blocking states.
 */
import type { VerseFileBrowseEntry } from '../../../../../core/verse/workbench-types.js';

export type DirState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; entries: VerseFileBrowseEntry[] };

export type RowState = 'ready' | 'loading' | 'error';

export interface FileRow {
  /** Root-relative path — the directory key and the read request's `path`. */
  path: string;
  depth: number;
  name: string;
  kind: 'directory' | 'file';
  state: RowState;
  /** Present on an errored directory row. */
  error?: string;
  /** File size; null for a directory. */
  sizeBytes: number | null;
}

/**
 * The rows a collapsed/expanded tree shows, in order. Only READY directories
 * contribute children; a loading or errored directory still gets its row
 * (with its state) but nothing beneath it until a retry succeeds.
 */
export function visibleFileRows(
  dirs: Readonly<Record<string, DirState>>,
  expanded: ReadonlySet<string>,
): FileRow[] {
  const rows: FileRow[] = [];
  const walk = (dirPath: string, depth: number): void => {
    const state = dirs[dirPath];
    if (state?.status !== 'ready') return;
    for (const entry of state.entries) {
      let row: FileRow;
      if (entry.kind === 'directory') {
        const child = dirs[entry.path];
        // 'loading' only while a fetch is actually in flight — a directory
        // that was never expanded has no state and reads as 'ready' (its
        // chevron, not a spinner, is what says it is unopened).
        row = {
          path: entry.path,
          depth,
          name: entry.name,
          kind: 'directory',
          state: child?.status === 'error' ? 'error' : child?.status === 'loading' ? 'loading' : 'ready',
          ...(child?.status === 'error' ? { error: child.message } : {}),
          sizeBytes: null,
        };
      } else {
        row = { path: entry.path, depth, name: entry.name, kind: 'file', state: 'ready', sizeBytes: entry.sizeBytes };
      }
      rows.push(row);
      if (entry.kind === 'directory' && expanded.has(entry.path)) walk(entry.path, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

/** The root listing's own state — the tree has no row for it. */
export function rootDirState(dirs: Readonly<Record<string, DirState>>): DirState | undefined {
  return dirs[''];
}
