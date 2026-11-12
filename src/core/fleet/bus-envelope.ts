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

export const BUS_CHANNELS = ['bus', 'slack', 'imessage', 'email', 'telegram', 'handoff'] as const;
export type BusChannel = typeof BUS_CHANNELS[number];
export interface BusSender { agent_id: string; vendor: string; human: boolean; team: boolean }

/** Legacy envelopes have six fields; channel-aware envelopes add a complete metadata group. */
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
  channel?: BusChannel;
  channel_ref?: string;
  sender?: BusSender;
  external?: boolean;
  origin_bridge?: string;
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
const CHANNEL_FIELDS = ['channel', 'channel_ref', 'sender', 'external'] as const;
const OPTIONAL_FIELDS = [...CHANNEL_FIELDS, 'origin_bridge'] as const;
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
    if (keys.some((key) => typeof key !== 'string' ||
      !([...FIELDS, ...OPTIONAL_FIELDS] as readonly string[]).includes(key)) ||
      FIELDS.some((key) => !Object.hasOwn(input, key))) {
      refuse('invalid-envelope', '$', 'Envelope requires id, from, to, priority, ttl and body with only recognized fields.');
    }
    const hasChannelMetadata = OPTIONAL_FIELDS.some((key) => Object.hasOwn(input, key));
    if (hasChannelMetadata && CHANNEL_FIELDS.some((key) => !Object.hasOwn(input, key))) {
      refuse('invalid-envelope', '$', 'Channel metadata must include channel, channel_ref, sender and external.');
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
    // Encode before inspecting nested metadata so getters, proxies and non-JSON
    // values are rejected without invoking untrusted code.
    const encoded = hasChannelMetadata
      ? encode(input as unknown as BusEnvelope<unknown>)
      : encode({ id, from, to, priority, ttl, body } as BusEnvelope<unknown>);
    const value = JSON.parse(encoded.json) as BusEnvelope;
    const protocolProblem = protocolIssue(value);
    if (protocolProblem) refuse('invalid-field', '$.body.protocol', protocolProblem);
    if (hasChannelMetadata) {
      if (!BUS_CHANNELS.includes(value.channel as BusChannel)) {
        refuse('invalid-field', '$.channel', 'Unknown channel.');
      }
      if (typeof value.channel_ref !== 'string' || value.channel_ref.length < 1 || value.channel_ref.length > 1024 || Array.from(value.channel_ref).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
        refuse('invalid-field', '$.channel_ref', 'Channel reference must be a nonempty bounded string without control characters.');
      }
      const sender = value.sender;
      if (!sender || typeof sender !== 'object' || Array.isArray(sender) ||
        Object.keys(sender).length !== 4 || !['agent_id', 'vendor', 'human', 'team'].every((key) => Object.hasOwn(sender, key)) ||
        typeof sender.agent_id !== 'string' || sender.agent_id.length > MAX_BUS_ADDRESS_LENGTH || !TOKEN.test(sender.agent_id) ||
        typeof sender.vendor !== 'string' || sender.vendor.length > MAX_BUS_ADDRESS_LENGTH || !TOKEN.test(sender.vendor) ||
        typeof sender.human !== 'boolean' || typeof sender.team !== 'boolean') {
        refuse('invalid-field', '$.sender', 'Sender must contain valid agent_id, vendor, human and team fields.');
      }
      if (typeof value.external !== 'boolean' || (!sender.team && !value.external)) {
        refuse('invalid-field', '$.external', 'External must be true when the sender is outside the team.');
      }
      if (Object.hasOwn(value, 'origin_bridge') &&
        (typeof value.origin_bridge !== 'string' || value.origin_bridge.length > MAX_BUS_ADDRESS_LENGTH || !TOKEN.test(value.origin_bridge))) {
        refuse('invalid-field', '$.origin_bridge', 'Origin bridge must be a printable ASCII token of 1 to 128 characters.');
      }
    }
    return { ok: true, value, ...encoded, issues: [] };
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

// ---------------------------------------------------------------------------
// Bus protocol v1
//
// Typed conventions carried under the reserved `protocol` key of the opaque
// envelope body. The wire envelope (bus.v1) is unchanged, so legacy bodies
// remain valid and nothing here dispatches or authorizes work. Topic names,
// kinds and payload refs are routing data, never identity.
//
// The implementation lives in this module (re-exported by bus-protocol.ts) so
// the runtime import closure of the Tier-1 authority roots stays flat: this
// file is already in that closure, a separate implementation module would join
// it and trip test/authority-tier1-closure-310b.test.ts.
// ---------------------------------------------------------------------------

export const BUS_PROTOCOL_VERSION = 1;
export const BUS_PROTOCOL_KEY = 'protocol';
export const BUS_PROTOCOL_KINDS = ['task', 'result', 'review', 'status', 'question'] as const;
export type BusProtocolKind = typeof BUS_PROTOCOL_KINDS[number];
export const BUS_TOPIC_NAMESPACES = ['fleet', 'repo', 'human'] as const;
export const BUS_PAYLOAD_REF_MAX = 256;

const SEGMENT = '[a-z0-9][a-z0-9_-]{0,63}';
const NAMESPACE = `(?:${BUS_TOPIC_NAMESPACES.join('|')})`;
/** A topic has a namespace and 1 to 4 further segments, e.g. `fleet.deploy` or `human.mason`. */
const TOPIC = new RegExp(`^${NAMESPACE}(?:\\.${SEGMENT}){1,4}$`);
/** A subscription prefix is a namespace, optionally narrowed, followed by `.*`. */
const TOPIC_PREFIX = new RegExp(`^${NAMESPACE}(?:\\.${SEGMENT}){0,3}$`);
const PAYLOAD_REF = new RegExp(`^[\\x21-\\x7e]{1,${BUS_PAYLOAD_REF_MAX}}$`);
const PROTOCOL_FIELDS = ['version', 'kind', 'topic', 'payload_ref'] as const;

export interface BusProtocol {
  version: typeof BUS_PROTOCOL_VERSION;
  kind: BusProtocolKind;
  /** Topic address; when present it must equal the envelope `to` field. */
  topic?: string;
  /** Opaque printable reference to data held elsewhere; the bus never fetches it. */
  payload_ref?: string;
}

/** Exact topic name, e.g. `fleet.deploy`. */
export function isTopicName(value: unknown): value is string {
  return typeof value === 'string' && TOPIC.test(value);
}

/** Subscription pattern: an exact topic name or a namespace prefix ending in `.*`. */
export function isTopicPattern(value: unknown): value is string {
  if (isTopicName(value)) return true;
  return typeof value === 'string' && value.endsWith('.*') && TOPIC_PREFIX.test(value.slice(0, -2));
}

/** `fleet.*` matches `fleet.deploy` but not `fleetx.deploy`; patterns never match malformed topics. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (!isTopicName(topic) || !isTopicPattern(pattern)) return false;
  return pattern.endsWith('.*') ? topic.startsWith(pattern.slice(0, -1)) : pattern === topic;
}

/** Returns the protocol object of a body when one is present and was not rejected at ingest. */
export function protocolOf(body: unknown): BusProtocol | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, BUS_PROTOCOL_KEY)) return undefined;
  return (body as { protocol: BusProtocol }).protocol;
}

