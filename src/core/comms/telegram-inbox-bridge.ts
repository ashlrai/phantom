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
import { createChannelReceiver, type ChannelAck, type ChannelMessage, type ChannelReceiveResult } from '../fleet/channel-envelope.js';
import { formatChannelAck } from '../fleet/channel-ack-text.js';
import type { AshlrConfig } from '../types.js';

export interface TelegramInboxDeps {
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

export async function recordTelegramToInbox(
  event: InboundEvent,
  text: string,
  cfg: AshlrConfig,
  deps: TelegramInboxDeps = {},
): Promise<ChannelReceiveResult> {
  const message = telegramChannelMessage(event, text);
  if (!message) return { ok: false, reason: 'sender-not-allowed' };
  const send = deps.send ?? sendTelegramMessage;
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
    const result = await receive(message);
    if (!result.ok && result.reason !== 'sender-not-allowed') {
      await send(`Not recorded: ${result.reason}`, replyTo, cfg).catch(() => undefined);
    }
    return result;
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}
