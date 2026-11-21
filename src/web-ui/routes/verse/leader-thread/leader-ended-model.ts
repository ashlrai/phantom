/**
 * routes/verse/leader-thread/leader-ended-model.ts: the pure half of "Ended
 * in the last hour" under the Leader pane's Working now strip. A session that
 * stops running leaves the strip's list; the list `phm sessions --json` prints
 * (fleet.live-sessions.v1) keeps it in its tree for SESSION_RECENT_MINUTES
 * with how it ended, so the strip can say that instead of going silent.
 *
 * Nothing is invented. The tree holds one outcome line for a worker ("Opened
 * a pull request", "Ended with no change") and none for a helper; a finished
 * session without one reads "Outcome unknown", and an end time the list does
 * not hold reads "time unknown". A list asked for running sessions only
 * (`live`) holds no ended ones, so it gives no rows rather than "none ended".
 */
import { flatTree, sessionAge, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import { SESSION_RECENT_MINUTES } from '../../../../core/fleet/session-tree.js';
import { validJob } from '../fleet/workers-card-model.js';

export interface EndedRow {
  /** The name shown: the job id when the session has one. */
  id: string;
  /** The session's own id in the list: what its conversation is read by. */
  session: string;
  /** The job whose log can be opened, or null when the session has none. */
  job: string | null;
  lane: string;
  kind: 'worker' | 'subagent';
  state: 'done' | 'failed';
  /** "failed 5m ago", "finished 12m ago" or "finished, time unknown". */
  when: string;
  /** How it ended in the list's words, or null when the list holds nothing beyond the state. */
  outcome: string | null;
}

/** How long the list keeps an ended session, as the strip says it. */
export const ENDED_WINDOW = SESSION_RECENT_MINUTES === 60 ? 'the last hour' : `the last ${SESSION_RECENT_MINUTES} minutes`;

const STATE_WORD = { done: 'finished', failed: 'failed' } as const;

/** Ended workers and helpers: the failed ones first (they want a look), then the most recently ended; an unknown end time goes last. */
export function endedRows(list: LiveSessionsV1): EndedRow[] {
  if (list.live) return [];
  return flatTree(list.tree.roots).map(({ node }) => node)
    .filter(node => (node.kind === 'worker' || node.kind === 'subagent') && (node.state === 'done' || node.state === 'failed'))
    .map((node, index) => {
      const state = node.state as 'done' | 'failed', age = node.lastMessageAgeSeconds;
      const said = node.lastMessage?.trim() || null;
      const row: EndedRow = {
        id: node.jobId ?? node.id, session: node.id, job: node.jobId !== null && validJob(node.jobId) ? node.jobId : null, lane: node.lane,
        kind: node.kind as 'worker' | 'subagent', state,
        when: age === null ? `${STATE_WORD[state]}, time unknown` : `${STATE_WORD[state]} ${sessionAge(age)} ago`,
        // "Failed" beside "failed 5m ago" says nothing twice.
        outcome: said !== null && said.toLowerCase() !== STATE_WORD[state] ? said : null,
      };
      return { index, age: age ?? Infinity, row };
    })
    .sort((a, b) => Number(b.row.state === 'failed') - Number(a.row.state === 'failed') || a.age - b.age || a.index - b.index)
    .map(({ row }) => row);
}

/** What a row says after its time: the outcome, or that a finished session's outcome is not in the list. A failed one needs no more words. */
export function outcomeWords(row: EndedRow): string | null {
  return row.outcome ?? (row.state === 'done' ? 'Outcome unknown' : null);
}

/** "3 finished · 1 failed"; a side with none is left out. */
export function endedCounts(rows: readonly EndedRow[]): string {
  const failed = rows.filter(row => row.state === 'failed').length, finished = rows.length - failed;
  return [...(finished ? [`${finished} finished`] : []), ...(failed ? [`${failed} failed`] : [])].join(' · ');
}

/** The rows on screen: every one when unfolded, only the failed ones when folded. */
export function endedShown(rows: readonly EndedRow[], open: boolean): readonly EndedRow[] {
  return open ? rows : rows.filter(row => row.state === 'failed');
}

/** The words beside a folded Working now strip, so a failure is never folded away; null when nothing failed. */
export function foldedFailureWords(rows: readonly EndedRow[]): string | null {
  const failed = rows.filter(row => row.state === 'failed').length;
  return failed ? `${failed} failed in ${ENDED_WINDOW}` : null;
}
