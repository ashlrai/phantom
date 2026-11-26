/** Shared by the server reader and the Verse UI. */
export const LANE_YIELD_SCHEMA = 'fleet.lane-yield.v1';
/** A lane with no merge and at least this many launches is "not paying off". */
export const NOT_PAYING_OFF_LAUNCHES = 3;

export interface LaneYieldRow {
  lane: string;
  launches: number;
  finished: number;
  prs_opened: number;
  merged: number;
  /** Empty finishes over finished runs; null when nothing finished (unknown, not zero). */
  empty_rate: number | null;
  merged_per_launch: number;
  /** Median minutes from launch to the newest recorded row of merged runs; null when nothing merged. */
  median_minutes_to_merge: number | null;
  not_paying_off: boolean;
  /** One plain sentence for phones and agents. */
  sentence: string;
}

export interface LaneYieldReport {
  schema: typeof LANE_YIELD_SCHEMA;
  version: 1;
  window_hours: number;
  /** False when the ledger could not be read. */
  known: boolean;
  launches: number | null;
  merged: number | null;
  /** First line of every human surface. */
  summary: string;
  /** Best merged-per-launch first. */
  lanes: LaneYieldRow[];
}
