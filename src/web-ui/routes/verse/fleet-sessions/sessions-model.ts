/**
 * The Sessions pane's read: GET /api/verse/fleet/control/live-sessions, the
 * same fleet.live-sessions.v1 list `phm sessions --json` prints. Narrowing is
 * defensive: a malformed row is dropped, a malformed field reads "unknown".
 */
import { flatTree, SESSION_FIELDS, type LiveSessionRow, type LiveSessionsV1, type SessionField } from '../../../../core/fleet/live-sessions.js';
import { buildSessionTree, UNKNOWN_PARENT_ID, type SessionNode, type SessionRecord, type SessionState } from '../../../../core/fleet/session-tree.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const LIVE_SESSIONS_API = '/api/verse/fleet/control/live-sessions';
/** The server reads at most once per 5 s; the pane asks every 10 s while visible. */
export const SESSIONS_POLL_MS = 10_000;
const MAX_ROWS = 500, MAX_TEXT = 200;

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const PR = /^https:\/\/github\.com\/\S+$/;

function narrowRow(raw: unknown): LiveSessionRow | null {
  const job = object(raw) ? text(raw.job) : null;
  if (!object(raw) || !job) return null;
  const why = object(raw.unknown) ? raw.unknown : {};
  const unknown: Partial<Record<SessionField, string>> = {};
  for (const field of SESSION_FIELDS) { const reason = text(why[field]); if (reason) unknown[field] = reason; }
  const prUrl = text(raw.prUrl);
  return {
    job, lane: text(raw.lane) ?? 'unknown', model: text(raw.model) ?? 'unknown', repo: text(raw.repo) ?? 'unknown',
    tier: text(raw.tier) ?? 'unknown', status: text(raw.status) ?? 'unknown', startedAt: time(raw.startedAt), ageSeconds: count(raw.ageSeconds),
    lastOutputAt: time(raw.lastOutputAt), lastOutputAgeSeconds: count(raw.lastOutputAgeSeconds), quiet: bool(raw.quiet),
    prUrl: prUrl && PR.test(prUrl) ? prUrl : null, computer: text(raw.computer) ?? 'unknown', thisComputer: bool(raw.thisComputer), unknown,
  };
}

const STATES: readonly string[] = ['running', 'idle', 'done', 'failed', 'unknown'], KINDS: readonly string[] = ['leader', 'worker', 'subagent'];
/** The tree's rows, read back as records (children of "unknown parent" keep their missing parent id). */
function treeRecords(nodes: unknown, out: SessionRecord[] = [], depth = 0): SessionRecord[] {
  for (const raw of Array.isArray(nodes) && depth < 8 ? nodes : []) {
    const id = object(raw) ? text(raw.id) : null;
    if (!object(raw) || !id || out.length >= MAX_ROWS) continue;
    if (id !== UNKNOWN_PARENT_ID) out.push({
      id, parentId: text(raw.parentId), kind: KINDS.includes(raw.kind as string) ? raw.kind as SessionRecord['kind'] : undefined,
      agent: text(raw.agent) ?? 'unknown', lane: text(raw.lane) ?? 'unknown', model: text(raw.model) ?? 'unknown', repo: text(raw.repo) ?? 'unknown',
      jobId: text(raw.jobId), state: STATES.includes(raw.state as string) ? raw.state as SessionState : 'unknown',
      startedAt: time(raw.startedAt), lastMessageAt: time(raw.lastMessageAt), lastMessage: text(raw.lastMessage),
    });
    treeRecords(raw.children, out, depth + 1);
  }
  return out;
}

