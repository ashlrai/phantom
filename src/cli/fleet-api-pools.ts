import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = 'Usage: ashlr fleet api-pools [--json] [--cost-per-job USD] [--jobs-per-slot-hour N] [--ceiling N]\nRead API pool pacing from queue status. Missing cost or ceiling means an unknown slot target.';
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export interface ApiPoolOptions { costPerJob?: number; jobsPerSlotHour?: number; ceiling?: number }
export interface ApiPoolReader { (path: string): Promise<string> }

interface ArrayPoolRow {
  remaining: number | null; need_usd_per_hour: number | null;
  hours_left: number | null; projected_end_pct: number | null;
}

interface ObjectPoolRow {
  name: string; spent: number | null; balance: number | null;
  hours_left: number | null; need_usd_per_hour: number | null;
  remaining: number | null; projected_end_pct: number | null;
  est_job_usd: number | null; idle?: boolean;
}

export type ApiPool = ArrayPoolRow | ObjectPoolRow;
type Report = ReturnType<typeof apiPools>;

export function apiPools(status: unknown, options: ApiPoolOptions = {}) {
  const budget = row(row(row(status).budget)['claude-api']);
  const raw = budget?.pools;

  // Handle array (original behavior)
  if (Array.isArray(raw)) {
    const pools = raw.map(row).filter(pool => pool.open === true || pool.status === 'open').map(pool => ({
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

  // Handle object keyed by pool name (gift, monthly, etc.)
  // In object format all pools are shown; idle check covers quiet ones.
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const pools: ObjectPoolRow[] = Object.entries(raw as Record<string, unknown>)
      .map(([name, pool]) => [name, row(pool)] as [string, Row])
      .map(([name, p]) => {
        const entry: ObjectPoolRow = {
          name,
          spent: number(p.spent),
          balance: number(p.balance),
          hours_left: number(p.hours_left),
          need_usd_per_hour: number(p.need_usd_per_hour),
          remaining: number(p.remaining),
          projected_end_pct: number(p.projected_end_pct),
          est_job_usd: number(p.est_job_usd ?? budget.estimated_cost_per_job ?? options.costPerJob),
        };
        // Mark idle when spent is 0 (null defaults to 0) and hours_left under 720
        const spent = entry.spent ?? 0;
        const hoursLeft = entry.hours_left ?? Number.POSITIVE_INFINITY;
        if (spent === 0 && hoursLeft < 720) {
          entry.idle = true;
        }
        return entry;
      });
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

  throw new Error('API pool observations unavailable');
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
    const rawJson = await reader(join(homedir(), '.ashlr-runs', 'queue', 'status.json'));
    const parsed = JSON.parse(rawJson);
    const budget = row(row(row(parsed.budget)['claude-api']));
    const rawPools = budget?.pools;
    const isObject = typeof rawPools === 'object' && rawPools !== null && !Array.isArray(rawPools);
    const report = apiPools(parsed, options);

    // Object-keyed pools: print name, spent, balance per pool
    const poolLines = isObject
      ? report.pools.map((pool: ApiPool) => {
          const op = pool as ObjectPoolRow;
          const idleMark = (op.spent === 0 && op.hours_left !== null && op.hours_left < 720) ? ' (IDLE)' : '';
          const costLine = op.est_job_usd !== null ? ` est $${op.est_job_usd}/job` : '';
          return `Pool "${op.name}": spent $${op.spent ?? 'unknown'}, balance $${op.balance ?? 'unknown'}, hours left ${op.hours_left ?? 'unknown'}, projected end ${op.projected_end_pct ?? 'unknown'}%${costLine}${idleMark}`;
        })
      : report.pools.map((pool, i) =>
          `Pool ${i + 1}: remaining $${pool.remaining ?? 'unknown'}, need $${pool.need_usd_per_hour ?? 'unknown'}/hour, hours left ${pool.hours_left ?? 'unknown'}, projected end ${pool.projected_end_pct ?? 'unknown'}%`
        );
    console.log(args.includes('--json') ? JSON.stringify(report) : [
      ...poolLines,
      `Total need: $${report.need_usd_per_hour ?? 'unknown'}/hour; slot target: ${report.slot_target ?? 'unknown'} (ceiling ${report.ceiling ?? 'unknown'})`,
    ].join('\n'));
    return 0;
  } catch { console.error('error: unable to read API pool observations'); return 1; }
}
