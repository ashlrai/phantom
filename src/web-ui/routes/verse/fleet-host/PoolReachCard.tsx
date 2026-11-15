import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { poolReachSummary, MAX_REASONS, type PoolReachHost, type PoolReachView } from './pool-reach-model.js';
import { poolReachQuery } from './pool-reach-query.js';
import { formatAge } from './runtime-identity-model.js';
import { snapshotAge } from './tailnet-peers-model.js';
import styles from './fleet-host.module.css';

const stateOf = (online: PoolReachHost['online']) => (online === true ? 'online' : online === false ? 'offline' : 'unknown');

export function PoolReachBody({ view, now = Date.now() }: { view: PoolReachView; now?: number }) {
  const sum = poolReachSummary(view, now);
  return <>
    <h3 className={styles.title}>Pool reach</h3>
    <p className={styles.line} data-tone={sum.tone}>
      {sum.text}{' '}<span className={styles.muted}>as of {formatAge(snapshotAge(view.asOf, now))}</span>
    </p>
    {view.hosts.length > 0 ? <ul className={styles.peerList}>{view.hosts.map((h, i) => {
      const state = stateOf(h.online);
      return <li className={styles.peerRow} key={`${i}:${h.slot}`}>
        <span className={styles.peerDot} data-state={state} aria-hidden="true" />
        <span className={styles.peerState}>{state}</span>
        <span className={styles.peerName}>{h.slot} {h.alias}</span>
        {h.isSelf ? <span className={styles.muted}>this computer</span> : null}
        <span className={styles.muted}>last seen {h.ageSeconds === 'unknown' ? 'unknown' : formatAge(h.ageSeconds)}</span>
      </li>;
    })}</ul> : null}
    {view.reasons.length > 0 ? <ul className={styles.peerList}>
      {view.reasons.slice(0, MAX_REASONS).map((r, i) => <li className={styles.muted} key={`${i}:${r}`}>{r}</li>)}
    </ul> : null}
  </>;
}

export function PoolReachCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(poolReachQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(poolReachQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const view = read.status === 'error' ? undefined : read.data;
  return <section className={styles.section} aria-label="Pool reach">
    {read.status === 'error' ? <p className={styles.muted}>Pool reach unavailable</p>
      : view === null ? <p className={styles.muted}>The pool reach API has not landed in this build yet.</p>
      : !view ? <p className={styles.muted} role="status">Reading pool reach…</p>
      : <PoolReachBody view={view} />}
  </section>;
}
