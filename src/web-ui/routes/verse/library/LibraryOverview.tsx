import { useEffect, useState } from 'react';
import type { LibrarySnapshot } from '../../../../core/fleet/library.js';
import { scrubSecrets } from '../../../../core/util/scrub-secrets.js';
import { getMutationToken, getReadClientProof } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import { CardNote } from '../command/Surface.js';
import styles from './library.module.css';
const kinds = [['', 'All'], ['file', 'Files & media'], ['memory', 'Memory'], ['message', 'Messages'], ['context', 'Context']] as const;
const query: QueryDef<LibrarySnapshot> = {
  key: 'verse-library-overview',
  fetch: async signal => {
    const token = getMutationToken();
    if (!token || isRemoteMobileMode()) throw new Error('Library unavailable');
    const response = await fetch('/api/verse/fleet/library-files/items', { credentials: 'same-origin',
      headers: { 'x-ashlr-read-client': getReadClientProof(), 'x-ashlr-token': token }, signal });
    if (!response.ok) throw new Error('Library unavailable');
    const body = await response.json() as LibrarySnapshot;
    if (!body || body.v !== 1 || !Number.isFinite(Date.parse(body.asOf)) || !Array.isArray(body.items) ||
      !Array.isArray(body.unavailable) || !body.unavailable.every(value => typeof value === 'string') ||
      !body.items.every(item => item && ['id', 'title', 'source', 'asOf', 'preview'].every(key => typeof item[key as keyof typeof item] === 'string') &&
        Number.isFinite(Date.parse(item.asOf)) && kinds.slice(1).some(([kind]) => kind === item.kind))) throw new Error('Library unavailable');
    // Defense in depth: scrub complete text before previewing or searching it.
    return { ...body, unavailable: body.unavailable.map(scrubSecrets), items: body.items.map(item => ({ ...item,
      title: scrubSecrets(item.title).slice(0, 120), source: scrubSecrets(item.source), preview: scrubSecrets(item.preview).slice(0, 240),
    })) };
  },
};
export function LibraryOverview({ visible, search, onSearch }: { visible: boolean; search: string; onSearch: (value: string) => void }) {
  const [kind, setKind] = useState('');
  const result = useQuery(query, { enabled: visible, freshMs: 30_000 });
  const refetch = useRefetch(query);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refetch, 30_000);
    return () => clearInterval(timer);
  }, [visible, refetch]);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = result.data?.items.filter(item => (!kind || item.kind === kind) &&
    terms.every(term => `${item.title} ${item.source} ${item.preview}`.toLowerCase().includes(term))) ?? [];
  return <section className={styles.section} aria-label="Library overview">
    <h2>Library</h2>
    <input type="search" className={styles.input} value={search} onChange={event => onSearch(event.target.value)}
      aria-label="Search Library" placeholder="Search files, memory, messages and context" autoComplete="off" spellCheck={false} />
    <div className={styles.actions} role="tablist" aria-label="Library kinds">
      {kinds.map(([value, label], index) => <button key={value} type="button" className={styles.button} role="tab"
        aria-selected={kind === value} tabIndex={kind === value ? 0 : -1} onClick={() => setKind(value)}
        style={kind === value ? { background: 'var(--bg-hover)', fontWeight: 600 } : undefined}
        onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % kinds.length : event.key === 'ArrowLeft' ? (index + kinds.length - 1) % kinds.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? kinds.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); setKind(kinds[next]![0]);
          (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
        }}>{label}</button>)}
    </div>
    {result.error ? <CardNote tone="danger">Library could not refresh. <button type="button" className={styles.button} onClick={refetch}>Retry</button></CardNote> : null}
    {result.data?.unavailable.length ? <CardNote tone="danger">Some sources are unavailable: {result.data.unavailable.join(', ')}.</CardNote> : null}
    {!result.data ? !result.error && <CardNote>Loading Library…</CardNote> : items.length ?
      <ul className={styles.bus} aria-label="Library items">{items.map(item => <li key={item.id} className={styles.busRow}>
        <strong>{item.title}</strong><span className={styles.snippet}>{item.preview}</span>
        <span className={styles.meta}>{item.source} · <time dateTime={item.asOf}>{new Date(item.asOf).toLocaleString()}</time></span>
      </li>)}</ul> : !result.error && !result.data.unavailable.length ?
        <CardNote>{search || kind ? 'No Library items match.' : 'Your Library is empty. Files, memories and agent messages will appear here.'}</CardNote> : null}
  </section>;
}
