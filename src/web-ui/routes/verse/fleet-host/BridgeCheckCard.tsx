import { Button } from '../../../components/primitives/index.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { bridgeCheckAsOf, bridgeCheckHeadline, bridgeClaimsLine, bridgeRuntimeLine, parseBridgeCheck, sectionFailing, type BridgeCheckView } from './bridge-check-model.js';
import { bridgeCheckQuery } from './bridge-check-query.js';
import styles from './fleet-host.module.css';

export function BridgeCheckBody({ view }: { view: BridgeCheckView }) {
  return <>
    <h3 className={styles.title}>{bridgeCheckHeadline(view)}</h3>
    <p className={styles.muted}>{bridgeCheckAsOf(view)}. Reachability evidence only; it grants no dispatch authority.</p>
    <ul className={styles.peerList}>{view.sections.map(s => <li className={styles.peerRow} key={s.name}>
      <span className={styles.badge}>{s.name}</span>
      <span>{s.status}{sectionFailing(s) && s.reason ? `: ${s.reason}` : ''}</span>
      <span className={styles.muted}>{s.source} · as of {s.asOf}</span>
      {s.name === 'runtime' ? <span className={styles.muted}>{bridgeRuntimeLine(view)}</span> : null}
      {s.name === 'claims' ? <span className={styles.muted}>{bridgeClaimsLine(view)}</span> : null}
    </li>)}</ul>
  </>;
}

export function BridgeCheckCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(bridgeCheckQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(bridgeCheckQuery);
  const refresh = useRefresh(bridgeCheckQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  if (!visible) return null;
  const view = read.data ? parseBridgeCheck(read.data) : null;
  return <section className={styles.section} aria-label="Bridge check">
    {read.status === 'error' ? <p className={styles.muted}>Bridge: unknown (read failed)</p>
      : read.data === null ? <p className={styles.muted}>The bridge check API has not landed in this build yet.</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading bridge check…</p>
      : view === null ? <p className={styles.muted}>Bridge: unknown (unexpected report shape)</p>
      : <BridgeCheckBody view={view} />}
    <Button size="sm" onClick={refresh} aria-label="Refresh bridge check">Refresh</Button>
  </section>;
}
