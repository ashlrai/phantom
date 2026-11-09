/**
 * core/events/run-event-log.ts — RQ-SWE5-EVENT-LOG: event-sourced run state.
 *
 * Each dispatched job gets one append-only JSONL log beside its existing
 * flat artifacts in the runs directory:
 *
 *   <runsDir>/<job>.events.jsonl        (default runsDir: ~/.ashlr-runs)
 *   <runsDir>/locks/<job>.events.lock   (append mutual exclusion)
 *
 * OpenHands event-stream pattern: the run's recorded history is a TREE of
 * events — every event names its `parent`, and a movable head pointer marks
 * where the next event attaches. Rewinding the head (`checkout`) or moving
 * it under a new label (`fork`) never rewrites history: head movements are
 * themselves appended `head` events, so the pointer's trail is auditable and
 * branch navigation survives crashes.
 *
 * Event kinds are the run lifecycle the fleet already observes:
 *   launch · tool-call · tool-result · checkpoint · note · finish · publish
 *   plus `head` for pointer records.
 *
 * `replay` folds the head path (root → pointer) into a run-state view: phase,
 * per-kind counts, the newest checkpoint reference (the integration seam with
 * `phm checkpoint` / authored handoffs), and the last finish/publish records.
 * Readers never lock and never write; appends hold a per-job lock file, are
 * fsynced, and run under 0o600. A torn trailing line (crashed write) is
 * reported as `deferred` and truncated under the append lock; malformed
 * complete lines fail closed — the log's value is its integrity.
 *
 * Metadata only: payloads are bounded, JSON-safe, and refused when
 * secret-shaped (same assertMetadata gate as connector profiles).
 */

import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { assertMetadata } from '../connectors/profile.js';
import { fsyncDirectory } from '../util/durability.js';

export const RUN_EVENT_SCHEMA = 'run.event.v1' as const;
export const RUN_STATE_SCHEMA = 'run.state.v1' as const;

