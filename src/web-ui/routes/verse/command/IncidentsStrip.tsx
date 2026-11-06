import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { executeCatalogCommand } from '../shell/run-command.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { incidents } from './incidents-model.js';
import styles from './incidents-strip.module.css';

export function IncidentsStrip({ now }: { now: number }) {
  const read = useQuery(opsRunsQuery);
  const refetch = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 10_000);
  const rows = read.status === 'error' || read.status === 'loading' ? [] : incidents(read.data ?? null, now);
  if (!rows.length) return null;
  return <section role="region" aria-label="Incidents" className={styles.strip}>
    <ul className={styles.list}>
      {rows.map(row => <li key={row.id} className={styles.row} data-severity={row.severity}>
        <span className={styles.dot} aria-hidden="true" />
        <strong>{row.title}</strong>
        <span>{row.detail}</span>
        {row.fix ? <code>{row.fix}</code> : null}
      </li>)}
    </ul>
    <Button variant="ghost" size="sm" onClick={() => { executeCatalogCommand('section.ops', { via: 'button' }); }}>Open Ops</Button>
  </section>;
}
