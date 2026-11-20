/**
 * Asks: the few things only Mason can do (a password, a 2FA code, a device
 * approval, a payment, or sending something to a person outside the team),
 * answered with one word from any of his surfaces.
 *
 * This is a typed view over the existing needs-you ledger, not a second store:
 * an ask is an open NEEDS-MASON.md line, and an answer is the same
 * `needs_mason.resolved` bus envelope plus resolved marker that /resolve, the
 * desktop and email already write (resolveNeedsMasonWithInbox). Ledger lines of
 * any other kind are never offered to Mason here; answering one is refused
 * with "the fleet decides this itself".
 *
 * New asks are written by raiseAsk as `ask:<kind> <request> (asked <ISO time>)`
 * so kind and creation time are explicit. Older free-text lines are classified
 * by wording, and their creation time is unknown unless the line carries one.
 */
import { appendNeedsMasonLine } from './needs-mason-append.js';
import { USAGE_POOLS } from '../fabric/usage-signal-writer.js';
import { appendAskLedger, askLedgerRecordOf } from './asks-ledger.js';
import { readNeedsMasonAnswer } from './needs-mason-answer.js';
import { resolveNeedsMasonWithInbox } from './needs-mason-relay.js';
import { readNeedsMasonLedger, type NeedsMasonLedgerItem, type NeedsMasonOptions } from './needs-mason-resolve.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ASK_KINDS = ['password', '2fa', 'device', 'payment', 'outreach', 'usage', 'approval'] as const;
export type AskKind = typeof ASK_KINDS[number];
/** `later` records "not now": the asker reads it and may ask again; nothing is snoozed here. */
export const ASK_ANSWERS = ['yes', 'no', 'done', 'later'] as const;
export type AskAnswer = typeof ASK_ANSWERS[number];
export type AskSource = NonNullable<NeedsMasonOptions['source']>;
/**
 * What each kind may be answered with. `usage` takes a percent instead of a word
 * (see parseAskReply's sibling `parseAnswerFor`); `approval` records a decision only.
 */
export const ASK_REPLIES: Record<AskKind, readonly string[]> = {
  password: ['done', 'later'], '2fa': ['done', 'later'], device: ['done', 'later'],
  payment: ['yes', 'no'], outreach: ['yes', 'no'], usage: [], approval: ['yes', 'no'],
};
export const USAGE_HINT = 'Reply with a number from 0 to 100, like 40.';
export const ASK_REFUSAL = 'the fleet decides this itself';
export const ASK_REQUEST_MAX = 200;
const SHORT_MIN = 4;

export interface Ask {
  /** Ledger item id, `nm-` + 12 hex. */
  id: string;
  /** Shortest unique prefix of the hex (at least 4), for one-word replies: `yes <shortId>`. */
  shortId: string;
  kind: AskKind;
  /** One plain line: what Mason is asked to do (the question). */
  request: string;
  /** Allowed replies, one word each. Empty when the reply is a value (see replyHint). */
  replies: string[];
  /** Plain words for a value reply ("a number from 0 to 100"), else null. */
  replyHint: string | null;
  /** One line: what the answer unblocks, or null when the ask does not say. */
  unblocks: string | null;
  /** What the ask is about (`grok-ultra`, `claude-api-credit`), or null. */
  subject: string | null;
  /** ISO time the ask was raised, or null when the ledger line does not say. */
  created: string | null;
  /** Whole seconds since `created`, or null when that is unknown. */
  ageSeconds: number | null;
  /** ISO time after which the ask no longer matters, or null when the ask does not say (shown as unknown, listed last). */
  expires: string | null;
}

export interface AsksList {
  schema: 'asks.v1';
  asOf: string;
  /** missing = no ledger yet (nothing asked); unavailable = it could not be read, so the list is unknown. */
  ledger: 'available' | 'missing' | 'unavailable';
  count: number;
  asks: Ask[];
  /** Open needs-you lines that are not one of the ask kinds; the fleet handles these. */
  fleetDecides: number;
  /** Asks past their expiry: hidden from `asks`, counted here so the hiding is visible. */
  expiredHidden: number;
}

export type AskAnswerStatus = 'answered' | 'already-answered' | 'refused' | 'unknown' | 'ambiguous' | 'invalid' | 'unavailable';
export interface AskAnswerResult {
  schema: 'asks.answer.v1';
  status: AskAnswerStatus;
  id: string | null;
  kind: AskKind | null;
  /** The recorded answer. For already-answered this is the first answer, or null when it can no longer be read. */
  answer: string | null;
  source: string | null;
  answeredAt: string | null;
  /** Plain reason for anything other than answered. */
  reason: string | null;
}

