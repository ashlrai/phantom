/**
 * Approvals: one-tap or one-word decisions only Mason can make, asked by an
 * agent with its own options ("use it" / "not now") and an optional expiry.
 *
 * Not a second store. An approval is one open NEEDS-MASON.md line, the same
 * ledger `phm asks` reads, and an answer is the same `needs_mason.resolved` bus
 * envelope plus resolved marker (resolveNeedsMasonWithInbox), with the
 * answerer's verified id added as `answeredBy`. The `phm asks` kinds
 * (password, 2FA, device, payment, outreach) show here too with yes/no/later,
 * so Mason has one list. An answer only records the decision: nothing is paid,
 * sent or changed here. `phm decisions` is the same list for those kinds,
 * folded with replies by foldDecisions below.
 *
 * Line format (written by raiseApproval, parsed by approvalOfLine):
 *   approval #3: Use the $40 credit? [use it|not now] (asked <ISO> by claude, expires <ISO>)
 */
import { appendNeedsMasonLine } from './needs-mason-append.js';
import { readNeedsMasonAnswer } from './needs-mason-answer.js';
import { resolveNeedsMasonWithInbox } from './needs-mason-relay.js';
import { readNeedsMasonLedger, type NeedsMasonLedgerItem, type NeedsMasonOptions } from './needs-mason-resolve.js';
import { askOfLine, formatAge, shortIds, type AskKind } from './asks.js';
import { OPERATOR_SENDER_ID } from './channel-envelope.js';
import { scrubSecrets } from '../util/scrub.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APPROVALS_SCHEMA = 'approvals.asks.v1';
export const APPROVAL_ANSWER_SCHEMA = 'approvals.answer.v1';
export const APPROVAL_QUESTION_MAX = 160;
export const APPROVAL_OPTIONS_MAX = 6;
const OPTION = /^[a-z][a-z0-9 '-]{0,23}$/;
const ASKER = /^[A-Za-z0-9._:@-]{1,48}$/;
const ISO = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)';
const LINE = new RegExp(`^approval #(\\d{1,6}): (.+) \\[([^\\]]+)\\] \\(asked ${ISO} by ([^,()\\s]+)(?:, expires ${ISO})?\\)$`);
/** The ledger reader hides any line containing "resolved", and ids hash at most 300 characters. */
const LEDGER_LINE_MAX = 300;

/** Surfaces an answer can come from; agent relays ('leader') are never Mason. */
export type ApprovalChannel = Exclude<NonNullable<NeedsMasonOptions['source']>, 'leader'>;
export const APPROVAL_CHANNELS: readonly ApprovalChannel[] = ['desktop', 'phone', 'telegram', 'cli', 'email'];

export interface Approval {
  /** Ledger item id, `nm-` + 12 hex. */
  id: string;
  /** What to type in a reply: the approval number (`3`), or the short hex id for a `phm asks` ask. */
  ref: string;
  /** Approval number, or null for a `phm asks` ask. */
  number: number | null;
  /** 'approval' for an agent's question; otherwise the `phm asks` kind. */
  kind: 'approval' | AskKind;
  question: string;
  options: string[];
  /** Who asked, as the asker named itself; null when unknown. */
  askedBy: string | null;
  created: string | null;
  ageSeconds: number | null;
  /** ISO expiry, or null for none. Expired approvals leave the list and refuse answers. */
  expires: string | null;
}

export interface ApprovalsList {
  schema: typeof APPROVALS_SCHEMA;
  asOf: string;
  /** missing = nothing asked yet; unavailable = the ledger could not be read, so the list is unknown. */
  ledger: 'available' | 'missing' | 'unavailable';
  count: number;
  approvals: Approval[];
  /** Open approvals whose expiry passed; they can no longer be answered. */
  expired: number;
}

export type ApprovalAnswerStatus = 'answered' | 'already-answered' | 'unverified' | 'expired' | 'unknown' | 'ambiguous' | 'invalid' | 'unavailable';
export interface ApprovalAnswerResult {
  schema: typeof APPROVAL_ANSWER_SCHEMA;
  status: ApprovalAnswerStatus;
  id: string | null;
  ref: string | null;
  question: string | null;
  /** The recorded option; for already-answered the first one, or null when it can no longer be read. */
  answer: string | null;
  /** Verified id that answered (always Mason's canonical id), or null. */
  answeredBy: string | null;
  channel: string | null;
  answeredAt: string | null;
  /** Plain words for anything other than answered. */
  reason: string | null;
}

