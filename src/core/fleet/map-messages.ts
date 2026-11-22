/**
 * The last agent-to-agent messages, one line each, for the fleet map's live
 * edges: `phm fleet map messages`, GET /api/fleet/map/messages and the phone
 * list.
 *
 * Not a second bus: a read-only projection of the durable bus inbox through the
 * `phm messages` read (agent-messages.ts) with the map's own agent-to-agent
 * rule. Display text and a short summary leave this read, and both are passed
 * through the shared secret scrub again here, so the raw envelope is never
 * echoed. Names are routing labels, not proven identities; an agent the map
 * does not draw has a null node (unknown, never guessed).
 */
import { parseSince, projectAgentMessages, type AgentMessageKind } from './agent-messages.js';
import { scanBusInbox, type BusInboxOptions } from './bus-inbox.js';
import { agentToAgent } from './fleet-edges.js';
import { mapEdgeAgent, MAP_EDGE_SUMMARY_MAX } from './map-edges.js';
import { scrubSecrets } from '../util/scrub.js';

export const MAP_MESSAGES_PATH = '/api/fleet/map/messages';
export const MAP_MESSAGES_DEFAULT_SINCE = '15m';
export const MAP_MESSAGES_DEFAULT_LIMIT = 20;
export const MAP_MESSAGES_MAX_LIMIT = 100;

/** Key order is the JSON contract. `fromNode`/`toNode` are map node ids (`leader`, `lane:<name>`, `job:<id>`), null when the map does not draw that agent. */
export interface MapMessage {
  id: string;
  from: string;
  to: string;
  fromNode: string | null;
  toNode: string | null;
  kind: AgentMessageKind;
  summary: string;
  at: string;
  /** Scrubbed display text, bounded to 8192 characters; never the raw envelope. */
  text?: string;
}
export interface MapMessages {
  schema: 'fleet.map-messages.v1';
  version: 1;
  generatedAt: string;
  /** Messages at or after this instant are listed. */
  since: string;
  source: 'available' | 'missing' | 'unavailable';
  /** Newest first, at most the limit. Null when the bus could not be read (unknown, not zero). */
  messages: MapMessage[] | null;
  /** Messages in the window before the limit; null with `messages`. */
  matched: number | null;
  /** Damaged bus rows skipped while reading. */
  skipped: number;
}
export interface MapMessagesOptions extends BusInboxOptions {
  limit?: number;
  /** The redaction applied to every summary. Defaults to the shared secret scrub. */
  redact?: (text: string) => string;
}

/** Pure: bus receipts in, newest-first messages out. */
export function buildMapMessages(scan: ReturnType<typeof scanBusInbox>, since: number, now: number, limit: number, redact: (text: string) => string = scrubSecrets): MapMessages {
  const head = { schema: 'fleet.map-messages.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(), since: new Date(since).toISOString(), source: scan.source };
  if (scan.source === 'unavailable') return { ...head, messages: null, matched: null, skipped: scan.skipped ?? 0 };
  const unique = new Map([...scan.rows].sort((a, b) => a.receivedAt - b.receivedAt || a.cursor - b.cursor).map(row => [row.envelope.id, row]));
  const rows = [...unique.values()].filter(row => agentToAgent(row.envelope) && row.receivedAt >= since && row.receivedAt <= now);
  const all = projectAgentMessages(rows);
  const messages = all.slice(0, limit).map(message => {
    const from = mapEdgeAgent(message.from), to = mapEdgeAgent(message.to);
    const body = unique.get(message.id)?.envelope.body;
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const display = [fields.text, fields.prompt, fields.summary, fields.detail, fields.reason].find(value => typeof value === 'string');
    const text = redact(scrubSecrets(typeof display === 'string' ? display : typeof body === 'string' ? body : message.summary)).slice(0, 8192);
    return { id: message.id, from: from.name, to: to.name, fromNode: from.node, toNode: to.node, kind: message.kind,
      summary: redact(message.summary).replace(/\s+/g, ' ').trim().slice(0, MAP_EDGE_SUMMARY_MAX) || 'No text.', at: message.ts, text };
  });
  return { ...head, messages, matched: all.length, skipped: scan.skipped ?? 0 };
}

/** The one read behind the CLI, the API and the map. `since` is `10m`, `2h`, `1d`, epoch ms or an ISO time; null when it is none of those. */
export function readMapMessages(since: string = MAP_MESSAGES_DEFAULT_SINCE, options: MapMessagesOptions = {}): MapMessages | null {
  const now = (options.now ?? Date.now)(), from = parseSince(since, now);
  return from === null ? null : buildMapMessages(scanBusInbox(options), from, now, options.limit ?? MAP_MESSAGES_DEFAULT_LIMIT, options.redact);
}

/** `limit` is a whole number from 1 to 100; null when it is anything else. */
export function parseMapMessagesLimit(value: string): number | null {
  return /^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= MAP_MESSAGES_MAX_LIMIT ? Number(value) : null;
}

/** GET /api/fleet/map/messages[?since=15m&limit=20]: 200 the messages, 400 a bad query, 503 the typed "unknown" read. */
export function mapMessagesResponse(url: string, options: BusInboxOptions = {}): { status: 200 | 400 | 503; body: MapMessages | { error: string } } {
  const params = new URL(url, 'http://localhost').searchParams;
  if ([...params.keys()].some(key => key !== 'since' && key !== 'limit') || params.getAll('since').length > 1 || params.getAll('limit').length > 1) {
    return { status: 400, body: { error: 'Use since and limit only, once each.' } };
  }
  const rawLimit = params.get('limit'), limit = rawLimit === null ? MAP_MESSAGES_DEFAULT_LIMIT : parseMapMessagesLimit(rawLimit);
  if (limit === null) return { status: 400, body: { error: `limit takes a whole number from 1 to ${MAP_MESSAGES_MAX_LIMIT}.` } };
  const read = readMapMessages(params.get('since') ?? undefined, { ...options, limit });
  if (!read) return { status: 400, body: { error: 'since takes 10m, 2h, 1d, epoch ms or an ISO time.' } };
  return { status: read.source === 'unavailable' ? 503 : 200, body: read };
}

/** `phm fleet map messages` for people: one line per message, newest first. */
export function formatMapMessagesText(read: MapMessages): string {
  if (!read.messages) return 'Agent messages: unknown (the agent bus could not be read).';
  const count = `${read.matched} agent message${read.matched === 1 ? '' : 's'} since ${read.since.slice(0, 16).replace('T', ' ')} UTC.`;
  return [count, ...read.messages.map(m => `${m.at.slice(11, 19)}Z ${m.from} -> ${m.to} (${m.kind}): ${m.summary}`),
    ...(read.skipped > 0 ? [`Skipped ${read.skipped} damaged bus record${read.skipped === 1 ? '' : 's'}.`] : [])].join('\n');
}
