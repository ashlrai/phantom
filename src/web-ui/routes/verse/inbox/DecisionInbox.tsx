import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { inboxQuery } from '../../../data/queries.js';
import { readFailureReason } from '../../../data/client.js';
import { verseBootstrapQuery } from '../verse-bootstrap-query.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ApprovalDetail } from '../approvals/ApprovalDetail.js';
import styles from './DecisionInbox.module.css';

/** Pending agent proposals, using the existing confirmation and token gates. */
export function DecisionInbox() {
  const query = useQuery(inboxQuery);
  const bootstrap = useQuery(verseBootstrapQuery);
  const retry = useRefetch(inboxQuery);
  usePollWhileVisible(retry, 10_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [dispatchDisabled, setDispatchDisabled] = useState(false);
  return <section className={styles.inbox} aria-label="Decision inbox">
    <h1>Decision inbox</h1>
    <p>Review pending agent decisions before approving or denying them.</p>
    {query.error ? <div role="alert">Could not load decisions. {readFailureReason(query.error)} <button onClick={retry}>Retry</button></div> : null}
    {!query.data && !query.error ? <p role="status">Loading decisions…</p> : null}
    {query.data && !query.error ? <>
      <p role="status">{query.data.proposals.length === 0 ? 'No pending decisions. You’re all caught up.' : `${query.data.proposals.length} pending decisions`}</p>
      <ul className={styles.list}>
        {query.data.proposals.map((p) => <li key={p.id}>
          <button aria-pressed={selected === p.id} onClick={() => setSelected(p.id)}>{p.title}</button>
          <span>{p.origin} · {p.kind} · {p.repo}</span>
        </li>)}
      </ul>
      {selected && query.data.proposals.some((p) => p.id === selected) ? <ApprovalDetail
        key={selected} id={selected} denyLabel="Deny"
        dispatchEnabled={bootstrap.data?.dispatchEnabled === true && !dispatchDisabled}
        onDispatchDisabled={() => setDispatchDisabled(true)} onDecided={() => { setSelected(null); retry(); }}
      /> : null}
    </> : null}
  </section>;
}
