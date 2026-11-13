/**
 * routes/verse/ideas/idea-verdict-model.ts: pure helpers for the Ideas pane
 * "not now" / "never" dismissal (RQ-PHX-IDEANOTNOW94). A 'never' verdict
 * hides its row; a 'not now' hides it for NOT_NOW_HIDE_MS, then the row
 * returns with a note line. No React, no fetch — the pane feeds it rows.
 */
import type { IdeaRowVerdict } from './ideas-model.js';

/** Seven days: how long a "not now" keeps an idea off the list. */
export const NOT_NOW_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

/** True while the verdict still keeps its row off the list. */
export function verdictHidesRow(verdict: IdeaRowVerdict | undefined, now: number): boolean {
  if (!verdict) return false;
  if (verdict.verdict === 'never') return true;
  const at = Date.parse(verdict.at);
  // An untrusted row with no readable date stays hidden rather than flickering.
  if (!Number.isFinite(at)) return true;
  return now - at < NOT_NOW_HIDE_MS;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * The small line a verdicted row carries — "You said not now on Nov 3:
 * too risky" — both on a returned not-now row and on rows revealed by the
 * Show dismissed toggle.
 */
export function verdictNote(verdict: IdeaRowVerdict): string {
  const at = Date.parse(verdict.at);
  const when = Number.isFinite(at) ? ` on ${dateFmt.format(new Date(at))}` : '';
  const what = verdict.verdict === 'never' ? 'never' : 'not now';
  return `You said ${what}${when}${verdict.reason ? `: ${verdict.reason}` : ''}`;
}