export interface AsksOptions extends Pick<NeedsMasonOptions, 'runsDir' | 'bus'> {
  now?: () => number;
  /** The surface the answer came through, for the answers ledger (default: the source). */
  channel?: string;
}
export interface AnswerAskDeps { resolve?: typeof resolveNeedsMasonWithInbox; readAnswer?: typeof readNeedsMasonAnswer }

const TAGGED = /^ask:(password|2fa|device|payment|outreach|usage|approval)(?:@([a-z0-9][a-z0-9-]{0,40}))?\s+(.+?)(?:\s+\(asked\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\))?$/i;
const EXPIRES = /\s+\(expires\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\)/i;
const APPROVAL_LINE = /^approval #\d{1,6}: /;
const STAMP = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)\b/;
// First match wins: a 2FA code for a device sign-in is a 2FA ask, not a device one.
const WORDING: Array<[AskKind, RegExp]> = [
  ['2fa', /\b(2fa|mfa|otp|two[- ]factor|one[- ]time\s+(?:code|passcode)|verification\s+code|authenticator\s+code|security\s+code)\b/i],
  ['device', /\bdevices?\b.*\b(approv\w*|confirm\w*|trust\w*)\b|\b(approv\w*|confirm\w*|trust\w*)\b.*\bdevices?\b/i],
  ['password', /\b(password|passphrase|passcode|keychain\s+(?:prompt|unlock)|re-?authenticate)\b/i],
  ['payment', /\b(payment|pay\s+(?:for|the)|billing|invoice|purchase|top[- ]?up|credit\s+card|card\s+(?:declined|update))\b|\$\s*\d/i],
];

const runsDirOf = (options: AsksOptions): string =>
  options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
const isKind = (value: unknown): value is AskKind => typeof value === 'string' && (ASK_KINDS as readonly string[]).includes(value);
export const isAskAnswer = (value: unknown): value is AskAnswer => typeof value === 'string' && (ASK_ANSWERS as readonly string[]).includes(value);

/** The ask a ledger line describes, or null when it is not one of the kinds. Outreach is only ever tagged, never guessed from wording. */
export function askOfLine(text: string): { kind: AskKind; request: string; created: string | null; unblocks: string | null; subject: string | null; expires: string | null } | null {
  // An agent's approval line (approvals.ts) has its own options; wording must not reclassify it.
  if (APPROVAL_LINE.test(text.trim())) return null;
  // "(expires <ISO>)" is a tag of its own, taken out before the rest is read, so either order of tags works.
  const expiry = EXPIRES.exec(text);
  const expires = validIso(expiry?.[1]);
  const body = expiry ? text.replace(EXPIRES, '') : text;
  const tagged = TAGGED.exec(body.trim());
  if (tagged) {
    // "<question> => <what it unblocks>": both plain, the question is what Mason reads first.
    const [question, ...rest] = tagged[3]!.split(' => ');
    const unblocks = rest.join(' => ').trim();
    return { kind: tagged[1]!.toLowerCase() as AskKind, request: question!.trim(), created: validIso(tagged[4]),
      unblocks: unblocks || null, subject: tagged[2]?.toLowerCase() ?? null, expires };
  }
  const match = WORDING.find(([, pattern]) => pattern.test(body));
  return match ? { kind: match[0], request: body.trim(), created: validIso(STAMP.exec(body)?.[1]), unblocks: null, subject: null, expires } : null;
}

function validIso(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const hexOf = (id: string): string => id.slice('nm-'.length);
export function shortIds(items: readonly NeedsMasonLedgerItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const hex = hexOf(item.id);
    let length = SHORT_MIN;
    while (length < hex.length && items.some(other => other.id !== item.id && hexOf(other.id).startsWith(hex.slice(0, length)))) length++;
    out.set(item.id, hex.slice(0, length));
  }
  return out;
}

const expiryMs = (iso: string | null): number => { const n = iso === null ? NaN : Date.parse(iso); return Number.isFinite(n) ? n : Infinity; };

