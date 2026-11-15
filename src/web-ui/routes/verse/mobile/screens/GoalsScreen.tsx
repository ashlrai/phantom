/**
 * routes/verse/mobile/screens/GoalsScreen.tsx — the Goals pane on the phone:
 * the same reads (goalsQuery, visionMissionQuery, useGoalMetrics) and model
 * functions (openGoals, goalLine, goalsHeadline) the desktop pane uses.
 * Nothing is re-derived; the metric column keeps the pane's live / stale /
 * unknown wording. Remote mode: none of these routes is on the gateway's
 * allowlist, so the screen says so instead of failing reads. Read-only:
 * the desktop's Leader steering stays on the Mac. All text is untrusted.
 */
import { readFailureReason } from '../../../../data/client.js';
import { refetchQuery } from '../../../../data/cache.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { goalsQuery, visionMissionQuery, type QueryDef } from '../../../../data/queries.js';
import { fleetMergesQuery } from '../../fleet-merges/fleet-merges-queries.js';
import { mergeBacklogQuery } from '../../fleet-merges/merge-backlog-queries.js';
import { deltaText, metricValueText, useGoalMetrics } from '../../goals-pane/GoalMetric.js';
import { goalLine, goalsHeadline, openGoals } from '../../goals-pane/goals-pane-model.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { useMobile } from '../mobile-context.js';
import { Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Meter, ui, type Tone } from '../ui-parts.js';
import styles from './GoalsScreen.module.css';

const POLL_MS = 30_000;

const STATUS_TONE: Record<string, Tone> = { active: 'running', planning: 'info', paused: 'warning' };
const METRIC_TONE: Record<string, Tone> = { live: 'success', stale: 'warning', unknown: 'neutral' };

/** Pull-to-refresh: the screen's own reads, forced fresh. */
export function refreshGoalsScreen(): Promise<unknown> {
  const queries: QueryDef<unknown>[] = [goalsQuery, visionMissionQuery, fleetMergesQuery, mergeBacklogQuery];
  return Promise.allSettled(queries.map((q) => refetchQuery(q.key, () => q.fetch(), true)));
}

export function GoalsScreen() {
  const { navigate } = useMobile();
  const remote = isRemoteMobileMode();
  const goals = useQuery(goalsQuery, { enabled: !remote });
  const mission = useQuery(visionMissionQuery, { enabled: !remote });
  const metrics = useGoalMetrics(goals.data, !remote);
  const refetchGoals = useRefetch(goalsQuery);
  const refetchMission = useRefetch(visionMissionQuery);
  const refetchMerges = useRefetch(fleetMergesQuery);
  const refetchBacklog = useRefetch(mergeBacklogQuery);
  const retry = () => { refetchGoals(); refetchMission(); refetchMerges(); refetchBacklog(); };
  usePollWhileVisible(retry, POLL_MS, { enabled: !remote });

  const goalsFailed = Boolean(goals.error) && goals.data === undefined;
  const missionFailed = Boolean(mission.error) && mission.data === undefined;
  const lines = openGoals(goals.data ?? []).map(goalLine);
  const loading = goals.data === undefined && !goalsFailed;

  let body;
  if (remote) {
    body = <EmptyState title="Goals are not available on the phone." body="The gateway this phone pairs through does not allow that read. Open Phantom on your Mac's network." />;
  } else if (goalsFailed) {
    body = <ErrorState title="Couldn’t load goals" reason={readFailureReason(goals.error)} onRetry={retry} />;
  } else if (loading) {
    body = <SkeletonList rows={3} label="Loading goals" />;
  } else {
    body = (
      <>
        {goals.data ? <p className={styles.headline}>{goalsHeadline(goals.data)}</p> : null}
        <p className={styles.mission}>
          {missionFailed
            ? 'Mission state unavailable'
            : mission.data ? `Mission state: ${mission.data.state}` : 'Mission state loading'}
        </p>
        {lines.length === 0 ? (
          <EmptyState title="No open goals." body={'Add one with `ashlr goals add "<objective>"`.'} />
        ) : (
          <div className={ui.group}>
            {lines.map((line) => {
              const metric = metrics[line.id]!;
              return (
                <div key={line.id} className={styles.goal}>
                  <div className={styles.head}>
                    <span className={styles.objective}>{line.objective}</span>
                    <Badge tone={STATUS_TONE[line.status] ?? 'neutral'}>{line.status}</Badge>
                  </div>
                  <Meter label={`Progress: ${line.objective}`} percent={line.percent} valueText={line.percentText} />
                  <p className={styles.metric} data-state={metric.state}>
                    <span className={styles.metricValue}>{metricValueText(metric)}</span>
                    <span>{deltaText(metric)}</span>
                    <Badge tone={METRIC_TONE[metric.state] ?? 'neutral'}>{metric.state}</Badge>
                    {metric.reason ? <span>{metric.reason}</span> : null}
                  </p>
                  <p className={styles.meta}>Next: {line.nextMilestone ?? 'none open'}</p>
                  <p className={styles.meta}>{line.milestoneCounts}</p>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <Screen title="Goals" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={remote ? undefined : refreshGoalsScreen} label="Goals">
      {body}
    </Screen>
  );
}
