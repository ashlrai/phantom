/**
 * One session read as a conversation: GET /api/verse/fleet/control/session-thread?id=,
 * the fleet.session-thread.v1 document `phm sessions thread <id> --json` prints.
 * The shapes below are the wire contract (CONTRACT.md, "Session thread"); they
 * are declared here so the pane also builds against a server that predates the
 * read. Narrowing is defensive: a malformed message is dropped, a malformed
 * field reads "unknown", and a body of another schema is no thread at all.
 */
import { ApiError, apiGet, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const SESSION_THREAD_API = '/api/verse/fleet/control/session-thread';
/** The server shares one session map for 5 s; the open thread asks every 10 s while visible. */
export const THREAD_POLL_MS = 10_000;
/** Mirror of the inbox limit (core/fleet/mason-inbox.ts); the server re-checks. */
export const THREAD_REPLY_MAX = 6_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MESSAGES = 200, MAX_TEXT = 8_000, MAX_LINE = 400;

export type ThreadSide = 'session' | 'other' | 'record';
export type ThreadFormat = 'plain' | 'mono' | 'markdown';
export type ThreadState = 'quiet' | 'running' | 'idle' | 'done' | 'failed' | 'unknown';
export type ThreadSource = 'available' | 'none' | 'unavailable';

export interface ThreadMessage { key: string; kind: string; side: ThreadSide; label: string; at: string | null; text: string; format: ThreadFormat }
export interface ThreadSession {
  id: string; kind: 'leader' | 'worker' | 'subagent';
  lane: string; model: string; repo: string;
  jobId: string | null; parentId: string | null;
  state: ThreadState;
  lastMessageAgeSeconds: number | null;
  prUrl: string | null;
}
export interface SessionThread {
  generatedAt: string;
  session: ThreadSession;
  summary: string[];
  messages: ThreadMessage[];
  sources: { activity: ThreadSource; bus: ThreadSource; replies: ThreadSource };
  gaps: string[];
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = MAX_LINE): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(line => text(line)).filter((line): line is string => line !== null).slice(0, 20) : []);
const PR = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;
const SOURCES: readonly ThreadSource[] = ['available', 'none', 'unavailable'];

function narrowMessage(raw: unknown): ThreadMessage | null {
  if (!object(raw)) return null;
  const key = text(raw.key), body = text(raw.text, MAX_TEXT);
  if (!key || body === null) return null;
  return {
    key, kind: text(raw.kind) ?? 'unknown', side: oneOf<ThreadSide>(raw.side, ['session', 'other', 'record'], 'record'),
    // A leader reply's `at` is its own heading time, not always ISO; anything that does not parse reads as no time.
    label: text(raw.label) ?? 'Unlabelled', at: time(raw.at), text: body, format: oneOf<ThreadFormat>(raw.format, ['plain', 'mono', 'markdown'], 'plain'),
  };
}

/** Null when this is not a session thread, or it names no session. */
export function narrowSessionThread(raw: unknown): SessionThread | null {
  if (!object(raw) || raw.schema !== 'fleet.session-thread.v1' || !object(raw.session)) return null;
  const s = raw.session, id = text(s.id);
  if (!id) return null;
  const age = typeof s.lastMessageAgeSeconds === 'number' && Number.isFinite(s.lastMessageAgeSeconds) && s.lastMessageAgeSeconds >= 0 ? s.lastMessageAgeSeconds : null;
  const prUrl = text(s.prUrl), sources = object(raw.sources) ? raw.sources : {};
  const seen = new Set<string>();
  const messages = (Array.isArray(raw.messages) ? raw.messages : []).slice(0, MAX_MESSAGES).map(narrowMessage)
    .filter((m): m is ThreadMessage => m !== null && !seen.has(m.key) && seen.add(m.key) !== undefined);
  return {
    generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(),
    session: {
      id, kind: oneOf(s.kind, ['leader', 'worker', 'subagent'] as const, 'worker'),
      lane: text(s.lane) ?? 'unknown', model: text(s.model) ?? 'unknown', repo: text(s.repo) ?? 'unknown',
      jobId: text(s.jobId), parentId: text(s.parentId),
      state: oneOf<ThreadState>(s.state, ['quiet', 'running', 'idle', 'done', 'failed', 'unknown'], 'unknown'),
      lastMessageAgeSeconds: age, prUrl: prUrl && PR.test(prUrl) ? prUrl : null,
    },
    summary: lines(raw.summary), messages,
    sources: { activity: oneOf(sources.activity, SOURCES, 'unavailable'), bus: oneOf(sources.bus, SOURCES, 'unavailable'), replies: oneOf(sources.replies, SOURCES, 'unavailable') },
    gaps: lines(raw.gaps),
  };
}

