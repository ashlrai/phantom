/**
 * RQ-PHX-TELEGRAMTOINBOX31: Telegram → MASON-INBOX.md bridge.
 *
 * The desktop records channel input through the shared channel receiver
 * (fleet/channel-envelope.ts). This adapter gives verified Telegram texts the
 * same treatment before dispatch hands them to the Leader:
 *
 *   telegramChannelMessage(event, text)      — pure mapping; null unless the
 *     event carries verified private-sender evidence (fail closed: no verified
 *     identity → no inbox write).
 *   recordTelegramToInbox(event, text, cfg)  — builds a channel receiver whose
 *     allowlist is derived from the configured owner id, appends the body to
 *     MASON-INBOX.md under channel `telegram`, and acknowledges on Telegram
 *     itself: the shared ack text plus a one-line inbox preview, sent as a
 *     reply to the original message.
 *
 * Identity: integrations/telegram.ts only emits `senderUserId`/`privateChat`
 * after `verifiedPrivateSender` has matched the private chat, sender id and
 * non-bot flag to the configured chat. The canonical sender is
 * `telegram:<userId>`; an asserted identity in the body is never trusted.
 *
 * Dedupe/attribution: delegated to createChannelReceiver — same sender+body
 * inside CHANNEL_DEDUPE_WINDOW_MS acknowledges as `duplicate` without a
 * second inbox entry, and the entry source names `telegram`.
 *
 * Never throws: receiver failures return { ok:false, reason } and a one-line
 * "Not recorded: <reason>" reply is attempted — except `sender-not-allowed`,
 * which stays silent (unverified input gets no reply). Ack transport is
 * best-effort; a failed Telegram send never unwrites an accepted entry.
 */

import { sendTelegramMessage, type InboundEvent, type TelegramSendOpts, type TelegramSendResult } from '../integrations/telegram.js';
import { createChannelReceiver, OPERATOR_SENDER_ID, type ChannelAck, type ChannelMessage, type ChannelReceiveResult } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import type { AshlrConfig } from '../types.js';
import { telegramFleetStatus, type TelegramFleetStatusDeps } from './telegram-fleet-status.js';
import { shipCommandReply, TELEGRAM_SHIP_RE, type ShipCommandDeps } from './telegram-ship-command.js';
import { deliverCosResult } from '../cos/intake.js';
import { recordTelegramMessages } from './telegram-thread-map.js';

export interface TelegramInboxDeps extends TelegramFleetStatusDeps {
  /** Release command dependencies. */
  ship?: ShipCommandDeps;
  /** Transport seam for tests. Default sendTelegramMessage. */
  send?: (text: string, opts?: TelegramSendOpts, cfg?: AshlrConfig) => Promise<TelegramSendResult>;
  /** Shared runs context (inbox + receipt store). Default ~/.ashlr-runs. */
  runsDir?: string;
  /** Clock seam for tests. */
  now?: () => Date;
}

/**
 * Map a verified Telegram inbound event to a canonical channel message.
 * Returns null without verified identity evidence — the receiver is the
 * second gate (allowlist), this is the first (adapter-verified shape only).
 */
export function telegramChannelMessage(event: InboundEvent, text: string): ChannelMessage | null {
  if (event.kind !== 'text' || event.privateChat !== true) return null;
  const id = event.senderUserId;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
  return { channel: 'telegram', verifiedSenderId: `telegram:${id}`, body: text };
}

/**
 * Configured operator id(s), mirroring `trustedPrivateId` in
 * integrations/telegram.ts (a private chat id identifies its sole operator).
 * Unconfigured or non-positive ids yield an empty set, so every sender is
 * refused — never a hardcoded id.
 */
function configuredOwnerIds(cfg: AshlrConfig): number[] {
  const raw = cfg.comms?.telegram?.chatId;
  const id = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? [id] : [];
}

export type TelegramInboxResult = ChannelReceiveResult | { ok: false; reason: 'status-replied' | 'status-send-failed' };

/** `/fleet-status` (optionally @bot) is answered by the bridge. */
export const TELEGRAM_FLEET_STATUS_RE = /^\/fleet-status(?:@\w+)?$/;

/** Called only by a trusted approval surface after displaying the exact draft. */
export async function deliverTelegramCosResult(id: string, approvedDigest: string,
  cfg: AshlrConfig, deps: TelegramInboxDeps = {}): Promise<void> {
  await deliverCosResult(id, approvedDigest, async draft => {
    const owner = configuredOwnerIds(cfg)[0];
    if (!owner || draft.origin.channel !== 'telegram' || draft.origin.senderId !== `telegram:${owner}` ||
        !/^[1-9]\d*$/.test(draft.origin.threadId ?? '')) throw new Error('No verified Telegram origin');
    const replyToMessageId = Number(draft.origin.threadId);
    if (!Number.isSafeInteger(replyToMessageId)) throw new Error('Invalid Telegram origin');
    const result = await (deps.send ?? sendTelegramMessage)(draft.text, { replyToMessageId }, cfg);
    if (!result.ok) throw new Error('Telegram delivery failed');
    if (result.messageId) recordTelegramMessages([result.messageId], { kind: 'update', threadId: id });
  }, deps.runsDir);
}

export async function recordTelegramToInbox(
  event: InboundEvent,
  text: string,
  cfg: AshlrConfig,
  deps: TelegramInboxDeps = {},
): Promise<TelegramInboxResult> {
  const message = telegramChannelMessage(event, text);
  if (!message) return { ok: false, reason: 'sender-not-allowed' };
  const send = deps.send ?? sendTelegramMessage;
  if (TELEGRAM_FLEET_STATUS_RE.test(text)) {
    if (!configuredOwnerIds(cfg).includes(event.senderUserId!)) return { ok: false, reason: 'sender-not-allowed' };
    try {
      const reply = await telegramFleetStatus(deps);
      const sent = await send(reply, typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined, cfg);
      return { ok: false, reason: sent.ok ? 'status-replied' : 'status-send-failed' };
    } catch {
      return { ok: false, reason: 'status-send-failed' };
    }
  }
  if (TELEGRAM_SHIP_RE.test(text)) {
    if (!configuredOwnerIds(cfg).includes(event.senderUserId!)) return { ok: false, reason: 'sender-not-allowed' };
    try {
      const reply = await shipCommandReply(text, deps.ship);
      if (reply === null) return { ok: false, reason: 'status-send-failed' };
      const sent = await send(reply, typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined, cfg);
      return { ok: false, reason: sent.ok ? 'status-replied' : 'status-send-failed' };
    } catch {
      return { ok: false, reason: 'status-send-failed' };
    }
  }
  const replyTo = typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined;
  // Same normalization the receiver applies, so the preview matches the entry.
  const preview = text.normalize('NFC').replace(/\r\n?/g, '\n').trim().slice(0, 60);
  try {
    const receive = createChannelReceiver({
      allowedSenderIds: new Set(configuredOwnerIds(cfg).map((id) => `telegram:${id}`)),
      runsDir: deps.runsDir,
      now: deps.now,
      acknowledge: async (ack: ChannelAck) => {
        await send(`${formatChannelAck(ack)}\nInbox: ${preview}`, replyTo, cfg);
      },
    });
    const result = await receive({ ...message, canonicalSenderId: OPERATOR_SENDER_ID,
      ...(Number.isSafeInteger(event.messageId) && event.messageId! > 0 ? { threadId: String(event.messageId) } : {}) });
    if (!result.ok && result.reason !== 'sender-not-allowed') {
      await send(`Not recorded: ${result.reason}`, replyTo, cfg).catch(() => undefined);
    }
    return result;
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}
