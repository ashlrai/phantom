/**
 * One session read as a conversation: GET /api/verse/fleet/control/session-thread?id=,
 * the fleet.session-thread.v1 document `phm sessions thread <id> --json` prints
 * (CONTRACT.md, "Session thread"). Narrowing is defensive: a malformed message
 * is dropped, a malformed field reads "unknown", and a body of another schema
 * is no thread at all. Where a reply goes is the server's answer (`reply`,
 * core/fleet/session-reply.ts); a body without one is read
 * with the same rule, so an older server still gets a reply box.
 */
import { isJobControlAction, type JobControlAction } from '../../../../core/fleet/job-control-types.js';
import { sessionReply, type SessionThreadReply } from '../../../../core/fleet/session-reply.js';
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
/** Who a reply written in the thread reaches, or why it cannot be sent from here. */
export type ReplyRoute =
  | { to: 'leader'; hint: string }
  | { to: 'job'; job: string; hint: string }
  | { to: 'none'; hint: string };
/** The pause, resume, stop or move that stands for the session's job, as the control file records it. */
export interface StandingControl { action: JobControlAction; lane: string | null; status: 'requested' | 'applied' }
export interface SessionThread {
  generatedAt: string;
  session: ThreadSession;
  summary: string[];
  messages: ThreadMessage[];
  /** `output` (the session's own log lines) is absent when the server that answered does not read it. */
  sources: { activity: ThreadSource; bus: ThreadSource; owner: ThreadSource; replies: ThreadSource; orders: ThreadSource; output?: ThreadSource; controls?: ThreadSource };
  gaps: string[];
  reply: ReplyRoute;
  /** Null when no request stands, and for a server that does not read the control file. */
  control: StandingControl | null;
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = MAX_LINE): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const time = (v: unknown): string | null => { const at = text(v); return at && Number.isFinite(Date.parse(at)) ? at : null; };
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(line => text(line)).filter((line): line is string => line !== null).slice(0, 20) : []);
const PR = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/;
const SOURCES: readonly ThreadSource[] = ['available', 'none', 'unavailable'];
const MENTION = /^@(RQ-[A-Z0-9-]+)$/;

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

const route = (reply: SessionThreadReply): ReplyRoute => {
  const job = reply.to === 'job' ? MENTION.exec(reply.mention ?? '')?.[1] : undefined;
  if (job) return { to: 'job', job, hint: reply.hint };
  return reply.to === 'leader' ? { to: 'leader', hint: reply.hint } : { to: 'none', hint: reply.hint };
};

/**
 * The server's `reply`, or the same rule applied here when the body carries none. A reply the server aims at a
 * job is believed only for this session's own job: a body never gets to aim Mason's words at another session.
 */
export function replyRoute(session: ThreadSession, raw?: unknown): ReplyRoute {
  const local = route(sessionReply(session));
  if (!object(raw)) return local;
  const hint = text(raw.hint), to = oneOf(raw.to, ['leader', 'job', 'none'] as const, 'none');
  if (!hint) return local;
  if (to === 'none') return { to, hint };
  if (to === 'leader') return session.kind === 'leader' ? { to, hint } : local;
  return MENTION.exec(text(raw.mention) ?? '')?.[1] === session.jobId && session.jobId !== null ? { to, job: session.jobId, hint } : local;
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
  const session: ThreadSession = {
    id, kind: oneOf(s.kind, ['leader', 'worker', 'subagent'] as const, 'worker'),
    lane: text(s.lane) ?? 'unknown', model: text(s.model) ?? 'unknown', repo: text(s.repo) ?? 'unknown',
    jobId: text(s.jobId), parentId: text(s.parentId),
    state: oneOf<ThreadState>(s.state, ['quiet', 'running', 'idle', 'done', 'failed', 'unknown'], 'unknown'),
    lastMessageAgeSeconds: age, prUrl: prUrl && PR.test(prUrl) ? prUrl : null,
  };
  const source = (name: string) => oneOf(sources[name], SOURCES, 'unavailable');
  return {
    generatedAt: time(raw.generatedAt) ?? new Date(0).toISOString(), session,
    summary: lines(raw.summary), messages,
    sources: { activity: source('activity'), bus: source('bus'), owner: source('owner'), replies: source('replies'), orders: source('orders'),
      ...(sources.output === undefined ? {} : { output: source('output') }), ...(sources.controls === undefined ? {} : { controls: source('controls') }) },
    gaps: lines(raw.gaps), reply: replyRoute(session, raw.reply), control: standing(raw.control),
  };
}

export function standing(raw: unknown): StandingControl | null {
  if (!object(raw) || !isJobControlAction(raw.action) || (raw.status !== 'requested' && raw.status !== 'applied')) return null;
  return { action: raw.action, lane: text(raw.lane, 40), status: raw.status };
}

/**
 * The job Pause, Stop and Move can reach from this conversation, or null: a worker with a job that is running,
 * quiet or of unknown state (the server refuses what it cannot do). A finished session has nothing to steer.
 */
export function steerable(thread: SessionThread): string | null {
  const { kind, jobId, state } = thread.session;
  return kind === 'worker' && jobId !== null && (state === 'running' || state === 'quiet' || state === 'unknown') ? jobId : null;
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

/** The exact text the send posts: the draft, aimed at the job when the route names one. Null when there is nothing to send. */
export function replyText(to: ReplyRoute, draft: string): string | null {
  const body = draft.replace(/\r\n/g, '\n').trim();
  if (!body || to.to === 'none') return null;
  const full = to.to === 'job' && !new RegExp(`(?:^|\\s)@${to.job}(?![A-Za-z0-9-])`).test(body) ? `@${to.job} ${body}` : body;
  return full.length > THREAD_REPLY_MAX ? null : full;
}

/** A message sent from here stays on screen only until the read holds Mason's own record of it. */
export const onRecord = (thread: SessionThread, sent: string): boolean => thread.messages.some(m => m.kind === 'owner' && m.text.trim() === sent);

/** One line of a routing record: `<job>, on <lane>: <state> [<pull request>]`, with the pull request split off when it is a GitHub one. */
export function routedRow(line: string): { text: string; pr: string | null } {
  const at = line.lastIndexOf(' '), url = at < 0 ? '' : line.slice(at + 1);
  return PR.test(url) ? { text: line.slice(0, at), pr: url } : { text: line, pr: null };
}

export const STATE_WORD: Readonly<Record<ThreadState, string>> = {
  quiet: 'quiet', running: 'running', idle: 'idle', done: 'done', failed: 'failed', unknown: 'state unknown',
};

/** One line under the conversation naming what each source holds, so an empty thread is never mistaken for a quiet session. */
export function sourcesLine(thread: SessionThread): string {
  const word = (name: string, source: ThreadSource) => `${name} ${source === 'available' ? 'shown' : source === 'none' ? 'none recorded' : 'unknown'}`;
  const { sources, session } = thread, leader = session.kind === 'leader';
  // Only a session with a job has a log to write to, and only a server that reads it says so.
  return [word('Activity', sources.activity), ...(sources.output !== undefined && session.jobId !== null ? [word('output', sources.output)] : []), word('bus messages', sources.bus),
    ...(session.kind === 'subagent' ? [] : [word('your messages', sources.owner)]),
    ...(leader ? [word('replies to you', sources.replies)] : []), word('routing', sources.orders),
    ...(sources.controls !== undefined && session.jobId !== null ? [word('control requests', sources.controls)] : [])].join(' · ');
}
