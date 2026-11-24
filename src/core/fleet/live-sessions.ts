/**
 * Every live agent session in one place: `phm sessions`, GET
 * /api/verse/fleet/control/live-sessions and the desktop Sessions pane.
 *
 * No source of its own. It projects the session map the Compute map already
 * reads (`readFleetSessionMap` in sessions-view.ts: the dispatch inventory from
 * runs-sessions.ts joined with the computers in compute-view.ts), so the job
 * list, PR links and computer placement match every other fleet view.
 *
 * `sessions` has one row per running session (launching, running, publishing,
 * or a job a computer claims that this computer cannot see); `tree` holds the
 * same sessions under the leader, with subagents and sessions that finished in
 * the last hour (session-tree.ts). A field no source reported
 * reads "unknown" (or null for times) and `unknown` says why in plain words.
 * Stable: rows sort by lane order, then start, then job id, and every row has
 * the same keys in the same order, so the same inputs and clock print
 * byte-identical JSON.
 *
 * Pure, so the desktop pane imports the types and helpers without fs readers;
 * the reader lives in live-sessions-read.ts.
 */
import { ORG_LANES } from './org-map.js';
import type { FleetSessionMap, MapSession } from './sessions-view.js';
import type { FleetSessionV1 } from './runs-sessions.js';
import type { SubagentRecord } from '../subagent/spawn.js';
import { buildSessionTree, leaderPassFresh, sessionRecords, type LeaderSessionFacts, type SessionNode, type SessionTreeV1 } from './session-tree.js';

export const LIVE_SESSIONS_SCHEMA = 'fleet.live-sessions.v1';
/** A running session with no new output for longer than this is "quiet". */
export const SESSION_QUIET_MINUTES = 10;
const QUIET_MS = SESSION_QUIET_MINUTES * 60_000;
const SHOWN: ReadonlySet<string> = new Set(['launching', 'running', 'publishing', 'unknown']);
/** Fields that can read "unknown", in the order `unknown` lists them. */
export const SESSION_FIELDS = ['lane', 'model', 'repo', 'tier', 'startedAt', 'lastOutputAt', 'computer'] as const;
/** Lane and repo filter names: the shape queue lines use. */
export const SESSION_FILTER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
export type SessionField = (typeof SESSION_FIELDS)[number];

/** Key order is the JSON contract. */
export interface LiveSessionRow {
  job: string;
  lane: string;
  model: string;
  repo: string;
  tier: string;
  /** launching, running, publishing, or unknown (a computer claims it; this computer has no record). */
  status: string;
  startedAt: string | null;
  ageSeconds: number | null;
  lastOutputAt: string | null;
  lastOutputAgeSeconds: number | null;
  /** No output for more than SESSION_QUIET_MINUTES. Null when the last output time is unknown. */
  quiet: boolean | null;
  prUrl: string | null;
  /** The computer it runs on (its node id), or "unknown". */
  computer: string;
  /** True on the computer that answered; null when the computer is unknown. */
  thisComputer: boolean | null;
  /** Why each unknown field is unknown. Only unknown fields appear, in SESSION_FIELDS order. */
  unknown: Partial<Record<SessionField, string>>;
}
export interface LiveSessionsV1 {
  schema: typeof LIVE_SESSIONS_SCHEMA;
  generatedAt: string;
  quietAfterMinutes: number;
  filter: { lane: string | null; repo: string | null };
  counts: { sessions: number; quiet: number; lanes: number; otherComputers: number };
  sessions: LiveSessionRow[];
  /** Plain words for every fact the list could not show. */
  gaps: string[];
  /** True when only running sessions were asked for (`phm sessions --live`). */
  live: boolean;
  /** Every session as one tree: leader, workers, subagents. Finished ones stay for an hour unless `live`. */
  tree: SessionTreeV1;
}
export interface LiveSessionsFilter {
  lane?: string | null; repo?: string | null; live?: boolean; subagents?: readonly SubagentRecord[] | null;
  /** What the leader's own files record; null or absent when they were not read. */
  leader?: LeaderSessionFacts | null;
}

