import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { computersQuery, type ComputerCard, type ComputersView } from './computers-model.js';
import styles from './fleet-host.module.css';

const show = <T,>(value: T | 'unknown', known: (v: T) => string): string => (value === 'unknown' ? 'unknown' : known(value));

function Computer({ computer }: { computer: ComputerCard }) {
  return <li className={styles.computer} data-state={computer.joined ? computer.stateCode : 'not-joined'} aria-label={computer.name}>
    <p className={styles.line}>
      <span className={styles.peerDot} data-state={computer.joined ? computer.stateCode : 'not-joined'} aria-hidden="true" />{' '}
      <span className={styles.peerName}>{computer.name}</span>
      {computer.isSelf ? <span className={styles.muted}> · this computer</span> : null}
    </p>
    {computer.joined
      ? <p className={styles.line}>{computer.state}</p>
      : <p className={styles.line}>Not joined. {computer.joinCommand
        ? <>On {computer.name}, run <code>{computer.joinCommand}</code></>
        : 'This computer has no node pool, so it cannot join this list.'}</p>}
    {computer.joined ? <dl className={styles.identity}>
      <dt>Memory free</dt><dd>{show(computer.freeMemoryBytes, (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`)}</dd>
      <dt>CPU free</dt><dd>{show(computer.cpuHeadroomPercent, (percent) => `${percent}%`)}</dd>
      <dt>Lanes</dt><dd>{show(computer.lanes, (lanes) => lanes.join(', ') || 'none')}</dd>
      <dt>Jobs running</dt><dd>{show(computer.jobsRunning, String)}</dd>
    </dl> : null}
  </li>;
}

/** One card per computer, in the server's words. `view` is null when the list cannot be read. */
export function ComputersBody({ view }: { view: ComputersView | null | undefined }) {
  if (view === undefined) return <p className={styles.muted} role="status">Looking for your computers…</p>;
  if (!view || view.computers.length === 0) return <p className={styles.muted}>Computers are unavailable right now.</p>;
  const ready = view.computers.filter((c) => c.joined && c.stateCode === 'ready').length;
  return <>
    <p className={styles.headline}>{ready} of {view.computers.length} ready for work</p>
    <ul className={styles.computers}>{view.computers.map((c, i) => <Computer computer={c} key={`${i}:${c.name}`} />)}</ul>
    {view.computers.length === 1
      ? <p className={styles.line}>This is your only computer so far. To add another, connect it to your Tailscale network, then run <code>phm nodes --discover</code> to see the command that joins it.</p>
      : null}
    {view.reasons.map((reason, i) => <p className={styles.muted} key={`${i}:${reason}`}>{reason}</p>)}
  </>;
}

export function ComputersPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(computersQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 15_000 });
  const refetch = useRefetch(computersQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible, refreshOnShow: false });
  return <div className={styles.pane} aria-label="Computers">
    <ComputersBody view={read.status === 'error' ? null : read.data} />
  </div>;
}
