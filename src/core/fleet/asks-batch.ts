/**
 * The one batch of things only Mason can answer, for the phone and for agents.
 *
 * This extends the asks ledger view in asks.ts (same ledger, same answerAsk);
 * it adds no store. buildAskBatch is pure: oldest first, the same question
 * asked twice shown once (oldest time kept, every duplicate id still answered
 * together). answerOwnerAsk records an answer only for a sender on the
 * verified-owner list (ownerAllowed, read through loadOwnerThreadSettings),
 * only when it is one of the ask's own choices, once.
 */
import type { OwnerChannel } from '../comms/leader-mailbox.js';
import { fixedOwnerConfigDir, loadOwnerThreadSettings, ownerAllowed, type OwnerThreadSettings } from '../comms/owner-channel.js';
import { answerAsk, ASK_REPLIES, askTypeOf, isMasonOnly, listAsks, type Ask, type AskType, type AskAnswerResult, type AskKind, type AsksList, type AsksOptions } from './asks.js';

export type AskResponseKind = 'yes-no' | 'pick-one' | 'short-value';
/** The four limits only Mason may cross. null = the ask does not say. */
export type HardLimit = 'secrets' | 'money' | 'outside-send' | 'data-loss';

export interface OpenAsk {
  id: string;
  question: string;
  kind: AskResponseKind;
  choices?: readonly string[];
  /** ISO time, or null when unknown (shown as unknown, sorted last). */
  askedAt: string | null;
  /** ISO time after which the ask is moot, or null when unknown (listed after every ask with a known expiry). */
  expires?: string | null;
  hardLimit: HardLimit | null;
  /** One line: what happens on yes (or on the first choice). */
  whatHappens?: string;
  /** The answer is a number (a usage percent), so a card shows one number field. */
  numeric?: boolean;
  type?: AskType;
  /** What the fleet did instead of asking Mason (shown with --all); null when it did nothing yet. */
  fleetDid?: string | null;
}

export interface BatchAsk {
  /** 1-based position, the number in a "2 yes" reply. */
  number: number;
  /** The oldest duplicate's id; the one a tap names. */
  id: string;
  /** Every id carrying this question; one answer records them all. */
  ids: string[];
  question: string;
  kind: AskResponseKind;
  /** Allowed answers. Empty for short-value (any short text). */
  choices: string[];
  askedAt: string | null;
  expires: string | null;
  hardLimit: HardLimit | null;
  whatHappens: string;
  /** Set only when the answer is a number from 0 to 100. */
  numeric?: boolean;
  type: AskType;
  fleetDid: string | null;
}

/** An ask the fleet answered itself: it used what software could read and recorded the action. */
export interface FleetHandled { question: string; fleetDid: string; at: string }

export interface AskBatch {
  schema: 'asks.batch.v1';
  count: number;
  asks: BatchAsk[];
  /** unavailable = the ledger could not be read, so zero asks would be a guess. */
  ledger: AsksList['ledger'];
  /** Open asks of type other left out of the default view. */
  otherHidden?: number;
  /** Only with --all: asks the fleet answered itself, newest first. */
  fleetHandled?: FleetHandled[];
}

export { SHORT_VALUE_MAX } from './ask-display.js';
const LIMIT_LINE: Record<HardLimit, string> = {
  secrets: 'The fleet gets the access it asked for.',
  money: 'The fleet may spend it.',
  'outside-send': 'The fleet sends it to the outside person.',
  'data-loss': 'The fleet deletes it.',
};
const norm = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase();
const ms = (iso: string | null): number => { const n = iso === null ? NaN : Date.parse(iso); return Number.isFinite(n) ? n : Infinity; };

export function choicesOf(ask: Pick<OpenAsk, 'kind' | 'choices'>): string[] {
  if (ask.kind === 'yes-no') return ['yes', 'no'];
  if (ask.kind === 'short-value') return [];
  return [...(ask.choices ?? [])];
}

export function buildAskBatch(open: readonly OpenAsk[], ledger: AskBatch['ledger'] = 'available'): AskBatch {
  // Soonest expiry first; unknown expiry last; ties (and all unknowns) oldest first.
  const sorted = [...open].sort((a, b) => ms(a.expires ?? null) - ms(b.expires ?? null) || ms(a.askedAt) - ms(b.askedAt));
  const merged = new Map<string, BatchAsk>();
  for (const ask of sorted) {
    const key = `${ask.kind}|${norm(ask.question)}`;
    const seen = merged.get(key);
    if (seen) { seen.ids.push(ask.id); continue; } // sorted, so the first one carries the soonest expiry
    merged.set(key, {
      number: 0, id: ask.id, ids: [ask.id], question: ask.question.trim(), kind: ask.kind, choices: choicesOf(ask),
      askedAt: ask.askedAt, expires: ask.expires ?? null, hardLimit: ask.hardLimit,
      whatHappens: ask.whatHappens ?? (ask.hardLimit ? LIMIT_LINE[ask.hardLimit] : 'Unknown: the ask does not say.'),
      ...(ask.numeric ? { numeric: true } : {}),
      type: ask.type ?? 'other', fleetDid: ask.fleetDid ?? null,
    });
  }
  const asks = [...merged.values()].map((ask, i) => ({ ...ask, number: i + 1 }));
  return { schema: 'asks.batch.v1', count: asks.length, asks, ledger };
}

