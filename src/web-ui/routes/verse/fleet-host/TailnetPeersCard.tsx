import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { formatAge } from './runtime-identity-model.js';
import { snapshotAge, summarizePeers, type TailnetPeerRow, type TailnetPeersView } from './tailnet-peers-model.js';
import { tailnetPeersQuery } from './tailnet-peers-query.js';
import styles from './fleet-host.module.css';

const stateOf = (online: TailnetPeerRow['online']) => (online === true ? 'online' : online === false ? 'offline' : 'unknown');

export function TailnetPeersBody({ view, now = Date.now() }: { view: TailnetPeersView | null; now?: number }) {
  if (!view) return <p className={styles.muted}>Peer list unavailable</p>;
  const sum = summarizePeers(view);
  return <>
    <h3 className={styles.title}>Fleet computers</h3>
    <p className={styles.line}>
      {sum.online} online · {sum.offline} offline{sum.unknown ? ` · ${sum.unknown} unknown` : ''}
      {' '}<span className={styles.muted}>as of {formatAge(snapshotAge(view.asOf, now))}</span>
    </p>
    {view.peers.length === 0 ? <>
      <p className={styles.muted}>No tailnet peers visible</p>
      {view.reasons[0] ? <p className={styles.muted}>{view.reasons[0]}</p> : null}
    </> : <ul className={styles.peerList}>{view.peers.map((p, i) => {
      const state = stateOf(p.online);
      return <li className={styles.peerRow} key={`${i}:${p.name}`}>
        <span className={styles.peerDot} data-state={state} aria-hidden="true" />
        <span className={styles.peerState}>{state}</span>
        <span className={styles.peerName}>{p.name}</span>
        <span className={styles.muted}>{p.os}</span>
        <span className={styles.muted}>last seen {p.ageSeconds === 'unknown' ? 'unknown' : formatAge(p.ageSeconds)}</span>
      </li>;
    })}</ul>}
  </>;
}

export function TailnetPeersCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(tailnetPeersQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(tailnetPeersQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.section} aria-label="Fleet computers">
    <TailnetPeersBody view={read.status === 'error' ? null : read.data ?? null} />
  </section>;
}
