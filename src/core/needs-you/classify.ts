/**
 * Who has to answer a "Needs you" item (RQ-NEEDSYOUN19NQ8).
 *
 * Mason is asked only about four things: secrets and keys, money and billing,
 * sends to people outside the team, and destroying data, plus a password, 2FA
 * code or device approval. Everything else is ordinary engineering work the
 * fleet decides itself. When the wording is unclear the answer is
 * "hard_limit": nothing that might touch a limit is ever auto-approved.
 *
 * Pure: no I/O, no clock, never throws. This changes who is asked, not what is
 * allowed; every existing safety check still runs when the item is acted on.
 */
import { askOfLine, type AskKind } from '../fleet/asks.js';
import { approvalOfLine } from '../fleet/approvals.js';

export type NeedsYouClass = 'hard_limit' | 'auto';
export type NeedsYouLimit = 'secrets' | 'money' | 'outside_send' | 'destroy_data' | 'sign_in' | 'unsure';

export interface NeedsYouVerdict {
  class: NeedsYouClass;
  /** Which limit, or null for auto. */
  limit: NeedsYouLimit | null;
  /** Plain words; for hard_limit it names the limit. */
  reason: string;
}

export const LIMIT_REASONS: Readonly<Record<NeedsYouLimit, string>> = {
  secrets: 'secrets or keys',
  money: 'money or billing',
  outside_send: 'a message to someone outside the team',
  destroy_data: 'deletes or overwrites data',
  sign_in: 'a password, 2FA code or device approval',
  unsure: 'unclear, so it stays with you',
};
export const AUTO_REASON = 'ordinary engineering work; the fleet goes ahead';

const ASK_LIMIT: Readonly<Record<AskKind, NeedsYouLimit>> = {
  password: 'sign_in', '2fa': 'sign_in', device: 'sign_in', payment: 'money', outreach: 'outside_send',
  // Only Mason knows his own number; a credit approval is money, though the answer itself spends nothing.
  usage: 'unsure', approval: 'money',
};

// First match wins. Word boundaries keep "tokenizer" or "keyboard" out.
const LIMITS: ReadonlyArray<readonly [NeedsYouLimit, RegExp]> = [
  ['sign_in', /\b(passwords?|passphrase|passcode|2fa|mfa|otp|two[- ]factor|verification\s+code|security\s+code|sign[- ]?in|log[- ]?in|re-?authenticate)\b|\bdevices?\b.*\b(approv\w*|trust\w*)\b|\b(approv\w*|trust\w*)\b.*\bdevices?\b/i],
  ['secrets', /\b(secrets?|credentials?|api[ -]?keys?|ssh[ -]?keys?|private[ -]?keys?|signing[ -]?keys?|keychain|\.env|env\s+file|certificates?|codesign\w*|notari[sz]\w*|standing\s+authority|always\s+allow)\b|\btokens?\b(?!\s+(usage|count|budget|limit|savings|use))/i],
  ['money', /\b(billing|bill|invoices?|payments?|pay|paid|purchase|buy|refund|subscriptions?|charges?|credit\s+card|credits?|spend|spending|spent|pricing|price|plan\s+upgrade|upgrade\s+(the\s+)?plan|top[- ]?up)\b|\$\s*\d/i],
  ['destroy_data', /\b(delete|deletes|deleting|wipe|erase|purge|destroy|truncate|drop\s+(the\s+)?(table|database|db|schema|bucket)|rm\s+-rf|force[- ]push|reset\s+--hard|overwrite|irreversible|cannot\s+be\s+undone|can't\s+be\s+undone)\b/i],
  ['outside_send', /\b(customers?|clients?|investors?|press|newsletter|linkedin|twitter|tweet|outreach|cold\s+email|recruiters?|candidates?|partners?|vendors?|the\s+public|publicly)\b/i],
];

// A send whose recipient is not clearly the team is treated as outside.
const SEND = /\b(send|email|e-mail|reply\s+to|respond\s+to|announce|dm|invite|contact|forward|tell|notify|publish|post\s+(to|on))\b/i;
const INTERNAL = /\b(team|teammates?|leaders?|agents?|lanes?|fleet|bus|pr|prs|pull\s+request|issue|reviewers?|channel|thread|inbox|ci|claude|codex|devin|mason)\b|#\d+/i;
// Words that can hide a limit without naming one: ask, do not guess.
const UNSURE = /\b(access|accounts?|permissions?|grants?|share|sharing|production\s+data|prod\s+(data|db|database)|migrate\s+data|legal|contract|terms|domain|dns|ownership|transfer)\b/i;

/** The words an item asks about: an approval's question, an ask's request, or the line itself. */
export function needsYouWords(text: string): string {
  const approval = approvalOfLine(text);
  if (approval) return approval.question;
  return text.replace(/^ask:\S+\s+/i, '').replace(/\s*\(asked [^)]*\)\s*$/, '').trim();
}

export function classifyNeedsYou(item: { text: string }): NeedsYouVerdict {
  const hard = (limit: NeedsYouLimit): NeedsYouVerdict => ({ class: 'hard_limit', limit, reason: LIMIT_REASONS[limit] });
  const raw = typeof item?.text === 'string' ? item.text : '';
  // A tagged ask (or ask wording) already names its limit.
  const ask = approvalOfLine(raw) ? null : askOfLine(raw);
  if (ask) return hard(ASK_LIMIT[ask.kind]);
  const words = needsYouWords(raw);
  // Too little to read is unclear, not ordinary.
  if (words.split(/\s+/).filter(word => /[a-z]{2}/i.test(word)).length < 2) return hard('unsure');
  const limit = LIMITS.find(([, pattern]) => pattern.test(words));
  if (limit) return hard(limit[0]);
  if (SEND.test(words) && !INTERNAL.test(words)) return hard('outside_send');
  if (UNSURE.test(words)) return hard('unsure');
  return { class: 'auto', limit: null, reason: AUTO_REASON };
}
