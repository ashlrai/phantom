/**
 * What is stopping work right now, for Home's Blocked card. Pure: it only arranges two reads other screens already
 * make (the live fleet snapshot's repo holds and parked count, and the Lanes pane's launch-stall view). A source that
 * is missing or unreadable is listed in `unknown` with its reason; it never counts as "nothing blocked".
 */
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import type { LaunchStallViewV1 } from '../../../../core/verse/fleet-launch-stall-api.js';

export interface BlockedHold { repo: string; reason: string; until: string | null }
export interface BlockedLane { lane: string; waiting: number; oldestMinutes: number }
export interface BlockedView {
  /** Why no job is launching, in the dispatcher's own words; null when launches are not blocked. */
  launch: { line: string; detail: string[] } | null;
  /** Queued work with no launch for this long; null when the dispatcher is launching or its log is unread. */
  stall: { minutes: number; queued: number } | null;
  holds: BlockedHold[];
  lanes: BlockedLane[];
  /** Parked jobs; null when the count is unknown (it is then also named in `unknown`). */
  parked: number | null;
  /** One line per reading that could not be made. */
  unknown: string[];
  headline: string;
  /** Something is recorded as blocked. False with a non-empty `unknown` means "not known to be clear". */
  blocked: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Only a v1 snapshot with a summary is a live reading; an older server or an error body is not. */
export function liveOf(data: unknown): FleetLiveSnapshotV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const live = data as Partial<FleetLiveSnapshotV1>;
  return live.v === 1 && typeof live.generatedAt === 'string' && live.summary !== null && typeof live.summary === 'object' ? live as FleetLiveSnapshotV1 : null;
}

/** `live` and `stall` are null when that read failed or has not arrived; `stallAbsent` when this build has no launch-stall route. */
export function blockedView(live: FleetLiveSnapshotV1 | null, stall: LaunchStallViewV1 | null, stallAbsent = false): BlockedView {
  const unknown: string[] = [];
  const holdRows = live && Array.isArray(live.blockedHolds) && live.blockedHolds.every(hold =>
    hold !== null && typeof hold === 'object' && typeof hold.repo === 'string' && hold.repo.trim().length > 0
    && typeof hold.reason === 'string' && hold.reason.trim().length > 0
    && (hold.until === null || typeof hold.until === 'string')) ? live.blockedHolds : null;
  if (!holdRows) unknown.push(live ? 'Repo holds: unknown (the hold list could not be read).' : 'Repo holds and parked jobs: unknown (the live fleet status could not be read).');
  const parked = live && typeof live.summary.parked === 'number' && Number.isSafeInteger(live.summary.parked) && live.summary.parked >= 0 ? live.summary.parked : null;
  if (live && parked === null) unknown.push('Parked jobs: unknown (the count was not recorded).');

  const why = stall?.why && stall.why.code !== 'none' ? stall.why : null;
  // The dispatcher could not say why: that is a missing reading, not a block.
  const launch = why && why.code !== 'unknown' ? { line: why.line, detail: why.detail } : null;
  if (why?.code === 'unknown') unknown.push(`Launches: unknown (${why.line})`);
  const stalled = stall?.stall?.stalled && stall.stall.minutes !== null && stall.stall.lastQ !== null
    ? { minutes: Math.round(stall.stall.minutes), queued: stall.stall.lastQ } : null;
  if (!stall && !stallAbsent) unknown.push('Launches and waiting jobs: unknown (the dispatcher status could not be read).');
  else if (stall && stall.source === 'unavailable' && stall.stall === null) unknown.push('Launches: unknown (the dispatcher log could not be read on this computer).');
  const lanes = (stall?.lanes ?? []).map(group => ({ lane: group.lane, waiting: group.jobs.length, oldestMinutes: Math.round(Math.max(...group.jobs.map(job => job.ageMinutes))) }));

  const holds = holdRows ?? [];
  const waiting = lanes.reduce((sum, lane) => sum + lane.waiting, 0);
  const parts = [
    holds.length ? `${plural(holds.length, 'repo')} held` : '',
    launch || stalled ? 'launches paused' : '',
    waiting ? `${plural(waiting, 'job')} waiting in ${plural(lanes.length, 'lane')}` : '',
    parked ? `${parked} parked` : '',
  ].filter(Boolean);
  const headline = parts.length ? `Blocked: ${parts.join(', ')}.`
    : unknown.length ? 'Nothing is recorded as blocked, but not every reading could be made.' : 'Nothing is blocked.';
  return { launch, stall: stalled, holds, lanes, parked, unknown, headline, blocked: parts.length > 0 };
}

/** When a hold lifts. No end time is "until cleared"; an unparseable one is unknown, never a guessed time. */
export function holdUntil(until: string | null, now: number = Date.now()): string {
  if (until === null) return 'until cleared';
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return 'until an unknown time';
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return `until ${sameDay ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}
