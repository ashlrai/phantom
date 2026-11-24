/**
 * routes/verse/leader-thread/composer-assist-model.ts: the pure half of the
 * Leader reply box's keyboard help. Typing `@` lists the agent sessions that
 * are running, read from the same list `phm sessions --json` prints
 * (fleet.live-sessions.v1), and choosing one writes `@RQ-<job>`, the steer
 * syntax the leaders' inbox already understands. The Up arrow in an empty box
 * brings back what Mason already said, read from the conversation itself.
 * Nothing is invented: a last message the list does not hold reads "Last
 * message unknown", and a session the steer syntax cannot name is counted but
 * never offered.
 */
import { flatTree, sessionAge, spoke, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import { canAim } from './leader-roster-model.js';

export interface MentionOption {
  /** The job id written after `@`. */
  id: string;
  lane: string;
  kind: 'worker' | 'subagent';
  /** Quiet: running, but no output for longer than the list's quiet window. */
  state: 'running' | 'quiet';
  /** "spoke 2m ago", "quiet 14m" or "last spoke unknown". */
  when: string;
  /** The last thing it said, or null when the list does not hold it. */
  said: string | null;
}

export interface MentionOptions {
  /** The matches shown, best first. */
  shown: MentionOption[];
  /** Matches beyond the shown ones. */
  more: number;
  /** Running sessions that can be aimed at, before the typed text narrows them. */
  running: number;
  /** Running sessions with no `RQ-` id: the steer syntax cannot name them. */
  unnamed: number;
}

export const MENTION_LIMIT = 6;

/**
 * The running workers and helpers matching what was typed after `@`. A match
 * on the job id outranks one on the lane, agent, repo or last message; quiet
 * sessions come first inside each, then the list's own most-recent-first order.
 */
export function mentionOptions(list: LiveSessionsV1, query: string, limit = MENTION_LIMIT): MentionOptions {
  const byJob = new Map(list.sessions.map(row => [row.job, row]));
  const needle = query.toLowerCase();
  const crew = flatTree(list.tree.roots).map(({ node }) => node)
    .filter(node => (node.kind === 'worker' || node.kind === 'subagent') && node.state === 'running');
  const named = crew.filter(node => canAim(node.jobId ?? node.id));
  const ranked = named.flatMap((node, index) => {
    const id = node.jobId ?? node.id;
    const onId = id.toLowerCase().includes(needle);
    if (!onId && ![node.lane, node.agent, node.repo, node.lastMessage ?? ''].some(field => field.toLowerCase().includes(needle))) return [];
    const row = node.jobId === null ? undefined : byJob.get(node.jobId);
    const quiet = row?.quiet === true;
    const option: MentionOption = {
      id, lane: node.lane, kind: node.kind as 'worker' | 'subagent', state: quiet ? 'quiet' : 'running',
      when: quiet ? `quiet ${sessionAge(row?.lastOutputAgeSeconds ?? null)}` : spoke(node), said: node.lastMessage,
    };
    return [{ option, rank: (onId ? 0 : 2) + (quiet ? 0 : 1), index }];
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ option }) => option);
  const shown = ranked.slice(0, Math.max(0, limit));
  return { shown, more: ranked.length - shown.length, running: named.length, unnamed: crew.length - named.length };
}

/** The option after (or before) `index`, wrapping; -1 for an empty list. */
export function stepOption(count: number, index: number, delta: 1 | -1): number {
  return count === 0 ? -1 : (Math.min(Math.max(index, 0), count - 1) + delta + count) % count;
}

export const RECALL_LIMIT = 20;

/** What Mason already said, oldest first, without blanks or back-to-back repeats; the newest `limit` are kept. */
export function recallable(texts: readonly string[], limit = RECALL_LIMIT): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (text !== '' && out[out.length - 1] !== text) out.push(text);
  }
  return out.slice(-Math.max(0, limit));
}

export interface RecallStep {
  /** The position in the recall list now shown, or null when the box is back to empty. */
  at: number | null;
  text: string;
}

/**
 * One Up (-1) or Down (+1) press. Recall only starts from an empty box and
 * only continues while the box still holds the recalled text untouched, so it
 * can never overwrite words Mason is writing. Null means the key is not ours.
 */
export function recallStep(sent: readonly string[], draft: string, at: number | null, delta: 1 | -1): RecallStep | null {
  const recalling = at !== null && sent[at] === draft;
  if (!recalling) return draft === '' && delta === -1 && sent.length > 0 ? { at: sent.length - 1, text: sent[sent.length - 1]! } : null;
  const next = at + delta;
  if (next < 0) return { at, text: draft };
  return next >= sent.length ? { at: null, text: '' } : { at: next, text: sent[next]! };
}
