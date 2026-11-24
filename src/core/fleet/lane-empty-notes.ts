import { readEmptyJobs } from './empty-jobs.js';
import { emptyNoteFor } from './lane-badge.js';

/**
 * Top EMPTY reason per lane over the last 24 h, for the lane health badge
 * tooltip (`FleetLaneConsoleOptions.emptyNotes`). It lives outside
 * lane-console on purpose: lane-console sits inside the Tier-1 authority
 * import closure, and the empty-jobs report cluster must not join it —
 * display surfaces inject this provider instead of lane-console importing
 * it statically. A missing ledger or any read failure means no notes.
 */
export async function fleetLaneEmptyNotes(runsDir: string, nowMs: number): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  try {
    const report = await readEmptyJobs(24, runsDir, undefined, nowMs);
    for (const row of report?.final?.lanes ?? []) {
      const note = emptyNoteFor(row.top, row.reasons[row.top], row.total);
      if (note) notes.set(row.lane, note);
    }
  } catch { /* the tooltip is optional */ }
  return notes;
}
