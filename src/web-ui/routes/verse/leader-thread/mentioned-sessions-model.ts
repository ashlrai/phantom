/**
 * routes/verse/leader-thread/mentioned-sessions-model.ts: the pure half of the
 * "Mentioned" row under a Leader message. Each job the message names is looked
 * up in the list `phm sessions --json` prints (fleet.live-sessions.v1), so the
 * row says what that session is doing now, not only that it was named.
 *
 * Nothing is guessed. A job the list does not hold reads "not in the session
 * list" (it may have finished long ago or never launched; the list cannot
 * say which), and a list that was not read leaves every job "state unknown".
 */
import { flatTree, sessionAge, spoke, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';

/**
 * `quiet`: running with no output for longer than the list's quiet window.
 * `absent`: the list was read and does not hold the job. `unread`: the list
 * could not be read. `reading`: the first read has not answered yet.
 */
export type MentionState = 'running' | 'quiet' | 'idle' | 'done' | 'failed' | 'unknown' | 'absent' | 'unread' | 'reading';

export interface MentionedSession {
  job: string;
  state: MentionState;
  /** "running · claude · spoke 2m ago", "not in the session list", "state unknown". */
  words: string;
  /** The last thing it said, only while it is working; null when the list holds none. */
  said: string | null;
}

/** What the read of the session list came to: the list, `null` when it could not be read, `undefined` while the first read is out. */
export type SessionListRead = LiveSessionsV1 | null | undefined;

const STATE_WORD: Record<'idle' | 'done' | 'failed' | 'unknown', string> = {
  idle: 'idle', done: 'finished', failed: 'failed', unknown: 'state unknown',
};

/** Refs as thread-refs.ts collects them: job ids, then pull requests (`#12`, `owner/repo#12`). */
export function splitMentioned(refs: readonly string[]): { jobs: string[]; pulls: string[] } {
  return { jobs: refs.filter(ref => !ref.includes('#')), pulls: refs.filter(ref => ref.includes('#')) };
}

/** One row per named job, in the order the message names them. */
export function mentionedSessions(jobs: readonly string[], list: SessionListRead): MentionedSession[] {
  if (list === undefined) return jobs.map(job => ({ job, state: 'reading', words: 'reading state', said: null }));
  if (list === null) return jobs.map(job => ({ job, state: 'unread', words: 'state unknown', said: null }));
  const nodes = flatTree(list.tree.roots).map(({ node }) => node);
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  return jobs.map(job => {
    const node = nodes.find(candidate => candidate.jobId === job) ?? nodes.find(candidate => candidate.id === job);
    if (!node) return { job, state: 'absent', words: 'not in the session list', said: null };
    const lane = node.lane === 'unknown' ? 'lane unknown' : node.lane;
    if (node.state !== 'running') return { job, state: node.state, words: `${STATE_WORD[node.state]} · ${lane}`, said: null };
    const row = rows.get(job);
    return row?.quiet === true
      ? { job, state: 'quiet', words: `quiet ${sessionAge(row.lastOutputAgeSeconds)} · ${lane}`, said: node.lastMessage }
      : { job, state: 'running', words: `running · ${lane} · ${spoke(node)}`, said: node.lastMessage };
  });
}
