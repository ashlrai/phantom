/**
 * Leader presence, the pure half: when the Leader last ran a pass, when the next one is due and how many of
 * Mason's messages still wait for it. A pass is when the Leader reads the inbox, so this is the conversation's
 * "will I be heard, and when". It reads only the fleet runs document the pane already holds, with the same pass
 * clock the per-message "Seen" and "Waiting" chips use. A time no read holds stays unknown.
 */
import { annotateAck, seenCounts } from '../fleet-inbox/inbox-ack-model.js';
import { newestLeaderPassMs } from '../fleet/interject-ack-model.js';
import { LEADER_PASS_CADENCE_MS, nextPassEta } from '../fleet/next-pass-eta.js';
import { fleetInbox } from './thread-merge-model.js';
import { isFlagOnlyText, isStatusAskText } from './thread-noise-model.js';

/** A pass this far past its due time is no longer "late": nothing is reading the inbox. */
export const PASS_STALLED_MS = 30 * 60_000;

export type PresenceState = 'reading' | 'unknown' | 'due' | 'late' | 'stalled';

export interface LeaderPresenceView {
  state: PresenceState;
  /** The one line that answers "is the Leader reading". */
  headline: string;
  /** What that means for Mason's own messages, when there is something to say. */
  detail: string | null;
  /** How far through the pass interval the clock is, 0 to 1; null when the last pass is unknown. */
  progress: number | null;
  /** Mason's messages no pass has read yet; null when the pass clock is unknown. */
  waiting: number | null;
  /** The last pass as an ISO instant, for the hover title. */
  lastPassIso: string | null;
}

/** "under a minute", "6 min", "1 h 12 min": spans as a person says them. */
export function spanText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 90) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The newest leader pass in a fleet runs read as epoch ms; null when the read holds no usable pass age. */
export function newestPassMs(runs: unknown): number | null {
  if (!record(runs) || !Array.isArray(runs.leaders) || typeof runs.generatedAt !== 'string') return null;
  const leaders = runs.leaders.flatMap((value: unknown) => {
    const age = record(value) ? value.ageSeconds : undefined;
    return typeof age === 'number' || age === null ? [{ ageSeconds: age }] : [];
  });
  return newestLeaderPassMs(leaders, Date.parse(runs.generatedAt));
}

function waitingLine(waiting: number, sent: number, state: 'due' | 'late' | 'stalled'): string | null {
  if (waiting === 0) return sent > 0 ? 'Everything you sent has been read.' : null;
  const subject = waiting === 1 ? '1 message of yours' : `${waiting} of your messages`;
  const verb = waiting === 1 ? 'waits' : 'wait';
  return state === 'stalled' ? `${subject} ${waiting === 1 ? 'is' : 'are'} unread until a pass runs.` : `${subject} ${verb} for the next pass.`;
}

/**
 * `runs` is undefined while the first read is in flight and null when the server does not serve the route;
 * `failed` says the read errored. Either of the last two is "unknown", never "all read".
 */
export function leaderPresence(runs: unknown, failed: boolean, nowMs: number): LeaderPresenceView {
  const none = { detail: null, progress: null, waiting: null, lastPassIso: null };
  if (runs === undefined && !failed) return { state: 'reading', headline: 'Checking when the Leader last read the inbox…', ...none };
  if (!record(runs)) return { state: 'unknown', headline: 'Leader pass time unknown', ...none, detail: 'The fleet read did not answer, so there is no telling when your messages are read.' };
  const last = newestPassMs(runs);
  if (last === null) return { state: 'unknown', headline: 'Leader pass time unknown', ...none, detail: 'No leader pass is recorded in the fleet read.' };

  const entries = fleetInbox(runs).filter(entry => entry.source !== 'system' && !isFlagOnlyText(entry.text) && !isStatusAskText(entry.text));
  const counts = seenCounts(annotateAck(entries.map(entry => ({ ...entry, priority: '—' })), runs, nowMs));
  const since = Math.max(0, nowMs - last);
  const eta = nextPassEta(last, nowMs);
  const lateBy = nowMs - (last + LEADER_PASS_CADENCE_MS);
  const state: 'due' | 'late' | 'stalled' = eta.kind !== 'overdue' ? 'due' : lateBy > PASS_STALLED_MS ? 'stalled' : 'late';
  const headline = state === 'stalled' ? `No leader pass for ${spanText(since)}`
    : state === 'late' ? `Leader pass is ${spanText(lateBy)} late · last one ${spanText(since)} ago`
      : `Last leader pass ${spanText(since)} ago · ${lateBy >= 0 ? 'next one due now' : `next in about ${spanText(-lateBy + 59_999)}`}`;
  return {
    state, headline,
    detail: waitingLine(counts.waiting, counts.waiting + counts.seen, state),
    progress: Math.min(1, since / LEADER_PASS_CADENCE_MS),
    waiting: counts.waiting,
    lastPassIso: new Date(last).toISOString(),
  };
}
