/**
 * Once-per-channel "Leader is live here" notice (Mason t1627u / t1641u).
 * The first time the owner thread proves a remote channel two-way — an
 * enabled adapter with at least one inbound on it and no outbound already
 * delivered there — one fixed reply is planned through sendOwnerReply under
 * the key leader-live-<channel>. The desktop thread is the notice surface
 * itself and never gets one. Idempotent: a second run finds the outbound
 * already on the thread and plans nothing.
 */
import { OWNER_CHANNELS, type OwnerChannel } from './leader-mailbox.js';
import type { OwnerAdapterStatus } from './owner-channel.js';
import {
  readOwnerCommsStatus,
  readOwnerThread,
  sendOwnerReply,
  type OwnerThreadMessage,
  type OwnerThreadOptions,
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
 * it, and no outbound has landed there yet (an existing outbound means the
 * channel already proved itself live). Desktop is never planned.
 */
export function planOwnerLiveNotices(
  messages: readonly OwnerThreadMessage[],
  statusAdapters: readonly OwnerAdapterStatus[],
): OwnerLiveNoticePlan[] {
  const plans: OwnerLiveNoticePlan[] = [];
  for (const adapter of statusAdapters) {
    const channel = adapter.id;
    if (channel === 'desktop' || adapter.enabled !== true) continue;
    const inbound = messages.find(message => message.direction === 'inbound' && message.channel === channel);
    if (!inbound) continue;
    if (messages.some(message => message.direction === 'outbound' && message.channel === channel)) continue;
    plans.push({ channel, replyTo: inbound.idempotencyKey, idempotencyKey: `leader-live-${channel}` });
  }
  return plans;
}

export type OwnerLiveNoticeReason =
  'accepted' | 'disabled' | 'halted' | 'no-inbound' | 'already-replied' | 'refused' | 'unavailable';

export interface OwnerLiveNoticeSkip {
  channel: OwnerChannel;
  reason: OwnerLiveNoticeReason;
}

export interface OwnerLiveNoticeReport {
  v: 1;
  /** True while KILL or the comms pause holds every adapter. */
  halted: boolean;
  /** Channels the planner selected this run (sent only under apply). */
  planned: OwnerChannel[];
  /** Planned channels whose sendOwnerReply returned sent, duplicate or partial. */
  sent: OwnerChannel[];
  /** Planned channels whose sendOwnerReply refused, halted or went unavailable. */
  failed: OwnerLiveNoticeSkip[];
  /** Channels never planned, with why. Carries no owner message text. */
  skipped: OwnerLiveNoticeSkip[];
}

/**
 * Read the thread and adapter status, plan the once-per-channel notices, and
 * under `apply` send each through sendOwnerReply — the only guarded reply
 * path. Transports are never called here directly. Dry runs send nothing.
 */
export async function sendOwnerLiveNotices(
  options: OwnerThreadOptions,
  send: { apply: boolean },
): Promise<OwnerLiveNoticeReport> {
  const status = readOwnerCommsStatus(options);
  const messages = readOwnerThread(options).messages;
  const plans = planOwnerLiveNotices(messages, status.adapters);
  const sent: OwnerChannel[] = [];
  const failed: OwnerLiveNoticeSkip[] = [];
  if (send.apply) {
    for (const plan of plans) {
      const result = await sendOwnerReply({
        text: OWNER_LIVE_NOTICE_TEXT,
        replyTo: plan.replyTo,
        idempotencyKey: plan.idempotencyKey,
      }, options);
      if (result.status === 'sent' || result.status === 'duplicate' || result.status === 'partial') {
        sent.push(plan.channel);
      } else {
        failed.push({ channel: plan.channel, reason: result.status });
      }
    }
  }
  const planned = new Set(plans.map(plan => plan.channel));
  const adapters = new Map(status.adapters.map(adapter => [adapter.id, adapter]));
  const skipped: OwnerLiveNoticeSkip[] = [];
  for (const channel of OWNER_CHANNELS) {
    if (channel === 'desktop' || planned.has(channel)) continue;
    const adapter = adapters.get(channel);
    skipped.push({
      channel,
      reason: adapter?.enabled !== true
        ? (adapter?.halted === true ? 'halted' : 'disabled')
        : messages.some(message => message.direction === 'inbound' && message.channel === channel)
          ? 'already-replied'
          : 'no-inbound',
    });
  }
  return {
    v: 1,
    halted: status.kill || status.paused,
    planned: plans.map(plan => plan.channel),
    sent,
    failed,
    skipped,
  };
}