export const RUN_EVENT_KINDS = [
  'launch', 'tool-call', 'tool-result', 'checkpoint', 'note', 'finish', 'publish', 'head',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** Default branch label; forks receive explicit or derived labels. */
export const RUN_EVENT_MAIN_BRANCH = 'main';

export interface RunEvent {
  schema: typeof RUN_EVENT_SCHEMA;
  /** 1-based append position in the physical log. */
  seq: number;
  /** `e<seq>` — unique within this job's log, stable forever. */
  id: string;
  job: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** Branch label this event grows (the pointer's branch at append time). */
  branch: string;
  /** Id of the event this extends; null only on the root event. */
  parent: string | null;
  kind: RunEventKind;
  /** Bounded metadata; `head` events carry {event, branch?, reason?}. */
  data: Record<string, unknown>;
}

export interface RunEventLogRead {
  events: RunEvent[];
  /** A crashed writer left an unterminated final line; it is ignored. */
  deferred: boolean;
}

/** The position the next appended event will extend. */
export interface RunHead {
  /** Event id the next append parents to; null on an empty log. */
  id: string | null;
  branch: string;
}

export interface RunBranch {
  name: string;
  /** Deepest event on this branch. */
  tip: string;
  /** Events carrying this branch label. */
  depth: number;
}

export interface RunStateView {
  schema: typeof RUN_STATE_SCHEMA;
  generatedAt: string;
  job: string;
  head: { id: string; seq: number; branch: string } | null;
  /** Event ids root → pointer: the current conversation. */
  path: string[];
  /** empty | running | finished | published */
  phase: 'empty' | 'running' | 'finished' | 'published';
  counts: Record<RunEventKind, number>;
  /** Nearest checkpoint event on the head path — what a resume restores. */
  checkpoint: { eventId: string; at: string; ref: string; source: string | null } | null;
  finish: Record<string, unknown> | null;
  publish: Record<string, unknown> | null;
  branches: RunBranch[];
  deferred: boolean;
}

export class RunEventLogError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RunEventLogError'; }
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const BRANCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVENT_ID = /^e[1-9][0-9]*$/;
const ISO_AT = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const MAX_DATA_BYTES = 16 * 1024;
const MAX_DATA_KEYS = 64;
const MAX_DATA_DEPTH = 6;
const MAX_DATA_ARRAY = 256;
const MAX_DATA_STRING = 4 * 1024;
const DEFAULT_LOCK_WAIT_MS = 2_000;

export function isRunEventJobId(job: string): boolean {
  return JOB_ID.test(job) && !/[\r\n]/.test(job);
}

export function runEventLogPath(job: string, runsDir?: string): string {
  if (!isRunEventJobId(job)) throw new RunEventLogError('invalid-job', 'Invalid job id');
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new RunEventLogError('invalid-runs-dir', 'runsDir must be an absolute path');
  return join(dir, `${job}.events.jsonl`);
}

/**
 * Locks live in a dedicated subdirectory: the lock helper enforces 0700 on
 * the directory it works in, and that must never tighten the runs dir itself.
 */
export function runEventLockPath(job: string, runsDir?: string): string {
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isRunEventJobId(job)) throw new RunEventLogError('invalid-job', 'Invalid job id');
  if (!isAbsolute(dir)) throw new RunEventLogError('invalid-runs-dir', 'runsDir must be an absolute path');
  return join(dir, 'locks', `${job}.events.lock`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validAt(at: unknown): at is string {
  return typeof at === 'string' && ISO_AT.test(at) && Number.isFinite(Date.parse(at));
}

/** JSON-safe, bounded payload validation; never echoes rejected content. */
function checkData(value: unknown, depth = 0): void {
  if (depth > MAX_DATA_DEPTH) throw new RunEventLogError('invalid-data', 'Event data too deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RunEventLogError('invalid-data', 'Event data must be finite');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_DATA_STRING) throw new RunEventLogError('invalid-data', 'Event data string too long');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DATA_ARRAY) throw new RunEventLogError('invalid-data', 'Event data array too long');
    for (const item of value) checkData(item, depth + 1);
    return;
  }
  if (record(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_DATA_KEYS || keys.some(k => !k || k.length > MAX_DATA_KEYS)) {
      throw new RunEventLogError('invalid-data', 'Event data keys out of bounds');
    }
    for (const key of keys) checkData(value[key], depth + 1);
    return;
  }
  throw new RunEventLogError('invalid-data', 'Event data must be JSON-safe');
}

function validateData(data: Record<string, unknown>): void {
  checkData(data);
  const serialized = JSON.stringify(data);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_DATA_BYTES) {
    throw new RunEventLogError('invalid-data', 'Event data too large');
  }
  try { assertMetadata(serialized); }
  catch { throw new RunEventLogError('invalid-data', 'Secret-shaped event data refused; use references only'); }
}

function isKind(kind: unknown): kind is RunEventKind {
  return typeof kind === 'string' && (RUN_EVENT_KINDS as readonly string[]).includes(kind);
}

function validateEvent(value: unknown, seq: number, line: number): RunEvent {
  if (!record(value) || value.schema !== RUN_EVENT_SCHEMA) {
    throw new RunEventLogError('invalid-log', `Invalid event at line ${line}`);
  }
  const e = value as Record<string, unknown>;
  if (e.seq !== seq || e.id !== `e${seq}` || !isRunEventJobId(e.job as string) ||
    !validAt(e.at) || typeof e.branch !== 'string' || !BRANCH_ID.test(e.branch) ||
    !(e.parent === null || (typeof e.parent === 'string' && EVENT_ID.test(e.parent))) ||
    !isKind(e.kind) || !record(e.data)) {
    throw new RunEventLogError('invalid-log', `Invalid event at line ${line}`);
  }
  try { checkData(e.data); } catch {
    throw new RunEventLogError('invalid-log', `Invalid event data at line ${line}`);
  }
  return e as unknown as RunEvent;
}

// ---------------------------------------------------------------------------
// Read (never locks; tolerates only a torn final line)
// ---------------------------------------------------------------------------

function parseLog(text: string, job: string): RunEventLogRead {
  const boundary = text.endsWith('\n') ? text.length : text.lastIndexOf('\n') + 1;
  const deferred = text.slice(boundary).trim().length > 0;
  const events: RunEvent[] = [];
  const kindById = new Map<string, RunEventKind>();
  const lines = text.slice(0, boundary).split('\n').filter(line => line.trim());
  lines.forEach((raw, index) => {
    const line = index + 1;
    if (Buffer.byteLength(raw) > MAX_LINE_BYTES) {
      throw new RunEventLogError('invalid-log', `Oversized event at line ${line}`);
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch {
      throw new RunEventLogError('invalid-log', `Malformed event at line ${line}`);
    }
    const event = validateEvent(value, index + 1, line);
    if (event.job !== job) throw new RunEventLogError('invalid-log', `Foreign job event at line ${line}`);
    if (kindById.has(event.id)) throw new RunEventLogError('invalid-log', `Duplicate event at line ${line}`);
    if (event.parent !== null && !kindById.has(event.parent)) {
      throw new RunEventLogError('invalid-log', `Dangling parent at line ${line}`);
    }
    if (event.kind === 'head') {
      const target = event.data.event;
      if (typeof target !== 'string' || !kindById.has(target)) {
        throw new RunEventLogError('invalid-log', `Head record at line ${line} targets an unknown event`);
      }
      if (kindById.get(target) === 'head') {
        throw new RunEventLogError('invalid-log', `Head record at line ${line} targets a head record`);
      }
      const branch = event.data.branch;
      if (branch !== undefined && (typeof branch !== 'string' || !BRANCH_ID.test(branch))) {
        throw new RunEventLogError('invalid-log', `Invalid head branch at line ${line}`);
      }
    }
    kindById.set(event.id, event.kind);
    events.push(event);
  });
  return { events, deferred };
}

/**
 * Read a job's event log. Missing log → empty result. A file that is a
 * symlink, malformed mid-file, oversized or non-regular fails closed.
 */
export async function readRunEventLog(job: string, options: { runsDir?: string } = {}): Promise<RunEventLogRead> {
  const path = runEventLogPath(job, options.runsDir);
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_LOG_BYTES) {
      throw new RunEventLogError('unsafe-log', 'Event log must be a regular file under the size cap');
    }
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof RunEventLogError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], deferred: false };
    throw new RunEventLogError('unreadable-log', 'Cannot read event log');
  }
  return parseLog(text, job);
}

