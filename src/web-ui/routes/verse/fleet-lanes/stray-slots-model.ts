import type { StraySlotsV1 } from '../../../../core/fleet/stray-slots.js';

/**
 * Per-lane line under the lane row: null while the lane lost no counted slots
 * to leftover processes. `slotsLost` counts finished jobs, so the job names in
 * parentheses are the distinct strays behind the count.
 */
export function strayLine(lane: string, data: StraySlotsV1 | null | undefined): string | null {
  const report = data?.lanes.find((entry) => entry.lane === lane);
  if (!report || report.slotsLost <= 0) return null;
  const jobs = [...new Set(report.strays.map((stray) => stray.job))];
  const names = jobs.length === 0 ? ''
    : ` (${jobs.slice(0, 4).join(', ')}${jobs.length > 4 ? ` +${jobs.length - 4} more` : ''})`;
  return `${report.slotsLost} ${report.slotsLost === 1 ? 'slot' : 'slots'} lost to strays${names}`;
}

/** Lanes with at least one lost slot, worst first, plus the total. */
export function strayTotals(data: StraySlotsV1 | null | undefined): { lanes: Array<{ lane: string; slotsLost: number }>; slotsLost: number } {
  const lanes = (data?.lanes ?? []).filter((lane) => lane.slotsLost > 0)
    .map(({ lane, slotsLost }) => ({ lane, slotsLost }))
    .sort((a, b) => b.slotsLost - a.slotsLost || a.lane.localeCompare(b.lane));
  return { lanes, slotsLost: lanes.reduce((sum, lane) => sum + lane.slotsLost, 0) };
}

/** Pane-level line for the headline; null when nothing is lost. */
export function strayTotalsLine(totals: ReturnType<typeof strayTotals>): string | null {
  if (totals.slotsLost <= 0) return null;
  const breakdown = totals.lanes.map(({ lane, slotsLost }) => `${lane} ${slotsLost}`).join(', ');
  return `${totals.slotsLost} counted ${totals.slotsLost === 1 ? 'slot has' : 'slots have'} no worker (${breakdown}). Run leader/STOP-STRAYS.sh to list them.`;
}