/** Open asks, soonest expiry first, then asks with no stated expiry in ledger order. Expired asks are hidden. Never throws; an unreadable ledger says so. */
export function listAsks(options: AsksOptions = {}): AsksList {
  const nowMs = (options.now ?? Date.now)();
  const ledger = readNeedsMasonLedger({ runsDir: runsDirOf(options) });
  const open = ledger.items.filter(item => !item.resolved);
  const shorts = shortIds(open);
  const asks: Ask[] = [];
  let expiredHidden = 0;
  for (const item of open) {
    const ask = askOfLine(item.text);
    if (!ask) continue;
    if (expiryMs(ask.expires) <= nowMs) { expiredHidden++; continue; }
    const createdMs = ask.created === null ? NaN : Date.parse(ask.created);
    asks.push({
      id: item.id, shortId: shorts.get(item.id)!, kind: ask.kind, request: ask.request, replies: [...ASK_REPLIES[ask.kind]],
      replyHint: ask.kind === 'usage' ? 'a number from 0 to 100' : null, unblocks: ask.unblocks, subject: ask.subject, created: ask.created,
      ageSeconds: Number.isFinite(createdMs) ? Math.max(0, Math.floor((nowMs - createdMs) / 1000)) : null, expires: ask.expires,
    });
  }
  // Array.sort is stable, so asks with the same (or no) expiry keep ledger order.
  asks.sort((a, b) => expiryMs(a.expires) - expiryMs(b.expires));
  return { schema: 'asks.v1', asOf: new Date(nowMs).toISOString(), ledger: ledger.status, count: asks.length, asks,
    fleetDecides: open.filter(item => !APPROVAL_LINE.test(item.text)).length - asks.length - expiredHidden, expiredHidden };
}

export type RaiseAskResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Append one ask to the ledger. Only the ask kinds are accepted, the request is
 * one plain line, and an identical open ask is returned instead of a second line.
 * Never put the secret itself in the request: say what is needed, not the value.
 */
export function raiseAsk(kind: unknown, request: unknown, options: AsksOptions = {}, extra: { subject?: string; unblocks?: string; expires?: string } = {}): RaiseAskResult {
  if (!isKind(kind)) return { ok: false, reason: ASK_REFUSAL };
  const oneLine = (value: unknown): string =>
    // eslint-disable-next-line no-control-regex
    typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const line = oneLine(request).replace(/ => /g, ' - ');
  if (!line) return { ok: false, reason: 'The request needs one plain line.' };
  if (line.length > ASK_REQUEST_MAX) return { ok: false, reason: `The request is limited to ${ASK_REQUEST_MAX} characters.` };
  const subject = extra.subject === undefined ? null : extra.subject.trim().toLowerCase();
  if (subject !== null && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(subject)) return { ok: false, reason: 'The subject is one short word like grok-ultra.' };
  // A usage answer is stored as that pool's reading, so the pool must be one the usage readers know.
  if (kind === 'usage' && (subject === null || !(USAGE_POOLS as readonly string[]).includes(subject))) {
    return { ok: false, reason: `A usage ask names its pool: ${USAGE_POOLS.join(', ')}.` };
  }
  const unblocks = oneLine(extra.unblocks).replace(/ => /g, ' - ');
  if (unblocks.length > ASK_REQUEST_MAX) return { ok: false, reason: `What it unblocks is limited to ${ASK_REQUEST_MAX} characters.` };
  const expires = extra.expires === undefined ? null : validIso(extra.expires);
  if (extra.expires !== undefined && (expires === null || !/Z$/.test(extra.expires.trim()))) return { ok: false, reason: 'The expiry is a UTC time like 2026-11-24T00:00:00Z.' };
  if (expires !== null && Date.parse(expires) <= (options.now ?? Date.now)()) return { ok: false, reason: 'The expiry is already past.' };
  const runsDir = runsDirOf(options);
  const existing = listAsks({ ...options, runsDir });
  if (existing.ledger === 'unavailable') return { ok: false, reason: 'The needs-you ledger could not be read.' };
  const same = existing.asks.find(ask => ask.kind === kind && ask.request === line && ask.subject === subject);
  if (same) return { ok: true, id: same.id, duplicate: true };
  const created = new Date((options.now ?? Date.now)()).toISOString();
  try {
    appendNeedsMasonLine(runsDir, `ask:${kind}${subject ? `@${subject}` : ''} ${line}${unblocks ? ` => ${unblocks}` : ''} (asked ${created})${expires ? ` (expires ${expires})` : ''}`);
  } catch { return { ok: false, reason: 'The needs-you ledger could not be written.' }; }
  const raised = listAsks({ ...options, runsDir }).asks.find(ask => ask.kind === kind && ask.request === line && ask.subject === subject);
  return raised ? { ok: true, id: raised.id, duplicate: false } : { ok: false, reason: 'The ask was written but could not be read back.' };
}

