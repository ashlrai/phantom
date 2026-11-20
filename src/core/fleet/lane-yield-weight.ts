/**
 * Lane yield weight: how often a lane's recent launches ended as a merged PR.
 * Pure; the caller reads `metrics/jobs.jsonl` and passes its text.
 *
 * Per lane and size (a launch row's `size`, else "unknown"), plus a per-lane
 * "all" row, the window is the lane's last 50 launches. A job's merge and empty
 * finish count once, on its latest launch. Fewer than 10 launches in the window
 * is unknown, and unknown gets the neutral weight 1.
 *
 * weight = yield / 0.5, clamped to 0.1..2, so a yield of 0.5 is exactly neutral.
 */
export const LANE_YIELD_SCHEMA = 'lanes.yield.v1';
export const YIELD_WINDOW_JOBS = 50;
export const YIELD_MIN_JOBS = 10;
/** A known yield at or above this counts as high; below it is low. */
export const YIELD_HIGH = 0.5;
export const NEUTRAL_WEIGHT = 1;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 2;

export interface LaneYieldRow {
  lane: string;
  /** Launch size ("sm", "md", ...), "unknown" when the launch row has none, or "all". */
  size: string;
  launches: number;
  merged: number;
  empty: number;
  /** merged / launches; null below the minimum. */
  yield: number | null;
  /** empty / launches; null below the minimum. */
  emptyRate: number | null;
  /** The number the router uses. */
  weight: number;
  known: boolean;
}

export interface LaneYieldReport {
  schema: typeof LANE_YIELD_SCHEMA;
  /** false when the ledger could not be read; rows is then empty. */
  known: boolean;
  windowJobs: number;
  minJobs: number;
  highYield: number;
  rows: LaneYieldRow[];
}

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export function yieldWeight(yieldRate: number | null): number {
  if (yieldRate === null) return NEUTRAL_WEIGHT;
  return Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, yieldRate / YIELD_HIGH)) * 100) / 100;
}

export function computeLaneYield(ledger: string | null): LaneYieldReport {
  const report: LaneYieldReport = { schema: LANE_YIELD_SCHEMA, known: ledger !== null, windowJobs: YIELD_WINDOW_JOBS, minJobs: YIELD_MIN_JOBS, highYield: YIELD_HIGH, rows: [] };
  if (ledger === null) return report;
  type Launch = { lane: string; size: string; at: number; seq: number; merged: boolean; empty: boolean };
  const launches: Launch[] = [];
  const byJob = new Map<string, Launch[]>();
  const merged = new Set<string>();
  const empty = new Set<string>();
  let seq = 0;
  for (const line of ledger.split('\n')) {
    let row: Row;
    try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) continue; row = value as Row; } catch { continue; }
    const id = text(row.job);
    if (!id) continue;
    if (row.event === 'launch') {
      const lane = text(row.lane);
      if (!lane) continue;
      const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
      const launch: Launch = { lane, size: text(row.size) ?? 'unknown', at: Number.isFinite(at) ? at : 0, seq: seq++, merged: false, empty: false };
      launches.push(launch);
      byJob.set(id, [...(byJob.get(id) ?? []), launch]);
    } else if (row.event === 'outcome' && (row.state === 'MERGED' || row.outcome === 'MERGED')) merged.add(id);
    else if (row.event === 'finish' && row.empty === true) empty.add(id);
  }
  for (const [id, runs] of byJob) {
    const last = runs.reduce((a, b) => (b.at > a.at || (b.at === a.at && b.seq > a.seq) ? b : a));
    if (merged.has(id)) last.merged = true;
    else if (empty.has(id)) last.empty = true;
  }
  launches.sort((a, b) => b.at - a.at || b.seq - a.seq);
  const groups = new Map<string, Launch[]>();
  const add = (lane: string, size: string, launch: Launch): void => {
    const key = JSON.stringify([lane, size]);
    const list = groups.get(key) ?? [];
    if (list.length < YIELD_WINDOW_JOBS) { list.push(launch); groups.set(key, list); }
  };
  for (const launch of launches) { add(launch.lane, launch.size, launch); add(launch.lane, 'all', launch); }
  for (const [key, list] of groups) {
    const [lane, size] = JSON.parse(key) as [string, string];
    const wins = list.filter(l => l.merged).length;
    const empties = list.filter(l => l.empty).length;
    const known = list.length >= YIELD_MIN_JOBS;
    const yieldRate = known ? wins / list.length : null;
    report.rows.push({ lane, size, launches: list.length, merged: wins, empty: empties, yield: yieldRate,
      emptyRate: known ? empties / list.length : null, weight: yieldWeight(yieldRate), known });
  }
  report.rows.sort((a, b) => a.lane.localeCompare(b.lane) || (a.size === 'all' ? -1 : b.size === 'all' ? 1 : a.size.localeCompare(b.size)));
  return report;
}

/** The row the router reads for a lane and size; absent means unknown and neutral. */
export function laneYieldFor(rows: readonly LaneYieldRow[] | undefined, lane: string, size: string): LaneYieldRow | null {
  return rows?.find(r => r.lane === lane && r.size === size) ?? null;
}
