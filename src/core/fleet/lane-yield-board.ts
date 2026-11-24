/**
 * Lane yield board: merged PRs per launch for every lane, the one number that decides where each pool's usage goes.
 *
 * Parsing is `yieldTally` in slot-yield.ts (the counting model behind `phm jobs yield`), so a job whose merge is
 * recorded twice is credited once. This file only groups its runs by lane and words the result. The CLI
 * (`phm fleet yield --by lane`), `GET /api/fleet/lane-yield` and the Home Yield card all read this report; nothing
 * recomputes it. Unknown stays unknown: a lane with no launches is omitted, an unreadable file is `known: false`.
 */
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { yieldTally, type YieldRun } from './slot-yield.js';

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const rate = (n: number) => n.toFixed(2);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const windowWords = (hours: number) => `${Number.isInteger(hours) ? hours : hours.toFixed(1)} h`;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sentence(row: Omit<LaneYieldRow, 'sentence'>): string {
  const parts = [`${row.lane}: ${plural(row.merged, 'merged PR')} from ${plural(row.launches, 'launch', 'launches')} (${rate(row.merged_per_launch)} per launch)`];
  if (row.empty_rate !== null) parts.push(`${pct(row.empty_rate)} empty`);
  if (row.not_paying_off) parts.push('not paying off');
  return parts.join(', ');
}

export function laneYieldFromRuns(runs: readonly YieldRun[], hours: number): LaneYieldReport {
  const byLane = new Map<string, YieldRun[]>();
  for (const run of runs) byLane.set(run.lane, [...(byLane.get(run.lane) ?? []), run]);
  const lanes = [...byLane].map(([lane, members]): LaneYieldRow => {
    const finished = members.filter(r => r.finished);
    const merged = members.filter(r => r.merged);
    const row = {
      lane, launches: members.length, finished: finished.length,
      prs_opened: members.reduce((sum, r) => sum + r.prs.size, 0), merged: merged.length,
      empty_rate: finished.length ? finished.filter(r => r.empty).length / finished.length : null,
      merged_per_launch: merged.length / members.length,
      median_minutes_to_merge: median(merged.map(r => Math.max(0, r.last - r.at) / 60_000)),
      not_paying_off: merged.length === 0 && members.length >= NOT_PAYING_OFF_LAUNCHES,
    };
    return { ...row, sentence: sentence(row) };
  }).sort((a, b) => b.merged_per_launch - a.merged_per_launch || b.merged - a.merged || b.launches - a.launches || a.lane.localeCompare(b.lane));
  const merged = lanes.reduce((sum, l) => sum + l.merged, 0);
  return { schema: LANE_YIELD_SCHEMA, version: 1, window_hours: hours, known: true, launches: runs.length, merged, summary: laneYieldSummary(lanes, merged, hours), lanes };
}

export function laneYieldSummary(lanes: readonly LaneYieldRow[], merged: number, hours: number): string {
  if (!lanes.length) return `No jobs in this window (last ${windowWords(hours)}).`;
  const best = lanes[0]!, weak = lanes[lanes.length - 1]!;
  const head = `Last ${windowWords(hours)}: ${plural(merged, 'merged PR')}.`;
  if (lanes.length === 1) return `${head} One lane: ${best.lane} (${rate(best.merged_per_launch)} merged per launch).`;
  return `${head} Best lane: ${best.lane} (${rate(best.merged_per_launch)} merged per launch). Weakest: ${weak.lane} (${rate(weak.merged_per_launch)}).`;
}

export function unknownLaneYield(hours: number): LaneYieldReport {
  return { schema: LANE_YIELD_SCHEMA, version: 1, window_hours: hours, known: false, launches: null, merged: null,
    summary: 'Lane yield: unknown (job metrics file unreadable).', lanes: [] };
}

/** Stream a metrics file through the shared tally; an unreadable file is unknown, never zero. */
export async function readLaneYield(path: string, hours: number, now: number, read: YieldLineReader = readLedgerLines): Promise<LaneYieldReport> {
  const tally = yieldTally(now, hours);
  if (!await read(path, line => tally.add(line))) return unknownLaneYield(hours);
  return laneYieldFromRuns(tally.runs(), hours);
}

export function laneYieldLines(report: LaneYieldReport): string[] {
  if (!report.known || !report.lanes.length) return [report.summary];
  return [report.summary, ...report.lanes.map(l => `  ${l.sentence}; ${plural(l.prs_opened, 'PR')} opened, ${l.finished} finished, ${l.median_minutes_to_merge === null ? 'time to merge unknown' : `median ${Math.round(l.median_minutes_to_merge)} min to merge`}`)];
}
