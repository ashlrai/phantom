/**
 * What the Leader has asked Mason and not yet heard back on, read from the
 * Leader thread page the pane already holds. Pure and browser-safe.
 *
 * The page is the newest messages only, so a question older than the page is
 * not listed here; it still shows in Needs you. Nothing is inferred: a
 * question counts as open until the thread carries Mason's answer to it.
 */
import { formatWait } from '../leader/answer-state.js';
import { answeredQuestions } from '../leader/thread-model.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';

export interface LeaderAsk {
  /** The thread message id; stable while the question stays on the page. */
  key: string;
  /** What the answer route is keyed by: `<memoId>:<index>`, else the message id. */
  questionId: string;
  /** Untrusted Leader text; render through MessageMarkdown only. */
  text: string;
  /** Null when the message's time cannot be read. */
  atMs: number | null;
  /** The Leader attached choices or a short-answer form to this question. */
  typed: boolean;
  /** Passed to the form so a revised question prompts a fresh read. */
  revision: string | null;
}

/** Open questions, oldest first: the one that has waited longest leads. */
export function openLeaderAsks(messages: readonly LeaderThreadMessage[]): LeaderAsk[] {
  const answered = answeredQuestions(messages);
  const out: LeaderAsk[] = [];
  for (const message of messages) {
    if (message.kind !== 'question' || message.from !== 'leader' || answered.has(message.id)) continue;
    const at = Date.parse(message.at);
    out.push({
      key: message.id,
      questionId: message.questionId ?? message.id,
      text: message.text,
      atMs: Number.isFinite(at) ? at : null,
      typed: message.questionForm !== undefined,
      revision: message.questionForm?.revision ?? null,
    });
  }
  return out.sort((a, b) => (a.atMs ?? Number.POSITIVE_INFINITY) - (b.atMs ?? Number.POSITIVE_INFINITY));
}

/** "asked 14m ago"; an unreadable time says so instead of reading as fresh. */
export function askedAgo(atMs: number | null, nowMs: number): string {
  if (atMs === null) return 'asked at an unknown time';
  const wait = formatWait(Math.max(0, nowMs - atMs));
  return wait === '<1m' ? 'asked just now' : `asked ${wait} ago`;
}

/** The ask to show: the picked one while it is still open, else the oldest. */
export function currentAsk(asks: readonly LeaderAsk[], picked: string | null): LeaderAsk | null {
  return asks.find(ask => ask.key === picked) ?? asks[0] ?? null;
}

/** Wrapping step through the open asks; -1 = previous, 1 = next. */
export function stepAsk(asks: readonly LeaderAsk[], current: LeaderAsk, delta: -1 | 1): LeaderAsk {
  const index = asks.findIndex(ask => ask.key === current.key);
  return asks[(Math.max(0, index) + delta + asks.length) % asks.length] ?? current;
}

/** A bare 1-9 keypress as a zero-based choice, when that many choices exist. */
export function choiceForKey(key: string, choices: number): number | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index < choices ? index : null;
}
