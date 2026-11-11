/**
 * routes/verse/goals-pane/GoalsPane.tsx: every open goal, its progress, its
 * next milestone and the mission state, beside the Leader thread. Goals change
 * through `ashlr goals` or the Add form; the only other write here is a
 * steering line to the Leader. Each source fails on
 * its own. All text is untrusted and rendered as React text, never HTML.
 */
import { useMemo } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { goalsQuery, visionMissionQuery } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { paneLinkUrl } from '../dock/pane-link.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { repoBacklogView } from '../fleet-merges/repo-backlog-model.js';
import { repoBacklogQuery } from '../fleet-merges/repo-backlog-queries.js';
import { GoalAddForm } from './GoalAddForm.js';
import { GoalSteer } from './GoalSteer.js';
import { GoalMetric, useGoalMetrics } from './GoalMetric.js';
import { goalLine, goalsHeadline, openGoals } from './goals-pane-model.js';
import { prBacklogGoal, prBacklogTotal } from './pr-backlog-goal-model.js';
import styles from './goals-pane.module.css';

// First known backlog total this session: the "since you opened Phantom" baseline.
let sessionBacklogBaseline: number | null = null;
export function resetPrBacklogBaseline(): void { sessionBacklogBaseline = null; }

export function GoalsPane({ visible = true, host }: Pick<Partial<PaneProps>, 'visible' | 'host'>) {
  const goals = useQuery(goalsQuery, { enabled: visible });
  const mission = useQuery(visionMissionQuery, { enabled: visible });

  const metrics = useGoalMetrics(goals.data, visible);
  const prBacklog = useQuery(repoBacklogQuery, { enabled: visible });
  const prGoal = useMemo(() => {
    const rows = prBacklog.data ? repoBacklogView(prBacklog.data, Date.now()).rows : undefined;
    const total = prBacklogTotal(rows);
    const previous = sessionBacklogBaseline;
    if (total !== null && sessionBacklogBaseline === null) sessionBacklogBaseline = total;
    return prBacklogGoal(rows, previous);
  }, [prBacklog.data]);

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
      <p className={styles.metric} data-state={prGoal.tone}>
        <a href={paneLinkUrl('fleet-merges', null, false) ?? undefined} onClick={event => { event.preventDefault(); host?.openPane('fleet-merges'); }}>{prGoal.label}</a>
        <span className={styles.metricValue}>{prGoal.value}</span>
        {prGoal.trend ? <span>{prGoal.trend}</span> : null}
      </p>
      <GoalAddForm />
      {goalsFailed ? <CardNote tone="danger">{goals.error?.message ?? 'Could not read goals.'}</CardNote> : null}
      {loading ? <CardNote>Loading goals</CardNote> : null}
      {goals.data && lines.length === 0 ? (
        <CardNote>No open goals. Add one above, or with `ashlr goals add "&lt;objective&gt;"`.</CardNote>
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
