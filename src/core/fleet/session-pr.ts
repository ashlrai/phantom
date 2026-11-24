/**
 * What became of the pull request a session's job opened: merged (and how
 * long after it opened), closed without merging, or still open when the
 * fleet last checked.
 *
 * A session reads "done" once its job has published. That is not the end
 * Mason cares about: the pull request can merge a minute later, sit open, or
 * be closed. The fleet's outcome reconciler already writes that to
 * `metrics/jobs.jsonl` as an `outcome` row (`state` MERGED, CLOSED or OPEN,
 * `ttm_s` the seconds from opened to merged); the job's activity read carries
 * it on the event entry as `pr` (runs-job-activity.ts `rowPrFate`). This
 * module picks the one answer for the job's current attempt and words it.
 *
 * Nothing is inferred. A job with a pull request and no outcome row gives
 * null: no record says what became of it yet, which is not "open".
 *
 * Pure and free of node imports, so the desktop console imports it too.
 */
import { sessionAge } from './live-sessions.js';
import type { FleetJobActivityV1, FleetJobPrFate, FleetJobPrState } from './runs-job-activity.js';

export const SESSION_PR_STATES: readonly FleetJobPrState[] = ['merged', 'closed', 'open'];
export type SessionPrState = FleetJobPrState;

/** Key order is the JSON contract. */
export interface SessionThreadPr {
  state: SessionPrState;
  /** Seconds from the pull request opening to its merge, as the ledger recorded them. Null when it did not, and for a state that is not merged. */
  mergeSeconds: number | null;
  /** The outcome row's own time, as written. Null when it carried none that parses. */
  at: string | null;
}

/**
 * The recorded outcome of the job's current attempt. Rows before the newest `launch` belong to an earlier
 * attempt and are set aside. A merge stands whatever was recorded around it; otherwise the newest row answers.
 */
export function sessionPr(activity: FleetJobActivityV1 | null | undefined): SessionThreadPr | null {
  if (!activity) return null;
  const events = activity.entries.flatMap(entry => (entry.kind === 'event' ? [entry] : []));
  const launched = events.map(entry => entry.event).lastIndexOf('launch');
  const recorded = events.slice(launched + 1).flatMap(entry => (entry.pr ? [{ at: entry.at, pr: entry.pr }] : []));
  const chosen = recorded.filter(row => row.pr.state === 'merged').at(-1) ?? recorded.at(-1);
  if (!chosen) return null;
  return { state: chosen.pr.state, mergeSeconds: mergeSeconds(chosen.pr), at: chosen.at !== null && Number.isFinite(Date.parse(chosen.at)) ? chosen.at : null };
}

const mergeSeconds = (pr: FleetJobPrFate) => (pr.state === 'merged' && pr.mergeSeconds !== null && Number.isFinite(pr.mergeSeconds) && pr.mergeSeconds >= 0 ? Math.floor(pr.mergeSeconds) : null);

/** Every sentence `prSentence` writes starts with this, so a screen that draws the outcome can leave the sentence out. */
export const PR_SENTENCE_START = 'Its pull request ';

/** The outcome as one summary sentence. */
export function prSentence(pr: SessionThreadPr): string {
  if (pr.state === 'merged') return `${PR_SENTENCE_START}merged${pr.mergeSeconds === null ? '' : ` ${sessionAge(pr.mergeSeconds)} after it opened`}.`;
  if (pr.state === 'closed') return `${PR_SENTENCE_START}was closed without merging.`;
  return `${PR_SENTENCE_START}was still open when last checked${pr.at === null ? '' : ` at ${pr.at}`}.`;
}

/** The outcome in a few words, for a chip: "merged in 1m", "merged", "closed, not merged", "still open". */
export function prWords(pr: Pick<SessionThreadPr, 'state' | 'mergeSeconds'>): string {
  if (pr.state === 'merged') return pr.mergeSeconds === null ? 'merged' : `merged in ${sessionAge(pr.mergeSeconds)}`;
  return pr.state === 'closed' ? 'closed, not merged' : 'still open';
}