/** Static diagnostic when a body carries a malformed `protocol`; undefined when absent or valid. */
export function protocolIssue(envelope: { to: string; body: unknown }): string | undefined {
  const { body } = envelope;
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, BUS_PROTOCOL_KEY)) return undefined;
  const protocol: unknown = (body as Record<string, unknown>)[BUS_PROTOCOL_KEY];
  if (protocol === null || typeof protocol !== 'object' || Array.isArray(protocol)) return 'Protocol must be an object.';
  const record = protocol as Record<string, unknown>;
  if (Object.keys(record).some(key => !(PROTOCOL_FIELDS as readonly string[]).includes(key))) return 'Protocol has unrecognized fields.';
  if (record.version !== BUS_PROTOCOL_VERSION) return `Protocol version must be ${BUS_PROTOCOL_VERSION}.`;
  if (!(BUS_PROTOCOL_KINDS as readonly unknown[]).includes(record.kind)) return 'Protocol kind must be task, result, review, status or question.';
  if (Object.hasOwn(record, 'topic') && (!isTopicName(record.topic) || record.topic !== envelope.to)) {
    return 'Protocol topic must be a namespaced name (fleet, repo or human) equal to the envelope to field.';
  }
  if (Object.hasOwn(record, 'payload_ref') && (typeof record.payload_ref !== 'string' || !PAYLOAD_REF.test(record.payload_ref))) {
    return `Protocol payload_ref must be a printable token of 1 to ${BUS_PAYLOAD_REF_MAX} characters.`;
  }
  return undefined;
}

/** Work a claim may take: protocol `task`, or the legacy `{kind:'work'}` body convention. */
export function isClaimableWork(body: unknown): boolean {
  if (body !== null && typeof body === 'object' && Object.hasOwn(body, BUS_PROTOCOL_KEY)) {
    return protocolOf(body)?.kind === 'task';
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { kind?: unknown }).kind === 'work';
}
