/**
 * The Conversations pane's read: one request for every session,
 * GET /api/verse/fleet/control/session-threads (the fleet.session-threads.v1
 * document `phm sessions threads --json` prints). Each entry carries what
 * Mason wrote, where the Leader routed it, which message of Mason's it serves,
 * the pause, stop or move that stands for its job, what its job has done as numbers (`work`), and where a reply to that session would go. An opened conversation is the Sessions pane's own view and read
 * (fleet-sessions/SessionThread.tsx), so nothing about one thread is narrowed
 * here. The wire shape is narrowed, so the pane also builds against a server
 * that predates the read. Narrowing is defensive: a malformed entry or message
 * is dropped, a malformed field reads "unknown", and a body of another schema
 * is no read at all.
 */
import { SESSION_FILTER_RE } from '../../../../core/fleet/live-sessions.js';
import { ApiError, apiGet, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowHelpers, narrowWork, replyRoute, standing, type ReplyRoute, type StandingControl, type ThreadWork } from '../fleet-sessions/session-thread-model.js';

export const SESSION_THREADS_API = '/api/verse/fleet/control/session-threads';
/** The server builds the read at most once per 5 s; the pane asks every 10 s while visible. */
export const WALL_POLL_MS = 10_000;
const MAX_ENTRIES = 60, MAX_MESSAGES = 200, MAX_TEXT = 8_000, MAX_LINE = 400;

export const WALL_STATES = ['running', 'quiet', 'idle', 'done', 'failed', 'unknown'] as const;
export type WallState = (typeof WALL_STATES)[number];
export interface WallMessage {
  key: string; kind: string; side: 'session' | 'other' | 'record'; label: string; at: string | null; text: string;
  format: 'plain' | 'mono' | 'markdown'; truncated: boolean;
}
export interface WallSession {
  id: string; kind: 'leader' | 'worker' | 'subagent';
  lane: string; model: string; repo: string;
  jobId: string | null; parentId: string | null;
  state: WallState;
  lastMessageAgeSeconds: number | null;
  prUrl: string | null;
  /** The helpers below it, as the session list counts them; null when the read did not say. */
  helpers: { below: number; running: number; failed: number } | null;
}
/** What a session's job has done, as the read's `work` key gives it: the shape, and the narrowing, an opened conversation uses for the same key. */
export type WallWork = ThreadWork;
/** The message of Mason's a session's job serves, as the read ties them (the job's prompt cites it). */
export interface WallServes {
  /** The same on every session serving the same message. */
  key: string;
  /** The message's time as the inbox wrote it: Eastern wall time to the minute. */
  at: string;
  source: string | null;
  /** Mason's words; null when the read did not hold them. */
  text: string | null;
  truncated: boolean;
  /** Every job routed for the message, on screen or not; null when the read did not say. */
  jobs: number | null;
}
/** One session's short conversation: `messages` holds only the newest few of `messageCount`. */
export interface WallEntry {
  session: WallSession; summary: string[]; messages: WallMessage[]; messageCount: number; gaps: string[];
  /** Where words written to this session go: the read's own answer, or the same rule applied here for a server that sends none. */
  reply: ReplyRoute;
  /** Null when its job cites no message of Mason's, and from a server that does not say. */
  serves: WallServes | null;
  /** The pause, resume, stop or move that stands for the session's job, as the control file records it. Null when none stands, and from a server that does not say. */
  control: StandingControl | null;
  /** Null for a session with no job, when its activity was not read, and from a server that does not say. */
  work: WallWork | null;
}
/** `ended` is finished or failed; `unknown` is every other state that is not running. */
export interface WallUnshown { running: number; ended: number; unknown: number }
export interface SessionWallRead {
  generatedAt: string;
  /** Every session in the list; `entries` may hold fewer. Null when the read did not say. */
  total: number | null;
  /** The sessions the read left out because it holds a fixed number, by what the list says of each. Null when the read did not say. */
  unshown: WallUnshown | null;
  entries: WallEntry[];
  gaps: string[];
  /** The narrowing the server says it applied; null when the read did not say. */
  scope: WallScope | null;
}

/** What the wall asks the server to narrow to. The route matches lane and repo exactly; `live` keeps only running sessions. */
export interface WallScope { lane: string | null; repo: string | null; live: boolean }
export const NO_SCOPE: WallScope = { lane: null, repo: null, live: false };
export const isScoped = (scope: WallScope) => scope.lane !== null || scope.repo !== null || scope.live;
export const sameScope = (a: WallScope, b: WallScope) => a.lane === b.lane && a.repo === b.repo && a.live === b.live;
/** A lane or repo the route accepts as a filter; anything else is never offered or sent. */
export const scopeName = (v: unknown): string | null => (typeof v === 'string' && v !== 'unknown' && SESSION_FILTER_RE.test(v) ? v : null);

