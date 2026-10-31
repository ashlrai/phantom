import { ForestPlot, forestVerdict } from '../../../components/charts/ForestPlot.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { opsFleetQuery } from '../ops/ops-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { experimentNotes, experimentRows } from './fleet-experiments-model.js';
import styles from './fleet-experiments.module.css';

const words = { positive: 'helped', negative: 'hurt', none: 'unclear', unknown: 'unknown' } as const;

export function FleetExperimentsPane({ visible }: PaneProps) {
  const read = useQuery(opsFleetQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(opsFleetQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible });

  if (read.data == null) {
    if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Experiments not in this build</p>;
    return <p className={styles.message} role="status">{read.status === 'error' ? 'Experiments are unavailable.' : 'Reading experiments…'}</p>;
  }
  const { rows, summary, status } = experimentRows(read.data);
  const experiments = new Map(read.data.experiments.map(exp => [exp.id, exp]));
  return <section className={styles.root} aria-label="Experiments">
    <p className={styles.header}>{summary.total} experiments · {summary.helped} helped · {summary.hurt} hurt · {summary.unclear} unclear</p>
    {read.data.sources.learning !== 'healthy' && <p className={styles.notice} role="status">Experiment data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Experiments could not refresh. Showing the last reading.</p>}
    <ForestPlot title="Calibration experiments" description="Lift and 95% confidence interval against no effect." rows={rows} status={status} gate={{ value: 0, label: 'no effect' }} unit="lift" />
    {rows.length > 0 && <ul className={styles.list} aria-label="Experiment details">{rows.map(row => {
      const exp = experiments.get(row.id)!;
      return <li key={row.id}><details><summary>{row.label} · {words[forestVerdict(row)]}</summary>
        <p>{row.detail}</p>{experimentNotes(exp).map((note, i) => <p key={i}>{note}</p>)}
      </details></li>;
    })}</ul>}
  </section>;
}
