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
import { readNeedsMasonAnswer } from './needs-mason-answer.js';
import { resolveNeedsMasonWithInbox } from './needs-mason-relay.js';
import { readNeedsMasonLedger, type NeedsMasonLedgerItem, type NeedsMasonOptions } from './needs-mason-resolve.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ASK_KINDS = ['password', '2fa', 'device', 'payment', 'outreach'] as const;
export type AskKind = typeof ASK_KINDS[number];
/** `later` records "not now": the asker reads it and may ask again; nothing is snoozed here. */
export const ASK_ANSWERS = ['yes', 'no', 'done', 'later'] as const;
export type AskAnswer = typeof ASK_ANSWERS[number];
export type AskSource = NonNullable<NeedsMasonOptions['source']>;
export const ASK_REFUSAL = 'the fleet decides this itself';
export const ASK_REQUEST_MAX = 200;
const SHORT_MIN = 4;

export interface Ask {
  /** Ledger item id, `nm-` + 12 hex. */
  id: string;
  /** Shortest unique prefix of the hex (at least 4), for one-word replies: `yes <shortId>`. */
  shortId: string;
  kind: AskKind;
  /** One plain line: what Mason is asked to do. */
  request: string;
  /** ISO time the ask was raised, or null when the ledger line does not say. */
  created: string | null;
  /** Whole seconds since `created`, or null when that is unknown. */
  ageSeconds: number | null;
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
}

export type AskAnswerStatus = 'answered' | 'already-answered' | 'refused' | 'unknown' | 'ambiguous' | 'invalid' | 'unavailable';
export interface AskAnswerResult {
  schema: 'asks.answer.v1';
  status: AskAnswerStatus;
  id: string | null;
  kind: AskKind | null;
  /** The recorded answer. For already-answered this is the first answer, or null when it can no longer be read. */
  answer: AskAnswer | null;
  source: string | null;
  answeredAt: string | null;
  /** Plain reason for anything other than answered. */
  reason: string | null;
}

export interface AsksOptions extends Pick<NeedsMasonOptions, 'runsDir' | 'bus'> { now?: () => number }
export interface AnswerAskDeps { resolve?: typeof resolveNeedsMasonWithInbox; readAnswer?: typeof readNeedsMasonAnswer }

const TAGGED = /^ask:(password|2fa|device|payment|outreach)\s+(.+?)(?:\s+\(asked\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\))?$/i;
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
export function askOfLine(text: string): { kind: AskKind; request: string; created: string | null } | null {
  // An agent's approval line (approvals.ts) has its own options; wording must not reclassify it.
  if (APPROVAL_LINE.test(text.trim())) return null;
  const tagged = TAGGED.exec(text.trim());
  if (tagged) return { kind: tagged[1]!.toLowerCase() as AskKind, request: tagged[2]!.trim(), created: validIso(tagged[3]) };
  const match = WORDING.find(([, pattern]) => pattern.test(text));
  return match ? { kind: match[0], request: text.trim(), created: validIso(STAMP.exec(text)?.[1]) } : null;
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

/** Open asks, oldest ledger line first. Never throws; an unreadable ledger says so. */
export function listAsks(options: AsksOptions = {}): AsksList {
  const nowMs = (options.now ?? Date.now)();
  const ledger = readNeedsMasonLedger({ runsDir: runsDirOf(options) });
  const open = ledger.items.filter(item => !item.resolved);
  const shorts = shortIds(open);
  const asks: Ask[] = [];
  for (const item of open) {
    const ask = askOfLine(item.text);
    if (!ask) continue;
    const createdMs = ask.created === null ? NaN : Date.parse(ask.created);
    asks.push({
      id: item.id, shortId: shorts.get(item.id)!, kind: ask.kind, request: ask.request, created: ask.created,
      ageSeconds: Number.isFinite(createdMs) ? Math.max(0, Math.floor((nowMs - createdMs) / 1000)) : null,
    });
  }
  return { schema: 'asks.v1', asOf: new Date(nowMs).toISOString(), ledger: ledger.status, count: asks.length, asks,
    fleetDecides: open.filter(item => !APPROVAL_LINE.test(item.text)).length - asks.length };
}

export type RaiseAskResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Append one ask to the ledger. Only the ask kinds are accepted, the request is
 * one plain line, and an identical open ask is returned instead of a second line.
 * Never put the secret itself in the request: say what is needed, not the value.
 */
export function raiseAsk(kind: unknown, request: unknown, options: AsksOptions = {}): RaiseAskResult {
  if (!isKind(kind)) return { ok: false, reason: ASK_REFUSAL };
  // eslint-disable-next-line no-control-regex
  const line = typeof request === 'string' ? request.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!line) return { ok: false, reason: 'The request needs one plain line.' };
  if (line.length > ASK_REQUEST_MAX) return { ok: false, reason: `The request is limited to ${ASK_REQUEST_MAX} characters.` };
  const runsDir = runsDirOf(options);
  const existing = listAsks({ ...options, runsDir });
  if (existing.ledger === 'unavailable') return { ok: false, reason: 'The needs-you ledger could not be read.' };
  const same = existing.asks.find(ask => ask.kind === kind && ask.request === line);
  if (same) return { ok: true, id: same.id, duplicate: true };
  const created = new Date((options.now ?? Date.now)()).toISOString();
  try { appendNeedsMasonLine(runsDir, `ask:${kind} ${line} (asked ${created})`); }
  catch { return { ok: false, reason: 'The needs-you ledger could not be written.' }; }
  const raised = listAsks({ ...options, runsDir }).asks.find(ask => ask.kind === kind && ask.request === line);
  return raised ? { ok: true, id: raised.id, duplicate: false } : { ok: false, reason: 'The ask was written but could not be read back.' };
}