/** Who is answering. `senderId` is the channel adapter's verified canonical id, never text from a message. */
export interface ApprovalAnswerer { channel: ApprovalChannel; senderId: string | null }
export interface ApprovalsOptions extends Pick<NeedsMasonOptions, 'runsDir' | 'bus'> { now?: () => number }
export interface ApprovalAnswerDeps { resolve?: typeof resolveNeedsMasonWithInbox; readAnswer?: typeof readNeedsMasonAnswer }

const runsDirOf = (options: ApprovalsOptions): string =>
  options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
// eslint-disable-next-line no-control-regex
const oneLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
/** One-letter replies a phone keyboard makes easy. */
const SHORT_WORD: Readonly<Record<string, string>> = { y: 'yes', n: 'no' };
const normalizeOption = (value: string): string => oneLine(value).toLowerCase().replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '').trim();

/** The approval a ledger line describes, or null when it is not an approval line. */
export function approvalOfLine(text: string): Omit<Approval, 'id' | 'ref' | 'ageSeconds'> | null {
  const m = LINE.exec(text.trim());
  if (!m) return null;
  const options = m[3]!.split('|').map(normalizeOption);
  if (options.length < 2 || options.some(option => !OPTION.test(option))) return null;
  return {
    number: Number(m[1]), kind: 'approval', question: m[2]!.trim(), options,
    askedBy: m[5] === 'unknown' ? null : m[5]!, created: m[4]!, expires: m[6] ?? null,
  };
}

function viewOf(item: NeedsMasonLedgerItem, short: string, nowMs: number): Approval | null {
  const approval = approvalOfLine(item.text);
  if (approval) {
    const { number, kind, question, options, askedBy, created, expires } = approval;
    // Same key order as an ask row below, so the JSON shape is stable.
    return { id: item.id, ref: String(number), number, kind, question, options, askedBy, created,
      ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(created!)) / 1000)), expires };
  }
  const ask = askOfLine(item.text);
  if (!ask) return null;
  const createdMs = ask.created === null ? NaN : Date.parse(ask.created);
  return {
    id: item.id, ref: short, number: null, kind: ask.kind, question: ask.request, options: [...DECISION_ANSWERS],
    askedBy: null, created: ask.created, ageSeconds: Number.isFinite(createdMs) ? Math.max(0, Math.floor((nowMs - createdMs) / 1000)) : null,
    expires: null,
  };
}

const isExpired = (approval: Pick<Approval, 'expires'>, nowMs: number): boolean =>
  approval.expires !== null && Date.parse(approval.expires) <= nowMs;

/** Open approvals and asks, oldest ledger line first. Never throws; an unreadable ledger says so. */
export function listApprovals(options: ApprovalsOptions = {}): ApprovalsList {
  const nowMs = (options.now ?? Date.now)();
  const ledger = readNeedsMasonLedger({ runsDir: runsDirOf(options) });
  const open = ledger.items.filter(item => !item.resolved);
  const shorts = shortIds(open);
  const views = open.map(item => viewOf(item, shorts.get(item.id)!, nowMs)).filter((v): v is Approval => v !== null);
  const approvals = views.filter(view => !isExpired(view, nowMs));
  return {
    schema: APPROVALS_SCHEMA, asOf: new Date(nowMs).toISOString(), ledger: ledger.status,
    count: approvals.length, approvals, expired: views.length - approvals.length,
  };
}

export interface RaiseApprovalInput { question: unknown; options: unknown; expires?: unknown; askedBy?: unknown }
export type RaiseApprovalResult =
  | { ok: true; id: string; ref: string; duplicate: boolean }
  | { ok: false; reason: string };

/**
 * Append one approval to the ledger. The question is one plain line, options
 * are 2-6 short lowercase words or phrases, and an identical open approval is
 * returned instead of a second line. Never put a secret in the question.
 */