const FROM_KIND: Record<AskKind | 'signin', Pick<OpenAsk, 'kind' | 'choices' | 'hardLimit' | 'whatHappens' | 'numeric' | 'fleetDid'>> = {
  payment: { kind: 'yes-no', hardLimit: 'money', whatHappens: LIMIT_LINE.money },
  outreach: { kind: 'yes-no', hardLimit: 'outside-send', whatHappens: LIMIT_LINE['outside-send'], fleetDid: 'Waiting: nothing was sent to the outside person.' },
  password: { kind: 'pick-one', choices: ASK_REPLIES.password, hardLimit: 'secrets', whatHappens: 'Done: the fleet carries on with it.' },
  signin: { kind: 'pick-one', choices: ASK_REPLIES.password, hardLimit: 'secrets', whatHappens: 'Done: the fleet carries on with it.' },
  '2fa': { kind: 'pick-one', choices: ASK_REPLIES['2fa'], hardLimit: 'secrets', whatHappens: 'Done: the fleet carries on with it.' },
  device: { kind: 'pick-one', choices: ASK_REPLIES.device, hardLimit: 'secrets', whatHappens: 'Done: the fleet carries on with it.' },
  // A usage answer is a number, so it is a short value; it is a reading, not a limit.
  usage: { kind: 'short-value', numeric: true, hardLimit: null, whatHappens: 'Recorded as your latest reading, with the time you said it.', fleetDid: 'No sensor reading found yet, so it is still open.' },
  // Money is a hard limit, but this answer only records the decision; nothing is spent by it.
  approval: { kind: 'yes-no', hardLimit: 'money', whatHappens: 'Recorded as your decision. Nothing is spent by this answer.', fleetDid: 'Waiting: nothing was spent.' },
};

export const openAskOf = (ask: Ask, fleetDid?: string | null): OpenAsk => ({
  id: ask.id, question: ask.request, askedAt: ask.created, expires: ask.expires, ...FROM_KIND[ask.kind], ...(ask.unblocks ? { whatHappens: ask.unblocks } : {}),
  type: askTypeOf(ask.kind), ...(fleetDid ? { fleetDid } : {}),
});

/**
 * The batch Mason sees: the open ledger asks through buildAskBatch. By default only the four types software cannot
 * answer (password, two-factor, device-approval, payment); `all` adds type other. Never throws.
 */
export function listAskBatch(options: AsksOptions = {}, list: (o: AsksOptions) => AsksList = listAsks, all = false,
  fleetDidFor: (ask: Ask) => string | null = () => null): AskBatch {
  const asks = list(options);
  const shown = all ? asks.asks : asks.asks.filter(ask => isMasonOnly(askTypeOf(ask.kind)));
  return { ...buildAskBatch(shown.map(ask => openAskOf(ask, fleetDidFor(ask))), asks.ledger), otherHidden: asks.asks.length - shown.length };
}

/** Plain words for a batch line and for a thread reply hint. */
export const batchChoicesText = (ask: BatchAsk): string => ask.kind === 'short-value' ? 'short answer' : ask.choices.join(' / ');

// ---- one-word replies -------------------------------------------------------

/**
 * "yes", "no" or "2 yes" (also "yes 2", "2: yes"): the word answers the oldest
 * ask, or the numbered one. Null when it is not a reply to a listed ask (more
 * words, a number with no such ask, a word that ask does not allow).
 */
export function parseThreadReply(text: string, batch: Pick<AskBatch, 'asks'>): { ask: BatchAsk; answer: string } | null {
  const words = text.trim().toLowerCase().replace(/[.!:]+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 2) return null;
  let number = 1, answer: string;
  if (words.length === 2) {
    const [a, b] = words as [string, string];
    const numFirst = /^\d{1,2}$/.test(a);
    if (!numFirst && !/^\d{1,2}$/.test(b)) return null;
    number = Number(numFirst ? a : b);
    answer = numFirst ? b : a;
  } else answer = words[0]!;
  const ask = batch.asks.find(item => item.number === number);
  return ask && ask.choices.includes(answer) ? { ask, answer } : null;
}

