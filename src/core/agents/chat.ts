import { readOwnerChatReceipts, ownerChatRoot, verifiedOwnerChat, ownerChatReceiptState } from './chat-owner-receipts.js';
/** Read-only channel projection. Routing labels and human flags are not authority. */
import { createHash } from 'node:crypto';
import { listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, type BusInboxOptions } from '../fleet/bus-inbox.js';
import { BUS_PRIORITIES, type BusPriority } from '../fleet/bus-envelope.js';
import { scrubSecrets } from '../util/scrub.js';
import { busBodySchema } from './bus-v2-schema.js';
import { readAgentRegistry, resolveAgent, agentChannelNameSchema, agentRefAddressMatcher } from './bus-identity.js';
import { busBodyInReplyToMatch, busReadContains, busReadContainsMatch, labelIdentityOf } from './bus-unified.js';

export const CHAT_SCHEMA = 'agent-chat.v1';
const THREAD = /^(outcome|run):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
/** The printable-label rule the shared bus reads apply to `--id` and `--in-reply-to`. */
const BUS_TOKEN = /^[\x21-\x7e]{1,128}$/;
const COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2'];
export interface ChatMessage {
  id: string; cursor: number; receivedAt: number; thread: string; agentId: string;
  kind: 'message' | 'interjection'; text: string;
}
export interface ChatParticipant {
  agentId: string; handle: string; displayName: string; engine: string | null;
  avatarColor: string; state: 'unknown';
}
export interface ChatThread { id: string; messageCount: number; lastCursor: number }
export type ChatResult = {
  status: 'ok'; schema: typeof CHAT_SCHEMA; channel: string; asOf: number;
  participants: ChatParticipant[]; threads: ChatThread[]; messages: ChatMessage[];
  nextCursor: number; hasMore: boolean; retention: 'live-retained-only';
} | { status: 'invalid' | 'unavailable' | 'retryable' | 'unknown-channel' };
export interface ChatQuery {
  channel: string; thread?: string; after?: number; limit?: number;
  /** The shared bus read filters, applied to every admitted channel row before
   * the thread index and the message page are built: `from`/`excludeFrom` match
   * the envelope sender label through `agentRefAddressMatcher`, `contains` the
   * same scrubbed one-line summary every bus read's `--contains` matches (for
   * the note/context bodies chat admits, that summary is the projected text),
   * `since`/`before` the `[since, before)` window on `receivedAt`, `id` the
   * exact envelope id, `inReplyTo` the body's own reply citation and `priority`
   * keeps only envelopes stamped with that exact P0..P3 band — the same match
   * every other bus read's `--priority` applies, so urgent room traffic is one
   * filtered read. */
  from?: string; excludeFrom?: string; contains?: string;
  since?: number; before?: number; id?: string; inReplyTo?: string; priority?: BusPriority;
}

/** Local owner read boundary only; never combines DMs, inboxes, or external transports.
 * Owner interjections require a matching accepted ingress receipt; a human flag
 * alone grants neither owner attribution nor permission to execute.
 */
