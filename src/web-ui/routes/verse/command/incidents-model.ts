import type { FleetRuns } from '../ops/ops-runs-model.js';
import { formatDateTime } from '../../../components/format/locale-format.js';

export interface Incident {
  id: string;
  severity: 'incident' | 'warn';
  title: string;
  detail: string;
  fix: string | null;
}

const MINUTE = 60_000;
// A weekly window never goes down by burning, so a low reading during an exhaustion hold is a reset.
export const RESET_IGNORED_USED_PCT_MAX = 25;
export const formatMinutes = (ms: number): string => `${Math.max(0, Math.floor(ms / MINUTE))} min`;
const time = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
// A failed leader pass logs `LEADER <executor> rc=N`; the rc value itself is
// unreliable, so the row shape — not the number — marks the failure. Any other
// LEADER row is a healthy pass.
const LEADER_FAILED = /^\S+\s+rc=/;

export function incidents(runs: FleetRuns | null, nowMs: number): Incident[] {
  if (!runs || !Number.isFinite(nowMs)) return [];
  const result: Incident[] = [];
  const leaderRows = runs.events.flatMap((event, index) => {
    const at = time(event.at);
    return /^LEADER$/i.test(event.kind) && at !== null && at <= nowMs
      ? [{ at, atText: event.at, index, failed: LEADER_FAILED.test(event.text) }] : [];
  }).sort((a, b) => (b.at - a.at) || (b.index - a.index));
  let leaderStreak = 0;
  while (leaderRows[leaderStreak]?.failed) leaderStreak++;
  if (leaderStreak > 0) {
    const lastHealthy = leaderRows[leaderStreak];
    const anchor = lastHealthy?.at ?? leaderRows[leaderRows.length - 1]!.at;
    if (nowMs - anchor >= 30 * MINUTE) {
      const pass = lastHealthy ? `last healthy pass ${lastHealthy.atText} (${formatMinutes(nowMs - lastHealthy.at)} ago)` : 'no healthy pass in the retained tail';
      result.push({ id: 'executor-down', severity: 'incident', title: 'Leader executor is failing', detail: `${leaderStreak} failed ${leaderStreak === 1 ? 'row' : 'rows'} in a row; ${pass}.`, fix: null });
    }
  }
  const activity = runs.events.filter(event => /LAUNCH|PUBLISH|CLAIM|START/i.test(event.kind));
  const activityTimes = activity.map(event => time(event.at));
  // If no activity is in the retained tail, its oldest event is the only
  // evidence of how long we have observed inactivity. An empty tail is unknown.
  const anchors = activity.length ? activityTimes : runs.events.map(event => time(event.at));
  const validAnchors = anchors.filter((at): at is number => at !== null && at <= nowMs);
  const anchor = validAnchors.length && !activityTimes.includes(null) && !activityTimes.some(at => at !== null && at > nowMs)
    ? (activity.length ? Math.max(...validAnchors) : Math.min(...validAnchors)) : null;
  if (anchor !== null && nowMs - anchor >= 30 * MINUTE && runs.publishesLastHour.length === 0
    && (runs.mergesLastHour.count === 0 || runs.mergesLastHour.count === null) && runs.sources.runsDir === 'healthy') {
    result.push({ id: 'stall', severity: 'incident', title: 'Fleet stalled', detail: `No launches, publishes or merges for ${formatMinutes(nowMs - anchor)}.`, fix: 'Run the leader: check ~/.ashlr-runs/queue/dispatch-events.log and the lane holds below.' });
  }
  const tick = time(runs.lastTick);
  if (tick !== null && nowMs - tick > 20 * MINUTE) {
    result.push({ id: 'tick-stale', severity: 'incident', title: 'Dispatcher tick is stale', detail: `dispatchd last ticked ${formatMinutes(nowMs - tick)} ago`, fix: null });
  }
  if (runs.claudeLane && /^down/i.test(runs.claudeLane)) {
    result.push({ id: 'claude-lane', severity: 'incident', title: 'Claude lane is down', detail: runs.claudeLane, fix: null });
  }
  const personal = runs.codexPersonal;
  const personalAsOf = time(personal?.asOf ?? null);
  const personalLane = runs.lanes.find(lane => lane.lane === 'codex-personal' && lane.held
    && /autobackoff|usage|limit|exhaust/i.test(lane.heldReason ?? ''));
  const resetIgnored = personalLane && personal && typeof personal.usedPct === 'number'
    && Number.isFinite(personal.usedPct) && personal.usedPct <= RESET_IGNORED_USED_PCT_MAX
    && personalAsOf !== null && personalAsOf <= nowMs;
  if (resetIgnored) {
    const asOf = formatDateTime(personalAsOf, 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    result.push({ id: 'reset-ignored', severity: 'incident', title: 'Personal Codex has reset but its lane is still held', detail: `codex-personal reads ${personal.usedPct}% as of ${asOf} (local) · ${personalLane.queued} jobs are waiting on the hold`, fix: 'Release the hold in Fleet ▸ Lanes, or wait for the hold to expire' });
  }
  if (runs.switches.some(value => value.endsWith('HOLD'))) {
    result.push({ id: 'hold', severity: 'warn', title: 'HOLD is on', detail: 'HOLD is on: nothing launches until it is removed.', fix: null });
  }
  if (runs.paused === true) result.push({ id: 'paused', severity: 'warn', title: 'Dispatcher paused', detail: 'The dispatcher is paused.', fix: null });
  const held = runs.lanes.filter(lane => lane.held && (lane.target > 0 || (resetIgnored && lane === personalLane)));
  if (held.length) {
    const names = held.map(lane => {
      const reason = lane.heldReason?.trim().slice(0, 80);
      return reason ? `${lane.lane} (${reason})` : lane.lane;
    }).join(' · ');
    result.push({ id: 'held-lanes', severity: 'warn', title: 'Lanes held', detail: `${held.length} ${held.length === 1 ? 'lane' : 'lanes'} held: ${names}`, fix: null });
  }
  const starved = runs.lanes.filter(lane => lane.running === 0 && lane.target > 0 && !lane.held && lane.queued > 0);
  if (starved.length) {
    result.push({ id: 'starved', severity: 'warn', title: 'Lanes idle', detail: `idle with work queued: ${starved.map(lane => `${lane.lane} (${lane.queued} queued)`).join(' · ')}`, fix: null });
  }
  return result;
}
