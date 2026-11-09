/**
 * routes/verse/library/LibraryMemory.tsx: what the Leader (chief of staff)
 * currently remembers, newest first. Read-only: it only GETs the existing
 * /api/verse/cos/memory route, so there is no edit or forget here. Every
 * string from the server renders as plain text.
 */
import { useEffect, useMemo, useState } from 'react';
import type { MemoryEntry } from '../../../../core/cos/memory.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { CardNote } from '../command/Surface.js';
import { formatRelative } from '../verse-model.js';
import styles from './library.module.css';

export const LIBRARY_MEMORY_POLL_MS = 15_000;
const COS_MEMORY_PATH = '/api/verse/cos/memory';

const byNewest = (a: MemoryEntry, b: MemoryEntry) => Date.parse(b.updated) - Date.parse(a.updated) || 0;

function failure(err: unknown): string {
  if (err instanceof ApiError) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message : 'request failed';
}

function Row({ entry }: { entry: MemoryEntry }) {
  const [open, setOpen] = useState(false);
  const when = formatRelative(entry.updated);
  return (
    <li>
      <button type="button" className={styles.hit} aria-expanded={open} onClick={() => setOpen(!open)}>
        <strong>{entry.kind}</strong>
        <span className={open ? styles.snippet : styles.clamp}>{entry.text}</span>
        <span className={styles.meta}>{entry.source}{when ? ` · ${when}` : ''}</span>
      </button>
    </li>
  );
}

export function LibraryMemory({ visible = true }: { visible?: boolean }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    const load = () => {
      apiGet<{ entries: MemoryEntry[] }>(COS_MEMORY_PATH, controller.signal)
        .then((res) => { if (!controller.signal.aborted) { setEntries(res.entries); setError(null); } })
        .catch((err: unknown) => { if (!controller.signal.aborted) setError(failure(err)); });
    };
    load();
    const timer = setInterval(load, LIBRARY_MEMORY_POLL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [visible]);

  const sorted = useMemo(() => (entries ? [...entries].sort(byNewest) : null), [entries]);
  return (
    <section className={styles.section} aria-label="Leader memory">
      <h2>Leader memory</h2>
      {error ? <CardNote tone="danger">Could not refresh the Leader's memory ({error}).</CardNote> : null}
      {sorted === null ? (
        error ? null : <CardNote>Loading…</CardNote>
      ) : sorted.length === 0 ? (
        <CardNote>The Leader has no saved memory yet</CardNote>
      ) : (
        <ul className={styles.hits}>{sorted.map((entry) => <Row key={entry.id} entry={entry} />)}</ul>
      )}
    </section>
  );
}
