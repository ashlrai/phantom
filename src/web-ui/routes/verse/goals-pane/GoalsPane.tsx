/**
 * routes/verse/goals-pane/GoalsPane.tsx: every open goal, its progress, its
 * next milestone and the mission state, beside the Leader thread. Goals change
 * through `ashlr goals`; the only write here is a steering line to the Leader. Each source fails on
 * its own. All text is untrusted and rendered as React text, never HTML.
 */
import { useMemo } from 'react';
import { bindGoalMetrics, type GoalMetricId, type MetricReading } from '../../../../core/fleet/goal-metrics.js';
import { useQuery } from '../../../data/hooks.js';
import { goalsQuery, visionMissionQuery } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { readMergeSpeed } from '../fleet-merges/fleet-merges-model.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { mergeBacklogQuery } from '../fleet-merges/merge-backlog-queries.js';
import { GoalSteer } from './GoalSteer.js';
import { GoalMetric, previousDayValue } from './GoalMetric.js';
import { goalLine, goalsHeadline, openGoals } from './goals-pane-model.js';
import styles from './goals-pane.module.css';

export function GoalsPane({ visible = true }: { visible?: boolean }) {
  const goals = useQuery(goalsQuery, { enabled: visible });
  const mission = useQuery(visionMissionQuery, { enabled: visible });

  const merges = useQuery(fleetMergesQuery, { enabled: visible });
  const backlog = useQuery(mergeBacklogQuery, { enabled: visible });
  const metrics = useMemo(() => {
    const readings: Partial<Record<GoalMetricId, MetricReading>> = {};
    const now = Date.now();
    const generatedAt = (d: unknown) => (d && typeof d === 'object' && 'generatedAt' in d && typeof d.generatedAt === 'string' && d.generatedAt ? d.generatedAt : null);
    if (merges.data !== undefined) {
      const value = readMergeSpeed(merges.data).perHour;
      readings['merges-per-hour'] = { value, observedAt: generatedAt(merges.data), previous24h: previousDayValue('merges-per-hour', value, now) };
    }
    if (backlog.data?.source === 'ok') {
      const value = backlog.data.counts.mergeState.DIRTY ?? 0;
      readings['open-dirty-prs'] = { value, observedAt: generatedAt(backlog.data), previous24h: previousDayValue('open-dirty-prs', value, now) };
    }
    return bindGoalMetrics(openGoals(goals.data ?? []), readings, now);
  }, [goals.data, merges.data, backlog.data]);

  const goalsFailed = Boolean(goals.error) && goals.data === undefined;
  const missionFailed = Boolean(mission.error) && mission.data === undefined;
  const lines = openGoals(goals.data ?? []).map(goalLine);
  const loading = goals.data === undefined && !goalsFailed;

  return (
    <div className={styles.root}>
      {goals.data ? <h2 className={styles.headline}>{goalsHeadline(goals.data)}</h2> : null}
      <p className={styles.mission}>
        {missionFailed
          ? 'Mission state unavailable'
          : mission.data ? `Mission state: ${mission.data.state}` : 'Mission state loading'}
      </p>
      {goalsFailed ? <CardNote tone="danger">{goals.error?.message ?? 'Could not read goals.'}</CardNote> : null}
      {loading ? <CardNote>Loading goals</CardNote> : null}
      {goals.data && lines.length === 0 ? (
        <CardNote>No open goals. Add one with `ashlr goals add "&lt;objective&gt;"`.</CardNote>
      ) : null}
      {lines.map(line => (
        <Card key={line.id} title={line.objective} caption={line.status}>
          <div className={styles.progressRow}>
            <div
              className={styles.track}
              role="progressbar"
              aria-label={`Progress: ${line.objective}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={line.percent ?? undefined}
              aria-valuetext={line.percentText}
            >
              <div className={styles.fill} style={{ width: `${line.percent ?? 0}%` }} />
            </div>
            <span className={styles.percent}>{line.percentText}</span>
          </div>
          <GoalMetric metric={metrics[line.id]!} />
          <p className={styles.meta}>Next: {line.nextMilestone ?? 'none open'}</p>
          <p className={styles.meta}>{line.milestoneCounts}</p>
          <GoalSteer goal={line} />
        </Card>
      ))}
    </div>
  );
}
