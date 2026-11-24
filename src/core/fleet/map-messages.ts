/**
 * The last agent-to-agent messages, one line each, for the fleet map's live
 * edges: `phm fleet map messages`, `phm fleet messages`,
 * GET /api/fleet/map/messages and the phone list.
 *
 * Not a second bus: a read-only projection of the durable bus inbox through
 * the shared `phm messages` pipeline (agent-messages.ts) with the map's own
 * agent-to-agent rule and the same filter vocabulary `phm messages` parses —
 * agent/with, kind, priority, job, thread, channel, contains,
 * from/exclude-from, in-reply-to, id, body-kind and to all match exactly the way
 * that read matches them, so a filtered question about the map feed gets the
 * same answer every other bus read gives. Display text and a short summary
 * leave this read, and both are passed through the shared secret scrub again here,
 * so the raw envelope is never echoed. Names are routing labels, not proven
 * identities; an agent the map does not draw has a null node (unknown, never
 * guessed).
 */
import { matchAgentMessages, parseAgentMessagesQuery, parseSince,
  type AgentMessage, type AgentMessagesQuery } from './agent-messages.js';
import { scanBusInbox, type BusInboxOptions } from './bus-inbox.js';
import { agentToAgent } from './fleet-edges.js';
import { mapEdgeAgent, MAP_EDGE_SUMMARY_MAX } from './map-edges.js';
import { scrubSecrets } from '../util/scrub.js';

export const MAP_MESSAGES_PATH = '/api/fleet/map/messages';
export const MAP_MESSAGES_DEFAULT_SINCE = '15m';
export const MAP_MESSAGES_DEFAULT_LIMIT = 20;
export const MAP_MESSAGES_MAX_LIMIT = 100;

/** The stringly flags the CLI and API hand this read: the `phm messages`
 * filter vocabulary plus this read's own --since/--before/--limit. */
export interface MapMessagesFlags {
  since?: string; before?: string; limit?: string;
  agent?: string; with?: string; kind?: string; priority?: string; job?: string;
  thread?: string; channel?: string; contains?: string;
  from?: string; excludeFrom?: string; inReplyTo?: string; id?: string; bodyKind?: string; to?: string;
}

/** Key order is the JSON contract. `fromNode`/`toNode` are map node ids (`leader`, `lane:<name>`, `job:<id>`), null when the map does not draw that agent. */
export interface MapMessage {
  id: string;
  from: string;
  to: string;
  fromNode: string | null;
  toNode: string | null;
  kind: AgentMessage['kind'];
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
  /** Messages the filters kept in the window before the limit; null with `messages`. */
  matched: number | null;
  /** Damaged bus rows skipped while reading. */
  skipped: number;
}
export interface MapMessagesOptions extends BusInboxOptions {
  /** The redaction applied to every summary. Defaults to the shared secret scrub. */
  redact?: (text: string) => string;
}

/** Pure: the matched agent messages in, newest-first map rows out. Same rows
 * and clock, same JSON. `bodies` maps a message's wire id to its stored
 * envelope body for the optional scrubbed `text` field; a miss falls back to
 * the summary, the same as an unreadable body did. */
export function buildMapMessages(scan: { source: MapMessages['source']; matched: readonly AgentMessage[];
    bodies?: ReadonlyMap<string, unknown>; skipped?: number },
  query: { since: number; limit?: number }, now: number,
  redact: (text: string) => string = scrubSecrets): MapMessages {
  const head = { schema: 'fleet.map-messages.v1' as const, version: 1 as const, generatedAt: new Date(now).toISOString(), since: new Date(query.since).toISOString(), source: scan.source };
  if (scan.source === 'unavailable') return { ...head, messages: null, matched: null, skipped: scan.skipped ?? 0 };
  const messages = scan.matched.slice(0, query.limit ?? MAP_MESSAGES_DEFAULT_LIMIT).map(message => {
    const from = mapEdgeAgent(message.from), to = mapEdgeAgent(message.to);
    const body = scan.bodies?.get(message.id);
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const display = [fields.text, fields.prompt, fields.summary, fields.detail, fields.reason].find(value => typeof value === 'string');
    const text = redact(scrubSecrets(typeof display === 'string' ? display : typeof body === 'string' ? body : message.summary)).slice(0, 8192);
    return { id: message.id, from: from.name, to: to.name, fromNode: from.node, toNode: to.node, kind: message.kind,
      summary: redact(message.summary).replace(/\s+/g, ' ').trim().slice(0, MAP_EDGE_SUMMARY_MAX) || 'No text.', at: message.ts, text };
  });
  return { ...head, messages, matched: scan.matched.length, skipped: scan.skipped ?? 0 };
}

/** `limit` is a whole number from 1 to 100; null when it is anything else. */
export function parseMapMessagesLimit(value: string): number | null {
  return /^[1-9][0-9]{0,3}$/.test(value) && Number(value) <= MAP_MESSAGES_MAX_LIMIT ? Number(value) : null;
}

/**
 * Shared flag/param check: `since`/`before` take 10m, 2h, 1d, epoch ms or ISO
 * (`before` exclusive) with this read's 15m default; `limit` keeps this read's
 * own 1..100 bound; every other filter is the `phm messages` vocabulary
 * validated by the same parser — so the CLI, the API and `phm messages`
 * itself can never disagree on what a value means.
 */
