/**
 * routes/verse/leader-thread/leader-health-model.ts: the pure half of the
 * notice above the Leader reply box that says the Leader's own passes are
 * failing. The read is GET /api/verse/leader/health, the fleet.leader-health.v1
 * document `phm fleet leader-health --json` prints.
 *
 * Nothing is guessed. A notice is drawn only from a counted failure: a read
 * that failed, a body of another shape, a log with no pass in it and a count
 * of zero all draw nothing (the presence line under the box already says when
 * the last pass ran). One failed pass is a warning; two or more in a row, the
 * count at which the command itself exits 1, means Mason is not being read.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const LEADER_HEALTH_API = '/api/verse/leader/health';
export const LEADER_HEALTH_COMMAND = 'phm fleet leader-health';
/** The server shares one reading for 15 s; the notice asks once a minute while the pane is on screen. */
export const LEADER_HEALTH_POLL_MS = 60_000;
/** From this many failed passes in a row the Leader is treated as not reading. */
export const LEADER_DOWN_FAILURES = 2;
const MAX_CAUSE = 160;

export interface LeaderHealthRead {
  /** Passes failed in a row; null when the log could not say. */
  failures: number | null;
  /** Hours since a pass succeeded; null when the log holds no good pass. */
  hoursSinceSuccess: number | null;
  /** The first line the failing pass wrote; null when none was read. */
  cause: string | null;
}

/** Null for anything that is not the document: the notice then draws nothing. */
export function narrowLeaderHealth(raw: unknown): LeaderHealthRead | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (body.schema !== 'fleet.leader-health.v1') return null;
  const whole = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  const hours = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  // One line, whatever the file held.
  const cause = typeof body.cause === 'string' ? body.cause.replace(/\s+/g, ' ').trim().slice(0, MAX_CAUSE) : '';
  return { failures: whole(body.consecutiveFailures), hoursSinceSuccess: hours(body.hoursSinceLastSuccess), cause: cause || null };
}

export const leaderHealthQuery: QueryDef<LeaderHealthRead | null> = {
  key: 'verse-leader-health',
  fetch: async signal => narrowLeaderHealth(await apiGet<unknown>(LEADER_HEALTH_API, signal)),
};

export interface LeaderHealthNotice {
  /** `failed`: one pass failed. `down`: two or more in a row. `recovered`: passes succeed again after a notice was on screen. */
  state: 'failed' | 'down' | 'recovered';
  headline: string;
  /** What it means for what Mason writes. */
  detail: string;
  /** "Last good pass 4 h ago", or that the log holds none. */
  lastGood: string;
  /** The failing pass's own first line; null when none was read (the notice says "Cause unknown"). */
  cause: string | null;
  /** A command the cause itself names as the fix; null otherwise. */
  fix: string | null;
}

/** "25 min", "4 h", "2 d 3 h": whole units, the smaller one dropped once it is noise. */
export function sinceWords(hours: number): string {
  const minutes = Math.floor(hours * 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const wholeHours = Math.floor(minutes / 60);
  if (wholeHours < 48) return `${wholeHours} h`;
  const rest = wholeHours % 24;
  return rest ? `${Math.floor(wholeHours / 24)} d ${rest} h` : `${Math.floor(wholeHours / 24)} d`;
}

const lastGoodWords = (hours: number | null) => (hours === null ? 'No good pass is in the dispatch log.' : `Last good pass ${sinceWords(hours)} ago.`);

/** The only fix offered is one the cause spells out itself. */
const fixOf = (cause: string | null) => (cause !== null && /\brun claude login\b/.test(cause) ? 'claude login' : null);

/**
 * `read` is the narrowed document, or null/undefined when there is none.
 * `wasFailing` is whether this pane has shown a failure notice since it
 * mounted: only then is a count of zero worth a line.
 */
export function leaderHealthNotice(read: LeaderHealthRead | null | undefined, wasFailing: boolean): LeaderHealthNotice | null {
  if (!read || read.failures === null) return null;
  if (read.failures === 0) {
    if (!wasFailing) return null;
    return {
      state: 'recovered', headline: 'The Leader is passing again.',
      detail: 'It reads what you sent on its passes, as before.', lastGood: lastGoodWords(read.hoursSinceSuccess), cause: null, fix: null,
    };
  }
  const down = read.failures >= LEADER_DOWN_FAILURES;
  return {
    state: down ? 'down' : 'failed',
    headline: down ? `The Leader’s last ${read.failures} passes failed.` : 'The Leader’s last pass failed.',
    detail: down
      ? 'It is not reading you. What you send is kept in its inbox until a pass succeeds.'
      : 'What you send is kept in its inbox; the next pass may read it.',
    lastGood: lastGoodWords(read.hoursSinceSuccess), cause: read.cause, fix: fixOf(read.cause),
  };
}