/** The scope in words, for the line that says what is on screen: "lane codex, repo phantom, running only". */
export function scopeWords(scope: WallScope): string {
  return [scope.lane && `lane ${scope.lane}`, scope.repo && `repo ${scope.repo}`, scope.live && 'running only'].filter(Boolean).join(', ');
}

/** The read's address for one scope. An unscoped wall asks the bare path, so every surface shares that request. */
export function wallPath(scope: WallScope): string {
  const params = new URLSearchParams();
  if (scope.lane) params.set('lane', scope.lane);
  if (scope.repo) params.set('repo', scope.repo);
  if (scope.live) params.set('live', '1');
  const query = params.toString();
  return query ? `${SESSION_THREADS_API}?${query}` : SESSION_THREADS_API;
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = MAX_LINE): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(line => text(line)).filter((line): line is string => line !== null).slice(0, 20) : []);
const PR = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;

function narrowMessage(raw: unknown): WallMessage | null {
  if (!object(raw)) return null;
  const key = text(raw.key), body = text(raw.text, MAX_TEXT);
  if (!key || body === null) return null;
  return {
    key, kind: text(raw.kind) ?? 'unknown', side: oneOf(raw.side, ['session', 'other', 'record'] as const, 'record'),
    // A leader reply's `at` is its own heading time, not always ISO; anything that does not parse reads as no time.
    label: text(raw.label) ?? 'Unlabelled', at: time(raw.at), text: body,
    format: oneOf(raw.format, ['plain', 'mono', 'markdown'] as const, 'plain'), truncated: raw.truncated === true,
  };
}

/** Null unless it names a message and its time; a count that is not one reads as unknown. */
function narrowServes(raw: unknown): WallServes | null {
  if (!object(raw)) return null;
  const key = text(raw.key), at = text(raw.at);
  if (!key || !at) return null;
  return { key, at, source: text(raw.source), text: text(raw.text, MAX_TEXT), truncated: raw.truncated === true, jobs: count(raw.jobs) };
}

/** Null when the entry names no session. */
function narrowEntry(raw: unknown): WallEntry | null {
  if (!object(raw) || !object(raw.session)) return null;
  const s = raw.session, id = text(s.id), prUrl = text(s.prUrl);
  if (!id) return null;
  const seen = new Set<string>();
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(0, MAX_MESSAGES).map(narrowMessage)
    .filter((m): m is WallMessage => m !== null && !seen.has(m.key) && seen.add(m.key) !== undefined);
  const session: WallSession = {
    id, kind: oneOf(s.kind, ['leader', 'worker', 'subagent'] as const, 'worker'),
    lane: text(s.lane) ?? 'unknown', model: text(s.model) ?? 'unknown', repo: text(s.repo) ?? 'unknown',
    jobId: text(s.jobId), parentId: text(s.parentId), state: oneOf(s.state, WALL_STATES, 'unknown'),
    lastMessageAgeSeconds: count(s.lastMessageAgeSeconds), prUrl: prUrl && PR.test(prUrl) ? prUrl : null,
    helpers: narrowHelpers(s.helpers),
  };
  return {
    session, summary: lines(raw.summary), messages,
    // A count below what is shown would hide messages that are on screen.
    messageCount: Math.max(count(raw.messageCount) ?? 0, messages.length), gaps: lines(raw.gaps),
    // Believed only for this session's own job, the rule the opened conversation applies to the same field.
    reply: replyRoute(session, raw.reply),
    // Only a worker serves a message; the leader routes them and a helper stands with its worker.
    serves: session.kind === 'worker' ? narrowServes(raw.serves) : null,
    // Asked of a job, so believed only on a session that has one.
    control: session.jobId !== null ? standing(raw.control) : null,
    // Work is a job's, so it is believed only on a session that has one.
    work: session.jobId !== null ? narrowWork(raw.work) : null,
  };
}

/** Believed only when all three are counts. */
function narrowUnshown(raw: unknown): WallUnshown | null {
  if (!object(raw)) return null;
  const running = count(raw.running), ended = count(raw.ended), unknown = count(raw.unknown);
  return running === null || ended === null || unknown === null ? null : { running, ended, unknown };
}

/** Null when this is not a session-threads read. */
export function narrowSessionWall(raw: unknown): SessionWallRead | null {
  if (!object(raw) || raw.schema !== 'fleet.session-threads.v1' || !Array.isArray(raw.threads)) return null;
  const seen = new Set<string>();
  const entries = raw.threads.slice(0, MAX_ENTRIES).map(narrowEntry)
    .filter((entry): entry is WallEntry => entry !== null && !seen.has(entry.session.id) && seen.add(entry.session.id) !== undefined);
  const total = object(raw.counts) ? count(raw.counts.sessions) : null;
  const f = object(raw.filter) ? raw.filter : null;
  // Believed only when every part is a value the route could have applied.
  const scope = f && (f.lane === null || scopeName(f.lane)) && (f.repo === null || scopeName(f.repo)) && typeof f.live === 'boolean'
    ? { lane: scopeName(f.lane), repo: scopeName(f.repo), live: f.live } : null;
  return { generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(), total: total === null ? null : Math.max(total, entries.length),
    unshown: object(raw.counts) ? narrowUnshown(raw.counts.unshown) : null, entries, gaps: lines(raw.gaps), scope };
}

