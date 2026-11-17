import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claimExecutionHeadline, parseClaimExecution, type ParsedClaimExecution } from './claim-execution-model.js';
import { claimExecutionQuery } from './claim-execution-query.js';
import { linkClaimsToOrders, linkTime, type ClaimOrderLink } from './claim-order-link.js';
import { orderStateQuery, type OrderStateResult } from '../fleet-board/order-state-query.js';
import { claimFreshness, sortByFreshness } from './claim-freshness.js';
import { formatAge } from './runtime-identity-model.js';
import { snapshotAge } from './tailnet-peers-model.js';
import styles from './fleet-host.module.css';

export function ClaimExecutionBody({ parsed, now, orderLinks }: { parsed: ParsedClaimExecution; now?: number; orderLinks?: Map<string, ClaimOrderLink> }) {
  const [clock, setClock] = useState(Date.now);
  usePollWhileVisible(() => setClock(Date.now()), 5_000);
  const currentTime = now ?? clock;
  const headline = claimExecutionHeadline(parsed);
  const elapsed = parsed.kind === 'ok' ? snapshotAge(parsed.asOf, currentTime) : 'unknown';
  return <>
    <h3 className={styles.title}>Claim execution</h3>
    <p className={styles.line} data-tone={headline.tone}>
      {headline.text}{' '}
      {parsed.kind === 'ok' ? <span className={styles.muted}>as of {formatAge(elapsed)}</span> : null}
    </p>
    {parsed.kind === 'ok' ? <>
      <ul className={styles.peerList}>{sortByFreshness(parsed.rows, parsed.asOf, currentTime).map((row, i) => {
        const freshness = claimFreshness(row, parsed.asOf, currentTime);
        const expires = row.expiresInSeconds === 'unknown' || elapsed === 'unknown' ? 'unknown'
          : formatAge(Math.max(0, row.expiresInSeconds - elapsed)).replace(/ old$/, '');
        const link = orderLinks?.get(row.claimId);
        const mismatch = link !== undefined && row.state === 'RUNNING' && (link.boardState === 'RECEIVED' || link.boardState === 'ASSIGNED');
        return <li className={styles.peerRow} key={`${i}:${row.claimId}`}>
          <span className={styles.badge}>{row.state === 'CLAIMED_NO_WORKER' ? 'CLAIMED, no live worker' : row.state}</span>
          {freshness.stale ? <span className={styles.badge} data-tone="warn">stale</span> : null}
          <span className={styles.muted}>{freshness.label}</span>
          <span>{row.jobId ?? 'no job id'}</span>
          {link ? <span className={styles.muted} data-mismatch={mismatch ? 'true' : undefined}>
            serves {link.source} order {linkTime(link.at)} ({link.boardState} on board)
          </span> : null}
          <span className={styles.muted}>{row.agent} · {row.repo}</span>
          {row.state === 'RUNNING' && row.worker ? <span className={styles.muted}>
            pid {row.worker.pid} · {row.worker.lane} · {formatAge(row.worker.ageSeconds)}
          </span> : null}
          <span className={styles.muted}>expires in {expires}</span>
        </li>;
      })}</ul>
      {parsed.reasons.length > 0 ? <ul className={styles.peerList}>
        {parsed.reasons.map((reason, i) => <li className={styles.muted} key={`${i}:${reason}`}>{reason}</li>)}
      </ul> : null}
    </> : null}
  </>;
}

export function ClaimExecutionCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(claimExecutionQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(claimExecutionQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  // Best-effort join: a failed or missing orders read leaves the rows exactly as before.
  const orders = useQuery(orderStateQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  return <section className={styles.section} aria-label="Claim execution">
    {read.status === 'error' ? <p className={styles.muted}>Claim execution unknown: read failed</p>
      : read.data === null ? <p className={styles.muted}>The claim execution API has not landed in this build yet.</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading claim execution…</p>
      : <ClaimExecutionBody parsed={parseClaimExecution(read.data)} orderLinks={orderLinksFor(read.data, orders)} />}
  </section>;
}

// orderStateQuery already runs parseOrderStateBody; any failure resolves to 'unavailable', which links nothing.
function orderLinksFor(claimBody: unknown, orders: { status: string; data?: OrderStateResult | null }): Map<string, ClaimOrderLink> {
  return linkClaimsToOrders(parseClaimExecution(claimBody), orders.status === 'error' ? undefined : orders.data ?? undefined);
}