const ID_INPUT = /^(?:nm-)?([0-9a-f]{4,12})$/;
const ANSWER_HINT = 'Answer yes, no, done or later.';
const PERCENT = /^(\d{1,3}(?:\.\d{1,2})?)\s*%?$/;

/**
 * The reply a kind accepts, in plain words when it does not. A usage reply is a
 * percent (40, 40%, 12.5); anything else is refused with a hint, never guessed.
 */
export function parseAnswerFor(kind: AskKind, raw: unknown): { ok: true; value: string } | { ok: false; hint: string } {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (kind === 'usage') {
    const match = PERCENT.exec(text);
    const value = match ? Number(match[1]) : NaN;
    return Number.isFinite(value) && value >= 0 && value <= 100 ? { ok: true, value: String(value) } : { ok: false, hint: USAGE_HINT };
  }
  if (kind === 'approval') {
    return text === 'yes' || text === 'no' || text === 'later' ? { ok: true, value: text } : { ok: false, hint: 'Answer yes or no.' };
  }
  return isAskAnswer(text) ? { ok: true, value: text } : { ok: false, hint: ANSWER_HINT };
}
const result = (status: AskAnswerStatus, fields: Partial<Omit<AskAnswerResult, 'schema' | 'status'>> = {}): AskAnswerResult => ({
  schema: 'asks.answer.v1', status, id: fields.id ?? null, kind: fields.kind ?? null, answer: fields.answer ?? null,
  source: fields.source ?? null, answeredAt: fields.answeredAt ?? null, reason: fields.reason ?? null,
});

/**
 * Record Mason's answer once. The id may be the full `nm-` id or a short prefix
 * (4+ hex). A repeat (any answer) changes nothing and returns the first answer.
 */
export async function answerAsk(idInput: unknown, answer: unknown, source: AskSource, options: AsksOptions = {},
    deps: AnswerAskDeps = {}): Promise<AskAnswerResult> {
  const idMatch = typeof idInput === 'string' ? ID_INPUT.exec(idInput.trim().toLowerCase()) : null;
  if (!idMatch) return result('invalid', { reason: 'Give the ask id (as shown by phm asks).' });
  const runsDir = runsDirOf(options);
  const ledger = readNeedsMasonLedger({ runsDir });
  if (ledger.status === 'unavailable') return result('unavailable', { reason: 'The needs-you ledger could not be read.' });
  const prefix = idMatch[1]!;
  // Open items win, so a short id stays usable after an older item with the same prefix was answered.
  const open = ledger.items.filter(item => !item.resolved && hexOf(item.id).startsWith(prefix));
  const matches = open.length ? open : ledger.items.filter(item => hexOf(item.id).startsWith(prefix));
  if (matches.length === 0) return result('unknown', { reason: 'No ask has that id.' });
  if (matches.length > 1) return result('ambiguous', { reason: 'More than one ask starts with that id; use more of it.' });
  const item = matches[0]!;
  const ask = askOfLine(item.text);
  if (!ask) return isAskAnswer(answer) ? result('refused', { id: item.id, reason: ASK_REFUSAL }) : result('invalid', { reason: ANSWER_HINT });
  const base = { id: item.id, kind: ask.kind };
  // An expired ask is hidden from every list, so it cannot be answered either (a repeat answer still reads back the first).
  if (!item.resolved && expiryMs(ask.expires) <= (options.now ?? Date.now)()) return result('unknown', { ...base, reason: 'That ask has expired.' });
  const reply = parseAnswerFor(ask.kind, answer);
  if (!reply.ok) return result('invalid', { ...base, reason: reply.hint });
  const alreadyAnswered = (): AskAnswerResult => {
    const recorded = (deps.readAnswer ?? readNeedsMasonAnswer)(item.id, options.bus ?? {});
    if (recorded.status !== 'found') return result('already-answered', { ...base, reason: 'Already answered; the first answer can no longer be read.' });
    const word = recorded.answer.reply?.trim().toLowerCase();
    return result('already-answered', {
      ...base, answer: word && parseAnswerFor(ask.kind, word).ok ? word : null, source: recorded.answer.source, answeredAt: recorded.answer.resolvedAt,
      reason: 'Already answered; nothing changed.',
    });
  };
  if (item.resolved) return alreadyAnswered();
  // Nothing is recorded for an invalid reply, an unreadable ledger or a repeat: this is the only write path.
  const now = options.now ?? Date.now;
  const answeredAt = new Date(now()).toISOString();
  const resolved = await (deps.resolve ?? resolveNeedsMasonWithInbox)({ itemId: item.id, reply: reply.value },
    { runsDir, source, now, ...(options.bus ? { bus: options.bus } : {}) });
  if (resolved.ok) {
    if (resolved.duplicate) return alreadyAnswered();
    // After the bus event: the answers ledger is the durable, append-only record (and, for usage, the reading).
    const recorded = appendAskLedger(runsDir, askLedgerRecordOf({
      askId: item.id, kind: ask.kind, subject: ask.subject, reply: reply.value, channel: options.channel ?? source, at: answeredAt,
    }));
    return recorded ? result('answered', { ...base, answer: reply.value, source, answeredAt })
      : result('unavailable', { ...base, reason: 'The answer was sent but the answers ledger could not be written; tell the fleet.' });
  }
  if (resolved.code === 'already-resolved') return alreadyAnswered();
  if (resolved.code === 'unknown') return result('unknown', { reason: 'No ask has that id.' });
  return result('unavailable', { ...base, reason: 'The answer could not be recorded; try again.' });
}

