/**
 * Bus v1 wire contract; see schema/bus.v1.schema.json.
 * Pure validation only: addresses are routing labels, never authenticated identities.
 */
import { isProxy } from 'node:util/types';

export const BUS_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type BusPriority = typeof BUS_PRIORITIES[number];
export const MAX_BUS_ENVELOPE_BYTES = 64 * 1024;
/** Root envelope is depth 0; body is depth 1. */
export const MAX_BUS_ENVELOPE_DEPTH = 32;
export const MAX_BUS_ADDRESS_LENGTH = 128;

export type BusJsonValue = null | boolean | number | string | BusJsonValue[] | {
  [key: string]: BusJsonValue;
};

/** Exactly six wire fields. Versioning belongs to the protocol/schema, not the body. */
export interface BusEnvelope<Body = BusJsonValue> {
  /** Sender-assigned message identity; deduplication is a transport responsibility. */
  id: string;
  from: string;
  to: string;
  /** P0 is highest priority. */
  priority: BusPriority;
  /**
   * Positive remaining lifetime in milliseconds (safe integer).
   * Transport must track elapsed time externally, decrement on forwarding, and
   * discard at zero. Validation alone cannot determine a message's age.
   */
  ttl: number;
  /** Opaque strict JSON data; no event-kind, command, or payload interpretation. */
  body: Body;
}

export type BusEnvelopeIssueCode =
  | 'invalid-envelope' | 'invalid-field' | 'invalid-json' | 'too-large' | 'too-deep';

export interface BusEnvelopeIssue {
  code: BusEnvelopeIssueCode;
  path: string;
  /** Static diagnostic; never includes untrusted field values or body contents. */
  message: string;
}

export type BusEnvelopeValidationResult =
  | { ok: true; value: BusEnvelope; json: string; byteLength: number; issues: [] }
  | { ok: false; issues: BusEnvelopeIssue[] };

const FIELDS = ['id', 'from', 'to', 'priority', 'ttl', 'body'] as const;
// Printable ASCII tokens allow pool/agent names, UUIDs, URIs and literal routing labels.
// Unlike $, the final lookahead requires absolute end, even for a trailing newline.
const TOKEN = /^[\x21-\x7e]+(?![\s\S])/;

class EnvelopeError extends Error {
  constructor(readonly issue: BusEnvelopeIssue) {
    super(issue.message);
  }
}

function refuse(code: BusEnvelopeIssueCode, path: string, message: string): never {
  throw new EnvelopeError({ code, path, message });
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataProperty(value: object, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !('value' in descriptor)) {
    refuse('invalid-json', path, 'Only own enumerable data properties are allowed.');
  }
  return descriptor.value;
}

/**
 * Strict data-only encoding, following the pool-ledger JSON validation pattern.
 * Account for bytes incrementally so large/deep values stop before allocating a
 * full serialization. Never invoke getters, proxy traps, or toJSON hooks, and
 * never normalize text, scrub, or otherwise interpret the opaque body. Numbers
 * use standard JSON.stringify semantics, including encoding negative zero as 0.
 */