const ID_INPUT = /^(?:nm-)?([0-9a-f]{4,12})$/;
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
  if (!isAskAnswer(answer)) return result('invalid', { reason: 'Answer yes, no, done or later.' });
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
  if (!ask) return result('refused', { id: item.id, reason: ASK_REFUSAL });
  const base = { id: item.id, kind: ask.kind };
  const alreadyAnswered = (): AskAnswerResult => {
    const recorded = (deps.readAnswer ?? readNeedsMasonAnswer)(item.id, options.bus ?? {});
    if (recorded.status !== 'found') return result('already-answered', { ...base, reason: 'Already answered; the first answer can no longer be read.' });
    const word = recorded.answer.reply?.trim().toLowerCase();
    return result('already-answered', {
      ...base, answer: isAskAnswer(word) ? word : null, source: recorded.answer.source, answeredAt: recorded.answer.resolvedAt,
      reason: 'Already answered; nothing changed.',
    });
  };
  if (item.resolved) return alreadyAnswered();
  const now = options.now ?? Date.now;
  const answeredAt = new Date(now()).toISOString();
  const resolved = await (deps.resolve ?? resolveNeedsMasonWithInbox)({ itemId: item.id, reply: answer },
    { runsDir, source, now, ...(options.bus ? { bus: options.bus } : {}) });
  if (resolved.ok) {
    if (resolved.duplicate) return alreadyAnswered();
    return result('answered', { ...base, answer, source, answeredAt });
  }
  if (resolved.code === 'already-resolved') return alreadyAnswered();
  if (resolved.code === 'unknown') return result('unknown', { reason: 'No ask has that id.' });
  return result('unavailable', { ...base, reason: 'The answer could not be recorded; try again.' });
}

/**
 * A one-word phone reply: `yes 3f2a`, `3f2a done`, `No nm-3f2a1b2c3d4e.`.
 * Anything longer or different is not an ask reply and goes to its usual path.
 */
export function parseAskReply(text: string): { id: string; answer: AskAnswer } | null {
  const words = text.trim().replace(/[.!]+$/, '').split(/\s+/);
  if (words.length !== 2) return null;
  const [a, b] = words.map(word => word.toLowerCase()) as [string, string];
  const [answer, id] = isAskAnswer(a) ? [a, b] : isAskAnswer(b) ? [b, a] : [null, null];
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
    `${list.count} ${list.count === 1 ? 'ask needs' : 'asks need'} you. Answer with: phm asks answer <id> yes|no|done|later`,
    ...list.asks.map(ask => `${ask.shortId}  ${ask.kind.padEnd(8)}  ${formatAge(ask.ageSeconds).padStart(7)}  ${ask.request}`),
  ];
}
