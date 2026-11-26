/**
 * routes/verse/goals-pane/FleetGoalCards.tsx: the fleet's self-managed goals,
 * one card each, behind first: the number now with an up, down or flat mark,
 * the target, one sentence on why the goal matters, a 24 h and a 7 d trend
 * line drawn against the target, and one action ("See evidence") that opens
 * the pane behind the number. Built only on `phm goals --json`
 * (core/fleet/goal-scorecard.ts, `fleet.goal-scorecard.v3`). Fails on its
 * own; unknown is shown as unknown with its reason, never as zero. One column
 * that wraps, so it reads at 390 px; the phone Goals screen mounts it too.
 */
import type { FleetGoal, GoalScorecard, GoalStatus, GoalTrend } from '../../../../core/fleet/goal-scorecard.js';
import { TREND_MARK, type TrendDirection } from '../../../../core/fleet/goal-trend.js';
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
const RANK: Record<GoalStatus, number> = { behind: 0, unknown: 1, 'on-track': 2 };
const DIRECTION: Record<TrendDirection, string> = { up: 'rising', down: 'falling', flat: 'steady', unknown: 'no trend yet' };

/** Behind first, then unknown, then on track; the API already orders, this keeps the view honest if it does not. */
export function goalsInOrder(goals: readonly FleetGoal[]): FleetGoal[] {
  return goals.map((g, i) => [g, i] as const).sort(([a, i], [b, j]) => (RANK[a.status] ?? 1) - (RANK[b.status] ?? 1) || i - j).map(([g]) => g);
}

/** "2 behind · 3 on track · 1 unknown", or a plain sentence when nothing is known. */
export function goalsSummary(goals: readonly FleetGoal[]): string {
  const count = (s: GoalStatus) => goals.filter(g => g.status === s).length;
  if (goals.length && count('unknown') === goals.length) return 'No goal has a reading yet.';
  return ([['behind', 'behind'], ['on-track', 'on track'], ['unknown', 'unknown']] as const)
    .filter(([s]) => count(s) > 0).map(([s, words]) => `${count(s)} ${words}`).join(' · ');
}

function asOfText(asOf: string | null | undefined): string {
  if (!asOf) return 'As of: unknown';
  const at = new Date(asOf);
  return `As of ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

function TrendLine({ goal, span, trend }: { goal: FleetGoal; span: '24 h' | '7 d'; trend: GoalTrend | undefined }) {
  const points = Array.isArray(trend?.points) ? trend.points : [];
  const known = points.filter(p => p !== null).length;
  const label = `${goal.title}, last ${span === '24 h' ? '24 hours' : '7 days'}`;
  return (
    <figure className={styles.trend}>
      <figcaption className={styles.meta}>{span}: {DIRECTION[trend?.direction ?? 'unknown'] ?? DIRECTION.unknown}</figcaption>
      {known >= 2
        ? <Sparkline points={points} width="fill" height={28} ariaLabel={label} describe={v => String(v)} target={trend?.target ?? null} />
        : <p className={styles.meta}>No {span} trend yet.</p>}
    </figure>
  );
}

/** ↑, ↓ or → with the words for screen readers; "?" when there is no trend yet. */
function TrendMark({ direction }: { direction: TrendDirection | undefined }) {
  const d = direction && direction in TREND_MARK ? direction : 'unknown';
  return <span className={styles.trendMark} data-trend={d} role="img" aria-label={`Trend: ${DIRECTION[d]}`} title={DIRECTION[d]}>{TREND_MARK[d]}</span>;
}

/** `onEvidence` is absent where no pane can open (the phone), so no dead button is drawn. */
function GoalCard({ goal, onEvidence }: { goal: FleetGoal; onEvidence?: (() => void) | undefined }) {
  const parts = Array.isArray(goal.parts) ? goal.parts : [];
  return (
    <Card title={goal.title} caption={<span className={styles.badge} data-status={goal.status}>{STATUS[goal.status] ?? 'Unknown'}</span>}
      actions={onEvidence ? <button type="button" onClick={onEvidence}>See evidence</button> : undefined}>
      <p className={styles.metric} data-state={goal.status}>
        <span className={styles.metricValue}>{goal.currentText ?? 'unknown'}</span>
        <TrendMark direction={goal.trend} />
        <span>Target: {goal.targetText}</span>
      </p>
      {goal.why ? <p className={styles.why}>{goal.why}</p> : null}
      <div className={styles.trends}>
        <TrendLine goal={goal} span="24 h" trend={goal.trend24h} />
        <TrendLine goal={goal} span="7 d" trend={goal.trend7d} />
      </div>
      {parts.length ? <p className={styles.meta}>{parts.map(p => `${p.name} ${p.value}`).join(' · ')}</p> : null}
      {goal.next ? <p className={styles.meta}>Next: {goal.next}</p> : null}
      <p className={styles.meta}>{goal.status === 'unknown' ? `Unknown: ${goal.reason}` : goal.reason}</p>
      <p className={styles.meta}>{asOfText(goal.updated_at)} · {goal.source}</p>
    </Card>
  );
}

/** The leader's current bets; a missing vision file says so in plain words instead of showing nothing. */
function FleetBets({ card }: { card: GoalScorecard }) {
  const bets = Array.isArray(card.bets) ? card.bets : [];
  if (!bets.length) return card.bets_reason ? <p className={styles.meta}>Current bets: none. {card.bets_reason}</p> : null;
  return (
    <section aria-label="Current bets">
      <h4 className={styles.headline}>Current bets</h4>
      <ul>
        {bets.map(b => <li key={b.id} className={styles.meta}>{b.id}{b.pool ? ` (${b.pool}${b.repo ? `, ${b.repo}` : ''})` : ''}: {b.goal}</li>)}
      </ul>
      <p className={styles.meta}>{asOfText(card.as_of ?? null)} · {card.bets_source ?? 'unknown'}</p>
    </section>
  );
}

export function FleetGoalCards({ visible = true, host }: Pick<Partial<PaneProps>, 'visible' | 'host'>) {
  const read = useQuery(goalScorecardQuery, { enabled: visible });
  const data = read.data;
  if (!data) {
    return read.error ? <CardNote tone="unknown">Fleet goals are unavailable right now.</CardNote> : <CardNote>Reading fleet goals</CardNote>;
  }
  const goals = goalsInOrder(Array.isArray(data.goals) ? data.goals : []);
  return (
    <section aria-label="Fleet goals" className={styles.fleet}>
      <h3 className={styles.headline}>Fleet goals</h3>
      {goals.length === 0
        ? <CardNote>No fleet goals yet. They appear once Phantom has recorded jobs, usage pools or releases.</CardNote>
        : <>
          {data.end_state_text ? <p className={styles.mission}>{data.end_state_text}</p> : null}
          {data.endState ? <p className={styles.mission}>{data.endState}</p> : null}
          <p className={styles.meta}>{goalsSummary(goals)}</p>
          {goals.map(goal => <GoalCard key={goal.id} goal={goal} onEvidence={host ? () => host.openPane(goal.evidencePane) : undefined} />)}
          <FleetBets card={data} />
        </>}
    </section>
  );
}
