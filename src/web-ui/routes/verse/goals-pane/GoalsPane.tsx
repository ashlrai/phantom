/**
 * routes/verse/goals-pane/GoalsPane.tsx: every open goal, its progress, its
 * next milestone and the mission state, beside the Leader thread. Read-only:
 * goals change through `ashlr goals`, never from here. Each source fails on
 * its own. All text is untrusted and rendered as React text, never HTML.
 */
import { useQuery } from '../../../data/hooks.js';
import { goalsQuery, visionMissionQuery } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { goalLine, goalsHeadline, openGoals } from './goals-pane-model.js';
import styles from './goals-pane.module.css';

export function GoalsPane({ visible = true }: { visible?: boolean }) {
  const goals = useQuery(goalsQuery, { enabled: visible });
  const mission = useQuery(visionMissionQuery, { enabled: visible });

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
          <p className={styles.meta}>Next: {line.nextMilestone ?? 'none open'}</p>
          <p className={styles.meta}>{line.milestoneCounts}</p>
        </Card>
      ))}
    </div>
  );
}
