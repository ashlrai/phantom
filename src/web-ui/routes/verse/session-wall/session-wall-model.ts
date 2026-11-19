/**
 * The Conversations pane's two reads. The wall is one request for every
 * session, GET /api/verse/fleet/control/session-threads (the
 * fleet.session-threads.v1 document `phm sessions threads --json` prints); an
 * opened conversation is GET /api/verse/fleet/control/session-thread?id=
 * (fleet.session-thread.v1). Both carry what Mason wrote and where the Leader
 * routed it. The wire shapes are narrowed here, so the pane
 * also builds against a server that predates either read. Narrowing is
 * defensive: a malformed entry or message is dropped, a malformed field reads
 * "unknown", and a body of another schema is no read at all.
 */
import { ApiError, apiGet, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const SESSION_THREADS_API = '/api/verse/fleet/control/session-threads';
export const SESSION_THREAD_API = '/api/verse/fleet/control/session-thread';
/** The server builds each read at most once per 5 s; the pane asks every 10 s while visible. */
export const WALL_POLL_MS = 10_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ENTRIES = 60, MAX_MESSAGES = 200, MAX_TEXT = 8_000, MAX_LINE = 400;

export const WALL_STATES = ['running', 'quiet', 'idle', 'done', 'failed', 'unknown'] as const;
export type WallState = (typeof WALL_STATES)[number];
export type WallSource = 'available' | 'none' | 'unavailable';
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
}
/** One session's conversation. On the wall `messages` holds only the newest few of `messageCount`. */
export interface WallEntry { session: WallSession; summary: string[]; messages: WallMessage[]; messageCount: number; gaps: string[] }
export interface SessionWallRead {
  generatedAt: string;
  /** Every session in the list; `entries` may hold fewer. Null when the read did not say. */
  total: number | null;
  entries: WallEntry[];
  gaps: string[];
}
export interface OpenThread extends WallEntry { generatedAt: string; sources: Record<'activity' | 'bus' | 'owner' | 'replies' | 'orders', WallSource> }

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = MAX_LINE): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(line => text(line)).filter((line): line is string => line !== null).slice(0, 20) : []);
const PR = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;
const SOURCES: readonly WallSource[] = ['available', 'none', 'unavailable'];

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

/** Null when the entry names no session. */
function narrowEntry(raw: unknown): WallEntry | null {
  if (!object(raw) || !object(raw.session)) return null;
  const s = raw.session, id = text(s.id), prUrl = text(s.prUrl);
  if (!id) return null;
  const seen = new Set<string>();
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(0, MAX_MESSAGES).map(narrowMessage)
    .filter((m): m is WallMessage => m !== null && !seen.has(m.key) && seen.add(m.key) !== undefined);
  return {
    session: {
      id, kind: oneOf(s.kind, ['leader', 'worker', 'subagent'] as const, 'worker'),
      lane: text(s.lane) ?? 'unknown', model: text(s.model) ?? 'unknown', repo: text(s.repo) ?? 'unknown',
      jobId: text(s.jobId), parentId: text(s.parentId), state: oneOf(s.state, WALL_STATES, 'unknown'),
      lastMessageAgeSeconds: count(s.lastMessageAgeSeconds), prUrl: prUrl && PR.test(prUrl) ? prUrl : null,
    },
    summary: lines(raw.summary), messages,
    // A count below what is shown would hide messages that are on screen.
    messageCount: Math.max(count(raw.messageCount) ?? 0, messages.length), gaps: lines(raw.gaps),
  };
}

/** Null when this is not a session-threads read. */
export function narrowSessionWall(raw: unknown): SessionWallRead | null {
  if (!object(raw) || raw.schema !== 'fleet.session-threads.v1' || !Array.isArray(raw.threads)) return null;
  const seen = new Set<string>();
  const entries = raw.threads.slice(0, MAX_ENTRIES).map(narrowEntry)
    .filter((entry): entry is WallEntry => entry !== null && !seen.has(entry.session.id) && seen.add(entry.session.id) !== undefined);
  const total = object(raw.counts) ? count(raw.counts.sessions) : null;
  return { generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(), total: total === null ? null : Math.max(total, entries.length), entries, gaps: lines(raw.gaps) };
}