export function readAgentChat(query: ChatQuery, options: BusInboxOptions = {}): ChatResult {
  const after = query.after ?? 0, limit = query.limit ?? 100;
  const containsNeedle = busReadContains(query.contains);
  if (!agentChannelNameSchema.safeParse(query.channel).success ||
      (query.thread !== undefined && !THREAD.test(query.thread)) ||
      !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      (query.from !== undefined && (typeof query.from !== 'string' || query.from.length === 0 || query.from.length > 128)) ||
      (query.excludeFrom !== undefined &&
        (typeof query.excludeFrom !== 'string' || query.excludeFrom.length === 0 || query.excludeFrom.length > 128)) ||
      (query.since !== undefined && (!Number.isSafeInteger(query.since) || query.since < 0)) ||
      (query.before !== undefined && (!Number.isSafeInteger(query.before) || query.before < 0)) ||
      (query.id !== undefined && (typeof query.id !== 'string' || !BUS_TOKEN.test(query.id))) ||
      (query.inReplyTo !== undefined && (typeof query.inReplyTo !== 'string' || !BUS_TOKEN.test(query.inReplyTo))) ||
      (query.priority !== undefined && !BUS_PRIORITIES.includes(query.priority)) ||
      containsNeedle === null) {
    return { status: 'invalid' };
  }
  const asOf = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(asOf) || asOf < 0) return { status: 'invalid' };
  const fixed = { ...options, now: () => asOf };
  const registry = readAgentRegistry(fixed);
  if (registry.status !== 'ok') return { status: 'unavailable' };
  const fromMatch = query.from === undefined ? undefined
    : agentRefAddressMatcher(query.from, registry.registry, labelIdentityOf(registry.registry));
  const excludeFromMatch = query.excludeFrom === undefined ? undefined
    : agentRefAddressMatcher(query.excludeFrom, registry.registry, labelIdentityOf(registry.registry));
  const channel = registry.registry.channels.find(row => row.name === query.channel);
  if (!channel) return { status: 'unknown-channel' };
  const identities = registry.registry.identities.filter(row => channel.members.includes(row.handle));
  const members = new Set(identities.map(row => row.id));
  const participants: ChatParticipant[] = identities.map((identity): ChatParticipant => {
    const runtime = [...identity.runtimes].sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    return { agentId: identity.id, handle: identity.handle, displayName: scrubSecrets(identity.displayName),
      engine: runtime?.model ?? runtime?.provider ?? null, state: 'unknown',
      avatarColor: COLORS[createHash('sha256').update(identity.id).digest()[0]! % COLORS.length]! };
  }).sort((a, b) => a.agentId.localeCompare(b.agentId));
  let ownerReceipts;
  try { ownerReceipts = readOwnerChatReceipts(ownerChatRoot(options.root)); } catch { return { status: 'unavailable' }; }
  const messages: ChatMessage[] = [];
  const threads = new Map<string, ChatThread>();
  let cursor = 0, complete = false;
  // One bounded retained-store scan, including a final exhaustion probe at capacity.
  for (let pageIndex = 0; pageIndex <= Math.ceil(BUS_INBOX_MAX_MESSAGES / 100); pageIndex++) {
    const page = listBusInboxAfter(cursor, 100, { ...fixed, includeOriginalEnvelope: true });
    if (page.status !== 'ok') return { status: page.status === 'retryable' ? 'retryable' : 'unavailable' };
    try { ownerReceipts = readOwnerChatReceipts(ownerChatRoot(options.root)); } catch { return { status: 'unavailable' }; }
    for (const row of page.messages) {
      const e = row.originalEnvelope ?? row.envelope;
      if (e.channel !== 'bus' || e.external !== false || !['agent-bus', 'agent-chat-owner'].includes(e.origin_bridge ?? '') ||
          e.channel_ref !== e.to || !e.to.startsWith(`group:${channel.name}:`) ||
          !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(e.to.slice(`group:${channel.name}:`.length))) continue;
      const sender = resolveAgent(registry.registry, e.from);
      if (e.origin_bridge === 'agent-chat-owner' && ownerChatReceiptState(e, row.cursor, ownerReceipts) === 'pending') return { status: 'retryable' };
      const owner = e.origin_bridge === 'agent-chat-owner' && e.from === 'owner:local' &&
        e.sender?.agent_id === 'owner:local' && verifiedOwnerChat(e, row.cursor, ownerReceipts);
      if (!owner && (e.origin_bridge !== 'agent-bus' || !sender || !members.has(sender.id) || e.sender?.agent_id !== sender.id)) continue;
      const body = busBodySchema.safeParse(e.body);
      if (!body.success || !('thread' in body.data) || !body.data.thread || !THREAD.test(body.data.thread) ||
          !('text' in body.data)) continue;
      // The shared read filters scope every admitted row — the thread index's
      // counts and the message page alike — so a filtered `list` names only
      // the threads the filter selects and a filtered `read` never shows a
      // row the filter rejects.
      if ((fromMatch !== undefined && !fromMatch(e.from)) ||
          (excludeFromMatch !== undefined && excludeFromMatch(e.from)) ||
          (query.priority !== undefined && e.priority !== query.priority) ||
          (containsNeedle !== undefined && !busReadContainsMatch(e.body, containsNeedle)) ||
          (query.since !== undefined && row.receivedAt < query.since) ||
          (query.before !== undefined && row.receivedAt >= query.before) ||
          (query.id !== undefined && e.id !== query.id) ||
          (query.inReplyTo !== undefined && !busBodyInReplyToMatch(e.body, query.inReplyTo))) continue;
      if (owner && !participants.some(p => p.agentId === 'owner:local')) participants.push({
        agentId: 'owner:local', handle: 'owner', displayName: 'Owner', engine: null, avatarColor: '#475569', state: 'unknown' });
      const thread = body.data.thread;
      const summary = threads.get(thread) ?? { id: thread, messageCount: 0, lastCursor: 0 };
      summary.messageCount++; summary.lastCursor = row.cursor; threads.set(thread, summary);
      if (query.thread === thread && row.cursor > after) messages.push({ id: e.id, cursor: row.cursor,
        receivedAt: row.receivedAt, thread, agentId: owner ? 'owner:local' : sender!.id,
        kind: owner ? 'interjection' : 'message', text: scrubSecrets(body.data.text) });
    }
    if (page.nextCursor <= cursor) { complete = true; break; }
    cursor = page.nextCursor;
  }
  if (!complete) return { status: 'retryable' };
  if (after > cursor) return { status: 'invalid' };
  messages.sort((a, b) => a.cursor - b.cursor);
  const selected = messages.slice(0, limit), hasMore = messages.length > limit;
  return { status: 'ok', schema: CHAT_SCHEMA, channel: channel.name, asOf, participants,
    threads: [...threads.values()].sort((a, b) => b.lastCursor - a.lastCursor), messages: selected,
    nextCursor: hasMore ? selected.at(-1)!.cursor : Math.max(after, cursor), hasMore, retention: 'live-retained-only' };
}
