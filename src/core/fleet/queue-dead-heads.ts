/** Offline queue advisory. Absence of a skip marker is not dispatch authority. */
import { parseReadyTsv } from './lane-console.js';
import { ledgerEventName, ledgerJobId } from './empty-cause.js';
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

export interface DeadHeadSkipVerdict {
  /** True when the newest skip verdict for the job was applied; false marks a dry run that still launched. */
  dead: boolean;
  /** The recorded skip reason; null when the row carried none. */
  reason: string | null;
}

/**
 * jobs.jsonl `skipped_empty` rows are the live dispatcher's empty-gate evidence:
 * the gate re-emits one row per skipped job per tick, so the last row per job in
 * the append-ordered ledger is its current verdict. A row carrying a numeric
 * `code` is a precheck decline instead — that job is DONE-NOOP'd and leaves the
 * queue, never a dead READY head (the same split isPrecheckSkipRow documents).
 * `applied:false` is the gate's dry run: the job still launched, so the verdict
 * is not dead and it vetoes older marker-file evidence. The caller's bounded
 * tail read is the evidence window; a job whose skips aged out simply has no
 * verdict here.
 */
export function ledgerDeadHeadSkips(ledger: string | null): Map<string, DeadHeadSkipVerdict> {
  const verdicts = new Map<string, DeadHeadSkipVerdict>();
  if (ledger === null) return verdicts;
  for (const line of ledger.split('\n')) {
    if (!line.includes('skipped_empty')) continue;
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    if (ledgerEventName(row) !== 'skipped_empty') continue;
    if (typeof row['code'] === 'number' && Number.isFinite(row['code'])) continue;
    const job = ledgerJobId(row);
    if (!job) continue;
    const reason = typeof row['reason'] === 'string' && row['reason'].trim() ? row['reason'].trim() : null;
    verdicts.set(job, { dead: row['applied'] !== false, reason });
  }
  return verdicts;
}
