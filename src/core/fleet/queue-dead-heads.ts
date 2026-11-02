/** Offline queue advisory. Absence of a skip marker is not dispatch authority. */
import { parseReadyTsv } from './lane-console.js';
import { scrubSecrets } from '../util/scrub.js';

export interface DeadQueueLine { job: string; position: number; reason: string }
export interface LaneDeadHeads {
  lane: string;
  deadLines: DeadQueueLine[];
  firstLaunchablePosition: number | null;
  roundsLost: number;
}

/**
 * Positions are one-based within READY rows of each lane. Inspect until cap
 * apparently launchable rows have been dealt (or the lane is exhausted).
 * Each skipped line costs one round, independent of launch capacity. A missing
 * marker means only that this report has no evidence preventing launch.
 */
export function queueDeadHeads(readyTsv: string, skippedEmpty: ReadonlyMap<string, string>, perLaneCap: number): LaneDeadHeads[] {
  if (!Number.isSafeInteger(perLaneCap) || perLaneCap < 1) throw new RangeError('per-lane cap must be a positive integer');
  const lanes = new Map<string, { report: LaneDeadHeads; position: number; launchable: number }>();
  for (const row of parseReadyTsv(readyTsv).rows) {
    if (row.status !== 'READY' || /^PARKED-/i.test(row.pool) || !row.id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id)) continue;
    let state = lanes.get(row.pool);
    if (!state) {
      state = { report: { lane: row.pool, deadLines: [], firstLaunchablePosition: null, roundsLost: 0 }, position: 0, launchable: 0 };
      lanes.set(row.pool, state);
    }
    if (state.launchable >= perLaneCap) continue;
    state.position++;
    const reason = skippedEmpty.get(row.id)?.trim();
    if (reason) {
      state.report.deadLines.push({ job: row.id, position: state.position, reason: scrubSecrets(reason) });
      state.report.roundsLost++;
    } else {
      state.report.firstLaunchablePosition ??= state.position;
      state.launchable++;
    }
  }
  return [...lanes.values()].map(state => state.report);
}
