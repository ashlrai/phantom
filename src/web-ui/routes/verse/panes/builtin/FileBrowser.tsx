/**
 * routes/verse/panes/builtin/FileBrowser.tsx — the Files pane's real browser:
 * a lazy tree of the chat's folders plus a bounded text preview, over
 * POST /api/verse/files/{browse,read} (core/verse/session-files.ts).
 *
 *   Browse  project-name                  ← root picker chips, only with >1 root
 *   ▸ src/                                 ← expand fetches that directory once
 *   ▾ test/                                ← children indent one step per level
 *     ◇ app.test.ts                     12 KB
 *   ┌ preview: path · size · truncated? ┐
 *   │ <pre>text</pre>                    │
 *   │              [Add to message] [×]  │
 *   └────────────────────────────────────┘
 *
 * PRIVACY. Both routes are privileged reads behind the mutation gate, so the
 * section asks for the held token before its first fetch (useTokenGate, the
 * same hand-off the context surfaces use): no hold → an unlock row, never a
 * silent fetch. Browsing never sends file content to a model; "Add to
 * message" only quotes the PATH into the composer, like the touched-files
 * rows already do.
 *
 * FRESHNESS. Directory listings are fetched on expand and kept for the life
 * of the pane — the agent edits files constantly, so a stale listing is
 * expected and honest (collapsing and re-expanding re-reads only dirs that
 * were never loaded or failed). The preview is one shot per click, aborted
 * when another file is picked or the pane unmounts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MutationTokenDialog } from '../../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../../components/primitives/Button.js';
import { IconChevronDown, IconChevronRight, IconLock, IconRefresh, IconX } from '../../../../components/primitives/icons.js';
import { useMutationHold } from '../../../../data/hooks.js';
import type { VerseFileReadResponse } from '../../../../../core/verse/workbench-types.js';
import { displayPath } from '../../chat/path-display.js';
import { formatBytes } from '../../composer/composer-text.js';
import { useTokenGate } from '../../context/use-token-gate.js';
import type { PaneHost } from '../pane-registry.js';
import { browseSessionDir, readSessionFilePreview } from './file-browser-queries.js';
import { rootDirState, visibleFileRows, type DirState, type FileRow } from './file-browser-model.js';
import styles from './stub-panes.module.css';

interface PreviewState {
  status: 'loading' | 'ready' | 'error';
  path: string;
  data?: VerseFileReadResponse;
  error?: string;
}

function describeError(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'The request failed.';
}

function rootNameOf(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

export function FileBrowser({ sessionId, roots, host, visible }: {
  sessionId: string | null;
  roots: readonly string[];
  host: PaneHost;
  visible: boolean;
}) {
  const { hasHold } = useMutationHold();
  const gate = useTokenGate();
  const [rootIndex, setRootIndex] = useState(0);
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const previewAbort = useRef<AbortController | null>(null);
  const scopeKey = useRef('');
  const prevRoot = useRef<string | undefined>(undefined);

  // roots can shrink under a live pane; the picker and the fetches agree on
  // the clamped index rather than disagreeing about which folder is shown.
  const effectiveRootIndex = Math.min(rootIndex, Math.max(0, roots.length - 1));
  const root = sessionId && roots.length > 0 ? roots[effectiveRootIndex] : undefined;

  const clearTree = useCallback(() => {
    for (const controller of aborts.current.values()) controller.abort();
    aborts.current.clear();
    previewAbort.current?.abort();
    setDirs({});
    setExpanded(new Set());
    setPreview(null);
  }, []);

  const loadDir = useCallback((relPath: string) => {
    if (!sessionId || !root || !hasHold) return;
    setDirs((prev) => ({ ...prev, [relPath]: { status: 'loading' } }));
    aborts.current.get(relPath)?.abort();
    const controller = new AbortController();
    aborts.current.set(relPath, controller);
    browseSessionDir(sessionId, root, relPath, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setDirs((prev) => ({ ...prev, [relPath]: { status: 'ready', entries: res.entries } }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDirs((prev) => ({ ...prev, [relPath]: { status: 'error', message: describeError(err) } }));
      })
      .finally(() => {
        if (aborts.current.get(relPath) === controller) aborts.current.delete(relPath);
      });
  }, [sessionId, root, hasHold]);

  // A different chat or a different hold state is a different tree: drop
  // every listing, expansion, preview and the root picker's position, then
  // let the load effect below fetch the new root once it is able.
  useEffect(() => {
    const key = `${sessionId ?? ''}${hasHold ? '1' : '0'}`;
    if (scopeKey.current === key) return;
    scopeKey.current = key;
    clearTree();
    setRootIndex(0);
  }, [sessionId, hasHold, clearTree]);

  // Switching roots keeps the picker where the user put it but discards the
  // old root's listings — dir keys are relative and would collide.
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    clearTree();
  }, [root, clearTree]);

  // The root listing loads itself once the pane is visible and the token is
  // held; hidden panes and locked sessions fetch nothing.
  useEffect(() => {
    if (!visible || !hasHold || !root) return;
    if (dirs[''] === undefined) loadDir('');
  }, [visible, hasHold, root, dirs, loadDir]);

  useEffect(() => () => {
    for (const controller of aborts.current.values()) controller.abort();
    previewAbort.current?.abort();
  }, []);

  const openPreview = useCallback((path: string) => {
    if (!sessionId || !root || !hasHold) return;
    previewAbort.current?.abort();
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreview({ status: 'loading', path });
    readSessionFilePreview(sessionId, root, path, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setPreview({ status: 'ready', path, data });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setPreview({ status: 'error', path, error: describeError(err) });
      });
  }, [sessionId, root, hasHold]);

  const onRowClick = useCallback((row: FileRow) => {
    if (row.kind === 'file') {
      openPreview(row.path);
      return;
    }
    const state = dirs[row.path];
    const opening = !expanded.has(row.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      return next;
    });
    // Expanding a never-loaded or failed directory fetches it; collapsing
    // never does. A failed listing also retries on the click that expands it.
    if (opening && (state === undefined || state.status === 'error')) loadDir(row.path);
  }, [dirs, expanded, loadDir, openPreview]);

  const rows = useMemo(() => visibleFileRows(dirs, expanded), [dirs, expanded]);
  const rootState = rootDirState(dirs);

  function mention(path: string) {
    if (!root) return;
    host.addToMessage(`@${displayPath(`${root.replace(/[\\/]+$/, '')}/${path}`, roots)}`);
  }

  if (!sessionId || roots.length === 0) return null;

  return (
    <section className={styles.section} aria-labelledby="pane-files-browser">
      <h3 id="pane-files-browser" className={styles.sectionTitle}>
        Browse <span className={styles.count}>{roots.length > 1 ? `${roots.length} folders` : root ? rootNameOf(root) : ''}</span>
      </h3>
      {roots.length > 1 ? (
        <div className={styles.picker} role="group" aria-label="Folder">
          {roots.map((r, i) => (
            <button key={r} type="button" className={styles.chip} aria-pressed={i === effectiveRootIndex}
              onClick={() => setRootIndex(i)} title={r}>
              {rootNameOf(r)}
            </button>
          ))}
        </div>
      ) : null}

      {!hasHold ? (
        <div className={styles.unlockRow}>
          <p className={styles.muted}>Browsing this chat's folders is a privileged read — unlock controls to list and preview them. Nothing is sent to a model.</p>
          <Button size="sm" icon={<IconLock size={14} />} onClick={() => void gate.run('Browse project files', async () => undefined)}>
            Unlock to browse
          </Button>
        </div>
      ) : (
        <>
          <ul className={styles.list} aria-label="Project files">
            {rootState === undefined || rootState.status === 'loading' ? (
              <li className={styles.row}><span className={styles.muted}>Reading {root ? rootNameOf(root) : ''}…</span></li>
            ) : rootState.status === 'error' ? (
              <li className={styles.row}>
                <span className={styles.muted}>{rootState.message}</span>
                <button type="button" className={styles.rowAction} onClick={() => loadDir('')} aria-label="Retry listing">
                  <IconRefresh size={12} />
                </button>
              </li>
            ) : rows.length === 0 ? (
              <li className={styles.row}><span className={styles.muted}>No browsable entries — private, binary and oversized names are skipped.</span></li>
            ) : rows.map((row) => (
              <li key={row.path}>
                <button type="button" className={`${styles.row} ${styles.treeRow}`}
                  style={{ paddingLeft: `calc(var(--space-2) + ${row.depth * 14}px)` }}
                  onClick={() => onRowClick(row)}
                  title={row.kind === 'directory' ? row.path : `${row.path} — ${formatBytes(row.sizeBytes ?? 0)}`}
                  aria-label={row.kind === 'directory'
                    ? `${expanded.has(row.path) ? 'Collapse' : 'Expand'} ${row.name}`
                    : `Preview ${row.name}`}>
                  <span className={styles.treeMark} aria-hidden="true">
                    {row.kind === 'directory'
                      ? (expanded.has(row.path) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)
                      : <span className={styles.fileDot} />}
                  </span>
                  <span className={styles.name}>{row.name}</span>
                  <span className={styles.meta}>
                    {row.kind === 'file' ? formatBytes(row.sizeBytes ?? 0)
                      : row.state === 'loading' ? '…'
                        : row.state === 'error' ? '!' : ''}
                  </span>
                </button>
                {row.state === 'error' && expanded.has(row.path) ? (
                  <p className={styles.rowError} role="alert" style={{ paddingLeft: `calc(var(--space-2) + ${row.depth * 14 + 16}px)` }}>{row.error}</p>
                ) : null}
              </li>
            ))}
          </ul>

          {preview ? (
            <div className={styles.preview} aria-label="File preview">
              <div className={styles.previewHead}>
                <span className={styles.previewPath} title={preview.path}>
                  {preview.status === 'ready' && preview.data
                    ? displayPath(`${preview.data.root.replace(/[\\/]+$/, '')}/${preview.data.path}`, roots)
                    : preview.path}
                </span>
                <span className={styles.previewActions}>
                  {preview.status === 'ready' ? (
                    <button type="button" className={styles.rowAction} onClick={() => mention(preview.path)}>
                      Add to message
                    </button>
                  ) : null}
                  <button type="button" className={styles.rowAction} onClick={() => setPreview(null)} aria-label="Close preview">
                    <IconX size={12} />
                  </button>
                </span>
              </div>
              {preview.status === 'loading' ? <p className={styles.muted}>Reading file…</p> : null}
              {preview.status === 'error' ? <p className={styles.rowError} role="alert">{preview.error}</p> : null}
              {preview.status === 'ready' && preview.data ? (
                <>
                  <p className={styles.previewMeta}>
                    {formatBytes(preview.data.byteLength)} of {formatBytes(preview.data.sizeBytes)}
                    {preview.data.truncated ? ' — partial preview (first 64 KB)' : ''}
                  </p>
                  <pre className={styles.previewText}>{preview.data.text || '(empty file)'}</pre>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}