export function raiseApproval(input: RaiseApprovalInput, options: ApprovalsOptions = {}): RaiseApprovalResult {
  const question = typeof input.question === 'string' ? oneLine(input.question) : '';
  if (!question) return { ok: false, reason: 'The question needs one plain line.' };
  if (question.length > APPROVAL_QUESTION_MAX) return { ok: false, reason: `The question is limited to ${APPROVAL_QUESTION_MAX} characters.` };
  if (/[[\]()]/.test(question) || /\bresolved\b/i.test(question)) return { ok: false, reason: 'The question cannot use brackets, parentheses or the word "resolved".' };
  if (scrubSecrets(question) !== question) return { ok: false, reason: 'The question looks like it holds a secret; say what is needed, not the value.' };
  const list = Array.isArray(input.options) ? input.options : typeof input.options === 'string' ? input.options.split(',') : [];
  const opts = list.map(option => typeof option === 'string' ? normalizeOption(option) : '');
  if (opts.length < 2 || opts.length > APPROVAL_OPTIONS_MAX) return { ok: false, reason: `Give 2 to ${APPROVAL_OPTIONS_MAX} options, such as yes,no.` };
  if (opts.some(option => !OPTION.test(option) || /\bresolved\b/.test(option))) {
    return { ok: false, reason: 'Each option is a short word or phrase (letters first, up to 24 characters), such as "use it".' };
  }
  if (new Set(opts).size !== opts.length) return { ok: false, reason: 'The options must differ.' };
  const nowMs = (options.now ?? Date.now)();
  let expires: string | null = null;
  if (input.expires !== undefined && input.expires !== null) {
    const ms = typeof input.expires === 'string' ? Date.parse(input.expires) : NaN;
    if (!Number.isFinite(ms)) return { ok: false, reason: 'The expiry must be an ISO time, such as 2026-11-18T09:00:00Z.' };
    if (ms <= nowMs) return { ok: false, reason: 'The expiry is already past.' };
    expires = new Date(ms).toISOString();
  }
  const askedBy = typeof input.askedBy === 'string' && ASKER.test(input.askedBy) && input.askedBy !== 'unknown' ? input.askedBy : 'unknown';
  const runsDir = runsDirOf(options);
  const ledger = readNeedsMasonLedger({ runsDir });
  if (ledger.status === 'unavailable') return { ok: false, reason: 'The needs-you ledger could not be read.' };
  const current = listApprovals({ ...options, runsDir });
  const same = current.approvals.find(a => a.kind === 'approval' && a.question === question && a.options.join('|') === opts.join('|'));
  if (same) return { ok: true, id: same.id, ref: same.ref, duplicate: true };
  // Numbers only grow, answered lines included, so "yes 3" never lands on a newer ask.
  const number = 1 + Math.max(0, ...ledger.items.map(item => approvalOfLine(item.text)?.number ?? 0));
  const line = `approval #${number}: ${question} [${opts.join('|')}] (asked ${new Date(nowMs).toISOString()} by ${askedBy}${expires ? `, expires ${expires}` : ''})`;
  if (line.length > LEDGER_LINE_MAX) return { ok: false, reason: 'The question and options are too long together; shorten them.' };
  try { appendNeedsMasonLine(runsDir, line); }
  catch { return { ok: false, reason: 'The needs-you ledger could not be written.' }; }
  const raised = listApprovals({ ...options, runsDir }).approvals.find(a => a.number === number);
  return raised ? { ok: true, id: raised.id, ref: raised.ref, duplicate: false } : { ok: false, reason: 'The approval was written but could not be read back.' };
}

const result = (status: ApprovalAnswerStatus, fields: Partial<Omit<ApprovalAnswerResult, 'schema' | 'status'>> = {}): ApprovalAnswerResult => ({
  schema: APPROVAL_ANSWER_SCHEMA, status, id: fields.id ?? null, ref: fields.ref ?? null, question: fields.question ?? null,
  answer: fields.answer ?? null, answeredBy: fields.answeredBy ?? null, channel: fields.channel ?? null,
  answeredAt: fields.answeredAt ?? null, reason: fields.reason ?? null,
});

/** A reference Mason may type: `3` or `#3` (approval number) or a hex id prefix (4+). */
function parseRef(input: string): { number: number } | { hex: string } | null {
  const text = input.trim().toLowerCase();
  const num = /^#(\d{1,6})$/.exec(text) ?? /^(\d{1,3})$/.exec(text);
  if (num) return { number: Number(num[1]) };
  const hex = /^(?:nm-)?([0-9a-f]{4,12})$/.exec(text);
  return hex ? { hex: hex[1]! } : null;
}

