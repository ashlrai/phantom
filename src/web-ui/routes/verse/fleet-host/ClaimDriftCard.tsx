import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claimDriftHeadline, parseClaimDrift, type ClaimDriftDisplayRow } from './claim-drift-model.js';
import styles from './fleet-host.module.css';

const claimDriftQuery: QueryDef<unknown> = {
  key: 'verse-fleet-claim-drift',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runtime-identity/claim-drift', signal),
};

const MAX_ROWS = 8;

function rowOwner(row: ClaimDriftDisplayRow): string {
  return row.kind === 'owner mismatch' ? `${row.busOwner ?? '?'}→${row.coordOwner ?? '?'}` : row.owner;
}

export function ClaimDriftCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(claimDriftQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(claimDriftQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const view = read.status === 'error' || read.data === undefined ? null : parseClaimDrift(read.data);
  const headline = view ? claimDriftHeadline(view) : null;
  return <section className={styles.section} aria-label="Claim store drift">
    <h3 className={styles.title}>Claim stores</h3>
    {read.status === 'error' ? <p className={styles.line} data-tone="warn">Claim stores unknown: request failed</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading claim stores…</p>
      : !view || !headline ? <p className={styles.line} data-tone="warn">Claim stores unknown: unreadable response</p>
      : <>
        <p className={styles.line} data-tone={headline.tone === 'ok' ? undefined : headline.tone === 'bad' ? 'bad' : 'warn'}>
          {headline.text}
        </p>
        {view.rows.length > 0 ? <ul className={styles.peerList}>
          {view.rows.slice(0, MAX_ROWS).map((row, i) => <li className={styles.peerRow} key={`${i}:${row.kind}:${row.id}`}>
            <span className={styles.badge} data-tone="bad">{row.kind}</span>
            <span>{row.id}</span>
            <span className={styles.muted}>{rowOwner(row)}</span>
            <span className={styles.muted}>lease until {row.leaseUntil}</span>
          </li>)}
        </ul> : null}
        {view.rows.length > MAX_ROWS ? <p className={styles.muted}>+{view.rows.length - MAX_ROWS} more</p> : null}
      </>}
  </section>;
}
