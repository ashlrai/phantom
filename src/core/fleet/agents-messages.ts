/**
 * `phm agents messages`: recent agent-to-agent messages placed on the map.
 *
 * Not a new store: the same read-only projection of the durable bus inbox that
 * `phm messages` uses (agent-messages.ts: scrubbed one-line summaries, capped at
 * 160 characters), filtered by the map's agent-to-agent rule (fleet-edges.ts)
 * and by the same filter vocabulary `phm messages` parses — kind, priority,
 * job, thread, channel, contains, from/exclude-from, in-reply-to, id,
 * body-kind, to, agent/with —
 * with each sender and recipient resolved to the node id `phm map` draws
 * (map-edges.ts: `leader`, `lane:<name>`, `job:<id>`). An agent the map does not
 * draw reads "unknown"; its routing label stays in `fromName` / `toName`.
 * Served by GET /api/verse/fleet/control/agent-messages for the Map pane's cards.
 */
import { matchAgentMessages, parseAgentMessagesQuery, parseSince,
  type AgentMessage, type AgentMessageKind, type AgentMessagesQuery } from './agent-messages.js';
import { scanBusInbox, type BusInboxOptions } from './bus-inbox.js';
import { agentToAgent } from './fleet-edges.js';
import { mapEdgeAgent } from './map-edges.js';

export const AGENTS_MESSAGES_DEFAULT_SINCE = '1h';
export const AGENTS_MESSAGES_DEFAULT_LIMIT = 50;
/** How many summaries a pair keeps for the map's hover card. */
export const AGENTS_MESSAGES_RECENT = 5;
export const UNKNOWN_NODE = 'unknown';

/** Key order is the JSON contract. */
export interface AgentsMessage {
  at: string;
  /** Map node id of the sender, or "unknown" when the map does not draw it. */
  from: string;
  to: string;
  kind: AgentMessageKind;
  /** One scrubbed line, at most 160 characters. */
  summary: string;
  /** Present only when the message names its thread (or replies into one). */
  threadId?: string;
  /** The routing labels behind `from` / `to`: claims, never proven identities. */
  fromName: string;
  toName: string;
}
/** Every message between two map nodes in the window, one direction. Unknown nodes pool under "unknown". */
export interface AgentsMessagePair {
  from: string;
  to: string;
  count: number;
  lastAt: string;
  /** Newest first, at most five. */
  recent: { at: string; kind: AgentMessageKind; summary: string }[];
}
export interface AgentsMessages {
  schema: 'agents.messages.v1';
  version: 1;
  generatedAt: string;
  since: string;
  source: 'available' | 'missing' | 'unavailable';
  /** Newest first, at most `limit`. Null when the bus could not be read (unknown, not zero). */
  messages: AgentsMessage[] | null;
  /** Edge weights over every message the filters kept (not only the listed ones), newest pair first. Null with `messages`. */
  pairs: AgentsMessagePair[] | null;
  /** Messages the filters kept before `limit`; null when unknown. */
  matched: number | null;
  skipped: number;
}

/** The stringly flags the CLI and API hand this read: the `phm messages` filter vocabulary plus this read's own --since/--before/--limit. */
export interface AgentsMessagesFlags {
  since?: string; before?: string; limit?: string;
  agent?: string; with?: string; kind?: string; priority?: string; job?: string;
  thread?: string; channel?: string; contains?: string;
  from?: string; excludeFrom?: string; inReplyTo?: string; id?: string; bodyKind?: string; to?: string;
}
/** Pure: the matched agent messages in, map-node rows and per-pair weights out. Same rows and clock, same JSON. */
export function buildAgentsMessages(scan: { source: AgentsMessages['source']; matched: readonly AgentMessage[]; skipped?: number },
  query: { since: number; limit?: number }, now: number): AgentsMessages {
  const head = { schema: 'agents.messages.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(),
    since: new Date(query.since).toISOString(), source: scan.source };
  const skipped = scan.skipped ?? 0;
  if (scan.source === 'unavailable') return { ...head, messages: null, pairs: null, matched: null, skipped };
  const node = (name: string, lane: string | null) => mapEdgeAgent({ name, lane }).node ?? UNKNOWN_NODE;
  const all: AgentsMessage[] = scan.matched.map(m => ({
    at: m.ts, from: node(m.from.name, m.from.lane), to: node(m.to.name, m.to.lane), kind: m.kind, summary: m.summary,
    // `pair:` conversations are synthesized from the two labels, not a thread the agents named.
    ...(m.conversation.startsWith('pair:') ? {} : { threadId: m.conversation }),
    fromName: m.from.name, toName: m.to.name,
  }));
  const pairs = new Map<string, AgentsMessagePair>();
  for (const m of all) {
    const key = `${m.from}->${m.to}`, pair = pairs.get(key) ?? { from: m.from, to: m.to, count: 0, lastAt: m.at, recent: [] };
    pair.count++;
    if (pair.recent.length < AGENTS_MESSAGES_RECENT) pair.recent.push({ at: m.at, kind: m.kind, summary: m.summary });
    pairs.set(key, pair);
  }
  return { ...head, messages: all.slice(0, query.limit ?? AGENTS_MESSAGES_DEFAULT_LIMIT), pairs: [...pairs.values()], matched: all.length, skipped };
}

