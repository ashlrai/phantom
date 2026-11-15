import { useQuery } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetMachine } from '../../../../core/fleet/machine.js';
import styles from './FleetView.module.css';

const query: QueryDef<FleetMachine> = { key: 'fleet-machine', fetch: signal => apiGet<FleetMachine>('/api/fleet/machine', signal) };
const show = (n: number | null | undefined, unit = '') => n == null ? 'unknown' : `${Math.round(n * 100) / 100}${unit}`;

export function MachineCard() {
  const { data } = useQuery(query);
  return <section className={styles.section} aria-label="Machine">
    <h2 className={styles.sectionTitle}>Machine</h2>
    {data?.overloaded && <p role="alert">Warning: load is over 4 times the number of CPUs.</p>}
    <dl>
      <dt>Load per CPU</dt><dd>{show(data?.loadPerCpu)} ({show(data?.load1)} load / {show(data?.cpus)} CPUs)</dd>
      <dt>Swap used</dt><dd>{show(data?.swapGb, ' GB')}</dd>
      <dt>Free disk</dt><dd>{show(data?.diskFreeGb, ' GB')}</dd>
      <dt>Worktrees</dt><dd>{show(data?.worktrees)}</dd>
      <dt>Running workers</dt><dd>{show(data?.runningWorkers)}</dd>
    </dl>
  </section>;
}
