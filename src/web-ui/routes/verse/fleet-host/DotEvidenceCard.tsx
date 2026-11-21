import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, useSectionVisible } from '../shell/section-visibility.js';
import { dotEvidenceView, type DotEvidenceView } from './dot-evidence-model.js';
import styles from './fleet-host.module.css';

/** Kept local to the web bundle; narrowed at the display boundary by dotEvidenceView. */
export const dotEvidenceQuery: QueryDef<unknown | null> = {
  key: 'verse-fleet-dot-evidence',
  async fetch(signal) {
    try {
      return await apiGet<unknown>('/api/verse/fleet/runtime-identity/dot-evidence', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

export function DotEvidenceBody({ view }: { view: DotEvidenceView }) {
  return <>
    <dl className={styles.identity}>
      {view.rows.map((row, i) => <div key={`${i}:${row.label}`} style={{ display: 'contents' }}>
        <dt>{row.label}</dt>
        <dd className={row.tone === 'unknown' ? styles.muted : undefined} data-tone={row.tone === 'warn' ? 'warn' : undefined}>{row.text}</dd>
      </div>)}
    </dl>
    {view.missing.length ? <ul className={styles.switches}>{view.missing.map((m, i) =>
      <li className={styles.muted} key={`${i}:${m}`}>{m}</li>)}</ul> : null}
  </>;
}

/** Fetches once on mount; the Refresh button is the only re-read. */
export function DotEvidenceCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(dotEvidenceQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 60_000 });
  const refetch = useRefetch(dotEvidenceQuery);
  const view = read.data ? dotEvidenceView(read.data) : null;
  return <section className={styles.section} aria-label="Dot evidence">
    <h3 className={styles.title}>Dot evidence</h3>
    <p className={styles.muted}>Sanitized and read-only; the bridge owner comes only from a live claim.</p>
    {read.status === 'error' && !view ? <p className={styles.muted}>Dot evidence unknown: read failed</p>
      : read.data === null ? <p className={styles.muted}>The Dot evidence API has not landed in this build yet.</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading Dot evidence…</p>
      : view ? <DotEvidenceBody view={view} />
      : <p className={styles.muted}>Dot evidence unknown: unreadable response</p>}
    {read.status === 'error' && view ? <p className={styles.muted}>Last refresh failed</p> : null}
    <button type="button" className={styles.refresh} onClick={refetch}>Refresh Dot evidence</button>
  </section>;
}