const VERIFY_REASON = 'Only Mason can answer, and this sender is not verified as Mason. Nothing was recorded.';

/**
 * Record Mason's answer once. Only a verified Mason sender is accepted; the
 * caller's channel adapter (Telegram owner check, the local-human check, the
 * desktop mutation gate) decides `senderId`. A repeat returns the first answer.
 */
export async function answerApproval(refInput: unknown, optionInput: unknown, answerer: ApprovalAnswerer,
    options: ApprovalsOptions = {}, deps: ApprovalAnswerDeps = {}): Promise<ApprovalAnswerResult> {
  if (answerer.senderId !== OPERATOR_SENDER_ID || !APPROVAL_CHANNELS.includes(answerer.channel)) {
    return result('unverified', { channel: APPROVAL_CHANNELS.includes(answerer.channel) ? answerer.channel : null, reason: VERIFY_REASON });
  }
  const ref = typeof refInput === 'string' ? parseRef(refInput) : null;
  if (!ref) return result('invalid', { reason: 'Give the approval number or id, as shown by phm approvals.' });
  const option = typeof optionInput === 'string' ? normalizeOption(optionInput) : '';
  const runsDir = runsDirOf(options);
  const ledger = readNeedsMasonLedger({ runsDir });
  if (ledger.status === 'unavailable') return result('unavailable', { reason: 'The needs-you ledger could not be read.' });
  const nowMs = (options.now ?? Date.now)();
  const shorts = shortIds(ledger.items.filter(item => !item.resolved));
  const views = ledger.items.map(item => ({ item, view: viewOf(item, shorts.get(item.id) ?? item.id.slice(3, 7), nowMs) }))
    .filter((row): row is { item: NeedsMasonLedgerItem; view: Approval } => row.view !== null);
  const hits = 'number' in ref ? views.filter(row => row.view.number === ref.number)
    : views.filter(row => row.item.id.slice(3).startsWith(ref.hex));
  // Open items win, so a short id stays usable after an older item with the same prefix was answered.
  const openHits = hits.filter(row => !row.item.resolved);
  const matches = openHits.length ? openHits : hits;
  if (matches.length === 0) return result('unknown', { reason: 'No approval has that number or id.' });
  if (matches.length > 1) return result('ambiguous', { reason: 'More than one approval starts with that id; use more of it.' });
  const { item, view } = matches[0]!;
  const base = { id: item.id, ref: view.ref, question: view.question };
  const alreadyAnswered = (): ApprovalAnswerResult => {
    const recorded = (deps.readAnswer ?? readNeedsMasonAnswer)(item.id, options.bus ?? {});
    if (recorded.status !== 'found') return result('already-answered', { ...base, reason: 'Already answered; the first answer can no longer be read.' });
    return result('already-answered', {
      ...base, answer: recorded.answer.reply, channel: recorded.answer.source, answeredAt: recorded.answer.resolvedAt,
      answeredBy: recorded.answer.answeredBy ?? null, reason: 'Already answered; nothing changed.',
    });
  };
  if (item.resolved) return alreadyAnswered();
  if (isExpired(view, nowMs)) return result('expired', { ...base, reason: `This approval expired at ${view.expires}; nothing was recorded.` });
  if (!view.options.includes(option)) return result('invalid', { ...base, reason: `Answer one of: ${view.options.join(', ')}.` });
  const answeredAt = new Date(nowMs).toISOString();
  const resolved = await (deps.resolve ?? resolveNeedsMasonWithInbox)({ itemId: item.id, reply: option }, {
    runsDir, source: answerer.channel, answeredBy: answerer.senderId, now: options.now ?? Date.now, ...(options.bus ? { bus: options.bus } : {}),
  });
  if (resolved.ok && !resolved.duplicate) {
    return result('answered', { ...base, answer: option, answeredBy: answerer.senderId, channel: answerer.channel, answeredAt });
  }
  if (resolved.ok || resolved.code === 'already-resolved') return alreadyAnswered();
  if (resolved.code === 'unknown') return result('unknown', { reason: 'No approval has that number or id.' });
  return result('unavailable', { ...base, reason: 'The answer could not be recorded; try again.' });
}

/**
 * A reply on a connected channel: "yes 3", "3 use it", "No 3f2a." or just
 * "use it". It answers when exactly one open approval matches; when the words
 * fit several it asks which one (status ambiguous, plain reason). Returns null,
 * untouched, for an unverified sender or text that is not a reply.
 */
