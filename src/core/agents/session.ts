/**
 * Resumable agent sessions, modeled on Claude Managed Agents sessions.
 *
 * A session is an agent profile reference (id + version), an environment id
 * and an append-only JSONL event log. Each turn is one queue.v1 job (the
 * `phm queue` store): the session never claims, dispatches or finishes a job.
 * It observes the turn jobs' queue statuses and records changes in its log,
 * so dispatchd and the queue store stay unchanged.
 *
 * Status is folded from the log:
 *   running       the latest turn's job is still in flight (READY, CLAIMED, ...)
 *   idle          the latest turn ended (DONE, PR-OPEN, RETIRED, DROPPED)
 *   rescheduling  the latest turn is BLOCKED; resume retries it
 *   terminated    the owner ended the session; nothing resumes it
 *
 * Files live under `<ASHLR_HOME>/agent-sessions/<id>.jsonl` (mode 0600,
 * directory 0700). Symlinks are refused. Events carry ids and statuses only:
 * job scope text stays in the queue, and a termination reason is scrubbed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ashlrHome } from '../cloud/store.js';
import { QueueStore } from '../queue/store.js';
import { QUEUE_STATUSES, type QueueDocument, type QueueJob, type QueueStatus } from '../queue/schema.js';
import { scrubSecrets } from '../util/scrub-secrets.js';

export const SESSION_STATUSES = ['idle', 'running', 'rescheduling', 'terminated'] as const;
export type SessionStatus = typeof SESSION_STATUSES[number];
export type TurnSource = 'create' | 'resume' | 'retry' | 'replay';

const SESSION_ID = /^sesn_[0-9a-f]{16}$/;
/** Same shape as agent profile ids, so a profile id is always accepted. */
const AGENT_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;
const ENVIRONMENT_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const MAX_REASON = 200;
const LOCK_TIMEOUT_MS = 5_000;
export const MAX_TURNS = 500;
/** Queue statuses after which a turn is over. BLOCKED is over too, but retryable. */
const ENDED: ReadonlySet<QueueStatus> = new Set(['DONE', 'PR-OPEN', 'RETIRED', 'DROPPED']);

interface EventBase { seq: number; ts: string }
export type SessionEvent = EventBase & (
  | { type: 'session.created'; agent: { id: string; version: number }; environmentId: string; queueDir: string }
  | { type: 'turn.queued'; turn: number; jobId: string; source: TurnSource; queueStatus: QueueStatus }
  | { type: 'turn.observed'; turn: number; jobId: string; queueStatus: QueueStatus }
  | { type: 'session.terminated'; reason?: string }
);
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type EventDraft = DistributiveOmit<SessionEvent, 'seq' | 'ts'>;

export interface SessionTurn { turn: number; jobId: string; source: TurnSource; queuedAt: string; queueStatus: QueueStatus }
export interface AgentSession {
  schema: 'agent-session.v1';
  id: string;
  status: SessionStatus;
  agent: { id: string; version: number };
  environmentId: string;
  queueDir: string;
  createdAt: string;
  updatedAt: string;
  turns: SessionTurn[];
  terminatedAt?: string;
  terminationReason?: string;
  /** Log lines that failed to parse (a torn write, a hand edit). They are skipped, never rewritten. */
  skippedLines: number;
  /** Set when the queue could not be read; status then reflects the last observation. */
  queueError?: string;
}

export type SessionErrorCode = 'invalid-id' | 'invalid' | 'not-found' | 'running' | 'terminated' | 'no-retry' | 'busy' | 'conflict';
export class AgentSessionError extends Error {
  constructor(readonly code: SessionErrorCode, message: string) { super(message); this.name = 'AgentSessionError'; }
}

export interface SessionStoreOptions {
  /** Session log directory. Defaults to `<ASHLR_HOME>/agent-sessions`. */
  dir?: string;
}
export const sessionsDir = (options: SessionStoreOptions = {}): string => options.dir ?? join(ashlrHome(), 'agent-sessions');
export const isAgentSessionId = (id: string): boolean => SESSION_ID.test(id);
const logPath = (dir: string, id: string): string => join(dir, `${id}.jsonl`);
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

