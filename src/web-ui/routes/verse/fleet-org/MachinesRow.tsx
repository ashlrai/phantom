import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { computersQuery, type ComputerCard } from '../fleet-host/computers-model.js';
import styles from './fleet-org.module.css';

/** "2 free", "full", or "slots unknown" in plain words. */
export function slotWords(computer: ComputerCard): string {
  if (computer.stateCode === 'offline') return 'offline';
  if (computer.freeSlots === 'unknown') return 'slots unknown';
  return computer.freeSlots === 0 ? 'full' : `${computer.freeSlots} free`;
}

/** The same rows as `phm nodes --json`, one chip per computer. */
export function MachinesChips({ computers }: { computers: ComputerCard[] | undefined }) {
  if (computers === undefined) return <p className={styles.quiet}>Looking for your computers…</p>;
  if (computers.length === 0) return <p className={styles.quiet}>Computers unknown.</p>;
  if (computers.length === 1 && computers[0]!.isSelf) return <p className={styles.quiet}>Only this Mac.</p>;
  return <ul className={styles.machines}>{computers.map((c, i) =>
    <li className={styles.machine} data-state={c.stateCode} key={`${i}:${c.name}`} title={c.state}>
      <strong>{c.name}</strong>{c.isSelf ? ' (this Mac)' : ''} · {slotWords(c)}
    </li>)}</ul>;
}

/** Machines row at the top of the org view. */
export function MachinesRow({ visible }: { visible: boolean }) {
  const read = useQuery(computersQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(computersQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.tier} aria-label="Machines">
    <h3 className={styles.title}>Machines</h3>
    <MachinesChips computers={read.status === 'error' ? [] : read.data?.computers} />
  </section>;
}
