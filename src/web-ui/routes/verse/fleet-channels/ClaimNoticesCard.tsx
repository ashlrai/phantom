import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { claimNoticesQuery } from './claim-notices-query.js';
import type { ClaimNoticesView } from './claim-notices-model.js';
import styles from './fleet-channels.module.css';

/** Read-only: what Phantom has told, and would tell, a Slack thread. */
export function ClaimNoticesCard({ visible, nowMs }: { visible: boolean; nowMs: number }) {
  const read = useQuery(claimNoticesQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(claimNoticesQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });
  if (read.data === null) return null; // build without the route
  if (read.data === undefined) {
    return <p className={styles.message} role="status">{read.status === 'error' ? 'Slack thread notices are unavailable.' : 'Reading Slack thread notices…'}</p>;
  }
  return <ClaimNoticesBody view={read.data} nowMs={nowMs} />;
}

export function ClaimNoticesBody({ view, nowMs }: { view: ClaimNoticesView; nowMs: number }) {
  return <section className={styles.root} aria-label="Slack thread notices" data-testid="claim-notices">
    <strong>Slack thread notices</strong>
    {view.source === 'missing' && <p className={styles.notice} role="status">No claim-notice state found yet; nothing has been posted.</p>}
    {view.source === 'unreadable' && <p className={styles.notice} role="status">Claim-notice state is unreadable; counts are unknown.</p>}
    {view.source === 'ok' && <>
      <p className={styles.header}>{view.bindings} bound threads · {view.sentTotal} posted · {view.pending.length} waiting</p>
      <p className={styles.header}>{view.delivery.slackSent} slack-sent · {view.delivery.noReceipt} no-slack-receipt · {view.delivery.unknown} unknown</p>
      {view.slackConfigured === false && <p className={styles.notice} role="status">Slack is not configured; notices stay pending.</p>}
      <ul className={styles.list} aria-label="Slack thread notice rows">
        {view.recent.map((row, i) => <li className={styles.row} key={`sent-${i}`}>
          <div className={styles.meta}><span className={styles.healthBadge}>{row.state}</span><strong>{row.claimId}</strong>
            <span>{row.delivery}</span>
            <time dateTime={new Date(row.at).toISOString()}>{formatRelative(new Date(row.at).toISOString(), nowMs)}</time></div>
        </li>)}
        {view.pending.map((row, i) => <li className={styles.row} key={`pending-${i}`}>
          <div className={styles.meta}><span className={styles.healthBadge}>{row.state}</span><span>would post</span></div>
          <p className={styles.preview}>{row.text}</p>
        </li>)}
      </ul>
      {view.unbound.state === 'unknown' && <p className={styles.notice} role="status">Unbound claims: unknown</p>}
      {view.unbound.state === 'known' && view.unbound.total > 0 && <>
        <p className={styles.notice} role="status">{view.unbound.total} live claims have no Slack thread; their notices are dropped</p>
        <ul className={styles.list} aria-label="Claims with no Slack thread">
          {view.unbound.rows.map((row, i) => <li className={styles.row} key={`unbound-${i}`}>
            <div className={styles.meta}><strong>{row.claimId}</strong><span>{row.repo}</span><span>{row.agent}</span>
              <time dateTime={new Date(row.claimedAt).toISOString()}>{formatRelative(new Date(row.claimedAt).toISOString(), nowMs)}</time></div>
            <code>{`ashlr fleet claim-bind ${row.claimId} --repo ${row.repo} --thread <threadKey>`}</code>
          </li>)}
        </ul>
      </>}
      <p className={styles.message}>Posted means a durable bus note was written, not that Slack delivered it.</p>
    </>}
  </section>;
}