export async function answerApprovalReply(text: string, answerer: ApprovalAnswerer, options: ApprovalsOptions = {},
    deps: ApprovalAnswerDeps = {}): Promise<ApprovalAnswerResult | null> {
  if (answerer.senderId !== OPERATOR_SENDER_ID || text.length > 80) return null;
  const words = normalizeOption(text).split(' ').filter(Boolean).map(word => SHORT_WORD[word] ?? word);
  if (words.length === 0 || words.length > 5) return null;
  const list = listApprovals(options);
  if (list.ledger !== 'available' || list.count === 0) return null;
  const fits = (phrase: string) => list.approvals.filter(a => a.options.includes(phrase));
  for (const [refWord, phrase] of [[words.at(-1)!, words.slice(0, -1).join(' ')], [words[0]!, words.slice(1).join(' ')]] as const) {
    const ref = phrase ? parseRef(refWord) : null;
    if (!ref) continue;
    const target = list.approvals.filter(a => 'number' in ref ? a.number === ref.number : a.id.slice(3).startsWith(ref.hex));
    if (target.length === 1 && target[0]!.options.includes(phrase)) return answerApproval(target[0]!.ref, phrase, answerer, options, deps);
    if (target.length === 0 && fits(phrase).length > 0) return result('unknown', { reason: `No open approval is ${refWord}. ${whichOne(phrase, fits(phrase))}` });
  }
  const phrase = words.join(' ');
  const candidates = fits(phrase);
  if (candidates.length === 1) return answerApproval(candidates[0]!.ref, phrase, answerer, options, deps);
  if (candidates.length > 1) return result('ambiguous', { answer: phrase, reason: `Which one? "${phrase}" fits ${candidates.length} approvals. ${whichOne(phrase, candidates)}` });
  return null;
}

function whichOne(phrase: string, candidates: readonly Approval[]): string {
  const shown = candidates.slice(0, 4).map(a => `"${phrase} ${a.ref}" for: ${a.question}`);
  return `Reply ${shown.join('; or ')}${candidates.length > 4 ? `; ${candidates.length - 4} more in phm approvals` : ''}.`;
}

/** Plain words for a phone or terminal. */
export function approvalAnswerText(outcome: ApprovalAnswerResult): string {
  switch (outcome.status) {
    case 'answered': return `Got it: "${outcome.answer}" to approval ${outcome.ref}: ${outcome.question}`;
    case 'already-answered': return outcome.answer
      ? `Approval ${outcome.ref} was already answered "${outcome.answer}"; nothing changed.`
      : `Approval ${outcome.ref} was already answered; nothing changed.`;
    default: return outcome.reason ?? 'Could not record that answer.';
  }
}

export function approvalsText(list: ApprovalsList): string[] {
  if (list.ledger === 'unavailable') return ['Approvals: unknown (the needs-you ledger could not be read).'];
  const expired = list.expired ? [`${list.expired} expired; they can no longer be answered.`] : [];
  if (list.count === 0) return ['Nothing needs your approval.', ...expired];
  return [
    `${list.count} waiting on you. Answer with: phm approvals answer <ref> <option>`,
    ...list.approvals.map(a => `  ${a.ref.padEnd(5)} ${a.question}  [${a.options.join(' | ')}]  ` +
      `asked ${formatAge(a.ageSeconds)} ago by ${a.askedBy ?? 'unknown'}${a.expires ? `, expires ${a.expires}` : ''}`),
    ...expired,
  ];
}

// ---------------------------------------------------------------------------
// Decisions (`phm decisions`): the asks folded with replies, one state each.

export const DECISIONS_SCHEMA = 'decisions.v1';
export const DECISIONS_VERSION = 1;
/** The one-word answers a decision takes; `y` and `n` count as yes and no. */
export const DECISION_ANSWERS = ['yes', 'no', 'later'] as const;
export type DecisionAnswer = typeof DECISION_ANSWERS[number];
export const SAY_WHICH_ONE = 'Say which one';

