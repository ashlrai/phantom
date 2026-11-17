/**
 * routes/verse/goals-pane/FleetGoalCards.tsx: the fleet's standing goals, one
 * card each: status, value now, target, a 24 h trend line and one action
 * ("See evidence") that opens the pane behind the number. Same data as
 * `phm goals` (core/fleet/goal-scorecard.ts). Fails on its own; unknown is
 * shown as unknown, never as zero.
 */
import type { FleetGoal, GoalScorecard, GoalStatus } from '../../../../core/fleet/goal-scorecard.js';
import { Sparkline } from '../../../components/charts/Sparkline.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import type { PaneProps } from '../panes/pane-registry.js';
import styles from './goals-pane.module.css';

export const goalScorecardQuery: QueryDef<GoalScorecard> = {
  key: 'fleet-goal-scorecard',
  fetch: signal => apiGet<GoalScorecard>('/api/verse/fleet/runs/goal-scorecard', signal),
};

const STATUS: Record<GoalStatus, string> = { 'on-track': 'On track', behind: 'Behind', unknown: 'Unknown' };

function asOfText(asOf: string | null): string {
  if (!asOf) return 'As of: unknown';
  const at = new Date(asOf);
  return `As of ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function GoalCard({ goal, onEvidence }: { goal: FleetGoal; onEvidence: () => void }) {
  const known = goal.trend.points.filter(p => p !== null).length;
  return (
    <Card title={goal.title} caption={<span className={styles.badge} data-status={goal.status}>{STATUS[goal.status]}</span>}
      actions={<button type="button" onClick={onEvidence}>See evidence</button>}>
      <p className={styles.metric} data-state={goal.status}>
        <span className={styles.metricValue}>{goal.valueText}</span>
        <span>Target: {goal.target}</span>
      </p>
      {known >= 2
        ? <Sparkline points={goal.trend.points} width="fill" height={24} ariaLabel={`${goal.title}, last 24 hours`} describe={v => String(v)} />
        : <p className={styles.meta}>No 24 h trend yet.</p>}
      <p className={styles.meta}>{goal.why}</p>
      <p className={styles.meta}>{asOfText(goal.asOf)} · {goal.source}</p>
    </Card>
  );
}

export function FleetGoalCards({ visible = true, host }: Pick<Partial<PaneProps>, 'visible' | 'host'>) {
  const read = useQuery(goalScorecardQuery, { enabled: visible });
  const data = read.data;
  if (!data) {
    return read.error ? <CardNote tone="unknown">Fleet goals are unavailable right now.</CardNote> : <CardNote>Reading fleet goals</CardNote>;
  }
  const goals = Array.isArray(data.goals) ? data.goals : [];
  return (
    <section aria-label="Fleet goals" className={styles.fleet}>
      <h3 className={styles.headline}>Fleet goals</h3>
      {goals.length === 0
        ? <CardNote>No fleet goals yet. They appear once Phantom has recorded jobs, usage pools or releases.</CardNote>
        : goals.map(goal => <GoalCard key={goal.id} goal={goal} onEvidence={() => host?.openPane(goal.evidencePane)} />)}
    </section>
  );
}
