/**
 * channel-reply-lag.ts — per-channel reply debt on the Mason↔Leader owner
 * thread. For every channel the thread has heard from: Mason's newest inbound
 * message, the first Leader (outbound) message on the same channel after it,
 * and how long Mason has been waiting when that reply is still missing.
 * Pure: the pane derives it from the owner-thread read it already polls.
 */
import { channelKey, type ChannelKey } from './fleet-channels-model.js';

/** Mason gets a red chip once his message has gone unanswered this long. */
export const REPLY_LAG_WARN_MS = 10 * 60 * 1000;

/** The owner-thread fields reply debt needs — `OwnerThreadLine` satisfies it. */
export interface ReplyLagMessage {
  channel: string;
  direction: 'inbound' | 'outbound';
  at: string;
  text: string;
}

export interface ChannelReplyLag {
  /** The raw owner-thread channel this lag was measured on. */
  channel: string;
  /** ISO instant and epoch ms of Mason's newest inbound message on this channel. */
  lastFromMasonAt: string;
  lastFromMasonMs: number;
  /** Mason's newest message on one line, capped at 80 characters. */
  preview: string;
  /** ISO instant and epoch ms of the first Leader message after it on this channel, or null. */
  replyAt: string | null;
  replyMs: number | null;
  /** How long Mason has waited so far; null once the Leader answered. */
  waitingMs: number | null;
  /** True once waitingMs has passed REPLY_LAG_WARN_MS. */
  overdue: boolean;
}

const PREVIEW_CHARS = 80;

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= PREVIEW_CHARS) return line;
  const prefix = line.slice(0, PREVIEW_CHARS - 1);
  const boundary = line[PREVIEW_CHARS - 1] === ' ' ? prefix.length : prefix.lastIndexOf(' ');
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

/**
 * Reply debt keyed by owner-thread channel id. "After" is thread order: the
 * thread file is one ordered log, so position — not the `at` clock — decides
 * whether an outbound message answers an inbound one. Messages whose `at`
 * does not parse are skipped; a channel with no inbound from Mason has no lag.
 */
export function deriveChannelReplyLag(messages: readonly ReplyLagMessage[], nowMs: number): Map<string, ChannelReplyLag> {
  const lastInbound = new Map<string, { index: number; ms: number; at: string; text: string }>();
  messages.forEach((message, index) => {
    if (message.direction !== 'inbound') return;
    const ms = Date.parse(message.at);
    if (Number.isFinite(ms)) lastInbound.set(message.channel, { index, ms, at: message.at, text: message.text });
  });
  const firstReply = new Map<string, { ms: number; at: string }>();
  messages.forEach((message, index) => {
    if (message.direction !== 'outbound') return;
    const inbound = lastInbound.get(message.channel);
    if (!inbound || index <= inbound.index || firstReply.has(message.channel)) return;
    const ms = Date.parse(message.at);
    if (Number.isFinite(ms)) firstReply.set(message.channel, { ms, at: message.at });
  });
  const lags = new Map<string, ChannelReplyLag>();
  for (const [channel, inbound] of lastInbound) {
    const reply = firstReply.get(channel);
    const waitingMs = reply ? null : Math.max(0, nowMs - inbound.ms);
    lags.set(channel, {
      channel,
      lastFromMasonAt: inbound.at,
      lastFromMasonMs: inbound.ms,
      preview: preview(inbound.text),
      replyAt: reply?.at ?? null,
      replyMs: reply?.ms ?? null,
      waitingMs,
      overdue: waitingMs !== null && waitingMs > REPLY_LAG_WARN_MS,
    });
  }
  return lags;
}

/**
 * The lag one pane row shows. Direct-mapped channels find their own entry;
 * the 'other' row folds every raw channel the board does not list, preferring
 * an overdue wait, then an unanswered one, then the newest message.
 */
export function replyLagForRow(lags: ReadonlyMap<string, ChannelReplyLag>, key: ChannelKey): ChannelReplyLag | undefined {
  const rank = (lag: ChannelReplyLag) => lag.overdue ? 2 : lag.waitingMs !== null ? 1 : 0;
  let best: ChannelReplyLag | undefined;
  for (const lag of lags.values()) {
    if (channelKey(lag.channel) !== key) continue;
    if (best === undefined || rank(lag) > rank(best) ||
        (rank(lag) === rank(best) && lag.lastFromMasonMs > best.lastFromMasonMs)) best = lag;
  }
  return best;
}

/** Channels still unanswered past the warning age — the header's "waiting" count. */
export function channelsWaiting(lags: ReadonlyMap<string, ChannelReplyLag>): number {
  let count = 0;
  for (const lag of lags.values()) if (lag.overdue) count++;
  return count;
}
