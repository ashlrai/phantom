/**
 * routes/verse/leader-thread/catchup-sessions-model.ts: the pure half of
 * "Ended while you were away" in the Leader pane's "Since you last looked"
 * card. A session that finishes or fails while Mason is not looking leaves the
 * Working now strip without a word; the list `phm sessions --json` prints
 * (fleet.live-sessions.v1) keeps it in its tree for SESSION_RECENT_MINUTES
 * with when and how it ended, so the card can name it.
 *
 * Nothing is invented. Only a session whose end time the list holds and that
 * falls inside the away window is listed; one with no readable end time is
 * left out, never guessed into the window. A list that could not be read, or
 * one asked for running sessions only, is "unknown", never "none ended". An
 * absence longer than the list's memory is marked partial.
 */
import { flatTree, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import { SESSION_RECENT_MINUTES } from '../../../../core/fleet/session-tree.js';
import type { AwayWindow } from './leader-catchup-model.js';

export interface AwaySession {
  /** The name shown: the job id when the session has one. */
  id: string;
  /** The session's own id in the list: what its conversation is read by. */
  session: string;
  lane: string;
  kind: 'worker' | 'subagent';
  state: 'done' | 'failed';
  /** When it ended, as the list records it. */
  endedAt: string;
  /** How it ended in the list's words, or null when the list holds nothing beyond the state. */
  outcome: string | null;
}

/** Rows shown before "Show all"; every failed session is shown regardless. */
export const AWAY_SESSIONS_SHOWN = 4;

const STATE_WORD = { done: 'finished', failed: 'failed' } as const;
const RECENT_MS = SESSION_RECENT_MINUTES * 60_000;

/** How far back the list remembers an ended session, as the card says it. */
export const AWAY_SESSIONS_MEMORY = SESSION_RECENT_MINUTES === 60 ? 'the last hour' : `the last ${SESSION_RECENT_MINUTES} minutes`;

/** Why the list cannot say which sessions ended, or null when it can. `undefined` is a read still in flight. */
export function awaySessionsUnknown(list: LiveSessionsV1 | null | undefined, failed: boolean): string | null {
  if (list === null || (list === undefined && failed)) return 'the session list could not be read';
  if (list?.live) return 'this session list holds running sessions only';
  return null;
}

/** Workers and helpers the list says ended inside the window. Order is not settled here: see `mergeAwaySessions`. */
export function endedWhileAway(list: LiveSessionsV1, window: AwayWindow): AwaySession[] {
  if (list.live) return [];
  return flatTree(list.tree.roots).map(({ node }) => node).flatMap(node => {
    if ((node.kind !== 'worker' && node.kind !== 'subagent') || (node.state !== 'done' && node.state !== 'failed')) return [];
    const ended = node.lastMessageAt === null ? NaN : Date.parse(node.lastMessageAt);
    if (!(ended >= window.since && ended <= window.until)) return [];
    const said = node.lastMessage?.trim() || null;
    return [{
      id: node.jobId ?? node.id, session: node.id, lane: node.lane, kind: node.kind, state: node.state, endedAt: node.lastMessageAt!,
      // "Failed" beside "failed 5m ago" says the same thing twice.
      outcome: said !== null && said.toLowerCase() !== STATE_WORD[node.state] ? said : null,
    }];
  });
}

/**
 * The card's rows across polls. The list forgets an ended session after
 * SESSION_RECENT_MINUTES, but a card left open is about one fixed window, so a
 * row once read stays. Failed first (they want a look), then the most recently
 * ended. Returns `kept` itself when the poll changed nothing.
 */
export function mergeAwaySessions(kept: readonly AwaySession[], fresh: readonly AwaySession[]): readonly AwaySession[] {
  const bySession = new Map(kept.map(row => [row.session, row]));
  let changed = false;
  for (const row of fresh) {
    const before = bySession.get(row.session);
    if (before && before.state === row.state && before.endedAt === row.endedAt && before.outcome === row.outcome) continue;
    bySession.set(row.session, row);
    changed = true;
  }
  if (!changed) return kept;
  return [...bySession.values()].sort((a, b) => Number(b.state === 'failed') - Number(a.state === 'failed')
    || Date.parse(b.endedAt) - Date.parse(a.endedAt) || (a.id < b.id ? -1 : 1));
}

/** True when Mason was away for longer than the list remembers, so earlier endings cannot be known. */
export function awaySessionsPartial(window: AwayWindow): boolean {
  return window.until - window.since > RECENT_MS;
}

/** "2 finished · 1 failed"; a side with none is left out. */
export function awaySessionCounts(rows: readonly AwaySession[]): string {
  const failed = rows.filter(row => row.state === 'failed').length, finished = rows.length - failed;
  return [...(finished ? [`${finished} finished`] : []), ...(failed ? [`${failed} failed`] : [])].join(' · ');
}

/** The rows on screen: all of them when unfolded; otherwise every failed one, then finished ones up to AWAY_SESSIONS_SHOWN. */
export function awaySessionsShown(rows: readonly AwaySession[], all: boolean): readonly AwaySession[] {
  if (all) return rows;
  const failed = rows.filter(row => row.state === 'failed').length;
  return rows.slice(0, Math.max(failed, AWAY_SESSIONS_SHOWN));
}

/** "failed" or "finished": the word before the time. */
export function awayStateWord(row: AwaySession): string {
  return STATE_WORD[row.state];
}

/** What a row says after its time: the outcome, or that a finished session's outcome is not in the list. A failed one needs no more words. */
export function awayOutcomeWords(row: AwaySession): string | null {
  return row.outcome ?? (row.state === 'done' ? 'Outcome unknown' : null);
}
