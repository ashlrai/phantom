/**
 * `phm bus recent`: who messaged whom lately, as one small typed list.
 *
 * Not a second read: `phm agents messages` (agents-messages.ts) already
 * projects the durable bus inbox into scrubbed one-line summaries. This keeps
 * its rows, names the agents by their routing labels (what an agent knows),
 * and cuts each summary to 100 characters. No message body leaves this read.
 */
import { readAgentsMessages, type AgentsMessage } from './agents-messages.js';
import type { BusInboxOptions } from './bus-inbox.js';
import type { AgentMessageKind } from './agent-messages.js';

export const BUS_RECENT_SCHEMA = 'bus.recent.v1';
export const BUS_RECENT_DEFAULT_SINCE = '5m';
export const BUS_RECENT_SUMMARY_MAX = 100;

/** Key order is the JSON contract. */
export interface BusRecentMessage { at: string; from: string; to: string; kind: AgentMessageKind; summary: string }
export interface BusRecent {
  schema: typeof BUS_RECENT_SCHEMA;
  as_of: string;
  /** Newest first. Null when the bus could not be read (unknown, not zero). */
  messages: BusRecentMessage[] | null;
}

const short = (text: string): string => text.length <= BUS_RECENT_SUMMARY_MAX ? text : `${text.slice(0, BUS_RECENT_SUMMARY_MAX - 1).trimEnd()}…`;

/** Pure: agent messages in, the typed list out. */
export function buildBusRecent(asOf: string, messages: readonly AgentsMessage[] | null): BusRecent {
  return { schema: BUS_RECENT_SCHEMA, as_of: asOf, messages: messages && messages.map(m => ({ at: m.at, from: m.fromName, to: m.toName, kind: m.kind, summary: short(m.summary) })) };
}

/** `since`/`before` take 10m, 2h, 1d, epoch ms or ISO (`before` exclusive); exit-code hint: ok false is a bad flag. */
export function readBusRecent(input: { since?: string; before?: string } = {}, options: BusInboxOptions = {}): { ok: true; result: BusRecent } | { ok: false; error: string } {
  const read = readAgentsMessages({ since: input.since ?? BUS_RECENT_DEFAULT_SINCE, before: input.before, limit: '1024' }, options);
  return read.ok ? { ok: true, result: buildBusRecent(read.result.generatedAt, read.result.messages) } : read;
}

export function formatBusRecentText(result: BusRecent): string {
  if (!result.messages) return 'Agent messages: unknown (the agent bus could not be read).';
  if (!result.messages.length) return 'No messages yet.';
  return result.messages.map(m => `${m.at.slice(11, 19)}Z ${m.kind.padEnd(7)} ${m.from} -> ${m.to}: ${m.summary}`).join('\n');
}