/**
 * Shared flag/param check: `since`/`before` take 10m, 2h, 1d, epoch ms or ISO
 * (`before` exclusive) with this read's 1h default; every other filter is the
 * `phm messages` vocabulary validated by the same parser — `limit` 1..1024.
 */
export function parseAgentsMessagesQuery(input: AgentsMessagesFlags, now: number):
  { ok: true; query: AgentMessagesQuery & { since: number; limit: number } } | { ok: false; error: string } {
  const since = parseSince(input.since ?? AGENTS_MESSAGES_DEFAULT_SINCE, now);
  if (since === null) return { ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' };
  let before: number | undefined;
  if (input.before !== undefined) {
    const parsed = parseSince(input.before, now);
    if (parsed === null) return { ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' };
    before = parsed;
  }
  const shared = parseAgentMessagesQuery({
    agent: input.agent, with: input.with, kind: input.kind, priority: input.priority, job: input.job,
    thread: input.thread, channel: input.channel, contains: input.contains,
    from: input.from, excludeFrom: input.excludeFrom, inReplyTo: input.inReplyTo, id: input.id,
    bodyKind: input.bodyKind, to: input.to, limit: input.limit,
  }, now);
  if (!shared.ok) return shared;
  return { ok: true, query: { ...shared.query, since, before, limit: shared.query.limit ?? AGENTS_MESSAGES_DEFAULT_LIMIT } };
}

/**
 * The one read behind the CLI, the API and the map. `agentToAgent` stays the
 * map's row gate and `receivedAt <= now` the clock-skew guard; every shared
 * filter then runs inside `matchAgentMessages`, so `matched` and `pairs` count
 * exactly the rows every filter accepts — the same set `phm messages` lists
 * for these flags, minus the rows the map never draws as agent mail.
 */
export function readAgentsMessages(input: AgentsMessagesFlags = {}, options: BusInboxOptions = {}):
  { ok: true; result: AgentsMessages } | { ok: false; error: string } {
  const now = (options.now ?? Date.now)(), parsed = parseAgentsMessagesQuery(input, now);
  if (!parsed.ok) return parsed;
  const scan = scanBusInbox(options);
  const rows = scan.rows.filter(row => agentToAgent(row.envelope) && row.receivedAt <= now);
  const matched = matchAgentMessages(rows, parsed.query, options, false);
  return { ok: true, result: buildAgentsMessages({ source: scan.source, matched, skipped: scan.skipped }, parsed.query, now) };
}

export function formatAgentsMessagesText(result: AgentsMessages): string {
  if (!result.messages || !result.pairs) return 'Agent messages: unknown (the agent bus could not be read).';
  const since = result.since.slice(0, 16).replace('T', ' ');
  if (!result.messages.length) return `No agent-to-agent messages since ${since} UTC.`;
  const who = (node: string, name: string) => node === UNKNOWN_NODE ? `${name} (unknown)` : node;
  return [`${result.messages.length} of ${result.matched} agent messages since ${since} UTC, newest first.`,
    ...result.messages.map(m => `  ${m.at.slice(11, 19)}Z ${m.kind.padEnd(7)} ${who(m.from, m.fromName)} -> ${who(m.to, m.toName)}: ${m.summary}`),
    `Lines: ${result.pairs.map(p => `${p.from} -> ${p.to} ${p.count}`).join(' · ')}`,
    ...(result.skipped > 0 ? [`Skipped ${result.skipped} damaged bus record${result.skipped === 1 ? '' : 's'}.`] : [])].join('\n');
}