// ---------------------------------------------------------------------------
// Tree navigation — the movable head
// ---------------------------------------------------------------------------

/**
 * Resolve the append position: the newest `head` record's target wins
 * (its `branch` overrides the target's label); otherwise the log tip.
 */
export function runHead(events: readonly RunEvent[]): RunHead {
  const byId = new Map(events.map(e => [e.id, e]));
  let pointer: RunEvent | undefined;
  let branch = RUN_EVENT_MAIN_BRANCH;
  for (const event of events) {
    if (event.kind === 'head') {
      const target = byId.get(event.data.event as string);
      if (target) {
        pointer = target;
        branch = (event.data.branch as string | undefined) ?? target.branch;
      }
    } else {
      pointer = event;
      branch = event.branch;
    }
  }
  return { id: pointer?.id ?? null, branch: pointer ? branch : RUN_EVENT_MAIN_BRANCH };
}

/**
 * Distinct branch labels. `tip` is where the branch currently continues —
 * the deepest event carrying the label, or the head record's target when a
 * head record (re)points the label before new content lands.
 */
export function runBranches(events: readonly RunEvent[]): RunBranch[] {
  const branches = new Map<string, RunBranch>();
  const ensure = (name: string, tip: string, depth: number): void => {
    const entry = branches.get(name) ?? { name, tip, depth: 0 };
    entry.tip = tip;
    entry.depth += depth;
    branches.set(name, entry);
  };
  for (const event of events) {
    ensure(event.branch, event.id, 1);
    if (event.kind === 'head' && typeof event.data.branch === 'string') {
      ensure(event.data.branch, event.data.event as string, 0);
    }
  }
  return [...branches.values()];
}

/** Ids root → pointer: the conversation as the head sees it. */
export function runPath(events: readonly RunEvent[], at?: string): string[] {
  const byId = new Map(events.map(e => [e.id, e]));
  const target = at ?? runHead(events).id;
  const path: string[] = [];
  const seen = new Set<string>();
  for (let event = target ? byId.get(target) : undefined; event; event = event.parent ? byId.get(event.parent) : undefined) {
    if (seen.has(event.id)) throw new RunEventLogError('invalid-log', 'Parent cycle in event log');
    seen.add(event.id);
    path.unshift(event.id);
  }
  if (target && !byId.has(target)) throw new RunEventLogError('unknown-event', `Unknown event: ${target}`);
  return path;
}

/**
 * Fold the head path into a resumable run-state view. `at` replays to an
 * earlier event without moving the stored pointer (read-only replay).
 */