export interface DecisionRecord {
  id: string;
  /** Short code Mason quotes in a reply ("yes 3f2a"). */
  code: string;
  kind: AskKind;
  /** One plain line. */
  question: string;
  /** ISO time asked, or null when unknown (a reply then counts from any time). */
  asked_at: string | null;
  /** Who asked, or where the ask came from. */
  source: string;
  /** ISO expiry, or null for none. */
  expires_at?: string | null;
}
/** A reply as a channel adapter received it; `sender_id` is the adapter's verified id, never text from the message. */
export interface DecisionReply { channel: string; sender_id: string; text: string; at: string }
export interface DecisionState extends Required<DecisionRecord> {
  state: 'waiting' | 'answered' | 'expired';
  answer: DecisionAnswer | null;
  answered_by: { channel: string; sender_id: string; at: string } | null;
}
export type IgnoredReason = 'unverified sender' | 'not a one-word answer' | 'unknown time' | 'unknown code'
  | 'nothing waiting' | 'already answered' | 'expired' | 'asked after this reply' | 'say which one';
export interface IgnoredReply { channel: string; sender_id: string; text: string; at: string; reason: IgnoredReason }
export interface DecisionsReport {
  schema: typeof DECISIONS_SCHEMA;
  version: typeof DECISIONS_VERSION;
  as_of: string;
  /** missing = nothing asked yet; unavailable = the ledger could not be read, so the list is unknown. */
  ledger: ApprovalsList['ledger'];
  waiting: number;
  decisions: DecisionState[];
  ignored: IgnoredReply[];
  /** Plain words when a bare answer fitted several waiting decisions that are still waiting, else null. */
  hint: string | null;
}
export interface FoldDecisionsOptions { verifiedSenderIds: readonly string[]; now: number; ledger?: ApprovalsList['ledger'] }

const IGNORED_TEXT_MAX = 40;
const answerWord = (word: string): DecisionAnswer | null => {
  const w = SHORT_WORD[word] ?? word;
  return (DECISION_ANSWERS as readonly string[]).includes(w) ? w as DecisionAnswer : null;
};

/** `yes`, `y 3f2a`, `3f2a later.`: the answer and the quoted code (null when bare), or null when not a one-word answer. */
export function parseDecisionReply(text: string): { answer: DecisionAnswer; code: string | null } | null {
  if (text.length > 80) return null;
  const words = normalizeOption(text).split(' ').filter(Boolean).map(word => word.replace(/^#/, ''));
  if (words.length === 1) { const answer = answerWord(words[0]!); return answer ? { answer, code: null } : null; }
  if (words.length !== 2) return null;
  const [a, b] = words as [string, string];
  const first = answerWord(a), second = answerWord(b);
  return first && !second ? { answer: first, code: b } : second && !first ? { answer: second, code: a } : null;
}

/**
 * Pure: each decision's state after these replies, at `now`. Replies are taken
 * oldest first. Only a sender in `verifiedSenderIds` counts; every other reply
 * is listed under `ignored` with its reason, never applied. A reply answers a
 * decision when it is one word (yes, no, later, y or n) and either quotes the
 * decision's code or the decision is the only one waiting at that moment. The
 * first answer wins. A bare answer while several wait answers none of them and
 * leaves a "say which one" hint naming each code.
 */
export function foldDecisions(records: readonly DecisionRecord[], replies: readonly DecisionReply[], options: FoldDecisionsOptions): DecisionsReport {
  const verified = new Set(options.verifiedSenderIds);
  const ms = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const value = Date.parse(iso);
    return Number.isFinite(value) ? value : null;
  };
  const rows: DecisionState[] = records.map(r => ({
    id: r.id, code: r.code.toLowerCase(), kind: r.kind, question: r.question, asked_at: r.asked_at, source: r.source,
    expires_at: r.expires_at ?? null, state: 'waiting', answer: null, answered_by: null,
  }));
  const asked = (row: DecisionState, at: number) => (ms(row.asked_at) ?? -Infinity) <= at;
  const live = (row: DecisionState, at: number) => (ms(row.expires_at) ?? Infinity) > at;
  const ignored: IgnoredReply[] = [];
  let ambiguous: string[] = [];
  const ordered = replies.map((reply, index) => ({ reply, index, at: ms(reply.at) }))
    .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.index - b.index);
  for (const { reply, at } of ordered) {
    const ignore = (reason: IgnoredReason) => {
      ignored.push({ channel: reply.channel, sender_id: reply.sender_id, text: clip(reply.text), at: reply.at, reason });
    };
    if (!verified.has(reply.sender_id)) { ignore('unverified sender'); continue; }
    const parsed = parseDecisionReply(reply.text);
    if (!parsed) { ignore('not a one-word answer'); continue; }
    if (at === null) { ignore('unknown time'); continue; }
    const waiting = rows.filter(row => row.answer === null && asked(row, at) && live(row, at));
    let target: DecisionState;
    if (parsed.code !== null) {
      const hit = rows.find(row => row.code === parsed.code || row.id.toLowerCase() === parsed.code);
      if (!hit) { ignore('unknown code'); continue; }
      if (hit.answer !== null) { ignore('already answered'); continue; }
      if (!asked(hit, at)) { ignore('asked after this reply'); continue; }
      if (!live(hit, at)) { ignore('expired'); continue; }
      target = hit;
    } else if (waiting.length === 1) {
      target = waiting[0]!;
    } else {
      if (waiting.length === 0) { ignore('nothing waiting'); continue; }
      ignore('say which one');
      ambiguous = waiting.map(row => row.id);
      continue;
    }
    target.answer = parsed.answer;
    target.state = 'answered';
    target.answered_by = { channel: reply.channel, sender_id: reply.sender_id, at: reply.at };
  }
  for (const row of rows) if (row.answer === null && !live(row, options.now)) row.state = 'expired';
  const stillWaiting = rows.filter(row => row.state === 'waiting');
  const unclear = stillWaiting.filter(row => ambiguous.includes(row.id));
  const hint = unclear.length > 1
    ? `${SAY_WHICH_ONE}: ${unclear.slice(0, 4).map(row => `"yes ${row.code}" for: ${row.question}`).join('; or ')}.`
    : null;
  return {
    schema: DECISIONS_SCHEMA, version: DECISIONS_VERSION, as_of: new Date(options.now).toISOString(),
    ledger: options.ledger ?? 'available', waiting: stillWaiting.length, decisions: rows, ignored, hint,
  };
}