export function parseMapMessagesQuery(input: MapMessagesFlags = {}, now = Date.now()):
  { ok: true; query: AgentMessagesQuery & { since: number; limit: number } } | { ok: false; error: string } {
  const since = parseSince(input.since ?? MAP_MESSAGES_DEFAULT_SINCE, now);
  if (since === null) return { ok: false, error: '--since takes 10m, 2h, 1d, epoch ms or an ISO time.' };
  let before: number | undefined;
  if (input.before !== undefined) {
    const parsed = parseSince(input.before, now);
    if (parsed === null) return { ok: false, error: '--before takes 10m, 2h, 1d, epoch ms or an ISO time.' };
    before = parsed;
  }
  let limit = MAP_MESSAGES_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    const parsed = parseMapMessagesLimit(input.limit);
    if (parsed === null) return { ok: false, error: `--limit takes a whole number from 1 to ${MAP_MESSAGES_MAX_LIMIT}.` };
    limit = parsed;
  }
  const shared = parseAgentMessagesQuery({
    agent: input.agent, with: input.with, kind: input.kind, priority: input.priority, job: input.job,
    thread: input.thread, channel: input.channel, contains: input.contains,
    from: input.from, excludeFrom: input.excludeFrom, inReplyTo: input.inReplyTo, id: input.id,
    bodyKind: input.bodyKind, to: input.to,
  }, now);
  if (!shared.ok) return shared;
  return { ok: true, query: { ...shared.query, since, before, limit } };
}

/**
 * The one read behind the CLI, the API and the map. Receipts are deduplicated
 * by id — newest wins — before any filter, `agentToAgent` stays the map's row
 * gate and `receivedAt <= now` the clock-skew guard; every shared filter then
 * runs inside `matchAgentMessages`, the same rows→messages pipeline `phm
 * messages`, `phm agents messages` and `phm bus recent` share, so `matched`
 * counts exactly the rows every filter accepts and a filtered question gets
 * the same answer on every bus read — minus the rows the map never draws as
 * agent mail. `since`/`input.before` take `10m`, `2h`, `1d`, epoch ms or an
 * ISO time and a malformed flag is a usage error, never a guessed window.
 */
export function readMapMessages(input: MapMessagesFlags = {}, options: MapMessagesOptions = {}):
  { ok: true; result: MapMessages } | { ok: false; error: string } {
  const now = (options.now ?? Date.now)(), parsed = parseMapMessagesQuery(input, now);
  if (!parsed.ok) return parsed;
  const scan = scanBusInbox(options);
  const unique = new Map([...scan.rows].sort((a, b) => a.receivedAt - b.receivedAt || a.cursor - b.cursor)
    .map(row => [row.envelope.id, row] as const));
  const rows = [...unique.values()].filter(row => agentToAgent(row.envelope) && row.receivedAt <= now);
  const bodies = new Map(rows.map(row => [row.envelope.id, row.envelope.body] as const));
  const matched = matchAgentMessages(rows, parsed.query, options, false);
  return { ok: true, result: buildMapMessages({ source: scan.source, matched, bodies, skipped: scan.skipped },
    parsed.query, now, options.redact) };
}

/** The query keys the read accepts — the CLI filter dimensions plus `limit`. */
const MAP_MESSAGES_QUERY_KEYS = ['since', 'before', 'limit', 'agent', 'with', 'kind', 'priority',
  'job', 'thread', 'channel', 'contains', 'from', 'excludeFrom', 'inReplyTo', 'id', 'bodyKind', 'to'] as const;

/** GET /api/fleet/map/messages[?since=15m&before=1h&limit=20&…]: 200 the messages, 400 a bad query, 503 the typed "unknown" read. */
export function mapMessagesResponse(url: string, options: BusInboxOptions = {}): { status: 200 | 400 | 503; body: MapMessages | { error: string } } {
  const params = new URL(url, 'http://localhost').searchParams;
  const keys = [...params.keys()];
  if (keys.some(key => !(MAP_MESSAGES_QUERY_KEYS as readonly string[]).includes(key)) ||
      keys.some(key => params.getAll(key).length > 1)) {
    return { status: 400, body: { error: `Use each filter at most once: ${MAP_MESSAGES_QUERY_KEYS.join(', ')}.` } };
  }
  const input: MapMessagesFlags = {};
  for (const key of MAP_MESSAGES_QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null) (input as Record<string, string>)[key] = value;
  }
  const read = readMapMessages(input, options);
  if (!read.ok) return { status: 400, body: { error: read.error } };
  return { status: read.result.source === 'unavailable' ? 503 : 200, body: read.result };
}

/** `phm fleet map messages` for people: one line per message, newest first. */
export function formatMapMessagesText(read: MapMessages): string {
  if (!read.messages) return 'Agent messages: unknown (the agent bus could not be read).';
  const count = `${read.matched} agent message${read.matched === 1 ? '' : 's'} since ${read.since.slice(0, 16).replace('T', ' ')} UTC.`;
  return [count, ...read.messages.map(m => `${m.at.slice(11, 19)}Z ${m.from} -> ${m.to} (${m.kind}): ${m.summary}`),
    ...(read.skipped > 0 ? [`Skipped ${read.skipped} damaged bus record${read.skipped === 1 ? '' : 's'}.`] : [])].join('\n');
}
