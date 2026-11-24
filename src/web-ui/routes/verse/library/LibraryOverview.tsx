import { useEffect, useState } from 'react';
import type { LibraryItem, LibrarySnapshot } from '../../../../core/fleet/library.js';
import { scrubSecrets } from '../../../../core/util/scrub-secrets.js';
import { getMutationToken, getReadClientProof } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import { CardNote } from '../command/Surface.js';
import { useViewport } from '../shell/viewport.js';
import styles from './library.module.css';
const kinds = [['', 'All'], ['file', 'Files'], ['media', 'Media'], ['memory', 'Memory'], ['message', 'Messages'], ['context', 'Context']] as const;
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
        Number.isFinite(Date.parse(item.asOf)) && kinds.slice(1).some(([kind]) => kind === item.kind) &&
        // Older servers omit owner and size; both then read as unknown.
        (item.owner == null || typeof item.owner === 'string') && (item.size == null || (Number.isSafeInteger(item.size) && item.size >= 0)))) throw new Error('Library unavailable');
    // Defense in depth: scrub complete text before previewing or searching it.
    return { ...body, unavailable: body.unavailable.map(scrubSecrets), items: body.items.map(item => ({ ...item,
      title: scrubSecrets(item.title).slice(0, 120), source: scrubSecrets(item.source), preview: scrubSecrets(item.preview).slice(0, 240),
      owner: item.owner == null ? null : scrubSecrets(item.owner).slice(0, 80), size: item.size ?? null,
    })) };
  },
};
const kindLabel = (kind: string): string => kinds.find(([value]) => value === kind)?.[1] ?? kind;
export const librarySize = (bytes: number | null): string => bytes === null ? 'unknown' : bytes < 1024 ? `${bytes} B`
  : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
function Detail({ item, onClose, closeLabel }: { item: LibraryItem; onClose: () => void; closeLabel: string }) {
  const facts: [string, string][] = [['Kind', kindLabel(item.kind)], ['Source', item.source], ['Owner', item.owner ?? 'unknown'],
    ['Updated', new Date(item.asOf).toLocaleString()], ['Size', librarySize(item.size)], ['Id', item.id]];
  return <section className={styles.detail} aria-label="Library item">
    <div className={styles.detailHead}><h3>{item.title}</h3>
      <button type="button" className={styles.button} onClick={onClose}>{closeLabel}</button></div>
    <dl className={styles.facts}>{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className={styles.detailText}>{item.preview || 'No preview.'}</p>
    <p className={styles.meta}>Agents: phm library show {item.id}</p>
  </section>;
}
export function LibraryOverview({ visible, search, onSearch }: { visible: boolean; search: string; onSearch: (value: string) => void }) {
  const [kind, setKind] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { compact } = useViewport();
  const result = useQuery(query, { enabled: visible, freshMs: 30_000 });
  const refetch = useRefetch(query);
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refetch, 30_000);
    return () => clearInterval(timer);
  }, [visible, refetch]);
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const items = result.data?.items.filter(item => (!kind || item.kind === kind) &&
    terms.every(term => `${item.title} ${item.source} ${item.owner ?? ''} ${item.preview}`.toLowerCase().includes(term))) ?? [];
  // The pane only shows an item the current filters still list.
  const selected = items.find(item => item.id === selectedId) ?? null;
  // At phone width the detail replaces the list; wider, they sit side by side.
  const showList = !(compact && selected);
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
      <div className={compact ? styles.stack : styles.split} data-layout={compact ? 'stacked' : 'split'}>
        {showList ? <ul className={styles.bus} aria-label="Library items">{items.map(item => <li key={item.id}>
          <button type="button" className={styles.hit} aria-current={item.id === selected?.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
            <strong>{item.title}</strong><span className={styles.snippet}>{item.preview}</span>
            <span className={styles.meta}>{item.source} · {item.owner ?? 'unknown'} · <time dateTime={item.asOf}>{new Date(item.asOf).toLocaleString()}</time> · {librarySize(item.size)}</span>
          </button>
        </li>)}</ul> : null}
        {selected ? <Detail item={selected} onClose={() => setSelectedId(null)} closeLabel={compact ? 'Back to list' : 'Close'} />
          : compact ? null : <p className={styles.meta}>Choose an item to see its details.</p>}
      </div> : !result.error && !result.data.unavailable.length ?
        <CardNote>{search || kind ? 'No Library items match.' : 'Your Library is empty. Files, media, memory, messages and shared context will appear here.'}</CardNote> : null}
  </section>;
}
