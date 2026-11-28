/**
 * routes/verse/leader-thread/ask-now-model.ts: the pure half of Ask now in
 * the Leader pane's reply box.
 *
 * Send writes to the inbox, which the Leader reads at its next pass. Ask now
 * posts the same words to the Leader thread (`POST /api/verse/leader/thread`),
 * where the Leader answers inside the request. A message asked this way is
 * drawn at once as a pending line and stays until the thread read holds it,
 * so nothing here invents a delivery: "waiting" means the request is out,
 * "not sent" carries the server's own reason.
 */

/** The server gives one reply this long before it cancels the invocation (docs/LEADER.md, Limits). */
export const REPLY_LIMIT_SECONDS = 120;

export interface PendingAsk {
  key: string;
  text: string;
  /** When Mason asked, for the elapsed count. */
  atMs: number;
  state: 'waiting' | 'failed';
  /** Why it did not go; null while waiting. */
  reason: string | null;
}

/** Cmd+Shift+Enter, or Ctrl+Shift+Enter: the chord that asks instead of sending. */
export function isAskChord(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return event.key === 'Enter' && event.shiftKey && (event.metaKey || event.ctrlKey);
}

/** The line beside the typing dots. Seconds appear once the wait is long enough to wonder about. */
export function waitWords(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000);
  if (seconds < 3) return 'Waiting for the Leader’s reply…';
  if (seconds < REPLY_LIMIT_SECONDS) return `Waiting for the Leader’s reply… ${seconds}s`;
  return `No reply after ${seconds}s. A reply is cut off at ${REPLY_LIMIT_SECONDS} seconds, so an answer or a refusal is due.`;
}

export interface AskGate {
  can: boolean;
  /** The button's tooltip: what Ask now does, or why it cannot right now. */
  why: string;
}

/** Whether Ask now can run, and the words that say so. */
export function askGate(input: { draft: string; readOnly: boolean; threadMissing: boolean; asking: boolean }): AskGate {
  if (input.readOnly) return { can: false, why: 'This session is read-only, so it cannot write to the Leader.' };
  if (input.threadMissing) return { can: false, why: 'The Leader conversation is not available on this server, so nothing can answer now. Send still reaches the inbox.' };
  if (input.asking) return { can: false, why: 'The Leader is answering your last question. Send still reaches the inbox.' };
  if (input.draft.trim() === '') return { can: false, why: 'Write something first. Ask now gets the Leader’s answer at once; Send leaves it for the next pass.' };
  return { can: true, why: 'Get the Leader’s answer at once (Cmd+Shift+Enter). Send leaves it in the inbox for the next pass.' };
}

/** Puts a message that did not go back in the box, above anything typed since. */
export function putBack(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${text}\n\n${draft.trimStart()}`;
}
