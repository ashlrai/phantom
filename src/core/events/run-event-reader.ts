import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const RUN_EVENT_SCHEMA = 'run.event.v1' as const;
export const RUN_STATE_SCHEMA = 'run.state.v1' as const;

export const RUN_EVENT_KINDS = [
  'launch', 'tool-call', 'tool-result', 'checkpoint', 'note', 'finish', 'publish', 'head',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

export const RUN_EVENT_MAIN_BRANCH = 'main';

export interface RunEvent {
  schema: typeof RUN_EVENT_SCHEMA;
    seq: number;
    id: string;
  job: string;
    at: string;
    branch: string;
    parent: string | null;
  kind: RunEventKind;
    data: Record<string, unknown>;
}

export interface RunEventLogRead {
  events: RunEvent[];
    deferred: boolean;
}

export interface RunHead {
    id: string | null;
  branch: string;
}

export interface RunBranch {
  name: string;
    tip: string;
    depth: number;
}

export interface RunStateView {
  schema: typeof RUN_STATE_SCHEMA;
  generatedAt: string;
  job: string;
  head: { id: string; seq: number; branch: string } | null;
    path: string[];
    phase: 'empty' | 'running' | 'finished' | 'published';
  counts: Record<RunEventKind, number>;
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
const MAX_DATA_KEYS = 64;
const MAX_DATA_DEPTH = 6;
const MAX_DATA_ARRAY = 256;
const MAX_DATA_STRING = 4 * 1024;

export function isRunEventJobId(job: string): boolean {
  return JOB_ID.test(job) && !/[\r\n]/.test(job);
}

export function runEventLogPath(job: string, runsDir?: string): string {
  if (!isRunEventJobId(job)) throw new RunEventLogError('invalid-job', 'Invalid job id');
  const dir = runsDir ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(dir)) throw new RunEventLogError('invalid-runs-dir', 'runsDir must be an absolute path');
  return join(dir, `${job}.events.jsonl`);
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function validAt(at: unknown): at is string {
  return typeof at === 'string' && ISO_AT.test(at) && Number.isFinite(Date.parse(at));
}

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

export async function readRunEventLog(job: string, options: { runsDir?: string } = {}): Promise<RunEventLogRead> {
  const path = runEventLogPath(job, options.runsDir);
  let text: string;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_LOG_BYTES) {
        throw new RunEventLogError('unsafe-log', 'Event log must be a regular file under the size cap');
      }
      const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_LOG_BYTES) throw new RunEventLogError('unsafe-log', 'Event log exceeds size cap');
      text = buffer.toString('utf8', 0, size);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof RunEventLogError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new RunEventLogError('unsafe-log', 'Event log must not be a symlink');
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], deferred: false };
    throw new RunEventLogError('unreadable-log', 'Cannot read event log');
  }
  return parseLog(text, job);
}

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

