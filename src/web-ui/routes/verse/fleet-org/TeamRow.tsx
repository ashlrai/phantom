import { useQuery } from '../../../data/hooks.js';
import { teamQuery } from '../fleet-team/TeamPane.js';
import styles from './fleet-org.module.css';

/** Team row in the org view: the same people as `phm team --json`, with the pools each brings. Joining another computer is `phm node join`. */
export function TeamRow({ visible }: { visible: boolean }) {
  const read = useQuery(teamQuery, { enabled: visible, freshMs: 0 });
  const people = read.status === 'error' ? undefined : read.data?.people;
  return <section className={styles.tier} aria-label="Team">
    <h3 className={styles.title}>Team</h3>
    {people === undefined ? <p className={styles.quiet}>{read.status === 'error' ? 'Team unknown.' : 'Reading the team…'}</p>
      : people.length === 0 ? <p className={styles.quiet}>Just you. Add a co-founder with phm team add.</p>
      : <ul className={styles.machines}>{people.map(p => <li className={styles.machine} key={p.id}>
        <strong>{p.displayName}</strong> · pools: {p.lanes.length ? p.lanes.join(', ') : 'none'}{p.poolSharePct === undefined ? '' : ` · ${p.poolSharePct}% share`}
      </li>)}</ul>}
  </section>;
}
