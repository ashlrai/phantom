/**
 * Lane yield verdict: did a lane's recent finished jobs produce anything?
 * Pure. A lane that ends almost every job empty has spare capacity but no
 * output, so remaps and free-capacity picks skip it unless the job names it.
 *
 *   unknown    fewer than 10 finished jobs in the window (never skipped)
 *   low-yield  20 or more finished jobs and empty_rate >= 0.8
 *   productive everything else
 */
import { hasRevertEvidence } from './slot-yield.js';

export const VERDICT_UNKNOWN_BELOW = 10;
export const VERDICT_LOW_MIN_JOBS = 20;
export const VERDICT_LOW_EMPTY_RATE = 0.8;

export type LaneVerdict = 'productive' | 'low-yield' | 'unknown';

/** One finished job. `at` is epoch ms, or null when the ledger had no usable time. */
export interface LaneJob { job: string; lane: string; at: number | null; empty: boolean; merged: boolean }

export interface LaneYieldStats {
  jobs: number;
  empty: number;
  merged: number;
  empty_rate: number | null;
  merged_per_job: number | null;
  verdict: LaneVerdict;
}

export interface YieldWindow { since: number; until?: number }

const round = (n: number): number => Math.round(n * 1000) / 1000;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Count one lane's finished jobs in the window. Rows that are not objects or lack a lane are
 * skipped, never fatal. With a window, a row without a usable time is outside it.
 */
export function laneYield(jobs: readonly unknown[], lane: string, window?: YieldWindow): LaneYieldStats {
  let n = 0, empty = 0, merged = 0;
  for (const row of jobs) {
    if (!isObject(row) || row.lane !== lane) continue;
    const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : null;
    if (window && (at === null || at < window.since || (window.until !== undefined && at > window.until))) continue;
    n++;
    if (row.merged === true) merged++;
    else if (row.empty === true) empty++;
  }
  const known = n >= VERDICT_UNKNOWN_BELOW;
  const rate = n ? empty / n : null;
  const verdict: LaneVerdict = !known ? 'unknown'
    : n >= VERDICT_LOW_MIN_JOBS && rate !== null && rate >= VERDICT_LOW_EMPTY_RATE ? 'low-yield' : 'productive';
  return { jobs: n, empty, merged, empty_rate: n ? round(empty / n) : null, merged_per_job: n ? round(merged / n) : null, verdict };
}

/** Fold the jobs ledger into one record per finished job, on the lane of its latest launch. Bad lines are skipped. */
export function parseLaneJobs(ledger: string): LaneJob[] {
  type Launch = { lane: string; at: number };
  const launches = new Map<string, Launch>();
  const done = new Map<string, { at: number | null; empty: boolean; merged: boolean }>();
  const reverted = new Set<string>();
  const time = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
  for (const line of ledger.split('\n')) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row) || typeof row.job !== 'string' || !row.job.trim()) continue;
    const id = row.job.trim();
    const at = time(row.ts);
    if (row.event === 'launch') {
      const lane = typeof row.lane === 'string' ? row.lane.trim() : '';
      const prev = launches.get(id);
      if (lane && (!prev || (at ?? 0) >= prev.at)) launches.set(id, { lane, at: at ?? 0 });
      continue;
    }
    if (hasRevertEvidence(row)) reverted.add(id);
    const merged = row.event === 'outcome' && (row.state === 'MERGED' || row.outcome === 'MERGED');
    const finished = row.event === 'finish';
    if (!merged && !finished) continue;
    const prev = done.get(id) ?? { at: null, empty: false, merged: false };
    done.set(id, { at: Math.max(prev.at ?? 0, at ?? 0) || null, empty: prev.empty || (finished && row.empty === true), merged: prev.merged || merged });
  }
  const out: LaneJob[] = [];
  for (const [job, d] of done) {
    const launch = launches.get(job);
    if (!launch) continue;
    const merged = d.merged && !reverted.has(job);
    out.push({ job, lane: launch.lane, at: d.at ?? (launch.at || null), merged, empty: d.empty && !merged });
  }
  return out;
}

/** Plain-words reason a low-yield lane is skipped, e.g. "skipped zai: 92 of 99 recent jobs ended empty". */
export function lowYieldReason(lane: string, stats: Pick<LaneYieldStats, 'jobs' | 'empty'>): string {
  return `skipped ${lane}: ${stats.empty} of ${stats.jobs} recent jobs ended empty`;
}

/** Stats for every lane in `lanes` plus any lane seen in the jobs. */
export function laneYieldAll(jobs: readonly LaneJob[], lanes: readonly string[], window?: YieldWindow): Array<{ lane: string } & LaneYieldStats> {
  const names = [...new Set([...lanes, ...jobs.map(j => j.lane)])].sort();
  return names.map(lane => ({ lane, ...laneYield(jobs, lane, window) }));
}
