/**
 * Bus protocol v1: typed conventions carried under the reserved `protocol` key
 * of the opaque envelope body. The wire envelope (bus.v1) is unchanged, so
 * legacy bodies remain valid and nothing here dispatches or authorizes work.
 * Topic names, kinds and payload refs are routing data, never identity.
 */

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
  if (protocolOf(body)?.kind === 'task') return true;
  return body !== null && typeof body === 'object' && !Array.isArray(body) && (body as { kind?: unknown }).kind === 'work';
}
