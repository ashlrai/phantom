import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet api-pools [--json] [--cost-per-job USD] [--jobs-per-slot-hour N] [--ceiling N]\nRead API pool pacing from queue status. Missing cost or ceiling means an unknown slot target.';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export interface ApiPoolOptions { costPerJob?: number; jobsPerSlotHour?: number; ceiling?: number }
export interface ApiPoolReader { (path: string): Promise<string> }

/** Project only pacing fields; never echo the raw status document. */
export function apiPools(status: unknown, options: ApiPoolOptions = {}) {
  const budget = row(row(row(status).budget)['claude-api']);
  if (!Array.isArray(budget.pools)) throw new Error('API pool observations unavailable');
  const pools = budget.pools.map(row).filter(pool => pool.open === true || pool.status === 'open').map(pool => ({
    remaining: number(pool.remaining), need_usd_per_hour: number(pool.need_usd_per_hour),
    hours_left: number(pool.hours_left), projected_end_pct: number(pool.projected_end_pct),
  }));
  const need = pools.every(pool => pool.need_usd_per_hour !== null)
    ? pools.reduce((sum, pool) => sum + pool.need_usd_per_hour!, 0) : null;
  const cost = number(options.costPerJob ?? budget.estimated_cost_per_job);
  const jobs = number(options.jobsPerSlotHour ?? budget.jobs_per_slot_hour ?? 4);
  const ceiling = number(options.ceiling ?? budget.ceiling);
  const valid = cost !== null && cost > 0 && jobs !== null && jobs > 0 && ceiling !== null && Number.isInteger(ceiling);
  return { schema: 'fleet.api-pools.v1', readOnly: true, pools, need_usd_per_hour: need,
    estimated_cost_per_job: cost, jobs_per_slot_hour: jobs, ceiling,
    slot_target: need === 0 ? 0 : need !== null && valid ? Math.min(ceiling, Math.ceil(need / (cost * jobs))) : null };
}

export async function cmdFleetApiPools(args: string[], reader: ApiPoolReader = path => readFile(path, 'utf8')): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const options: ApiPoolOptions = {};
  const flags = new Map<string, keyof ApiPoolOptions>([['--cost-per-job', 'costPerJob'], ['--jobs-per-slot-hour', 'jobsPerSlotHour'], ['--ceiling', 'ceiling']]);
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { console.error(usage); return 2; }
    seen.add(flag);
    if (flag === '--json') continue;
    const key = flags.get(flag), value = args[++i];
    const parsed = value?.trim() ? Number(value) : NaN;
    if (!key || !Number.isFinite(parsed) || parsed < 0 || (key !== 'ceiling' && parsed === 0) || (key === 'ceiling' && !Number.isInteger(parsed))) {
      console.error(usage); return 2;
    }
    options[key] = parsed;
  }
  try {
    const report = apiPools(JSON.parse(await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json'))), options);
    console.log(args.includes('--json') ? JSON.stringify(report) : [
      ...report.pools.map((pool, i) => `Pool ${i + 1}: remaining $${pool.remaining ?? 'unknown'}, need $${pool.need_usd_per_hour ?? 'unknown'}/hour, hours left ${pool.hours_left ?? 'unknown'}, projected end ${pool.projected_end_pct ?? 'unknown'}%`),
      `Total need: $${report.need_usd_per_hour ?? 'unknown'}/hour; slot target: ${report.slot_target ?? 'unknown'} (ceiling ${report.ceiling ?? 'unknown'})`,
    ].join('\n'));
    return 0;
  } catch { console.error('error: unable to read API pool observations'); return 1; }
}