/**
 * A one-word phone reply: `yes 3f2a`, `3f2a done`, `No nm-3f2a1b2c3d4e.`.
 * Anything longer or different is not an ask reply and goes to its usual path.
 */
export function parseAskReply(text: string): { id: string; answer: string } | null {
  const words = text.trim().replace(/[.!]+$/, '').split(/\s+/);
  if (words.length !== 2) return null;
  const [a, b] = words.map(word => word.toLowerCase()) as [string, string];
  // A percent has at most three digits, so it can never read as a four-plus hex id: "40 3f2a".
  const isAnswer = (word: string): boolean => isAskAnswer(word) || /^\d{1,3}(?:\.\d{1,2})?%?$/.test(word);
  const [answer, id] = isAnswer(a) ? [a, b] : isAnswer(b) ? [b, a] : [null, null];
  return answer && id && ID_INPUT.test(id) ? { id, answer } : null;
}

/**
 * The channel path. Only a sender the adapter has verified as Mason can answer;
 * anything else returns null untouched, exactly like text that is not a reply.
 */
export async function answerAskFromChannel(text: string, sender: { verified: boolean; source: AskSource },
    options: AsksOptions = {}, deps: AnswerAskDeps = {}): Promise<AskAnswerResult | null> {
  if (sender.verified !== true) return null;
  const reply = parseAskReply(text);
  if (!reply) return null;
  // "no cafe" may be an ordinary sentence: an id that matches no ask is not a reply.
  const outcome = await answerAsk(reply.id, reply.answer, sender.source, options, deps);
  return outcome.status === 'unknown' ? null : outcome;
}

/** Plain words for a phone or terminal. */
export function askAnswerText(outcome: AskAnswerResult): string {
  const short = outcome.id ? hexOf(outcome.id).slice(0, SHORT_MIN) : '';
  switch (outcome.status) {
    case 'answered': return `Got it: ${outcome.answer} to ${outcome.kind} ask ${short}.`;
    case 'already-answered': return outcome.answer
      ? `Already answered ${outcome.answer} to ask ${short}; nothing changed.`
      : `Ask ${short} was already answered; nothing changed.`;
    case 'refused': return `Not asking you: ${ASK_REFUSAL}.`;
    default: return outcome.reason ?? 'Could not record that answer.';
  }
}

export function formatAge(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

export function asksText(list: AsksList): string[] {
  if (list.ledger === 'unavailable') return ['Asks: unknown (the needs-you ledger could not be read).'];
  if (list.count === 0) return ['Nothing needs you.'];
  return [
    `${list.count} ${list.count === 1 ? 'ask needs' : 'asks need'} you. Answer with: phm asks answer <id> <reply>`,
    ...list.asks.map(ask => `${ask.shortId}  ${ask.kind.padEnd(8)}  ${formatAge(ask.ageSeconds).padStart(7)}  ${ask.request} [${ask.replyHint ?? ask.replies.join('/')}]${ask.unblocks ? ` -> ${ask.unblocks}` : ''}${ask.expires ? ` (expires ${ask.expires.slice(0, 10)})` : ''}`),
  ];
}