function assertId(id: string): void {
  if (!isAgentSessionId(id)) throw new AgentSessionError('invalid-id', `"${id.slice(0, 40)}" is not an agent session id (sesn_ plus 16 hex digits)`);
}

/** Validate the id and confirm the log exists before taking its lock, so a typo leaves no lock file behind. */
async function existingDir(id: string, options: SessionStoreOptions): Promise<string> {
  assertId(id);
  const dir = sessionsDir(options);
  try { await lstat(logPath(dir, id)); }
  catch (error) { if (missing(error)) throw new AgentSessionError('not-found', `No agent session ${id}. See: phm sessions list`); throw error; }
  return dir;
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new AgentSessionError('invalid', 'Agent session directory cannot be a symlink');
}

/** Exclusive lock file; a busy lock is reported, never stolen. */
async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let lock;
  for (;;) {
    try { lock = await open(path, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new AgentSessionError('busy', `Session lock busy: ${path}`);
      await delay(10);
    }
  }
  const token = randomUUID();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token }));
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    const held = await readFile(path, 'utf8').catch(() => undefined);
    if (held?.includes(token)) await unlink(path).catch(error => { if (!missing(error)) throw error; });
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStatus = (v: unknown): v is QueueStatus => QUEUE_STATUSES.includes(v as QueueStatus);
const isTurn = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_TURNS;
const isJobId = (v: unknown): v is string => typeof v === 'string' && JOB_ID.test(v);

/** Strict per-type shape check; anything else counts as a skipped line. */
function parseEvent(line: string): SessionEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!isRecord(value) || !Number.isInteger(value.seq) || typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts))) return undefined;
  switch (value.type) {
    case 'session.created': {
      const agent = value.agent;
      return isRecord(agent) && typeof agent.id === 'string' && AGENT_ID.test(agent.id) && Number.isSafeInteger(agent.version) && (agent.version as number) >= 1 &&
        typeof value.environmentId === 'string' && ENVIRONMENT_ID.test(value.environmentId) && typeof value.queueDir === 'string' && value.queueDir.length > 0
        ? value as unknown as SessionEvent : undefined;
    }
    case 'turn.queued':
      return isTurn(value.turn) && isJobId(value.jobId) && isStatus(value.queueStatus) && ['create', 'resume', 'retry', 'replay'].includes(value.source as string)
        ? value as unknown as SessionEvent : undefined;
    case 'turn.observed':
      return isTurn(value.turn) && isJobId(value.jobId) && isStatus(value.queueStatus) ? value as unknown as SessionEvent : undefined;
    case 'session.terminated':
      return value.reason === undefined || typeof value.reason === 'string' ? value as unknown as SessionEvent : undefined;
    default:
      return undefined;
  }
}

interface LogRead { events: SessionEvent[]; skipped: number; endsWithNewline: boolean }

