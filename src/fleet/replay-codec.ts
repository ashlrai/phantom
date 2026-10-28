import { createHash } from 'node:crypto';
import { scrubSecrets } from '../core/util/scrub.js';

export type ReplayValue = null | boolean | number | string | ReplayValue[] | { [key: string]: ReplayValue };
export type ReplayOutcome =
  | { status: 'returned'; value: ReplayValue }
  | { status: 'threw'; error: { name: string; message: string; code: string | null } };

export interface ReplayCall {
  operation: string;
  input: ReplayValue;
  outcome: ReplayOutcome | null;
}

export interface ReplaySession {
  jobId: string;
  input: ReplayValue;
  calls: ReplayCall[];
  outcome: ReplayOutcome | null;
}

export interface ReplayFleet {
  schema: 'phantom-fleet-replay/v1';
  sessions: ReplaySession[];
}

export const REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const REPLAY_MAX_CALLS = 1000;
export const REPLAY_MAX_SESSIONS = 100;

/** Diagnostics deliberately omit payloads, filenames and adapter error text. */
export class ReplayHarnessError extends Error {
  constructor(readonly code: 'invalid' | 'secret' | 'incomplete' | 'mismatch' | 'busy' | 'storage') {
    super(`Fleet replay refused: ${code}`);
    this.name = 'ReplayHarnessError';
  }
}

// Values must already be safe, serializable DTOs. Never silently drop undefined,
// invoke a getter/toJSON, or redact a result the live runner would branch on.
export function replayValue(value: unknown): ReplayValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): ReplayValue {
    if (++nodes > 50_000 || depth > 32) throw new ReplayHarnessError('invalid');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return item;
    if (typeof item === 'string') {
      if (Buffer.byteLength(item) > REPLAY_MAX_BYTES) throw new ReplayHarnessError('invalid');
      if (scrubSecrets(item) !== item) throw new ReplayHarnessError('secret');
      return item;
    }
    if (typeof item !== 'object' || ancestors.has(item)) throw new ReplayHarnessError('invalid');
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new ReplayHarnessError('invalid');
    }
    ancestors.add(item);
    const result: { [key: string]: ReplayValue } = Object.create(null);
    const keys = Reflect.ownKeys(item);
    if (keys.length > 50_000) throw new ReplayHarnessError('invalid');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new ReplayHarnessError('invalid');
      }
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) {
        throw new ReplayHarnessError('invalid');
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new ReplayHarnessError('invalid');
      // Credentials belong behind Phantom Secrets references, never in a tape.
      const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (/(password|passwd|secret|token|credential|authorization|apikey|privatekey|connectionstring)$|^(env|environment|auth)$/.test(normalizedKey) &&
          !(typeof descriptor.value === 'string' && /^phm_[A-Za-z0-9_-]+$/.test(descriptor.value))) {
        throw new ReplayHarnessError('secret');
      }
      if (scrubSecrets(key) !== key) throw new ReplayHarnessError('secret');
      result[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    if (array) {
      if (Object.keys(result).length !== item.length) throw new ReplayHarnessError('invalid');
      return Array.from({ length: item.length }, (_, i) => result[String(i)]);
    }
    return result;
  }
  const result = visit(value, 0);
  const text = canonicalReplayJson(result);
  if (Buffer.byteLength(text) > REPLAY_MAX_BYTES) throw new ReplayHarnessError('invalid');
  return result;
}

export function canonicalReplayJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalReplayJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalReplayJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export function replayIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/.test(value)) {
    throw new ReplayHarnessError('invalid');
  }
  replayValue(value);
  return value;
}

export function replayError(error: unknown): Extract<ReplayOutcome, { status: 'threw' }> {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-Error thrown');
  const code = (e as Error & { code?: unknown }).code;
  return {
    status: 'threw',
    error: {
      name: scrubSecrets(e.name).slice(0, 160),
      message: scrubSecrets(e.message).slice(0, 4096),
      code: typeof code === 'string' ? scrubSecrets(code).slice(0, 160) : null,
    },
  };
}

export function restoreReplayError(outcome: Extract<ReplayOutcome, { status: 'threw' }>): Error {
  const error = new Error(outcome.error.message);
  error.name = outcome.error.name;
  if (outcome.error.code !== null) Object.assign(error, { code: outcome.error.code });
  return error;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReplayHarnessError('invalid');
  return value as Record<string, unknown>;
}

function fields(value: unknown, keys: string[]): Record<string, unknown> {
  const item = object(value);
  if (Object.keys(item).sort().join(',') !== keys.sort().join(',')) throw new ReplayHarnessError('invalid');
  return item;
}

function outcome(value: unknown): void {
  if (value === null) return;
  const item = object(value);
  if (item.status === 'returned') {
    fields(item, ['status', 'value']);
    replayValue(item.value);
  } else if (item.status === 'threw') {
    fields(item, ['status', 'error']);
    const e = fields(item.error, ['name', 'message', 'code']);
    if (typeof e.name !== 'string' || typeof e.message !== 'string' ||
        !(e.code === null || typeof e.code === 'string')) throw new ReplayHarnessError('invalid');
    replayValue(e);
  } else throw new ReplayHarnessError('invalid');
}

function validateFleet(value: unknown): ReplayFleet {
  const fleet = fields(value, ['schema', 'sessions']);
  if (fleet.schema !== 'phantom-fleet-replay/v1' || !Array.isArray(fleet.sessions) ||
      fleet.sessions.length > REPLAY_MAX_SESSIONS) throw new ReplayHarnessError('invalid');
  const ids = new Set<string>();
  for (const raw of fleet.sessions) {
    const session = fields(raw, ['jobId', 'input', 'calls', 'outcome']);
    const id = replayIdentity(session.jobId);
    if (ids.has(id)) throw new ReplayHarnessError('invalid');
    ids.add(id);
    replayValue(session.input);
    outcome(session.outcome);
    if (!Array.isArray(session.calls) || session.calls.length > REPLAY_MAX_CALLS) throw new ReplayHarnessError('invalid');
    for (const [index, rawCall] of session.calls.entries()) {
      const call = fields(rawCall, ['operation', 'input', 'outcome']);
      replayIdentity(call.operation);
      replayValue(call.input);
      outcome(call.outcome);
      if (call.outcome === null && (session.outcome !== null || index !== session.calls.length - 1)) {
        throw new ReplayHarnessError('invalid');
      }
    }
  }
  return value as ReplayFleet;
}

// This digest detects damaged/edited captures; it is not an authenticity proof
// or a reusable authorization for anything recorded in the file.
export function encodeReplayFleet(fleet: ReplayFleet): string {
  validateFleet(fleet);
  const body = canonicalReplayJson(fleet);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const text = canonicalReplayJson({ ...fleet, sha256 }) + '\n';
  if (Buffer.byteLength(text) > REPLAY_MAX_BYTES) throw new ReplayHarnessError('invalid');
  return text;
}

export function decodeReplayFleet(text: string): ReplayFleet {
  if (Buffer.byteLength(text) > REPLAY_MAX_BYTES) throw new ReplayHarnessError('invalid');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ReplayHarnessError('invalid'); }
  const item = fields(parsed, ['schema', 'sessions', 'sha256']);
  const { sha256, ...body } = item;
  const fleet = validateFleet(body);
  if (typeof sha256 !== 'string' || sha256 !== createHash('sha256').update(canonicalReplayJson(body)).digest('hex')) {
    throw new ReplayHarnessError('invalid');
  }
  return fleet;
}