/** Null when this is not a session thread, or it names no session. */
export function narrowOpenThread(raw: unknown): OpenThread | null {
  if (!object(raw) || raw.schema !== 'fleet.session-thread.v1') return null;
  const entry = narrowEntry(raw);
  if (!entry) return null;
  const sources = object(raw.sources) ? raw.sources : {};
  const source = (name: string) => oneOf(sources[name], SOURCES, 'unavailable');
  return { ...entry, messageCount: entry.messages.length, generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(),
    sources: { activity: source('activity'), bus: source('bus'), owner: source('owner'), replies: source('replies'), orders: source('orders') } };
}

export const sessionWallQuery: QueryDef<SessionWallRead | null> = {
  key: 'verse-fleet-session-threads',
  fetch: async signal => narrowSessionWall(await apiGet<unknown>(SESSION_THREADS_API, signal)),
};

export function openThreadQuery(id: string): QueryDef<OpenThread | null> {
  return {
    key: `verse-fleet-session-thread:${id}`,
    fetch: async signal => (SESSION_ID.test(id) ? narrowOpenThread(await apiGet<unknown>(`${SESSION_THREAD_API}?id=${encodeURIComponent(id)}`, signal)) : null),
  };
}

/** Why a read cannot be shown. `gone`: the list no longer holds the session. `unsupported`: the server has no such read. */
export interface WallFailure { kind: 'gone' | 'unsupported' | 'unavailable'; text: string }

export function wallFailure(error: unknown, what: 'wall' | 'thread'): WallFailure {
  if (error instanceof ApiError && error.status === 404) {
    // The thread route answers 404 with its own sentence for an id the list does not hold; any other 404 is a server without the route.
    if (what === 'thread' && error.detail && /^No session /.test(error.detail)) return { kind: 'gone', text: error.detail };
    return { kind: 'unsupported', text: what === 'wall'
      ? 'This Phantom server cannot read every session as a conversation yet. Update Phantom; until then the Sessions pane lists them.'
      : 'This Phantom server cannot read a session as a conversation yet. Update Phantom, or open its messages in the worker log.' };
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

const AIMABLE = /^RQ-[A-Z0-9-]+$/;
/** The job a message can be aimed at with `@`, for a worker that is still running. Null for everything else. */
export function aimableJob(session: WallSession): string | null {
  const live = session.state === 'running' || session.state === 'quiet';
  return live && session.jobId && AIMABLE.test(session.jobId) ? session.jobId : null;
}

/** One line under an opened conversation naming what each source holds, so an empty thread is never mistaken for a quiet session. */
export function sourcesLine(thread: OpenThread): string {
  const word = (name: string, source: WallSource) => `${name} ${source === 'available' ? 'shown' : source === 'none' ? 'none recorded' : 'unknown'}`;
  const { sources, session } = thread;
  return [word('Activity', sources.activity), word('bus messages', sources.bus), word('your messages', sources.owner),
    ...(session.kind === 'leader' ? [word('replies to you', sources.replies)] : []),
    // Only the leader and a worker are ever tied to one of Mason's messages; a helper has no routing to be unknown.
    ...(session.kind === 'subagent' ? [] : [word('routing', sources.orders)])].join(' · ');
}

const ROUTED_PR = /\s*(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+))\/?/;
/** One job of a routing record: the server's own words for it, and its pull request when the line names one. */
export interface RoutedJob { text: string; pr: { url: string; number: string } | null }
/** A `routing` message's text is one job per line (job, lane, how far it got). Nothing is re-derived here; a PR link is only lifted out to be clickable. */
export function routedJobs(text: string): RoutedJob[] {
  return text.split('\n').map(line => line.trim()).filter(line => line !== '').map(line => {
    const found = ROUTED_PR.exec(line);
    return found ? { text: line.replace(ROUTED_PR, '').trim(), pr: { url: found[1]!, number: found[2]! } } : { text: line, pr: null };
  });
}
