/**
 * The session tree inside `fleet.live-sessions.v1`: leader at the root, then
 * workers, then their subagents. `buildSessionTree` is pure (records and a
 * clock in, tree out); `sessionRecords` turns what the fleet already records
 * (the live-sessions rows, the session map and `subagent.v1` records) into its
 * input. Unknown stays "unknown" (null for times and messages), never guessed.
 */
import type { SubagentRecord } from '../subagent/spawn.js';
import type { LiveSessionRow } from './live-sessions.js';
import type { FleetSessionMap } from './sessions-view.js';

export const SESSION_TREE_SCHEMA = 'fleet.session-tree.v1';
export const SESSION_TREE_VERSION = 1;
/** Finished sessions stay in the tree, and failures in the top line, this long. */
export const SESSION_RECENT_MINUTES = 60;
/** The row that holds sessions whose parent is not in the list. */
export const UNKNOWN_PARENT_ID = 'unknown parent';
export type SessionState = 'running' | 'idle' | 'done' | 'failed' | 'unknown';
export type SessionKind = 'leader' | 'worker' | 'subagent';
/** The leader reads as idle (between passes) while its newest recorded pass is at most this old; past it, its state is unknown. */
export const LEADER_PASS_FRESH_MINUTES = 120;
/** The leader's last reply is one line in the tree, cut at this length. */
export const LEADER_REPLY_EXCERPT_CHARS = 240;

/** What the fleet's own files record about the leader. Every field is null when no record holds it. */
export interface LeaderSessionFacts {
  /** When the leader last finished a planning pass: the newest dated heading of its plan log. */
  lastPassAt: string | null;
  /** When it last wrote to the owner; null when that reply's heading has no readable time. */
  lastReplyAt: string | null;
  /** The newest reply it wrote to the owner. */
  lastReply: string | null;
}

export interface SessionRecord {
  id: string;
  parentId: string | null;
  /** Default: no parent is the leader, a child of a root is a worker, deeper is a subagent. */
  kind?: SessionKind;
  agent: string; lane: string; model: string; repo: string;
  jobId: string | null;
  state: SessionState;
  startedAt: string | null;
  lastMessageAt: string | null;
  /** The last thing it said, in plain words; null when unknown. */
  lastMessage: string | null;
}
/** Key order is the JSON contract. */
export interface SessionNode extends Required<Omit<SessionRecord, 'kind'>> {
  kind: SessionKind | 'unknown-parent';
  lastMessageAgeSeconds: number | null;
  /** Sessions under this one, at any depth. */
  counts: { below: number; running: number; failed: number };
  children: SessionNode[];
}
export interface SessionTreeV1 {
  schema: typeof SESSION_TREE_SCHEMA;
  version: typeof SESSION_TREE_VERSION;
  generatedAt: string;
  /** For example "9 sessions running: leader, 6 workers, 2 subagents; 1 failed in the last hour". */
  line: string;
  counts: { sessions: number; running: number; idle: number; done: number; failed: number; unknown: number;
    leaders: number; workers: number; subagents: number; orphans: number; failedLastHour: number };
  roots: SessionNode[];
}