export function replayRunState(
  job: string,
  read: RunEventLogRead,
  options: { at?: string; now?: () => Date } = {},
): RunStateView {
  const counts = Object.fromEntries(RUN_EVENT_KINDS.map(k => [k, 0])) as Record<RunEventKind, number>;
  const byId = new Map(read.events.map(e => [e.id, e]));
  const path = runPath(read.events, options.at);
  // The pointer's working branch comes from the head record (a fork relabels
  // where new events land); a read-only `--at` replay reports the target's own.
  const pointer = options.at
    ? { id: options.at, branch: byId.get(options.at)?.branch ?? RUN_EVENT_MAIN_BRANCH }
    : runHead(read.events);
  let checkpoint: RunStateView['checkpoint'] = null;
  let finish: RunStateView['finish'] = null;
  let publish: RunStateView['publish'] = null;
  for (const id of path) {
    const event = byId.get(id)!;
    counts[event.kind]++;
    if (event.kind === 'checkpoint' && typeof event.data.ref === 'string' && event.data.ref) {
      checkpoint = {
        eventId: event.id,
        at: event.at,
        ref: event.data.ref,
        source: typeof event.data.source === 'string' ? event.data.source : null,
      };
    }
    if (event.kind === 'finish') finish = event.data;
    if (event.kind === 'publish') publish = event.data;
  }
  const headEvent = pointer.id ? byId.get(pointer.id)! : null;
  const phase: RunStateView['phase'] =
    publish ? 'published' : finish ? 'finished' : counts.launch ? 'running' : 'empty';
  return {
    schema: RUN_STATE_SCHEMA,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    job,
    head: headEvent ? { id: headEvent.id, seq: headEvent.seq, branch: pointer.branch } : null,
    path,
    phase,
    counts,
    checkpoint,
    finish,
    publish,
    branches: runBranches(read.events),
    deferred: read.deferred,
  };
}

// ---------------------------------------------------------------------------
// Append (locked, fsynced, 0o600)
// ---------------------------------------------------------------------------

export interface AppendRunEventOptions {
  runsDir?: string;
  /** Caller-supplied ISO timestamp; defaults to now. */
  at?: string;
  lockWaitMs?: number;
  now?: () => Date;
}

async function appendLine(path: string, line: string, truncateAt: number): Promise<void> {
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_LOG_BYTES) {
      throw new RunEventLogError('unsafe-log', 'Event log must be a regular file under the size cap');
    }
    if (truncateAt > 0 && stat.size > truncateAt) await file.truncate(truncateAt);
    const size = Math.min(stat.size, truncateAt > 0 ? truncateAt : stat.size);
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      throw new RunEventLogError('log-full', 'Event log size cap reached');
    }
    await file.writeFile(line);
    await file.sync();
  } finally {
    await file.close();
  }
  fsyncDirectory(dirname(path));
}

