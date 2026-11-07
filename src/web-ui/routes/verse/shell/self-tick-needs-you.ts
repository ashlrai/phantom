/**
 * routes/verse/shell/self-tick-needs-you.ts — the Needs-you row for the host
 * self-tick timer. `ashlr fleet self-tick` records every pass in
 * queue/self-tick-last.json; this producer turns the
 * GET /api/verse/fleet/self-tick projection into the one row Mason needs when
 * the fleet is not managing itself: never installed, an unreadable record, a
 * stopped timer, or a failed step. A healthy record — a fresh pass with no
 * failed step, including a 'busy' skip — shows nothing, and a missing or
 * failed fetch shows nothing too (never an error banner).
 */
import type { FleetNeedsYouItem } from './fleet-needs-you.js';
import type { SelfTickLastView } from './self-tick-query.js';

export const SELF_TICK_SCHEDULE_COMMAND = 'ashlr fleet self-tick-schedule --write --load';
export const SELF_TICK_LAST_COMMAND = 'ashlr fleet self-tick --last';

/**
 * Mirrors 2 × SELF_TICK_MAX_INTERVAL_SECONDS (core/fleet/self-tick-schedule.ts)
 * — kept local so the web bundle never imports server code. An installed
 * timer ticks at least every 3600 s, so a record older than two of those
 * intervals means the timer stopped.
 */
const SELF_TICK_STALE_SECONDS = 7_200;

/** Compact age for the stale row, the same buckets fleet-digest uses. */
const ageText = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s} s` : s < 3_600 ? `${Math.floor(s / 60)} min` : s < 86_400 ? `${Math.floor(s / 3_600)} h` : `${Math.floor(s / 86_400)} d`;
};

const row = (
  id: string,
  severity: FleetNeedsYouItem['severity'],
  title: string,
  detail: string,
  nextStep: string,
  command: string,
): FleetNeedsYouItem => ({
  id, severity, title, detail, nextStep, target: 'fleet',
  open: { kind: 'terminal', command },
});

export function selfTickNeedsYou(
  last: SelfTickLastView | null | undefined,
  nowMs: number = Date.now(),
): FleetNeedsYouItem[] {
  if (last === undefined) return [];
  if (last === null) {
    return [row('self-tick-never-run', 'urgent',
      'Self-tick has never run',
      'No self-tick record exists in the runs dir — the self-management timer was never installed or never finished a pass.',
      'Installs and activates the host timer',
      SELF_TICK_SCHEDULE_COMMAND)];
  }
  if (last.state === 'unreadable') {
    return [row('self-tick-unreadable', 'attention',
      'Self-tick record is unreadable',
      'queue/self-tick-last.json exists but will not parse, so nothing can say when the timer last ran.',
      'Prints the stored record and its parse problem',
      SELF_TICK_LAST_COMMAND)];
  }
  // ageSeconds was stamped when the record was fetched; re-age it against the
  // drawer's clock so a borderline record cannot hide while the drawer sits open.
  const atMs = Date.parse(last.at);
  const live = Number.isFinite(atMs) && Number.isFinite(nowMs)
    ? Math.floor((nowMs - atMs) / 1_000) : Number.NEGATIVE_INFINITY;
  const ageSeconds = Math.max(0, last.ageSeconds, live);
  const dryRun = last.mode === 'dry-run' ? ' (dry run)' : '';
  if (ageSeconds > SELF_TICK_STALE_SECONDS) {
    return [row('self-tick-stale', 'urgent',
      `Self-tick last ran ${ageText(ageSeconds)} ago${dryRun}`,
      'An installed timer ticks at least every hour — a record this old means the timer stopped.',
      'Re-installs and activates the host timer',
      SELF_TICK_SCHEDULE_COMMAND)];
  }
  if (last.failedSteps.length > 0) {
    return [row('self-tick-failed', 'urgent',
      `Self-tick step failed: ${last.failedSteps.join(', ')}${dryRun}`,
      'The last recorded pass ran, but at least one step exited nonzero.',
      'Prints the recorded run with each step report',
      SELF_TICK_LAST_COMMAND)];
  }
  return [];
}