/** Why no thread can be shown. `gone` is the server saying the list no longer holds the session. */
export type ThreadFailure = { kind: 'gone' | 'unsupported' | 'unavailable'; text: string };

export function threadFailure(error: unknown): ThreadFailure {
  if (error instanceof ApiError && error.status === 404) {
    // The route answers 404 with its own sentence for an id the list does not hold; any other 404 is a server without the route.
    return error.detail && /^No session /.test(error.detail) ? { kind: 'gone', text: error.detail }
      : { kind: 'unsupported', text: 'This Phantom server cannot read a session as a conversation yet. Update Phantom, or open its messages in the worker log.' };
  }
  if (error instanceof ApiError && error.status === 503) return { kind: 'unavailable', text: 'The session list could not be read just now. It retries every few seconds.' };
  return { kind: 'unavailable', text: `${readFailureReason(error)} It retries every few seconds.` };
}

export function sessionThreadQuery(id: string): QueryDef<SessionThread | null> {
  return {
    key: `verse-fleet-session-thread:${id}`,
    fetch: async signal => (SESSION_ID.test(id) ? narrowSessionThread(await apiGet<unknown>(`${SESSION_THREAD_API}?id=${encodeURIComponent(id)}`, signal)) : null),
  };
}

/** Who a reply written in the thread reaches, or why it cannot be sent from here. */
export type ReplyRoute =
  | { to: 'leader'; hint: string }
  | { to: 'job'; job: string; hint: string }
  | { to: 'none'; hint: string };

const AIMABLE = /^RQ-[A-Z0-9-]+$/;

export function replyRoute(session: ThreadSession): ReplyRoute {
  if (session.kind === 'leader') return { to: 'leader', hint: 'Goes to the Leader\'s inbox, the same as the Leader chat.' };
  const live = session.state === 'running' || session.state === 'quiet';
  if (session.jobId && AIMABLE.test(session.jobId) && live) {
    return { to: 'job', job: session.jobId, hint: `Goes to the Leader's inbox with @${session.jobId} in front, so the Leader knows which session you mean.` };
  }
  if (!live) return { to: 'none', hint: 'This session is not running, so there is nothing to steer. Write to the Leader in the Leader chat.' };
  return { to: 'none', hint: 'This session has no job id a message can be aimed at. Write to the Leader in the Leader chat.' };
}

/** The exact text the send posts: the draft, aimed at the job when the route names one. Null when there is nothing to send. */
export function replyText(route: ReplyRoute, draft: string): string | null {
  const body = draft.replace(/\r\n/g, '\n').trim();
  if (!body || route.to === 'none') return null;
  const full = route.to === 'job' && !new RegExp(`(?:^|\\s)@${route.job}(?![A-Za-z0-9-])`).test(body) ? `@${route.job} ${body}` : body;
  return full.length > THREAD_REPLY_MAX ? null : full;
}

export const STATE_WORD: Readonly<Record<ThreadState, string>> = {
  quiet: 'quiet', running: 'running', idle: 'idle', done: 'done', failed: 'failed', unknown: 'state unknown',
};

/** One line under the conversation naming what each source holds, so an empty thread is never mistaken for a quiet session. */
export function sourcesLine(thread: SessionThread): string {
  const word = (name: string, source: ThreadSource) => `${name} ${source === 'available' ? 'shown' : source === 'none' ? 'none recorded' : 'unknown'}`;
  const { sources, session } = thread;
  return [word('Activity', sources.activity), word('bus messages', sources.bus), ...(session.kind === 'leader' ? [word('replies to you', sources.replies)] : [])].join(' · ');
}
