/**
 * The three bus operations (send, read, ack) shared by `phm bus` and the MCP tool.
 * Identity is declared by the caller (flags or PHM_BUS_* env): a routing label, not authentication.
 * Bodies pass through scrubSecrets before they are stored, and nothing here logs a body.
 */
import { hostname } from 'node:os';

import { scrubSecrets } from '../util/scrub-secrets.js';
import {
  BUS_KINDS, BUS_MESSAGE_SCHEMA, BUS_VENDORS, type BusKind, type BusMessage, type BusRecipient, type BusSender,
  busMessageIssues, busTopicOf, isBusId, isBusKind, isBusLabel, isBusVendor, newBusId,
} from './message.js';
import {
  type BusStoreOptions, appendBusAck, appendBusMessage, readBusAcks, readBusTopicMessages,
} from './store.js';

export const DEFAULT_BUS_READ_LIMIT = 50;
export const MAX_BUS_READ_LIMIT = 200;

type Env = Record<string, string | undefined>;

export interface BusIdentityInput { agent?: string; vendor?: string; node?: string }

/** Flags win over PHM_BUS_AGENT / PHM_BUS_VENDOR / PHM_BUS_NODE; the fallback is a human at this host. */
export function resolveBusIdentity(input: BusIdentityInput = {}, env: Env = process.env): BusSender | { error: string } {
  const agent = input.agent ?? env['PHM_BUS_AGENT'] ?? 'operator';
  const vendor = input.vendor ?? env['PHM_BUS_VENDOR'] ?? 'human';
  const node = input.node ?? env['PHM_BUS_NODE'] ?? (hostname().replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64) || 'local');
  if (!isBusLabel(agent)) return { error: 'agent is invalid (letters, digits and . _ : -, up to 64)' };
  if (!isBusVendor(vendor)) return { error: `vendor must be one of ${BUS_VENDORS.join('|')}` };
  if (!isBusLabel(node)) return { error: 'node is invalid (letters, digits and . _ : -, up to 64)' };
  return { agent, vendor, node };
}

export interface BusSendInput extends BusIdentityInput {
  to: BusRecipient;
  body: string;
  kind?: string;
  thread?: string;
  refs?: string[];
}

export type BusSendResult =
  | { ok: true; status: 'posted' | 'duplicate'; id: string; thread: string; topic: string; redacted: boolean }
  | { ok: false; status: 'invalid' | 'full' | 'unavailable'; issues: string[] };

export function busSend(input: BusSendInput, options: BusStoreOptions = {}, env: Env = process.env, now: Date = new Date()): BusSendResult {
  const from = resolveBusIdentity(input, env);
  if ('error' in from) return { ok: false, status: 'invalid', issues: [from.error] };
  const kind: BusKind | string = input.kind ?? 'note';
  if (!isBusKind(kind)) return { ok: false, status: 'invalid', issues: [`kind must be one of ${BUS_KINDS.join('|')}`] };
  const body = scrubSecrets(input.body ?? '');
  const id = newBusId(now.getTime());
  const message: BusMessage = {
    schema: BUS_MESSAGE_SCHEMA, id, thread: input.thread ?? id, from, to: input.to, kind, body,
    refs: input.refs ?? [], createdAt: now.toISOString(),
  };
  const issues = busMessageIssues(message);
  if (issues.length > 0) return { ok: false, status: 'invalid', issues };
  const topic = busTopicOf(message.to);
  const status = appendBusMessage(topic, message, options);
  if (status === 'posted' || status === 'duplicate') {
    return { ok: true, status, id, thread: message.thread, topic, redacted: body !== input.body };
  }
  return { ok: false, status, issues: [`store refused the message: ${status}`] };
}

export interface BusReadInput extends BusIdentityInput {
  /** Only these topics; all topics when omitted. */
  topic?: string;
  /** Messages addressed to this agent, role or topic label. */
  for?: string;
  /** ISO timestamp or a duration such as 30m, 2h, 1d. */
  since?: string;
  /** Hide messages the reader's agent already acked. */
  unacked?: boolean;
  limit?: number;
}

export type BusReadResult =
  | { ok: true; reader: BusSender; messages: BusMessage[]; truncated: boolean }
  | { ok: false; issues: string[] };

const DURATION = /^(\d{1,6})([smhd])$/;

export function parseBusSince(value: string, now: Date = new Date()): number | null {
  const d = DURATION.exec(value);
  if (d) return now.getTime() - Number(d[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2] as 's' | 'm' | 'h' | 'd'];
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function busRead(input: BusReadInput = {}, options: BusStoreOptions = {}, env: Env = process.env, now: Date = new Date()): BusReadResult {
  const reader = resolveBusIdentity(input, env);
  if ('error' in reader) return { ok: false, issues: [reader.error] };
  if (input.topic !== undefined && !isBusLabel(input.topic)) return { ok: false, issues: ['topic is invalid'] };
  if (input.for !== undefined && !isBusLabel(input.for)) return { ok: false, issues: ['for is invalid'] };
  let since: number | null = null;
  if (input.since !== undefined) {
    since = parseBusSince(input.since, now);
    if (since === null) return { ok: false, issues: ['since must be an ISO timestamp or a duration like 30m, 2h, 1d'] };
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_BUS_READ_LIMIT), 1), MAX_BUS_READ_LIMIT);
  const target = input.for?.toLowerCase();
  const acked = input.unacked
    ? new Set(readBusAcks(options).filter(a => a.by.agent === reader.agent).map(a => a.messageId))
    : null;
  const matches = readBusTopicMessages(input.topic === undefined ? undefined : [input.topic.toLowerCase()], options).filter(m =>
    (since === null || Date.parse(m.createdAt) >= since)
    && (target === undefined || [m.to.agent, m.to.role, m.to.topic].some(x => x?.toLowerCase() === target))
    && (acked === null || !acked.has(m.id)));
  // Newest `limit` messages, still returned oldest first.
  return { ok: true, reader, messages: matches.slice(-limit), truncated: matches.length > limit };
}

export interface BusAckInput extends BusIdentityInput { id: string; topic?: string }

export type BusAckOpResult =
  | { ok: true; status: 'acked' | 'duplicate'; id: string; by: BusSender }
  | { ok: false; status: 'invalid' | 'not-found' | 'unavailable'; issues: string[] };

export function busAck(input: BusAckInput, options: BusStoreOptions = {}, env: Env = process.env, now: Date = new Date()): BusAckOpResult {
  const by = resolveBusIdentity(input, env);
  if ('error' in by) return { ok: false, status: 'invalid', issues: [by.error] };
  if (!isBusId(input.id)) return { ok: false, status: 'invalid', issues: ['id is invalid'] };
  if (input.topic !== undefined && !isBusLabel(input.topic)) return { ok: false, status: 'invalid', issues: ['topic is invalid'] };
  const known = readBusTopicMessages(input.topic === undefined ? undefined : [input.topic.toLowerCase()], options);
  if (!known.some(m => m.id === input.id)) return { ok: false, status: 'not-found', issues: ['no message with that id'] };
  const status = appendBusAck({ schema: 'bus.ack.v1', messageId: input.id, by, at: now.toISOString() }, options);
  return status === 'unavailable'
    ? { ok: false, status, issues: ['store is locked or unavailable'] }
    : { ok: true, status, id: input.id, by };
}