// ---- answering ----------------------------------------------------------------

export interface AskSender { channel: OwnerChannel; senderId: string }
export type OwnerAnswerStatus = 'answered' | 'already-answered' | 'conflict' | 'refused' | 'invalid' | 'unknown' | 'unavailable';
export interface OwnerAnswerResult {
  schema: 'asks.owner-answer.v1';
  status: OwnerAnswerStatus;
  id: string | null;
  answer: string | null;
  /** Plain words, safe to show. */
  message: string;
}
export interface OwnerAnswerDeps {
  settings?: OwnerThreadSettings;
  batch?: () => AskBatch;
  /** Record one ledger id. Default is answerAsk with source cli, the same writer every surface uses. */
  record?: (id: string, answer: string, channel: string) => Promise<AskAnswerResult>;
  options?: AsksOptions;
}

const out = (status: OwnerAnswerStatus, id: string | null, answer: string | null, message: string): OwnerAnswerResult =>
  ({ schema: 'asks.owner-answer.v1', status, id, answer, message });

/**
 * Record Mason's answer. Unverified sender: a plain refusal, nothing read or
 * written. Not one of the ask's choices: invalid, nothing written. Same answer
 * again: already-answered, nothing changes. A different second answer:
 * conflict, the first stays.
 */
export async function answerOwnerAsk(input: { askId: string; answer: string; sender: AskSender }, deps: OwnerAnswerDeps = {}): Promise<OwnerAnswerResult> {
  const { askId, sender } = input;
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
  let settings: OwnerThreadSettings;
  try { settings = deps.settings ?? loadOwnerThreadSettings(fixedOwnerConfigDir()); }
  catch { return out('refused', null, null, 'Cannot confirm who you are, so nothing was recorded.'); }
  if (!sender || typeof sender.senderId !== 'string' || !ownerAllowed(sender.channel, sender.senderId, settings)) {
    return out('refused', null, null, 'Only the owner can answer. Nothing was recorded.');
  }
  // All types: a number or a card tap may answer an `other` ask by id, even though the default list hides it.
  const batch = (deps.batch ?? (() => listAskBatch(deps.options, listAsks, true)))();
  const ask = batch.asks.find(item => item.ids.includes(askId));
  // The ledger names the real channel; the bus source is the closest surface it knows.
  const record = deps.record ?? ((id, value, channel) => answerAsk(id, value, channel === 'telegram' ? 'telegram' : channel === 'email' ? 'email' : 'cli',
    { ...deps.options, channel }));
  if (!ask) {
    // Not open any more: the ledger can still say whether it was answered the same way.
    const known = await record(askId, answer.toLowerCase(), sender.channel);
    if (known.status === 'already-answered') return repeat(askId, answer.toLowerCase(), known.answer);
    return out('unknown', null, null, batch.ledger === 'unavailable' ? 'Asks are unknown right now.' : 'No open ask has that id.');
  }
  const value = answer.toLowerCase();
  // A short value (a percent) is validated by the ask's own kind inside answerAsk, which says what it wants.
  if (ask.kind !== 'short-value' && !ask.choices.includes(value)) return out('invalid', ask.id, null, `Answer ${ask.choices.join(' or ')}.`);
  let last: AskAnswerResult | null = null;
  for (const id of ask.ids) {
    last = await record(id, value, sender.channel);
    if (last.status === 'invalid') return out('invalid', ask.id, null, last.reason ?? 'That is not an answer this ask accepts.');
    if (last.status === 'already-answered') return repeat(ask.id, value, last.answer);
    if (last.status !== 'answered') return out('unavailable', ask.id, null, last.reason ?? 'The answer could not be recorded; try again.');
  }
  return out('answered', ask.id, last?.answer ?? value, `Got it: ${last?.answer ?? value}.`);
}

const repeat = (id: string, answer: string, first: string | null): OwnerAnswerResult =>
  first === answer ? out('already-answered', id, answer, `Already answered ${answer}; nothing changed.`)
    : out('conflict', id, first, first ? `Already answered ${first}; that stays.` : 'Already answered; the first answer stays.');

/** A thread message from a sender: parse it, then answer. Null when it is not a reply (so it goes its usual way). */
export async function answerFromThread(text: string, sender: AskSender, deps: OwnerAnswerDeps = {}): Promise<OwnerAnswerResult | null> {
  const batch = (deps.batch ?? (() => listAskBatch(deps.options)))();
  const reply = parseThreadReply(text, batch);
  if (!reply) return null;
  return answerOwnerAsk({ askId: reply.ask.id, answer: reply.answer, sender }, { ...deps, batch: () => batch });
}