async function readLog(dir: string, id: string): Promise<LogRead> {
  let handle;
  try { handle = await open(logPath(dir, id), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch (error) {
    if (missing(error)) throw new AgentSessionError('not-found', `No agent session ${id}. See: phm sessions list`);
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new AgentSessionError('invalid', 'Symlinked agent session logs are refused');
    throw error;
  }
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AgentSessionError('invalid', 'Agent session log must be a regular file');
    if (info.size > MAX_LOG_BYTES) throw new AgentSessionError('invalid', `Agent session log exceeds ${MAX_LOG_BYTES} bytes`);
    text = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const events: SessionEvent[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const event = parseEvent(line);
    if (event) events.push(event); else skipped += 1;
  }
  if (events[0]?.type !== 'session.created') throw new AgentSessionError('invalid', `Agent session log ${id} has no session.created event`);
  return { events, skipped, endsWithNewline: text.length === 0 || text.endsWith('\n') };
}

/** Pure fold of an event log into the session view. */
export function foldSession(id: string, events: readonly SessionEvent[], skippedLines = 0): AgentSession {
  const created = events[0];
  if (created?.type !== 'session.created') throw new AgentSessionError('invalid', `Agent session log ${id} has no session.created event`);
  const session: AgentSession = {
    schema: 'agent-session.v1', id, status: 'idle', agent: { ...created.agent }, environmentId: created.environmentId,
    queueDir: created.queueDir, createdAt: created.ts, updatedAt: created.ts, turns: [], skippedLines,
  };
  for (const event of events.slice(1)) {
    session.updatedAt = event.ts;
    if (event.type === 'turn.queued') {
      // Turns are strictly sequential; a duplicate or out-of-order turn is a corrupt line.
      if (event.turn !== session.turns.length + 1) { session.skippedLines += 1; continue; }
      session.turns.push({ turn: event.turn, jobId: event.jobId, source: event.source, queuedAt: event.ts, queueStatus: event.queueStatus });
    } else if (event.type === 'turn.observed') {
      const turn = session.turns[event.turn - 1];
      if (turn?.jobId === event.jobId) turn.queueStatus = event.queueStatus; else session.skippedLines += 1;
    } else if (event.type === 'session.terminated') {
      session.terminatedAt ??= event.ts;
      if (event.reason !== undefined) session.terminationReason ??= event.reason;
    } else {
      session.skippedLines += 1;
    }
  }
  session.status = statusOf(session);
  return session;
}

function statusOf(session: AgentSession): SessionStatus {
  if (session.terminatedAt) return 'terminated';
  const last = session.turns.at(-1);
  if (!last || ENDED.has(last.queueStatus)) return 'idle';
  return last.queueStatus === 'BLOCKED' ? 'rescheduling' : 'running';
}

async function append(dir: string, id: string, read: LogRead, drafts: EventDraft[]): Promise<SessionEvent[]> {
  if (!drafts.length) return read.events;
  let seq = read.events.reduce((max, event) => Math.max(max, event.seq), 0);
  const ts = new Date().toISOString();
  const added = drafts.map(draft => ({ seq: ++seq, ts, ...draft }) as SessionEvent);
  // A torn trailing line gets its own line so the new events stay parseable.
  const text = (read.endsWithNewline ? '' : '\n') + added.map(event => JSON.stringify(event)).join('\n') + '\n';
  const handle = await open(logPath(dir, id), fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  return [...read.events, ...added];
}

/** Events that bring the log up to date with the queue. Pure. */
export function observeQueue(session: AgentSession, doc: QueueDocument): EventDraft[] {
  if (session.status === 'terminated') return [];
  const drafts: EventDraft[] = [];
  const jobs = new Map(doc.jobs.map(job => [job.id, job]));
  // A job missing from the queue keeps its last observed status.
  const statuses = session.turns.map(turn => jobs.get(turn.jobId)?.status ?? turn.queueStatus);
  session.turns.forEach((turn, index) => {
    if (statuses[index] !== turn.queueStatus) drafts.push({ type: 'turn.observed', turn: turn.turn, jobId: turn.jobId, queueStatus: statuses[index] });
  });
  const last = session.turns.at(-1);
  if (!last || session.turns.length >= MAX_TURNS) return drafts;
  const known = new Set(session.turns.map(turn => turn.jobId));
  // A resume whose log append failed after the job was added: the job id names its turn.
  const orphan = jobs.get(`${session.id}.t${last.turn + 1}`);
  // `phm queue replay --failed` retries a BLOCKED job as a new job; adopt it as the next turn.
  const replay = statuses.at(-1) === 'BLOCKED' ? doc.jobs.find(job => job.replayOf === last.jobId && !known.has(job.id)) : undefined;
  const next = orphan && !known.has(orphan.id) ? { job: orphan, source: 'resume' as const } : replay ? { job: replay, source: 'replay' as const } : undefined;
  if (next) drafts.push({ type: 'turn.queued', turn: last.turn + 1, jobId: next.job.id, source: next.source, queueStatus: next.job.status });
  return drafts;
}

async function readQueue(queueDir: string): Promise<QueueDocument> {
  return new QueueStore(queueDir).read();
}

/** Observe the queue, append changes, return the up-to-date view. Caller holds the session lock. */
async function syncLocked(dir: string, id: string, queue?: QueueDocument): Promise<{ session: AgentSession; events: SessionEvent[] }> {
  const read = await readLog(dir, id);
  let session = foldSession(id, read.events, read.skipped);
  let doc = queue;
  let queueError: string | undefined;
  if (!doc && session.status !== 'terminated') {
    try { doc = await readQueue(session.queueDir); }
    catch (error) { queueError = error instanceof Error ? error.message : 'Queue read failed'; }
  }
  let events = read.events;
  if (doc) {
    events = await append(dir, id, read, observeQueue(session, doc));
    session = foldSession(id, events, read.skipped);
  }
  if (queueError) session.queueError = queueError;
  return { session, events };
}

const lockPath = (dir: string, id: string): string => join(dir, `${id}.lock`);

export interface CreateSessionInput {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  /** Existing queue.v1 job that becomes turn 1. */
  jobId: string;
  /** Queue directory. Defaults to the `phm queue` default. Recorded so later turns use the same queue. */
  queueDir?: string;
}

/** Start a session whose first turn is an existing queue job. */
export async function createAgentSession(input: CreateSessionInput, options: SessionStoreOptions = {}): Promise<AgentSession> {
  if (!AGENT_ID.test(input.agentId)) throw new AgentSessionError('invalid', 'Agent id must start with a letter and use letters, digits, _ or - (max 80)');
  if (!Number.isSafeInteger(input.agentVersion) || input.agentVersion < 1) throw new AgentSessionError('invalid', 'Agent version must be a positive integer');
  if (!ENVIRONMENT_ID.test(input.environmentId)) throw new AgentSessionError('invalid', 'Environment id must start with a letter and use letters, digits, _, . or - (max 80)');
  if (!JOB_ID.test(input.jobId)) throw new AgentSessionError('invalid', 'Invalid queue job id');
  const queueDir = resolve(input.queueDir ?? new QueueStore().directory);
  const dir = sessionsDir(options);
  await ensureDir(dir);
  return withLock(join(dir, '.create.lock'), async () => {
    const doc = await readQueue(queueDir);
    const job = doc.jobs.find(row => row.id === input.jobId);
    if (!job) throw new AgentSessionError('not-found', `No queue job ${input.jobId} in ${queueDir}. Add it with: phm queue add`);
    // One job is one turn of at most one live session.
    const { sessions } = await listAgentSessions({ ...options, observe: false });
    const owner = sessions.find(s => s.status !== 'terminated' && s.queueDir === queueDir && s.turns.some(turn => turn.jobId === job.id));
    if (owner) throw new AgentSessionError('conflict', `Job ${job.id} is already a turn of ${owner.id}`);
    const id = `sesn_${randomBytes(8).toString('hex')}`;
    const ts = new Date().toISOString();
    const events: SessionEvent[] = [
      { seq: 1, ts, type: 'session.created', agent: { id: input.agentId, version: input.agentVersion }, environmentId: input.environmentId, queueDir },
      { seq: 2, ts, type: 'turn.queued', turn: 1, jobId: job.id, source: 'create', queueStatus: job.status },
    ];
    const handle = await open(logPath(dir, id), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return foldSession(id, events);
  });
}

/** One session with its full event log, observed against the queue first. */
export async function getAgentSession(id: string, options: SessionStoreOptions = {}): Promise<{ session: AgentSession; events: SessionEvent[] }> {
  const dir = await existingDir(id, options);
  return withLock(lockPath(dir, id), () => syncLocked(dir, id));
}

export interface ListResult { sessions: AgentSession[]; errors: Array<{ id: string; error: string }> }

/** Every session, newest first. `observe: false` folds logs without reading the queue or writing. */
export async function listAgentSessions(options: SessionStoreOptions & { observe?: boolean } = {}): Promise<ListResult> {
  const dir = sessionsDir(options);
  let names: string[];
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw new AgentSessionError('invalid', 'Agent session directory cannot be a symlink');
    names = await readdir(dir);
  } catch (error) { if (missing(error)) return { sessions: [], errors: [] }; throw error; }
  const ids = names.filter(name => /^sesn_[0-9a-f]{16}\.jsonl$/.test(name)).map(name => name.slice(0, -'.jsonl'.length));
  const queues = new Map<string, Promise<QueueDocument>>();
  const result: ListResult = { sessions: [], errors: [] };
  for (const id of ids) {
    try {
      if (options.observe === false) {
        const read = await readLog(dir, id);
        result.sessions.push(foldSession(id, read.events, read.skipped));
        continue;
      }
      result.sessions.push((await withLock(lockPath(dir, id), async () => {
        const created = (await readLog(dir, id)).events[0] as Extract<SessionEvent, { type: 'session.created' }>;
        if (!queues.has(created.queueDir)) queues.set(created.queueDir, readQueue(created.queueDir));
        const doc = await queues.get(created.queueDir)!.catch(() => undefined);
        return syncLocked(dir, id, doc);
      })).session);
    } catch (error) {
      result.errors.push({ id, error: error instanceof Error ? error.message : 'Unreadable session' });
    }
  }
  result.sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  return result;
}

export interface ResumeInput {
  /** New instruction for the next turn. Required when idle; when rescheduling, omit it to retry the blocked turn. */
  scope?: string;
  acceptance?: string;
}

/**
 * Queue the next turn. Idle: a new job copies the last turn's routing fields
 * with the new scope. Rescheduling without a scope: the blocked job is retried
 * through the queue's own replay. Running and terminated sessions are refused.
 */
export async function resumeAgentSession(id: string, input: ResumeInput = {}, options: SessionStoreOptions = {}): Promise<{ session: AgentSession; job: QueueJob }> {
  const scope = input.scope?.trim();
  if (input.scope !== undefined && !scope) throw new AgentSessionError('invalid', '--scope cannot be empty');
  const dir = await existingDir(id, options);
  return withLock(lockPath(dir, id), async () => {
    const { session } = await syncLocked(dir, id);
    if (session.queueError) throw new AgentSessionError('invalid', `Queue unreadable: ${session.queueError}`);
    if (session.status === 'terminated') throw new AgentSessionError('terminated', `${id} is terminated and cannot resume`);
    if (session.status === 'running') throw new AgentSessionError('running', `${id} is running turn ${session.turns.length}; resume it once that job ends`);
    if (session.turns.length >= MAX_TURNS) throw new AgentSessionError('invalid', `${id} reached ${MAX_TURNS} turns`);
    const last = session.turns.at(-1)!;
    const store = new QueueStore(session.queueDir);
    let job: QueueJob;
    let source: TurnSource;
    if (!scope) {
      if (session.status !== 'rescheduling') throw new AgentSessionError('invalid', `${id} is idle; pass --scope with the next instruction`);
      const [replayed] = await store.replay({ ids: [last.jobId] });
      if (!replayed) throw new AgentSessionError('no-retry', `Turn ${last.turn} (${last.jobId}) has no finished attempt to retry; pass --scope to queue a new turn`);
      job = replayed;
      source = 'retry';
    } else {
      const previous = (await store.read()).jobs.find(row => row.id === last.jobId);
      if (!previous) throw new AgentSessionError('not-found', `Turn ${last.turn} job ${last.jobId} is no longer in the queue`);
      job = await store.add({
        id: `${id}.t${last.turn + 1}`, status: 'READY', priority: previous.priority, pool: previous.pool, tier: previous.tier,
        repo: previous.repo, scope, acceptance: input.acceptance ?? previous.acceptance, deps: [], claims: [],
      });
      source = 'resume';
    }
    const read = await readLog(dir, id);
    const events = await append(dir, id, read, [{ type: 'turn.queued', turn: last.turn + 1, jobId: job.id, source, queueStatus: job.status }]);
    return { session: foldSession(id, events, read.skipped), job };
  });
}

/** End the session. Its queue jobs are untouched; block an in-flight job with `phm queue block`. */
export async function terminateAgentSession(id: string, input: { reason?: string } = {}, options: SessionStoreOptions = {}): Promise<{ session: AgentSession; alreadyTerminated: boolean }> {
  const dir = await existingDir(id, options);
  return withLock(lockPath(dir, id), async () => {
    const { session } = await syncLocked(dir, id);
    if (session.status === 'terminated') return { session, alreadyTerminated: true };
    const reason = input.reason?.trim() ? scrubSecrets(input.reason.trim()).slice(0, MAX_REASON) : undefined;
    const read = await readLog(dir, id);
    const events = await append(dir, id, read, [{ type: 'session.terminated', ...(reason ? { reason } : {}) }]);
    return { session: foldSession(id, events, read.skipped), alreadyTerminated: false };
  });
}
