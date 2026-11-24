/**
 * Telegram half of `phm asks`: Mason replies "yes 3f2a" (or no/done) from his
 * phone and the answer reaches the same answerAsk the CLI and desktop use.
 * No new channel or credential: this rides the existing bot and its retained
 * sender evidence. Anything not from Mason's own private chat is left alone.
 */
import { answerApprovalReply, approvalAnswerText } from '../fleet/approvals.js';
import { answerAskFromChannel, askAnswerText, type AnswerAskDeps, type AsksOptions } from '../fleet/asks.js';
import { OPERATOR_SENDER_ID } from '../fleet/channel-envelope.js';
import type { InboundEvent, TelegramSendOpts, TelegramSendResult } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';

/**
 * The configured owner chat, a private chat and the exact sender: the same
 * evidence /release, /resolve and /hold require. Old or injected events that
 * lack it fail closed.
 */
export function isVerifiedTelegramOwner(event: InboundEvent, cfg: AshlrConfig): boolean {
  const chatId = cfg.comms?.telegram?.chatId;
  const id = typeof chatId === 'string' && /^[1-9]\d*$/.test(chatId) ? Number(chatId) : NaN;
  return Number.isSafeInteger(id) && event.fromChatId === chatId && event.privateChat === true && event.senderUserId === id;
}

export interface TelegramAskReplyDeps extends AnswerAskDeps {
  send: (text: string, opts: TelegramSendOpts | undefined, cfg: AshlrConfig) => Promise<TelegramSendResult>;
  options?: AsksOptions;
}

/**
 * True when the text was an ask or approval reply from Mason and was answered
 * (or refused, or he was asked which one) on the spot. `yes 3f2a` keeps the
 * `phm asks` path; anything else that fits an open approval ("yes 3",
 * "use it") goes through answerApprovalReply. The reply only ever goes back to
 * the verified owner's own chat.
 */
export async function handleTelegramAskReply(event: InboundEvent, text: string, cfg: AshlrConfig, deps: TelegramAskReplyDeps): Promise<boolean> {
  const { send, options, ...answerDeps } = deps;
  const verified = isVerifiedTelegramOwner(event, cfg);
  const outcome = await answerAskFromChannel(text, { verified, source: 'telegram' }, options, answerDeps);
  const approval = outcome ? null
    : await answerApprovalReply(text, { channel: 'telegram', senderId: verified ? OPERATOR_SENDER_ID : null }, options, answerDeps);
  if (!outcome && !approval) return false;
  const reply = outcome ? askAnswerText(outcome) : approvalAnswerText(approval!);
  const sent = await send(reply, typeof event.messageId === 'number' ? { replyToMessageId: event.messageId } : undefined, cfg);
  if (!sent.ok) throw new Error('Telegram acknowledgement failed');
  return true;
}
