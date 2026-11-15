import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claimExecutionHeadline, parseClaimExecution, type ParsedClaimExecution } from './claim-execution-model.js';
import { claimExecutionQuery } from './claim-execution-query.js';
import { formatAge } from './runtime-identity-model.js';
import { snapshotAge } from './tailnet-peers-model.js';
import styles from './fleet-host.module.css';

export function ClaimExecutionBody({ parsed, now = Date.now() }: { parsed: ParsedClaimExecution; now?: number }) {
  const headline = claimExecutionHeadline(parsed);
  const elapsed = parsed.kind === 'ok' ? snapshotAge(parsed.asOf, now) : 'unknown';
  return <>
    <h3 className={styles.title}>Claim execution</h3>
    <p className={styles.line} data-tone={headline.tone}>
      {headline.text}{' '}
      {parsed.kind === 'ok' ? <span className={styles.muted}>as of {formatAge(elapsed)}</span> : null}
    </p>
    {parsed.kind === 'ok' ? <>
      <ul className={styles.peerList}>{parsed.rows.map((row, i) => {
        const expires = row.expiresInSeconds === 'unknown' || elapsed === 'unknown' ? 'unknown'
          : formatAge(Math.max(0, row.expiresInSeconds - elapsed)).replace(/ old$/, '');
        return <li className={styles.peerRow} key={`${i}:${row.claimId}`}>
          <span className={styles.badge}>{row.state === 'CLAIMED_NO_WORKER' ? 'CLAIMED, no live worker' : row.state}</span>
          <span>{row.jobId ?? 'no job id'}</span>
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
  return <section className={styles.section} aria-label="Claim execution">
    {read.status === 'error' ? <p className={styles.muted}>Claim execution unknown: read failed</p>
      : read.data === null ? <p className={styles.muted}>The claim execution API has not landed in this build yet.</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading claim execution…</p>
      : <ClaimExecutionBody parsed={parseClaimExecution(read.data)} />}
  </section>;
}