export const sessionWallQuery: QueryDef<SessionWallRead | null> = {
  key: 'verse-fleet-session-threads',
  fetch: async signal => narrowSessionWall(await apiGet<unknown>(SESSION_THREADS_API, signal)),
};

/** One cache entry per scope, so coming back to a scope shows its last read at once. */
export function sessionWallQueryFor(scope: WallScope): QueryDef<SessionWallRead | null> {
  if (!isScoped(scope)) return sessionWallQuery;
  const path = wallPath(scope);
  return { key: `${sessionWallQuery.key}:${path.slice(SESSION_THREADS_API.length)}`, fetch: async signal => narrowSessionWall(await apiGet<unknown>(path, signal)) };
}

/** Lanes or repos a scope can name, gathered from the sessions read so far; `known` keeps earlier ones while the list is narrowed. The same array comes back when nothing is new. */
export function scopeChoices(known: readonly string[], entries: readonly WallEntry[], field: 'lane' | 'repo', chosen: string | null): readonly string[] {
  const all = new Set(known);
  for (const { session } of entries) { const name = scopeName(session[field]); if (name) all.add(name); }
  if (chosen) all.add(chosen);
  return all.size === known.length ? known : [...all].sort((a, b) => a.localeCompare(b));
}

/**
 * The sessions on screen that hold every word typed in the find box, in any
 * of: id, kind, lane, model, repo, parent, state, summary, and the messages
 * the read returned for the card. It does not search the whole conversation,
 * nor sessions the read left out.
 */
export function findEntries(entries: readonly WallEntry[], find: string): readonly WallEntry[] {
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return entries;
  return entries.filter(({ session, summary, messages }) => {
    const hay = [session.id, session.kind, session.lane, session.model, session.repo, session.parentId ?? '', STATE_WORD[session.state], ...summary,
      ...messages.flatMap(message => [message.label, message.text])].join('\n').toLowerCase();
    return words.every(word => hay.includes(word));
  });
}

/** Why the wall cannot be shown. `unsupported`: the server has no such read. */
export interface WallFailure { kind: 'unsupported' | 'unavailable'; text: string }

export function wallFailure(error: unknown): WallFailure {
  if (error instanceof ApiError && error.status === 404) {
    return { kind: 'unsupported', text: 'This Phantom server cannot read every session as a conversation yet. Update Phantom; until then the Sessions pane lists them.' };
  }
  if (error instanceof ApiError && error.status === 503) return { kind: 'unavailable', text: 'The session list could not be read just now. It retries every few seconds.' };
  return { kind: 'unavailable', text: `${readFailureReason(error)} It retries every few seconds.` };
}

export const STATE_WORD: Readonly<Record<WallState, string>> = {
  running: 'running', quiet: 'quiet', idle: 'idle', done: 'done', failed: 'failed', unknown: 'state unknown',
};

/** How many of the shown sessions are in each state, counted from the entries so the filter never disagrees with the cards. */
export function stateCounts(entries: readonly WallEntry[]): Record<WallState, number> {
  const counts = Object.fromEntries(WALL_STATES.map(state => [state, 0])) as Record<WallState, number>;
  for (const entry of entries) counts[entry.session.state] += 1;
  return counts;
}

/** The line above the wall. Sessions the read left out are counted, never dropped silently. */
export function wallHeadline(read: SessionWallRead): string {
  const shown = read.entries.length;
  if (shown === 0) return read.total ? `${read.total} sessions, none of them readable as a conversation` : 'No agent sessions';
  const counts = stateCounts(read.entries);
  const by = WALL_STATES.filter(state => counts[state] > 0).map(state => `${counts[state]} ${STATE_WORD[state]}`).join(', ');
  const more = read.total !== null && read.total > shown ? ` of ${read.total}` : '';
  return `${shown}${more} session${(read.total ?? shown) === 1 ? '' : 's'}: ${by}`;
}

/** A card's last line: where a reply written in its conversation goes, in a few words. The whole sentence is the route's `hint`. */
export function replyLine(reply: ReplyRoute): string {
  return reply.to === 'job' ? `Reply goes to @${reply.job}` : reply.to === 'leader' ? 'Reply goes to the Leader\'s inbox' : 'Read only';
}