function encode(envelope: BusEnvelope<unknown>): { json: string; byteLength: number } {
  const parts: string[] = [];
  const ancestors = new Set<object>();
  let byteLength = 0;
  const write = (part: string): void => {
    byteLength += Buffer.byteLength(part, 'utf8');
    if (byteLength > MAX_BUS_ENVELOPE_BYTES) {
      refuse('too-large', '$', 'Envelope exceeds the 65536-byte UTF-8 limit.');
    }
    parts.push(part);
  };
  const string = (value: string): void => {
    // A UTF-16 code unit needs at least one byte when JSON-encoded. Bound the
    // allocation even for strings made entirely of escaped control characters.
    if (value.length > MAX_BUS_ENVELOPE_BYTES - byteLength) {
      refuse('too-large', '$', 'Envelope exceeds the 65536-byte UTF-8 limit.');
    }
    write(JSON.stringify(value));
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > MAX_BUS_ENVELOPE_DEPTH) refuse('too-deep', '$.body', 'Envelope exceeds depth 32.');
    if (value === null || typeof value === 'boolean') { write(String(value)); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'number' && Number.isFinite(value)) { write(JSON.stringify(value)); return; }
    if (value === null || typeof value !== 'object' || isProxy(value) || ancestors.has(value)) {
      refuse('invalid-json', '$.body', 'Body must contain only acyclic finite JSON data.');
    }
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !plainRecord(value)) {
      refuse('invalid-json', '$.body', 'JSON containers must be plain objects or arrays.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_BUS_ENVELOPE_BYTES) refuse('too-large', '$', 'Too many JSON properties.');
    if (keys.some((key) => typeof key !== 'string')) {
      refuse('invalid-json', '$.body', 'JSON containers cannot have symbol properties.');
    }
    const length = array ? (value as unknown[]).length : keys.length;
    if (array && (length > MAX_BUS_ENVELOPE_BYTES || keys.length !== length + 1)) {
      refuse('invalid-json', '$.body', 'JSON arrays must be dense and have no extra properties.');
    }
    ancestors.add(value);
    write(array ? '[' : '{');
    for (let index = 0; index < length; index++) {
      if (index > 0) write(',');
      const key = array ? String(index) : keys[index] as string;
      if (!array) { string(key); write(':'); }
      visit(dataProperty(value, key, '$.body'), depth + 1);
    }
    write(array ? ']' : '}');
    ancestors.delete(value);
  };
  visit(envelope, 0);
  return { json: parts.join(''), byteLength };
}

/**
 * Validate an object and return a detached JSON snapshot plus checked wire bytes.
 * Rejects lossy JSON coercions (undefined, NaN, sparse arrays, class instances,
 * accessors, hooks, symbols and cycles). Does not mutate input or dispatch events.
 */
export function validateBusEnvelope(input: unknown): BusEnvelopeValidationResult {
  try {
    if (!plainRecord(input)) refuse('invalid-envelope', '$', 'Envelope must be a plain object.');
    const keys = Reflect.ownKeys(input);
    if (keys.length !== FIELDS.length || keys.some((key) => !FIELDS.includes(key as typeof FIELDS[number]))) {
      refuse('invalid-envelope', '$', 'Envelope requires exactly id, from, to, priority, ttl and body.');
    }
    const fields = FIELDS.map((key) => dataProperty(input, key, `$.${key}`));
    const [id, from, to, priority, ttl, body] = fields;
    for (const [index, field] of ['id', 'from', 'to'].entries()) {
      const value = fields[index];
      if (typeof value !== 'string' || value.length > MAX_BUS_ADDRESS_LENGTH || !TOKEN.test(value)) {
        refuse('invalid-field', `$.${field}`, 'Expected a printable ASCII token of 1 to 128 characters.');
      }
    }
    if (!BUS_PRIORITIES.includes(priority as BusPriority)) {
      refuse('invalid-field', '$.priority', 'Priority must be P0, P1, P2 or P3.');
    }
    if (typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl <= 0) {
      refuse('invalid-field', '$.ttl', 'TTL must be a positive safe integer in milliseconds.');
    }
    const encoded = encode({ id, from, to, priority, ttl, body } as BusEnvelope<unknown>);
    return { ok: true, value: JSON.parse(encoded.json) as BusEnvelope, ...encoded, issues: [] };
  } catch (error) {
    return { ok: false, issues: [error instanceof EnvelopeError ? error.issue : {
      code: 'invalid-json', path: '$', message: 'Envelope is not valid JSON data.',
    }] };
  }
}

/** Cap the received UTF-8 JSON text (including whitespace) before parsing it. */
export function parseBusEnvelope(input: unknown): BusEnvelopeValidationResult {
  if (typeof input !== 'string') {
    return { ok: false, issues: [{ code: 'invalid-json', path: '$', message: 'Expected JSON text.' }] };
  }
  if (input.length > MAX_BUS_ENVELOPE_BYTES || Buffer.byteLength(input, 'utf8') > MAX_BUS_ENVELOPE_BYTES) {
    return { ok: false, issues: [{ code: 'too-large', path: '$', message: 'JSON text exceeds the 65536-byte UTF-8 limit.' }] };
  }
  try {
    return validateBusEnvelope(JSON.parse(input));
  } catch {
    return { ok: false, issues: [{ code: 'invalid-json', path: '$', message: 'Malformed JSON text.' }] };
  }
}
