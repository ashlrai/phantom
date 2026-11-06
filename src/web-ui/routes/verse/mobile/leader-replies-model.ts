/**
 * routes/verse/mobile/leader-replies-model.ts — the phone Home's two-way
 * leader thread: the tail of MASON-INBOX.md interleaved with the leader's
 * own MASON-OUTBOX.md answers, newest last, capped for a compact section.
 *
 * The desktop pane's merge does the ordering — same clock parsing, same
 * tie-break — so a reply here sits exactly where the Mac's thread puts it.
 * A leader row is marked with the Mason line it answers (the newest Mason
 * line before it): that link is the only thing the file format gives the
 * reply back to the words it responded to.
 */
import type { OutboxKind } from '../../../../core/fleet/outbox-kind.js';
import { previewText } from '../leader/thread-model.js';
import { mergeThread } from '../leader-thread/thread-merge-model.js';
import type { InboxEntry } from './inbox-tail-query.js';

export interface LeaderReplyRow {
  who: 'mason' | 'leader';
  /** ISO instant for the row's <time>; '' when the entry's stamp could not be read. */
  at: string;
  text: string;
  /** The outbox classifier's chip — leader rows only. */
  kind?: OutboxKind;
  /** A short preview of the Mason line the reply answers — leader rows only. */
  answers?: string;
}

/** The most rows the section shows. */
export const LEADER_REPLIES_LIMIT = 8;
const ROW_TEXT_MAX = 280;
const ANSWERS_PREVIEW_MAX = 80;

export function leaderReplyRows(
  outbox: readonly { at: string; text: string }[],
  inbox: readonly InboxEntry[],
  nowMs: number,
): LeaderReplyRow[] {
  const merged = mergeThread([], [...inbox], nowMs, undefined, outbox);
  const rows: LeaderReplyRow[] = [];
  let lastMason: string | null = null;
  // Undated lines follow the dated ones, like the desktop pane.
  for (const line of [...merged.lines, ...merged.undated]) {
    if (line.who === 'mason') lastMason = line.text;
    rows.push({
      who: line.who,
      at: Number.isFinite(line.at) ? new Date(line.at).toISOString() : '',
      text: previewText(line.text, ROW_TEXT_MAX),
      ...(line.kind ? { kind: line.kind } : {}),
      ...(line.who === 'leader' && lastMason !== null ? { answers: previewText(lastMason, ANSWERS_PREVIEW_MAX) } : {}),
    });
  }
  // `answers` resolved before the slice, so a reply keeps its link when the
  // order itself scrolled out of the eight-row window.
  return rows.slice(-LEADER_REPLIES_LIMIT);
}
