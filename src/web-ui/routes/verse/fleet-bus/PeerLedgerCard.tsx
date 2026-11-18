import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Tag } from '../../../components/primitives/index.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { pairsNearLimit, parsePeerLedger, peerLedgerHeadline, type PeerLedgerView } from './peer-ledger-model.js';
import { peerLedgerQuery } from './peer-ledger-query.js';
import styles from './fleet-bus.module.css';

export function PeerLedgerBody({ view }: { view: PeerLedgerView }) {
  const pairs = pairsNearLimit(view).slice(0, 5);
  const hot = view.origins.filter(o => o.nearCap);
  return <>
    <p className={styles.header}>{peerLedgerHeadline(view)}</p>
    {pairs.length > 0 || hot.length > 0 ? <ul className={styles.list} aria-label="Peer bus budget">
      {pairs.map(p => <li className={styles.row} key={`${p.fromAgent}\u0000${p.target}`}>
        <span>{p.fromAgent} → {p.target}</span>
        <span className={styles.text}>{p.remaining}/{view.pairLimit} left</span>
        {p.remaining <= 0 && <Tag size="sm">at limit</Tag>}
      </li>)}
      {hot.map(o => <li className={styles.row} key={`origin:${o.origin}`}>
        <span>{o.origin}</span>
        <span className={styles.text}>hop {o.maxHop}/{view.maxHops}</span>
        <Tag size="sm">near hop cap</Tag>
      </li>)}
    </ul> : null}
  </>;
}

export function PeerLedgerCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(peerLedgerQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(peerLedgerQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const view = read.data ? parsePeerLedger(read.data) : null;
  return <section aria-label="Peer bus budget">
    {read.status === 'error' ? <p className={styles.notice}>Peer bus budget unknown: read failed</p>
      : read.data === null ? <p className={styles.notice}>Peer bus budget is not in this build yet.</p>
      : read.data === undefined ? <p className={styles.notice} role="status">Reading peer bus budget…</p>
      : view ? <PeerLedgerBody view={view} />
      : <p className={styles.notice}>Peer bus budget unknown: unreadable report</p>}
  </section>;
}
