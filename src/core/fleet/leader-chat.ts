/**
 * The Leader chat: Mason's MASON-INBOX.md entries and the leader's replies
 * (MASON-OUTBOX.md, PLAN-LOG "Reply for Mason") as ONE time-ordered list,
 * each Mason message carrying what happened to it. Read-only; `phm leader
 * thread`, the desktop inbox box and the phone box all read this projection.
 *
 * Links. A reply answers a message when its MASON-OUTBOX heading carries
 * `[leader-network:reply-<requestId>]` (what the leader network writes) or its
 * text names the message id as `re: <id>`. Received means the planner's ack
 * ledger (queue/inbox-acks.jsonl) holds the id. Nothing is guessed: no link
 * means not answered, no ledger row means not yet received.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInboxAckStates } from './inbox-ack-state.js';
import { inboxChannelSlug } from './inbox-channel-slug.js';
import { readInboxEntries, type InboxEntry } from './mason-inbox.js';
import { readOutboxEntries, replyTime, type OutboxEntry } from './mason-outbox.js';
import { LEADER_CHAT_OPEN_MS, type LeaderChat, type LeaderChatMessage } from './leader-chat-types.js';

export type { LeaderChat, LeaderChatMessage, LeaderChatState } from './leader-chat-types.js';
export { LEADER_CHAT_OPEN_MS } from './leader-chat-types.js';

export interface LeaderChatInput {
  /** Newest first, as readInboxEntries returns them. */
  inbox: readonly InboxEntry[];
  /** Oldest first, as readOutboxEntries returns them. */
  replies: readonly OutboxEntry[];
  /** Planner ack ledger: entry id → status. */
  acks: ReadonlyMap<string, unknown>;
  nowMs: number;
  limit?: number;
}

const RE_ID = /\bre:\s*([A-Za-z0-9._:-]{4,64})/gi;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The id a Mason message shows: the leader-network request id, the channel-line id, or a stable content hash. */
export function inboxMessageId(entry: InboxEntry): string {
  return entry.requestId ?? entry.id ?? `in-${hash(`${entry.at}\n${entry.source}\n${entry.text}`)}`;
}

function instant(at: string): number | null {
  const ms = at ? replyTime(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function buildLeaderChat(input: LeaderChatInput): LeaderChat {
  let malformedInbox = 0;
  type Row = { message: LeaderChatMessage; ms: number | null; order: number };
  const rows: Row[] = [];
  // Inbox is newest first; walk it oldest first so file order breaks timestamp ties.
  for (const entry of [...input.inbox].reverse()) {
    // parseInbox keeps an unreadable "## " heading as the entry time; such a block, or one with no text, is skipped.
    if (entry.at.startsWith('## ') || !entry.text.trim()) { malformedInbox++; continue; }
    const id = inboxMessageId(entry);
    const ms = instant(entry.at);
    const received = input.acks.has(id) || (entry.requestId !== undefined && input.acks.has(entry.requestId));
    rows.push({ ms, order: rows.length, message: {
      id, ts: ms === null ? null : new Date(ms).toISOString(), direction: 'to-leader',
      channel: entry.channel ?? inboxChannelSlug(entry.source), text: entry.text, state: received ? 'received' : 'sent', received,
    } });
  }
  const byId = new Map(rows.map(row => [row.message.id, row.message]));
  for (const reply of input.replies) {
    if (!reply.text.trim()) continue;
    const ms = instant(reply.at);
    const named = [...reply.text.matchAll(RE_ID)].map(match => match[1]!);
    const replyTo = [reply.replyTo, ...named].find((id): id is string => id !== undefined && byId.has(id));
    rows.push({ ms, order: rows.length, message: {
      id: `out-${hash(`${reply.at}\n${reply.text}`)}`, ts: ms === null ? null : new Date(ms).toISOString(), direction: 'from-leader',
      channel: 'outbox', text: reply.text, state: 'reply', ...(replyTo ? { replyTo } : {}),
    } });
    if (replyTo) byId.get(replyTo)!.state = 'answered';
  }
  for (const row of rows) {
    const m = row.message;
    if (m.direction === 'to-leader' && m.state !== 'answered' && row.ms !== null && input.nowMs - row.ms > LEADER_CHAT_OPEN_MS) m.state = 'open-over-2h';
  }
  // Dated rows by time, unknown times last; ties keep inbox-then-replies file order.
  rows.sort((a, b) => (a.ms === null ? 1 : 0) - (b.ms === null ? 1 : 0) || (a.ms ?? 0) - (b.ms ?? 0) || a.order - b.order);
  const limit = input.limit === undefined ? rows.length : Math.max(0, Math.floor(input.limit));
  return {
    v: 1, generatedAt: new Date(input.nowMs).toISOString(),
    messages: limit === 0 ? [] : rows.slice(-limit).map(row => row.message),
    skipped: { malformedInbox },
  };
}

/** Read MASON-INBOX.md, both reply journals and the ack ledger (bounded tails), then build the chat. */
export async function readLeaderChat(opts: { runsDir?: string; nowMs?: number; limit?: number } = {}): Promise<LeaderChat & { sources: { inbox: string; replies: string } }> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const [inbox, replies] = await Promise.all([readInboxEntries({ runsDir, limit: 200 }), readOutboxEntries({ runsDir, limit: 200 })]);
  const chat = buildLeaderChat({
    inbox: inbox.entries, replies: replies.entries, acks: readInboxAckStates(runsDir),
    nowMs: opts.nowMs ?? Date.now(), ...(opts.limit === undefined ? {} : { limit: opts.limit }),
  });
  return { ...chat, sources: { inbox: inbox.sourceState, replies: replies.sourceState } };
}