const at = (iso: string | null): number => (iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : -Infinity);
const many = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Siblings: running first, then whoever spoke (or started) most recently, then id. */
export function buildSessionTree(records: readonly SessionRecord[], now: number): SessionTreeV1 {
  const byId = new Map<string, SessionRecord>();
  for (const record of records) if (record.id && record.id !== UNKNOWN_PARENT_ID && !byId.has(record.id)) byId.set(record.id, record);
  const childrenOf = new Map<string | null, SessionRecord[]>();
  for (const record of byId.values()) {
    // A parent that is missing (or is the record itself) is unknown, so the session is shown, never dropped.
    const parent = record.parentId === null ? null : byId.has(record.parentId) && record.parentId !== record.id ? record.parentId : UNKNOWN_PARENT_ID;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), record]);
  }
  const counts: SessionTreeV1['counts'] = { sessions: 0, running: 0, idle: 0, done: 0, failed: 0, unknown: 0,
    leaders: 0, workers: 0, subagents: 0, orphans: childrenOf.get(UNKNOWN_PARENT_ID)?.length ?? 0, failedLastHour: 0 };
  const running: Record<SessionKind, number> = { leader: 0, worker: 0, subagent: 0 };
  const seen = new Set<string>();
  const level = (parent: string | null, depth: number): SessionNode[] => (childrenOf.get(parent) ?? []).filter(r => !seen.has(r.id)).map(record => {
    seen.add(record.id);
    const kind = record.kind ?? (depth === 0 ? 'leader' : depth === 1 ? 'worker' : 'subagent');
    const children = level(record.id, depth + 1);
    const spoke = at(record.lastMessageAt);
    counts.sessions += 1; counts[record.state] += 1; counts[`${kind}s`] += 1;
    if (record.state === 'running') running[kind] += 1;
    if (record.state === 'failed' && now - Math.max(spoke, at(record.startedAt)) <= SESSION_RECENT_MINUTES * 60_000) counts.failedLastHour += 1;
    return { id: record.id, parentId: record.parentId, agent: record.agent, lane: record.lane, model: record.model, repo: record.repo,
      jobId: record.jobId, state: record.state, startedAt: record.startedAt, lastMessageAt: record.lastMessageAt, lastMessage: record.lastMessage,
      kind, lastMessageAgeSeconds: spoke === -Infinity ? null : Math.max(0, Math.floor((now - spoke) / 1000)), counts: below(children), children };
  }).sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running')
    || Math.max(at(b.lastMessageAt), at(b.startedAt)) - Math.max(at(a.lastMessageAt), at(a.startedAt)) || (a.id < b.id ? -1 : 1));
  const below = (nodes: SessionNode[]) => nodes.reduce((sum, n) => ({ below: sum.below + 1 + n.counts.below,
    running: sum.running + Number(n.state === 'running') + n.counts.running, failed: sum.failed + Number(n.state === 'failed') + n.counts.failed }),
  { below: 0, running: 0, failed: 0 });
  const roots = level(null, 0);
  const orphans = level(UNKNOWN_PARENT_ID, 1);
  // A parent cycle has no root: its members are orphans too.
  for (const record of byId.values()) if (!seen.has(record.id)) {
    counts.orphans += 1; childrenOf.set(UNKNOWN_PARENT_ID, [record]); orphans.push(...level(UNKNOWN_PARENT_ID, 1));
  }
  if (orphans.length) roots.push({ id: UNKNOWN_PARENT_ID, parentId: null, agent: 'unknown', lane: 'unknown', model: 'unknown', repo: 'unknown',
    jobId: null, state: 'unknown', startedAt: null, lastMessageAt: null, lastMessage: null, kind: 'unknown-parent',
    lastMessageAgeSeconds: null, counts: below(orphans), children: orphans });
  const who = [running.leader === 1 ? 'leader' : running.leader ? many(running.leader, 'leader') : '', running.worker ? many(running.worker, 'worker') : '',
    running.subagent ? many(running.subagent, 'subagent') : ''].filter(Boolean).join(', ');
  const line = [counts.running ? `${many(counts.running, 'session')} running: ${who}` : counts.sessions ? 'No agent sessions running' : 'No agent sessions running.',
    counts.failedLastHour ? `${counts.failedLastHour} failed in the last hour` : '', counts.unknown ? `${counts.unknown} with state unknown` : '',
    counts.orphans ? `${counts.orphans} under unknown parent` : ''].filter(Boolean).join('; ');
  return { schema: SESSION_TREE_SCHEMA, version: SESSION_TREE_VERSION, generatedAt: new Date(now).toISOString(), line, counts, roots };
}

const OUTCOME_WORDS: Record<string, string> = { pr: 'Opened a pull request', empty: 'Ended with no change', failed: 'Failed' };
const SUBAGENT_STATE: Record<SubagentRecord['state'], SessionState> = { planned: 'idle', held: 'idle', running: 'running', completed: 'done', failed: 'failed', refused: 'failed' };

/**
 * Records from what the fleet already writes. Workers: `rows` (running, already
 * filtered) plus, unless `live`, sessions that finished in the last hour. All
 * report to one leader row. Subagents: `subagent.v1` records.
 *
 * The leader row is filled from `options.leader` (see `leaderRecord`); without
 * it the row's state and messages stay unknown. With it and no lane or repo
 * filter, the leader is listed even when no worker is.
 */
