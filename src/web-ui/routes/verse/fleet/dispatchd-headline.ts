import type { FleetRunsDirState } from '../../../../core/fleet/runs-dir-state.js';

/** The shared runs query narrows the server projection to these display fields. */
type HeadlineRuns = Pick<FleetRunsDirState, 'runsDirPresent' | 'lastTick'> & {
  lanes: Array<{ running: number | null; held: boolean }>;
};

function fresh(runs: HeadlineRuns | null, now: number): runs is HeadlineRuns {
  if (!runs?.runsDirPresent || !runs.lastTick) return false;
  const age = now - Date.parse(runs.lastTick);
  return Number.isFinite(age) && age >= 0 && age <= 15 * 60_000;
}

export function dispatchdWorking(runs: HeadlineRuns | null, now: number): number | null {
  if (!fresh(runs, now) || runs.lanes.some(lane => lane.running === null)) return null;
  return runs.lanes.reduce((sum, lane) => sum + (lane.running ?? 0), 0);
}

export function dispatchdLine(runs: HeadlineRuns | null, now: number): string | null {
  const working = dispatchdWorking(runs, now);
  if (working === null || !runs) return null;
  const lanes = runs.lanes.filter(lane => (lane.running ?? 0) > 0).length;
  const held = runs.lanes.filter(lane => lane.held === true).length;
  const minutes = Math.floor((now - Date.parse(runs.lastTick!)) / 60_000);
  return `dispatchd · ${working} worker${working === 1 ? '' : 's'} on ${lanes} lane${lanes === 1 ? '' : 's'}${held ? ` · ${held} held` : ''} · read ${minutes < 1 ? 'just now' : `${minutes} m ago`}`;
}