async function lockedAppend(
  job: string,
  runsDir: string | undefined,
  lockWaitMs: number | undefined,
  build: (read: RunEventLogRead) => Omit<RunEvent, 'schema' | 'seq' | 'id' | 'job' | 'parent' | 'branch'> & { branch?: string; parent?: string | null },
): Promise<RunEvent> {
  const path = runEventLogPath(job, runsDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const acquisition = acquireLocalStoreLockWithOutcome(
    runEventLockPath(job, runsDir), lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  if (acquisition.state !== 'acquired') {
    throw new RunEventLogError('busy', acquisition.state === 'contended'
      ? 'Event log lock is held by another process'
      : 'Event log storage unavailable');
  }
  const { lock } = acquisition;
  try {
    const read = await readRunEventLog(job, { runsDir });
    const partial = build(read);
    const head = runHead(read.events);
    const seq = (read.events.at(-1)?.seq ?? 0) + 1;
    const event: RunEvent = {
      schema: RUN_EVENT_SCHEMA,
      seq,
      id: `e${seq}`,
      job,
      at: partial.at,
      branch: partial.branch ?? head.branch,
      parent: partial.parent !== undefined ? partial.parent : head.id,
      kind: partial.kind,
      data: partial.data,
    };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new RunEventLogError('invalid-data', 'Event too large');
    // A torn tail is replaced by the new event; complete events never move.
    await appendLine(path, line, read.deferred ? await tailBoundary(path) : 0);
    return event;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Byte offset of the incomplete final line (the cut point for a torn tail). */
async function tailBoundary(path: string): Promise<number> {
  const text = await readFile(path, 'utf8');
  return text.lastIndexOf('\n') + 1;
}

/**
 * Append a lifecycle event at the current head. `checkpoint` events must
 * carry `data.ref` — the reference a later resume resolves.
 */
export async function appendRunEvent(
  job: string,
  kind: RunEventKind,
  data: Record<string, unknown> = {},
  options: AppendRunEventOptions = {},
): Promise<RunEvent> {
  if (kind === 'head') throw new RunEventLogError('invalid-kind', 'Append head records via checkout/fork');
  if (!isKind(kind)) throw new RunEventLogError('invalid-kind', 'Unknown event kind');
  if (kind === 'checkpoint' && (typeof data.ref !== 'string' || !data.ref)) {
    throw new RunEventLogError('invalid-data', 'Checkpoint events require a nonempty data.ref');
  }
  validateData(data);
  const at = options.at ?? (options.now?.() ?? new Date()).toISOString();
  if (!validAt(at)) throw new RunEventLogError('invalid-data', 'Invalid --at ISO timestamp');
  return lockedAppend(job, options.runsDir, options.lockWaitMs,
    () => ({ kind, data, at }));
}

function buildHeadRecord(
  read: RunEventLogRead,
  target: string,
  options: { branch?: string; reason?: string },
  at: string,
): Omit<RunEvent, 'schema' | 'seq' | 'id' | 'job'> & { branch?: string } {
  const byId = new Map(read.events.map(e => [e.id, e]));
  const targetEvent = byId.get(target);
  if (!targetEvent) throw new RunEventLogError('unknown-event', `Unknown event: ${target}`);
  if (targetEvent.kind === 'head') {
    throw new RunEventLogError('invalid-event', 'Head records are navigation metadata, not content; point at a real event');
  }
  const head = runHead(read.events);
  if (head.id === target && !options.branch) {
    throw new RunEventLogError('no-op', 'Head already at target');
  }
  const data: Record<string, unknown> = { event: target };
  if (options.branch) data.branch = options.branch;
  if (options.reason) data.reason = options.reason;
  // The pointer record stays on the branch it was written under.
  return { kind: 'head', data, at, parent: head.id, branch: head.branch };
}

function checkHeadArgs(target: string, options: { branch?: string; reason?: string; at: string }): void {
  if (!EVENT_ID.test(target)) throw new RunEventLogError('invalid-event', 'Invalid event id');
  if (options.branch !== undefined && !BRANCH_ID.test(options.branch)) {
    throw new RunEventLogError('invalid-branch', 'Invalid branch name');
  }
  if (options.reason !== undefined && (typeof options.reason !== 'string' || !options.reason.trim())) {
    throw new RunEventLogError('invalid-data', 'Head reason must be nonempty');
  }
  if (!validAt(options.at)) throw new RunEventLogError('invalid-data', 'Invalid --at ISO timestamp');
}

/**
 * Move the head pointer to an existing event. `branch` starts a new branch
 * (fork); without it the pointer simply seeks along the target's own branch
 * (checkout). The movement itself is appended — history is never rewritten.
 */
export async function moveRunHead(
  job: string,
  target: string,
  options: AppendRunEventOptions & { branch?: string; reason?: string } = {},
): Promise<RunEvent> {
  const at = options.at ?? (options.now?.() ?? new Date()).toISOString();
  checkHeadArgs(target, { ...options, at });
  return lockedAppend(job, options.runsDir, options.lockWaitMs,
    read => buildHeadRecord(read, target, options, at));
}

/**
 * Fork: move the head to `target` under a new branch label. When no label is
 * given, derives `fork-<target>` (suffixed when taken) — inside the append
 * lock, so racing forks never collide.
 */
export async function forkRun(
  job: string,
  target: string,
  options: AppendRunEventOptions & { branch?: string; reason?: string } = {},
): Promise<RunEvent> {
  const at = options.at ?? (options.now?.() ?? new Date()).toISOString();
  checkHeadArgs(target, { ...options, at });
  return lockedAppend(job, options.runsDir, options.lockWaitMs, (read) => {
    const taken = new Set(runBranches(read.events).map(b => b.name));
    let branch = options.branch;
    if (!branch) {
      branch = `fork-${target}`;
      for (let n = 2; taken.has(branch); n++) branch = `fork-${target}-${n}`;
    }
    return buildHeadRecord(read, target, { ...options, branch }, at);
  });
}
