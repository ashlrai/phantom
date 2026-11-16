/**
 * routes/verse/resources/first-read.ts — which resource rows still deserve
 * their one automatic usage check this app session.
 *
 * On the first open after an install or upgrade the Resources bar asks for
 * one bounded usage check per unread resource itself — the same request
 * "Check again" sends — so the rows fill with real readings instead of
 * sitting on "No current usage reading · Check now". `shouldAutoCheck` is
 * pure (no I/O): the bar owns firing and the one-at-a-time queue; this file
 * owns the choice and the app-session memory of attempted seats.
 */
import type { CapacityRow } from '../usage/capacity-strip-model.js';

/** Which seats this app session already started one bounded usage check for. */
export interface FirstReadSession {
  readonly attempted: ReadonlySet<string>;
}

// Session memory: lives for the app session (a page reload starts a new one),
// not for one mount — an unmounted or strict-remounted bar must not re-fire.
const attempted = new Set<string>();

/** The app session's own first-read memory. */
export function firstReadSession(): FirstReadSession {
  return { attempted };
}

/** Record that a seat's one bounded auto-check has been started this session. */
export function markFirstReadAttempted(seatId: string): void {
  attempted.add(seatId);
}

/** Test hook: production keeps the set for the whole session. */
export function resetFirstReadSessionForTest(): void {
  attempted.clear();
}

/**
 * `projectResourceDisplay`'s `missing` state, reached with no clock: nothing
 * was ever read for this row on this computer — no measured or flagged window
 * (a current or retained reading needs one), no recorded history. A check
 * that ran and produced no reading is still missing — the seat earned its one
 * bounded retry, and the row then shows the check's own reason rather than
 * the generic fix.
 */
function missingUsage(row: CapacityRow): boolean {
  return !row.windows.some(window => window.usedPercent !== null || window.limitReached)
    && row.historicalUsage == null;
}

/**
 * Seat ids whose one bounded auto-check should fire now: subscription
 * resources with a `missing` usage state (never read on this computer), not
 * signed out, and not already attempted this app session. Signed-out rows
 * are their own state (Reconnect, not a usage check); local rows are
 * `kind: 'local'` and never `missing`; Devin reads organization consumption
 * through its own endpoint, so the native account check would only refuse it.
 */
export function shouldAutoCheck(rows: readonly CapacityRow[], session: FirstReadSession): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (session.attempted.has(row.seatId)) continue;
    if (row.kind !== 'subscription' || row.engine === 'devin' || row.signedOut) continue;
    if (!missingUsage(row)) continue;
    out.push(row.seatId);
  }
  return out;
}