const clip = (text: string): string => {
  const line = scrubSecrets(oneLine(text));
  return line.length > IGNORED_TEXT_MAX ? `${line.slice(0, IGNORED_TEXT_MAX - 1)}…` : line;
};

/** The ledger's open asks as decision records; an agent's own-option approvals stay in `phm approvals`. */
export function decisionRecordsOf(list: ApprovalsList): DecisionRecord[] {
  return list.approvals.flatMap((a): DecisionRecord[] => a.kind === 'approval' ? [] : [{
    id: a.id, code: a.ref, kind: a.kind, question: a.question, asked_at: a.created, source: a.askedBy ?? 'needs-you ledger', expires_at: a.expires,
  }]);
}

/**
 * The live list. Replies on connected channels are applied as they arrive
 * (answerApprovalReply, the Telegram owner check), so the ledger already holds
 * them: this folds no further replies and the only verified id is Mason's.
 */
export function readDecisions(options: ApprovalsOptions = {}): DecisionsReport {
  const list = listApprovals(options);
  return foldDecisions(decisionRecordsOf(list), [], { verifiedSenderIds: [OPERATOR_SENDER_ID], now: Date.parse(list.asOf), ledger: list.ledger });
}

/** Plain words for a terminal. */
export function decisionsText(report: DecisionsReport): string[] {
  if (report.ledger === 'unavailable') return ['Decisions: unknown (the needs-you ledger could not be read).'];
  const nowMs = Date.parse(report.as_of);
  const waiting = report.decisions.filter(d => d.state === 'waiting');
  const lines = waiting.length === 0 ? ['Nothing needs you.'] : [
    `${waiting.length} waiting on you. Answer with: phm decisions answer <code> yes|no|later`,
    ...waiting.map(d => {
      const askedMs = d.asked_at === null ? NaN : Date.parse(d.asked_at);
      const age = Number.isFinite(askedMs) ? `${formatAge(Math.max(0, Math.floor((nowMs - askedMs) / 1000)))} ago` : 'at an unknown time';
      return `  ${d.code.padEnd(6)} ${d.kind.padEnd(8)} asked ${age}  ${d.question}`;
    }),
  ];
  if (report.hint) lines.push(report.hint);
  const expired = report.decisions.filter(d => d.state === 'expired').length;
  if (expired) lines.push(`${expired} expired; they can no longer be answered.`);
  return lines;
}
