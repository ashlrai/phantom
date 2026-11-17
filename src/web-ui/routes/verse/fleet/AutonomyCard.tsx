import type { AutonomyReport } from '../../../../core/fleet/autonomy.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet.module.css';

const query: QueryDef<AutonomyReport> = { key: 'fleet-autonomy', fetch: async signal => {
  const value = await apiGet<AutonomyReport>('/api/verse/fleet/runs/autonomy', signal);
  if (value?.schema !== 'fleet.autonomy.v1' || typeof value.headline !== 'string' ||
    ![value.mergedPerHour, value.withoutHumanShare, value.selfImprovementShare].every(n =>
      n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
    [value.withoutHumanShare, value.selfImprovementShare].some(n => n !== null && n > 1)) throw new Error('Invalid autonomy report.');
  return value;
} };

export function AutonomyCard() {
  const read = useQuery(query, { freshMs: 30_000 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 30_000);
  const report = read.status === 'error' ? undefined : read.data;
  const number = (value: number | null | undefined, percent = false) => value == null ? 'Unknown'
    : percent ? `${Math.round(value * 100)}%` : String(Math.round(value * 100) / 100);
  return <Card title="Autonomy" caption="Last 24 hours">
    <p>{report?.headline ?? (read.status === 'loading' ? 'Reading autonomy…' : 'Autonomy is unknown. Local evidence is unavailable.')}</p>
    <dl className={styles.facts}>
      <div><dt>Merged per hour</dt><dd>{number(report?.mergedPerHour)}</dd></div>
      <div><dt>Without a person</dt><dd>{number(report?.withoutHumanShare, true)}</dd></div>
      <div><dt>Improved the fleet</dt><dd>{number(report?.selfImprovementShare, true)}</dd></div>
    </dl>
  </Card>;
}
