import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GoalsView {
  schema: 'fleet.goals.v1';
  available: boolean;
  observedAt: string | null;
  lanes: { lane: string; mergesPerHour: number | null; medianOpenToMergeSeconds: number | null; emptyRate: number | null }[];
  pools: { pool: string; usedPercent: number | null; resetAt: string | null }[];
}
const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const number = (x: unknown, max = Infinity): number | null => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= max ? x : null;
const stamp = (x: unknown): string | null => typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null;

/** Project only dispatcher measurements. The 24-hour cohort is jobs launched in that period. */
export function projectGoals(input: unknown): GoalsView {
  const status = record(input);
  const rollup = record(record(status.rollup_24h).by_lane);
  const lanes = Object.entries(rollup).sort(([a], [b]) => a.localeCompare(b)).map(([lane, raw]) => {
    const row = record(raw); const merged = number(row.merged);
    return { lane, mergesPerHour: merged === null ? null : merged / 24, medianOpenToMergeSeconds: number(row.median_ttm_s), emptyRate: number(row.empty_rate, 1) };
  });
  const pools = Object.entries(record(status.budget)).sort(([a], [b]) => a.localeCompare(b)).map(([pool, raw]) => {
    const row = record(raw);
    return { pool, usedPercent: number(row.weekly_used_pct, 100), resetAt: stamp(row.reset_at) };
  });
  return { schema: 'fleet.goals.v1', available: input !== null && typeof input === 'object' && !Array.isArray(input), observedAt: stamp(status.last_tick), lanes, pools };
}
export async function readGoals(runsDir = join(homedir(), '.ashlr-runs')): Promise<GoalsView> {
  try { return projectGoals(JSON.parse(await readFile(join(runsDir, 'queue', 'status.json'), 'utf8'))); }
  catch { return projectGoals(null); }
}
