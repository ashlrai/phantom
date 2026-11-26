/**
 * skill-outcomes.ts — read-only join of the learned-skill corpus to
 * trajectory outcome attribution.
 *
 * `summarizeTrajectoryLearning` already folds shadow skill selections into
 * per-(skill, revision) terminal/realized tallies, published only after the
 * trajectory sample gate passes. This module is the thin read path
 * `phm skills list --outcomes` uses: it withholds everything when the
 * skill-use ledger is degraded (the same suppression fleet status applies)
 * and otherwise returns the published per-skill rows. Unknown stays absent —
 * a null return means "not measured", never zero-filled counts.
 */
import {
  listTrajectoryRecords,
  summarizeTrajectoryLearning,
  trajectoryWindowMaxFiles,
  type TrajectoryRecord,
  type TrajectoryRecordListOptions,
  type TrajectorySkillOutcomeSummary,
} from '../autonomy/trajectory-records.js';
import {
  readSkillUseEventsWithDiagnostics,
  type ReadSkillRecordsOptions,
  type SkillUseEventReadResult,
} from './skill-records.js';

/** Same defaults the trajectory join applies when callers pass no window/limit. */
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_LIMIT = 200;

export interface SkillTrajectoryOutcomeOptions {
  windowHours?: number;
  limit?: number;
}

export interface SkillTrajectoryOutcomeDeps {
  readSkillUseEvents?: (opts?: ReadSkillRecordsOptions) => SkillUseEventReadResult;
  listRecords?: (opts?: TrajectoryRecordListOptions) => TrajectoryRecord[];
  summarize?: typeof summarizeTrajectoryLearning;
}

/**
 * Per-skill trajectory outcome tallies for the learned-skill list, or null
 * when the evidence is not publishable: the skill-use ledger degraded, or
 * the trajectory sample gate has not passed. Read-only; never throws.
 */
export function readSkillTrajectoryOutcomes(
  opts: SkillTrajectoryOutcomeOptions = {},
  deps: SkillTrajectoryOutcomeDeps = {},
): TrajectorySkillOutcomeSummary | null {
  try {
    const windowHours = opts.windowHours && opts.windowHours > 0 ? opts.windowHours : DEFAULT_WINDOW_HOURS;
    const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LIMIT;
    const untilMs = Date.now();
    const sinceMs = untilMs - windowHours * 60 * 60 * 1000;
    const readEvents = deps.readSkillUseEvents ?? readSkillUseEventsWithDiagnostics;
    // Mirror the windowed read trajectory-records performs so the health gate
    // and the join see the same skill-use snapshot.
    const skillRead = readEvents({
      sinceMs,
      untilMs,
      limit: Math.max(limit * 8, 400),
      maxFiles: trajectoryWindowMaxFiles(windowHours),
    });
    if (skillRead.eventState === 'degraded') return null;
    const listRecords = deps.listRecords ?? listTrajectoryRecords;
    const records = listRecords({
      windowHours,
      limit,
      deps: { readSkillUseEvents: () => skillRead.events },
    });
    const summarize = deps.summarize ?? summarizeTrajectoryLearning;
    return summarize(records, windowHours).skillOutcomes ?? null;
  } catch {
    return null;
  }
}