export function sessionRecords(rows: readonly LiveSessionRow[], map: FleetSessionMap | null, subagents: readonly SubagentRecord[], now: number,
  options: { live?: boolean; lane?: string | null; repo?: string | null; leader?: LeaderSessionFacts | null } = {}): SessionRecord[] {
  const recent = (iso: string | null | undefined) => now - at(iso ?? null) <= SESSION_RECENT_MINUTES * 60_000;
  const activity = new Map((map?.mapSessions ?? []).map(session => [session.job, session.activity]));
  const workers: SessionRecord[] = rows.map(row => ({ id: row.job, parentId: 'leader', kind: 'worker', agent: row.lane, lane: row.lane, model: row.model,
    repo: row.repo, jobId: row.job, state: row.status === 'unknown' ? 'unknown' : 'running', startedAt: row.startedAt, lastMessageAt: row.lastOutputAt,
    lastMessage: activity.get(row.job)?.trim() || null }));
  const ids = new Set(workers.map(worker => worker.id));
  for (const done of options.live ? [] : map?.recent ?? []) {
    if (ids.has(done.job) || !recent(done.finishedAt) || (options.lane && done.lane !== options.lane) || (options.repo && done.repo !== options.repo)) continue;
    ids.add(done.job);
    workers.push({ id: done.job, parentId: 'leader', kind: 'worker', agent: done.lane ?? 'unknown', lane: done.lane ?? 'unknown', model: done.model ?? 'unknown',
      repo: done.repo ?? 'unknown', jobId: done.job, state: done.outcome === 'failed' ? 'failed' : 'done', startedAt: done.startedAt, lastMessageAt: done.finishedAt,
      lastMessage: OUTCOME_WORDS[done.outcome ?? ''] ?? null });
  }
  const repoOf = new Map(workers.map(worker => [worker.id, worker.repo]));
  const filtered = !!(options.lane || options.repo);
  const children: SessionRecord[] = [];
  for (const sub of [...subagents].sort((a, b) => a.depth - b.depth)) {
    const state = SUBAGENT_STATE[sub.state];
    const over = state === 'done' || state === 'failed', known = repoOf.has(sub.parent_id) || sub.parent_id === 'leader';
    // Old records leave: finished ones after an hour, waiting ones once their parent is gone.
    // With a lane or repo filter, a subagent shows only under a session the filter kept.
    if ((over && options.live) || (filtered && !repoOf.has(sub.parent_id)) || (state !== 'running' && !recent(sub.created_at) && (over || !known))) continue;
    repoOf.set(sub.id, repoOf.get(sub.parent_id) ?? 'unknown');
    children.push({ id: sub.id, parentId: sub.parent_id, kind: 'subagent', agent: 'subagent', lane: sub.lane ?? 'unknown', model: sub.model ?? 'unknown',
      repo: repoOf.get(sub.id)!, jobId: null, state, startedAt: sub.created_at, lastMessageAt: null, lastMessage: null });
  }
  const leader = leaderRecord(options.leader ?? null, now);
  const leaderKnown = leader.state !== 'unknown' || leader.lastMessage !== null;
  if (!workers.length && !children.some(child => child.parentId === 'leader') && (filtered || !leaderKnown)) return children;
  return [leader, ...workers, ...children];
}

/** True when `facts` records a pass that ended in the last LEADER_PASS_FRESH_MINUTES (a pass dated after `now` is not trusted). */
export function leaderPassFresh(facts: LeaderSessionFacts | null | undefined, now: number): boolean {
  const age = now - at(facts?.lastPassAt ?? null);
  return age >= 0 && age <= LEADER_PASS_FRESH_MINUTES * 60_000;
}

/**
 * The leader's row. It runs in passes, not as one long process, so a recent
 * pass reads as `idle` (between passes) and anything older, or no pass at all,
 * stays `unknown`: no record says whether it is still alive. Its last message
 * is the newest reply it wrote to the owner, on one line. Lane, model and
 * start time are recorded nowhere yet and stay unknown.
 */
export function leaderRecord(facts: LeaderSessionFacts | null, now: number): SessionRecord {
  const reply = facts?.lastReply?.replace(/\s+/g, ' ').trim() || null;
  const repliedAt = at(facts?.lastReplyAt ?? null);
  return { id: 'leader', parentId: null, kind: 'leader', agent: 'leader', lane: 'unknown', model: 'unknown', repo: 'unknown', jobId: null,
    state: leaderPassFresh(facts, now) ? 'idle' : 'unknown', startedAt: null,
    lastMessageAt: reply !== null && repliedAt !== -Infinity && repliedAt <= now ? new Date(repliedAt).toISOString() : null,
    lastMessage: reply === null ? null : reply.length > LEADER_REPLY_EXCERPT_CHARS ? `${reply.slice(0, LEADER_REPLY_EXCERPT_CHARS - 1)}…` : reply };
}
