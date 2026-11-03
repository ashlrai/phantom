/**
 * bus.message.v1: the vendor-neutral agent bus message.
 * Schema of record: docs/bus/bus.message.v1.schema.json (a test keeps the enums in step).
 * Labels are routing hints, never authenticated identities; bodies are untrusted markdown.
 */
import { randomBytes } from 'node:crypto';

export const BUS_MESSAGE_SCHEMA = 'bus.message.v1';
export const BUS_VENDORS = ['claude', 'codex', 'devin', 'grok', 'local', 'human'] as const;
export const BUS_KINDS = ['note', 'ask', 'reply', 'handoff', 'status'] as const;
export const MAX_BUS_BODY_CHARS = 16_384;
export const MAX_BUS_REFS = 32;
export const MAX_BUS_REF_CHARS = 256;

export type BusVendor = typeof BUS_VENDORS[number];
export type BusKind = typeof BUS_KINDS[number];

export interface BusSender { agent: string; vendor: BusVendor; node: string }
export interface BusRecipient { agent?: string; role?: string; topic?: string }

export interface BusMessage {
  schema: typeof BUS_MESSAGE_SCHEMA;
  id: string;
  thread: string;
  from: BusSender;
  to: BusRecipient;
  kind: BusKind;
  body: string;
  refs: string[];
  createdAt: string;
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isBusLabel(value: unknown): value is string {
  return typeof value === 'string' && LABEL.test(value);
}

export function isBusId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

export function isBusVendor(value: unknown): value is BusVendor {
  return typeof value === 'string' && (BUS_VENDORS as readonly string[]).includes(value);
}

export function isBusKind(value: unknown): value is BusKind {
  return typeof value === 'string' && (BUS_KINDS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, out: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) out.push(`${path}.${key} is not allowed`);
}

/** Returns every problem found; an empty list means `value` is a valid bus.message.v1. */
export function busMessageIssues(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ['message must be an object'];
  unknownKeys(value, ['schema', 'id', 'thread', 'from', 'to', 'kind', 'body', 'refs', 'createdAt'], 'message', issues);
  if (value['schema'] !== BUS_MESSAGE_SCHEMA) issues.push(`schema must be ${BUS_MESSAGE_SCHEMA}`);
  if (typeof value['id'] !== 'string' || !ID.test(value['id'])) issues.push('id is invalid');
  if (typeof value['thread'] !== 'string' || !ID.test(value['thread'])) issues.push('thread is invalid');

  const from = value['from'];
  if (!isRecord(from)) issues.push('from must be an object');
  else {
    unknownKeys(from, ['agent', 'vendor', 'node'], 'from', issues);
    if (!isBusLabel(from['agent'])) issues.push('from.agent is invalid');
    if (!isBusVendor(from['vendor'])) issues.push(`from.vendor must be one of ${BUS_VENDORS.join('|')}`);
    if (!isBusLabel(from['node'])) issues.push('from.node is invalid');
  }

  const to = value['to'];
  if (!isRecord(to)) issues.push('to must be an object');
  else {
    unknownKeys(to, ['agent', 'role', 'topic'], 'to', issues);
    const present = ['agent', 'role', 'topic'].filter(k => to[k] !== undefined);
    if (present.length === 0) issues.push('to needs at least one of agent, role, topic');
    for (const key of present) if (!isBusLabel(to[key])) issues.push(`to.${key} is invalid`);
  }

  if (!isBusKind(value['kind'])) issues.push(`kind must be one of ${BUS_KINDS.join('|')}`);
  const body = value['body'];
  if (typeof body !== 'string' || body.length < 1) issues.push('body must be a non-empty string');
  else if (body.length > MAX_BUS_BODY_CHARS) issues.push(`body exceeds ${MAX_BUS_BODY_CHARS} characters`);

  const refs = value['refs'];
  if (!Array.isArray(refs)) issues.push('refs must be an array');
  else {
    if (refs.length > MAX_BUS_REFS) issues.push(`refs exceeds ${MAX_BUS_REFS} items`);
    if (refs.some(r => typeof r !== 'string' || r.length < 1 || r.length > MAX_BUS_REF_CHARS)) issues.push('refs items must be 1-256 character strings');
  }

  const at = value['createdAt'];
  if (typeof at !== 'string' || !ISO.test(at) || Number.isNaN(Date.parse(at))) issues.push('createdAt must be an ISO 8601 date-time');
  return issues;
}

export type BusParse = { ok: true; message: BusMessage } | { ok: false; issues: string[] };

export function parseBusMessage(value: unknown): BusParse {
  const issues = busMessageIssues(value);
  return issues.length === 0 ? { ok: true, message: value as BusMessage } : { ok: false, issues };
}

/** Time-sortable id: base36 millis then 8 random hex chars. */
export function newBusId(now: number = Date.now()): string {
  return `bus-${now.toString(36).padStart(9, '0')}-${randomBytes(4).toString('hex')}`;
}

/** The storage topic of a message: explicit topic, else the agent or role inbox. */
export function busTopicOf(to: BusRecipient): string {
  const topic = to.topic ?? (to.agent !== undefined ? `agent-${to.agent}` : to.role !== undefined ? `role-${to.role}` : '');
  return topic.toLowerCase();
}
