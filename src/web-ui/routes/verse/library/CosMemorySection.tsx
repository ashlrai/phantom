/**
 * routes/verse/library/CosMemorySection.tsx: what the Leader remembers about
 * Mason (`~/.phantom/memory/`), with a way to add and forget entries. Writes
 * go through the mutation token. Every string from the server renders as plain
 * text, never HTML.
 */
import { useEffect, useMemo, useState } from 'react';
import type { MemoryEntry, MemoryKind } from '../../../../core/cos/memory.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { CardNote } from '../command/Surface.js';
import {
  COS_MEMORY_FORGET_PATH, COS_MEMORY_KINDS, COS_MEMORY_MAX_CHARS, COS_MEMORY_PATH,
  cosMemoryOutcome, cosMemoryRows, narrowCosMemory,
} from './cos-memory-model.js';
import styles from './library.module.css';

const cosMemoryQuery: QueryDef<MemoryEntry[]> = {
  key: 'verse-cos-memory',
  fetch: async (signal) => {
    const entries = narrowCosMemory(await apiGet<unknown>(COS_MEMORY_PATH, signal));
    if (!entries) throw new Error('malformed memory response');
    return entries;
  },
};

const failure = (err: unknown): string =>
  err instanceof ApiError ? cosMemoryOutcome(err.status, err.detail) : cosMemoryOutcome(0);

export const LIBRARY_MEMORY_POLL_MS = 15_000;

export function CosMemorySection({ visible }: { visible: boolean }) {
  const memory = useQuery(cosMemoryQuery, { enabled: visible });
  const refetch = useRefetch(cosMemoryQuery);
  const { token, touch } = useMutationHold();
  const rows = useMemo(() => (memory.data ? cosMemoryRows(memory.data, Date.now()) : []), [memory.data]);
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setInterval(refetch, LIBRARY_MEMORY_POLL_MS);
    return () => clearInterval(timer);
  }, [visible, refetch]);

  async function remember() {
    if (!token) { setNote(cosMemoryOutcome(401)); return; }
    setSending(true);
    try {
      touch();
      await apiPost<unknown>(COS_MEMORY_PATH, { kind, text: text.trim() }, token);
      setNote(cosMemoryOutcome(201));
      setText('');
      refetch();
    } catch (err) {
      setNote(failure(err));
    } finally {
      setSending(false);
    }
  }

  async function forget(id: string) {
    setConfirming(null);
    if (!token) { setNote(cosMemoryOutcome(401)); return; }
    setSending(true);
    try {
      touch();
      await apiPost<unknown>(COS_MEMORY_FORGET_PATH, { id }, token);
      setNote('Forgotten.');
      refetch();
    } catch (err) {
      setNote(failure(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.section} aria-label="What Phantom remembers about you">
      <h2>What Phantom remembers about you</h2>
      <p className={styles.meta}>The Leader reads this before every request. Forget anything that is wrong.</p>
      {memory.error && memory.data ? <CardNote tone="danger">Could not refresh memory{memory.error instanceof ApiError ? ` (HTTP ${memory.error.status})` : ''}.</CardNote> : null}
      {memory.error && !memory.data ? (
        <CardNote tone="danger">What Phantom remembers is unavailable right now.</CardNote>
      ) : !memory.data ? (
        <CardNote>Loading…</CardNote>
      ) : rows.length === 0 ? (
        <CardNote>Nothing remembered yet. Tell the Leader a preference, or add one here.</CardNote>
      ) : (
        <ul className={styles.bus} aria-label="Remembered about you">
          {rows.map((row) => (
            <li key={row.id} className={styles.busRow}>
              <span className={styles.busWho}><span className={styles.chip}>{row.kind}</span> {row.source} · {row.age}</span>
              <button type="button" className={styles.hit} aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>
                <span className={styles.busText} style={expanded === row.id ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{row.text}</span>
              </button>
              {confirming === row.id ? (
                <div className={styles.actions}>
                  <span className={styles.meta}>Forget this for good?</span>
                  <button type="button" className={styles.button} disabled={sending} onClick={() => void forget(row.id)}>Yes, forget</button>
                  <button type="button" className={styles.button} onClick={() => setConfirming(null)}>Keep</button>
                </div>
              ) : (
                <div><button type="button" className={styles.button} onClick={() => setConfirming(row.id)}>Forget</button></div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className={styles.actions} onSubmit={(event) => { event.preventDefault(); if (text.trim() && !sending) void remember(); }}>
        <select className={styles.input} aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)} style={{ width: 'auto' }}>
          {COS_MEMORY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <textarea className={styles.input} aria-label="What should Phantom remember?" value={text} maxLength={COS_MEMORY_MAX_CHARS}
          placeholder="What should Phantom remember?" rows={2} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className={styles.button} disabled={sending || text.trim() === ''}>Remember</button>
      </form>
      {note ? <p className={styles.meta} role="status">{note}</p> : null}
    </section>
  );
}
