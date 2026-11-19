/**
 * routes/verse/leader-thread/leader-roster-model.ts — the pure half of the
 * Leader pane's "Working now" strip: every agent session that is running, in
 * one line each, read from the same list `phm sessions --json` prints
 * (fleet.live-sessions.v1). Nothing is invented: a last message the list does
 * not hold reads "Last message unknown", and a session whose id the steer
 * syntax cannot name (`@RQ-...`) is shown but cannot be aimed at.
 */
import { flatTree, sessionAge, spoke, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { SessionNode } from '../../../../core/fleet/session-tree.js';
import { targetsOf } from '../fleet/interject-target-model.js';
import { validJob } from '../fleet/workers-card-model.js';

export interface RosterRow {
  /** The name shown and aimed at: the job id when the session has one. */
  id: string;
  /** The session's own id in the list: what its conversation is read by. */
  session: string;
  /** The job whose log can be opened, or null when the session has none. */
  job: string | null;
  lane: string;
  kind: 'worker' | 'subagent';
  /** Quiet: running, but no output for longer than the list's quiet window. */
  state: 'running' | 'quiet';
  /** "spoke 2m ago", "quiet 14m" or "last spoke unknown". */
  when: string;
  /** The last thing it said, or null when the list does not hold it. */
  said: string | null;
  /** True when `@id` is a name the leaders' inbox understands. */
  aimable: boolean;
  prUrl: string | null;
}

/** The text put in the Leader reply box to aim the next message at `id`. */
export function aimText(id: string): string {
  return `@${id} `;
}

/** Whether the steer syntax can name this id (the same parser the Leader thread reads sent messages with). */
export function canAim(id: string): boolean {
  return targetsOf(aimText(id))[0] === id;
}

/** The sessions this strip is about: workers and their helpers, never the leader itself. */
function crew(list: LiveSessionsV1): SessionNode[] {
  return flatTree(list.tree.roots).map(({ node }) => node).filter(node => node.kind === 'worker' || node.kind === 'subagent');
}

/** Running workers and helpers: the quiet ones first (they want a look), then the list's own most-recent-first order. */
export function rosterRows(list: LiveSessionsV1): RosterRow[] {
  const byJob = new Map(list.sessions.map(row => [row.job, row]));
  return crew(list).filter(node => node.state === 'running').map((node, index) => {
    const row = node.jobId === null ? undefined : byJob.get(node.jobId);
    const quiet = row?.quiet === true;
    const id = node.jobId ?? node.id;
    return { index, row: {
      id, session: node.id, job: node.jobId !== null && validJob(node.jobId) ? node.jobId : null, lane: node.lane, kind: node.kind as 'worker' | 'subagent',
      state: quiet ? 'quiet' as const : 'running' as const,
      when: quiet ? `quiet ${sessionAge(row?.lastOutputAgeSeconds ?? null)}` : spoke(node),
      said: node.lastMessage, aimable: canAim(id), prUrl: row?.prUrl ?? null,
    } };
  }).sort((a, b) => Number(b.row.state === 'quiet') - Number(a.row.state === 'quiet') || a.index - b.index).map(({ row }) => row);
}

/** "6 working now · 1 quiet · 2 with state unknown"; the unknown ones are counted, never folded into either side. */
export function rosterHeadline(rows: readonly RosterRow[], list: LiveSessionsV1): string {
  const quiet = rows.filter(row => row.state === 'quiet').length;
  const unknown = crew(list).filter(node => node.state === 'unknown').length;
  return [
    rows.length === 0 ? 'No agents are working right now' : `${rows.length} working now`,
    ...(quiet ? [`${quiet} quiet`] : []),
    ...(unknown ? [`${unknown} with state unknown`] : []),
  ].join(' · ');
}

/** The row after (or before) `index`, wrapping; -1 for an empty list. */
export function stepRow(count: number, index: number, delta: 1 | -1): number {
  return count === 0 ? -1 : (Math.max(index, 0) + delta + count) % count;
}