/** Null when this is not a live-sessions list. */
export function narrowLiveSessions(raw: unknown): LiveSessionsV1 | null {
  if (!object(raw) || raw.schema !== 'fleet.live-sessions.v1' || !Array.isArray(raw.sessions)) return null;
  const sessions = raw.sessions.slice(0, MAX_ROWS).map(narrowRow).filter((row): row is LiveSessionRow => row !== null);
  const filter = object(raw.filter) ? raw.filter : {};
  const generatedAt = time(raw.generatedAt) ?? new Date(0).toISOString();
  return {
    // Rebuilding the tree from its own rows re-derives every count, age and the top line, so a malformed tree cannot mislead.
    live: raw.live === true, tree: buildSessionTree(treeRecords(object(raw.tree) ? raw.tree.roots : null), Date.parse(generatedAt)),
    schema: 'fleet.live-sessions.v1', generatedAt,
    quietAfterMinutes: count(raw.quietAfterMinutes) ?? 10, filter: { lane: text(filter.lane), repo: text(filter.repo) },
    counts: { sessions: sessions.length, quiet: sessions.filter(row => row.quiet).length,
      lanes: new Set(sessions.map(row => row.lane)).size, otherComputers: sessions.filter(row => row.thisComputer === false).length },
    sessions, gaps: Array.isArray(raw.gaps) ? raw.gaps.map(text).filter((gap): gap is string => gap !== null).slice(0, 20) : [],
  };
}

export const liveSessionsQuery: QueryDef<LiveSessionsV1 | null> = {
  key: 'verse-fleet-live-sessions',
  fetch: async signal => narrowLiveSessions(await apiGet<unknown>(LIVE_SESSIONS_API, signal)),
};

/** The tree's top line, plus quiet sessions and sessions on another computer when there are any. */
export function sessionsHeadline(list: LiveSessionsV1): string {
  const { quiet, otherComputers } = list.counts;
  return [list.tree.line, ...(quiet ? [`${quiet} quiet`] : []), ...(otherComputers ? [`${otherComputers} on another computer`] : [])].join(' · ');
}

/** What the list can be narrowed to. "quiet" is the server's own flag (no output for `quietAfterMinutes`). */
export const SESSION_SCOPES = ['all', 'running', 'quiet', 'failed'] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];
/** One visible tree row. `context` marks a parent kept only so a matching session under it stays placed. */
export interface SessionTreeRow { node: SessionNode; depth: number; context: boolean }

const inScope = (scope: SessionScope, node: SessionNode, row: LiveSessionRow | undefined): boolean =>
  scope === 'all' || (scope === 'quiet' ? row?.quiet === true : node.state === scope);

/** Sessions per scope, counted from the same tree the rows come from (the "unknown parent" group is not a session). */
export function sessionScopeCounts(list: LiveSessionsV1): Record<SessionScope, number> {
  const rows = new Map(list.sessions.map(row => [row.job, row]));
  const counts: Record<SessionScope, number> = { all: 0, running: 0, quiet: 0, failed: 0 };
  for (const { node } of flatTree(list.tree.roots)) {
    if (node.kind === 'unknown-parent') continue;
    const row = node.jobId === null ? undefined : rows.get(node.jobId);
    for (const scope of SESSION_SCOPES) if (inScope(scope, node, row)) counts[scope] += 1;
  }
  return counts;
}

/**
 * The tree narrowed to one scope and a typed filter (every word must appear in the id, lane, model, repo, computer
 * or last message). A parent of a match stays as context, so a match keeps its place in the tree.
 */
export function filterSessionTree(list: LiveSessionsV1, scope: SessionScope, query: string): { rows: SessionTreeRow[]; matches: number } {
  const jobs = new Map(list.sessions.map(row => [row.job, row]));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0;
  const walk = (nodes: readonly SessionNode[], depth: number): SessionTreeRow[] => nodes.flatMap(node => {
    const row = node.jobId === null ? undefined : jobs.get(node.jobId);
    const hay = [node.id, node.agent, node.lane, node.model, node.repo, row?.computer, node.lastMessage].filter(Boolean).join('\n').toLowerCase();
    const hit = node.kind !== 'unknown-parent' && inScope(scope, node, row) && words.every(word => hay.includes(word));
    if (hit) matches += 1;
    const below = walk(node.children, depth + 1);
    return hit || below.length > 0 ? [{ node, depth, context: !hit && node.kind !== 'unknown-parent' }, ...below] : [];
  });
  return { rows: walk(list.tree.roots, 0), matches };
}
