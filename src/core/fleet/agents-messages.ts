/**
 * `phm agents messages`: recent agent-to-agent messages placed on the map.
 *
 * Not a new store: the same read-only projection of the durable bus inbox that
 * `phm messages` uses (agent-messages.ts: scrubbed one-line summaries, capped at
 * 160 characters), filtered by the map's agent-to-agent rule (fleet-edges.ts),
 * with each sender and recipient resolved to the node id `phm map` draws
 * (map-edges.ts: `leader`, `lane:<name>`, `job:<id>`). An agent the map does not
 * draw reads "unknown"; its routing label stays in `fromName` / `toName`.
 * Served by GET /api/verse/fleet/control/agent-messages for the Map pane's cards.
 */
import { AGENT_MESSAGES_MAX_LIMIT, parseSince, projectAgentMessages, type AgentMessageKind } from './agent-messages.js';
import { scanBusInbox, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';
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
  /** Edge weights over every message in the window (not only the listed ones), newest pair first. Null with `messages`. */
  pairs: AgentsMessagePair[] | null;
  /** Messages in the window before `limit`; null when unknown. */
  matched: number | null;
  skipped: number;
}

/** Pure: bus receipts in, messages and per-pair weights out. Same rows and clock, same JSON. */
export function buildAgentsMessages(scan: { source: AgentsMessages['source']; rows: readonly BusInboxReceipt[]; skipped?: number },
  query: { since: number; before?: number; limit?: number }, now: number): AgentsMessages {
  const head = { schema: 'agents.messages.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(),
    since: new Date(query.since).toISOString(), source: scan.source };
  const skipped = scan.skipped ?? 0;
  if (scan.source === 'unavailable') return { ...head, messages: null, pairs: null, matched: null, skipped };
  const rows = scan.rows.filter(row => agentToAgent(row.envelope) && row.receivedAt >= query.since && row.receivedAt <= now
    && (query.before === undefined || row.receivedAt < query.before));
  const node = (name: string, lane: string | null) => mapEdgeAgent({ name, lane }).node ?? UNKNOWN_NODE;
  const all: AgentsMessage[] = projectAgentMessages(rows).map(m => ({
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

/** Shared flag/param check: `since`/`before` take 10m, 2h, 1d, epoch ms or ISO (`before` exclusive); `limit` 1..1024. */
export function parseAgentsMessagesQuery(input: { since?: string; before?: string; limit?: string }, now: number):
  { ok: true; query: { since: number; before?: number; limit: number } } | { ok: false; error: string } {
  const since = parseSince(input.since ?? AGENTS_MESSAGES_DEFAULT_SINCE, now);
  if (since === null) return { ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' };
  let before: number | undefined;
  if (input.before !== undefined) {
    const parsed = parseSince(input.before, now);
    if (parsed === null) return { ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' };
    before = parsed;
  }
  const limit = input.limit === undefined ? AGENTS_MESSAGES_DEFAULT_LIMIT : Number(input.limit);
  if (input.limit !== undefined && (!/^[1-9][0-9]*$/.test(input.limit) || limit > AGENT_MESSAGES_MAX_LIMIT)) {
    return { ok: false, error: `--limit takes 1..${AGENT_MESSAGES_MAX_LIMIT}.` };
  }
  return { ok: true, query: { since, before, limit } };
}

/** The one read behind the CLI, the API and the map. */
export function readAgentsMessages(input: { since?: string; before?: string; limit?: string } = {}, options: BusInboxOptions = {}):
  { ok: true; result: AgentsMessages } | { ok: false; error: string } {
  const now = (options.now ?? Date.now)(), parsed = parseAgentsMessagesQuery(input, now);
  return parsed.ok ? { ok: true, result: buildAgentsMessages(scanBusInbox(options), parsed.query, now) } : parsed;
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
