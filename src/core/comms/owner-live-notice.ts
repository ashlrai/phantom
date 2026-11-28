/**
 * Once-per-channel "Leader is live here" notice (Mason t1627u / t1641u).
 * The first time the owner thread proves a remote channel two-way — an
 * enabled adapter with at least one inbound on it and no outbound already
 * delivered there — one fixed reply is planned through sendOwnerReply under
 * the key leader-live-<channel>. The desktop thread is the notice surface
 * itself and never gets one. Idempotent: a second run finds the outbound
 * already on the thread and plans nothing.
 *
 * Recovered from PR #5124 @ 5945d7b297c8f872d7bdda8312eb54e05535bd1e
 * (RQ-PHX-OWNERLIVENOTICE09) for RQ-PHX-OWNERLIVENOTICERECOVER171.
 */
import { OWNER_CHANNELS, type OwnerChannel } from './leader-mailbox.js';
import type { OwnerAdapterStatus } from './owner-channel.js';
import type { LeaderReply } from '../fleet/mason-outbox.js';
import { sendLeaderReplyToPhone, type OwnerLiveReplyReport } from './owner-live-reply.js';
import { readOwnerLiveStatus, type PhoneChannel } from './owner-live-status.js';
import {
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerReply,
  type OwnerThreadMessage,
  type OwnerThreadOptions,
  type OwnerThreadReceipts,
} from './owner-thread.js';

/** The fixed text every newly-live channel carries once. */
export const OWNER_LIVE_NOTICE_TEXT = 'Leader is live here, reply to talk to me.';

export interface OwnerLiveNoticePlan {
  channel: OwnerChannel;
  /** Idempotency key of the earliest inbound the notice answers. */
  replyTo: string;
  /** Stable dedupe key — a repeat run resolves to 'duplicate'. */
  idempotencyKey: string;
}

/**
 * Pure plan over the recorded thread and adapter status. A channel earns one
 * notice when its adapter is enabled, the owner has written at least once on
 * it, and a receipt proves no outbound has landed there. Missing receipts
 * are unknown, including when the caller omits the optional snapshot.
 */
export function planOwnerLiveNotices(
  messages: readonly OwnerThreadMessage[],
  statusAdapters: readonly OwnerAdapterStatus[],
  receipts: OwnerThreadReceipts = {},
): OwnerLiveNoticePlan[] {
  const plans: OwnerLiveNoticePlan[] = [];
  for (const adapter of statusAdapters) {
    const channel = adapter.id;
    if (channel === 'desktop' || adapter.enabled !== true) continue;
    const inbound = messages.find(message => message.direction === 'inbound' && message.channel === channel);
    if (!inbound) continue;
    if (messages.some(message => message.direction === 'outbound' && receipts[message.id]?.[channel]?.state === 'delivered')) continue;
    plans.push({ channel, replyTo: inbound.idempotencyKey, idempotencyKey: `leader-live-${channel}` });
  }
  return plans;
}

export type OwnerLiveNoticeReason =
  'accepted' | 'disabled' | 'halted' | 'no-inbound' | 'already-replied' | 'refused' | 'unavailable';

export interface OwnerLiveNoticeSkip {
  channel: OwnerChannel;
  reason: OwnerLiveNoticeReason;
  /** Plain words: why, and the one step that changes it. Ids and tokens never appear. */
  detail?: string;
}

export interface OwnerLiveNoticeReport {
  v: 1;
  /** True while KILL or the comms pause holds every adapter. */
  halted: boolean;
  /** Channels the planner selected this run (sent only under apply). */
  planned: OwnerChannel[];
  /** Planned channels whose own delivery was sent or duplicate. */
  sent: OwnerChannel[];
  /** Planned channels whose sendOwnerReply refused, halted or went unavailable. */
  failed: OwnerLiveNoticeSkip[];
  /** Channels never planned, with why. Carries no owner message text. */
  skipped: OwnerLiveNoticeSkip[];
  /** The hourly newest-leader-reply send; absent when the caller passed no replies. */
  reply?: OwnerLiveReplyReport;
}

/**
 * Read the thread and adapter status, plan the once-per-channel notices, and
 * under `apply` send each through sendOwnerReply — the only guarded reply
 * path. Transports are never called here directly. Dry runs send nothing.
 */
export async function sendOwnerLiveNotices(
  options: OwnerThreadOptions,
  send: { apply: boolean; replies?: readonly LeaderReply[] },
): Promise<OwnerLiveNoticeReport> {
  const status = readOwnerCommsStatus(options);
  const thread = readOwnerThread(options);
  const messages = thread.messages;
  const plans = planOwnerLiveNotices(messages, status.adapters, thread.receipts);
  const sent: OwnerChannel[] = [];
  const failed: OwnerLiveNoticeSkip[] = [];
  if (send.apply) {
    for (const plan of plans) {
      const result = await sendOwnerReply({
        text: OWNER_LIVE_NOTICE_TEXT,
        replyTo: plan.replyTo,
        idempotencyKey: plan.idempotencyKey,
      }, options);
      const delivery = result.deliveries?.find(row => row.channel === plan.channel);
      if (delivery?.status === 'sent' || delivery?.status === 'duplicate') {
        sent.push(plan.channel);
      } else {
        const reason = delivery?.status ?? (result.status === 'halted' || result.status === 'unavailable' ? result.status : 'refused');
        failed.push({ channel: plan.channel, reason, ...(delivery?.reason || result.reason ? { detail: delivery?.reason ?? result.reason } : {}) });
      }
    }
  }
  const planned = new Set(plans.map(plan => plan.channel));
  const adapters = new Map(status.adapters.map(adapter => [adapter.id, adapter]));
  const skipped: OwnerLiveNoticeSkip[] = [];
  const live = new Map(readOwnerLiveStatus(options.settings, { halted: status.kill, paused: status.paused }).channels.map(c => [c.channel as OwnerChannel, c]));
  for (const channel of OWNER_CHANNELS) {
    if (channel === 'desktop' || planned.has(channel)) continue;
    const adapter = adapters.get(channel);
    // A comms pause disables every adapter without flagging `halted`; report
    // both holds as 'halted' so the skip reason matches the report's `halted`.
    const held = adapter?.halted === true || status.paused;
    const why = live.get(channel as PhoneChannel);
    skipped.push({
      channel,
      ...(adapter?.enabled !== true && why ? { detail: why.nextStep ? `${why.reason} Next: ${why.nextStep}` : why.reason } : {}),
      reason: 'unavailable' in thread ? 'unavailable' : adapter?.enabled !== true
        ? (held ? 'halted' : 'disabled')
        : messages.some(message => message.direction === 'inbound' && message.channel === channel)
          ? 'already-replied'
          : 'no-inbound',
    });
  }
  const reply = send.replies === undefined ? undefined
    : await sendLeaderReplyToPhone(options, { apply: send.apply, replies: send.replies, halted: status.kill, paused: status.paused });
  return {
    v: 1,
    halted: status.kill || status.paused,
    planned: plans.map(plan => plan.channel),
    sent,
    failed,
    skipped,
    ...(reply ? { reply } : {}),
  };
}