/** Plain words for what the leader's row could not show. With no fact at all it is the one line older readers print. */
export function leaderGaps(facts: LeaderSessionFacts | null | undefined, now: number): string[] {
  if (!facts || (facts.lastPassAt === null && facts.lastReply === null)) return ['Leader state, model and messages unknown: no source records the leader session yet.'];
  const gaps: string[] = [];
  if (!leaderPassFresh(facts, now)) {
    const passed = facts.lastPassAt === null ? NaN : Date.parse(facts.lastPassAt);
    gaps.push(Number.isFinite(passed) && passed <= now
      ? `Leader state unknown: its last recorded pass ended ${sessionAge(Math.floor((now - passed) / 1000))} ago.`
      : 'Leader state unknown: its plan log records no pass with a readable time.');
  }
  if (facts.lastReply === null) gaps.push('Leader messages unknown: no reply to you is recorded yet.');
  gaps.push('Leader model unknown: no source records the model its passes run on.');
  return gaps;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const valid = (at: string | null | undefined): at is string => !!at && Number.isFinite(Date.parse(at));
const seconds = (at: string | null, now: number) => (at === null ? null : Math.max(0, Math.floor((now - Date.parse(at)) / 1000)));
const laneRank = (lane: string) => {
  const index = (ORG_LANES as readonly string[]).indexOf(lane);
  return lane === 'unknown' ? ORG_LANES.length + 1 : index < 0 ? ORG_LANES.length : index;
};

function row(map: MapSession, local: FleetSessionV1 | undefined, localNode: string, now: number): LiveSessionRow {
  const unknown: Partial<Record<SessionField, string>> = {};
  // A job only a computer's claim names: its records live on that computer.
  const elsewhere = local ? null : map.nodeId && map.nodeId !== localNode ? 'it runs on another computer; its records are only readable there' : 'no record of it on this computer';
  const known = (field: SessionField, value: string | null | undefined, why: string) => {
    const text = value?.trim();
    if (text && text !== 'unknown') return text;
    unknown[field] = elsewhere ?? why;
    return 'unknown';
  };
  const lane = known('lane', map.lane ?? local?.lane, 'the queue line names no lane');
  const model = known('model', map.model ?? local?.model, 'no launch record or model file names a model yet');
  const repo = known('repo', local?.repo, 'the queue line names no repo');
  const tier = known('tier', local?.tier, 'the queue line names no tier');
  const startedAt = valid(local?.startedAt) ? local.startedAt : null;
  if (startedAt === null) unknown.startedAt = elsewhere ?? 'no claim or launch time was recorded';
  const lastOutputAt = valid(local?.lastOutputAt) ? local.lastOutputAt : null;
  if (lastOutputAt === null) unknown.lastOutputAt = elsewhere ?? (local && 'lastOutputAt' in local ? 'the worker has not written a log yet' : 'this server does not report output times');
  const computer = map.nodeId ?? 'unknown';
  if (map.nodeId === null) unknown.computer = map.placement === 'conflict'
    ? 'more than one computer claims it' : 'no computer claims it and no worker process was seen on this computer';
  const outputAge = seconds(lastOutputAt, now);
  return { job: map.job, lane, model, repo, tier, status: map.status, startedAt, ageSeconds: seconds(startedAt, now),
    lastOutputAt, lastOutputAgeSeconds: outputAge, quiet: outputAge === null ? null : outputAge * 1000 > QUIET_MS,
    prUrl: map.prUrl ?? local?.prUrl ?? null, computer, thisComputer: map.nodeId === null ? null : map.nodeId === localNode,
    unknown: Object.fromEntries(SESSION_FIELDS.filter(field => field in unknown).map(field => [field, unknown[field]!])) };
}

export function buildLiveSessions(map: FleetSessionMap | null, now: number, filter: LiveSessionsFilter = {}): LiveSessionsV1 {
  const lane = filter.lane?.trim() || null, repo = filter.repo?.trim() || null;
  const gaps: string[] = [];
  const local = new Map((map?.sessions ?? []).map(session => [session.job, session]));
  const localNode = map?.localNodeId ?? '';
  const all = (map?.mapSessions ?? []).filter(session => SHOWN.has(session.status)).map(session => row(session, local.get(session.job), localNode, now));
  const sessions = all.filter(session => (!lane || session.lane === lane) && (!repo || session.repo === repo))
    .sort((a, b) => laneRank(a.lane) - laneRank(b.lane) || cmp(a.lane, b.lane)
      || (a.startedAt ? Date.parse(a.startedAt) : Infinity) - (b.startedAt ? Date.parse(b.startedAt) : Infinity) || cmp(a.job, b.job));

  if (!map) gaps.push('Sessions unknown: the session list could not be read.');
  else {
    if (!map.runsDirPresent) gaps.push('No runs directory on this computer: only jobs other computers claim can show.');
    else if (map.sourceState !== 'healthy') {
      const bad = Object.entries(map.sources).filter(([, state]) => state !== 'healthy' && state !== 'missing').map(([name]) => name);
      gaps.push(`Some session records were unreadable${bad.length ? ` (${bad.join(', ')})` : ''}; a session may be missing.`);
    }
    if (map.truncated) gaps.push('The list was cut at its size limit; some sessions are not shown.');
  }
  if (filter.subagents === null) gaps.push('Subagents unknown: the subagent records could not be read.');
  const tree = buildSessionTree(sessionRecords(sessions, map, filter.subagents ?? [], now, { live: filter.live, lane, repo, leader: filter.leader }), now);
  if (tree.roots.some(node => node.id === 'leader')) gaps.push(...leaderGaps(filter.leader, now));
  const quiet = sessions.filter(session => session.quiet).length;
  return { schema: LIVE_SESSIONS_SCHEMA, generatedAt: new Date(now).toISOString(), quietAfterMinutes: SESSION_QUIET_MINUTES,
    filter: { lane, repo },
    counts: { sessions: sessions.length, quiet, lanes: new Set(sessions.map(session => session.lane)).size,
      otherComputers: sessions.filter(session => session.thisComputer === false).length },
    sessions, gaps, live: filter.live === true, tree };
}

/** "45s", "12m", "3h 5m". */
export function sessionAge(value: number | null): string {
  if (value === null) return 'unknown';
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Every row of the tree with its depth, top to bottom. */
export function flatTree(nodes: readonly SessionNode[], depth = 0): { node: SessionNode; depth: number }[] {
  return nodes.flatMap(node => [{ node, depth }, ...flatTree(node.children, depth + 1)]);
}
/** "spoke 2m ago", or "last spoke unknown". */
export const spoke = (node: SessionNode): string => (node.lastMessageAgeSeconds === null ? 'last spoke unknown' : `spoke ${sessionAge(node.lastMessageAgeSeconds)} ago`);

/** `phm sessions` for people: the top line, then one indented row per session. */
export function renderLiveSessionsText(list: LiveSessionsV1): string {
  const scope = [list.filter.lane && `lane ${list.filter.lane}`, list.filter.repo && `repo ${list.filter.repo}`].filter(Boolean).join(', ');
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  const lines = [`${list.tree.line}${scope ? ` (${scope})` : ''}${list.counts.quiet ? `; ${list.counts.quiet} quiet (no output for ${list.quietAfterMinutes}+ min)` : ''}`];
  for (const { node, depth } of flatTree(list.tree.roots)) {
    const pad = '  '.repeat(depth), s = node.jobId === null ? undefined : rows.get(node.jobId);
    if (node.kind === 'unknown-parent') { lines.push(`${pad}unknown parent:`); continue; }
    const where = !s ? null : s.computer === 'unknown' ? 'computer unknown' : s.thisComputer ? `on ${s.computer} (this computer)` : `on ${s.computer}`;
    const named = (word: string, value: string) => (value === 'unknown' ? `${word} unknown` : value);
    lines.push(pad + [node.id, node.agent !== node.id && named('lane', node.agent), named('model', node.model), named('repo', node.repo), named('state', node.state),
      `${spoke(node)}${s?.quiet ? ' QUIET' : ''}`, where, s?.prUrl, node.lastMessage].filter(Boolean).join(' | '));
    for (const field of SESSION_FIELDS) if (s?.unknown[field]) lines.push(`${pad}  ${field} unknown: ${s.unknown[field]}`);
  }
  for (const gap of list.gaps) lines.push(`note: ${gap}`);
  lines.push(`Live log: phm fleet job <id> --log. Pause or stop: phm job pause|stop <id>. Updated ${list.generatedAt}.`);
  return lines.join('\n');
}
