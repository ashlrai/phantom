import { readFile, stat } from 'node:fs/promises';
import { readPoolBudgets } from '../core/fleet/pool-budget-store.js';
import { BUDGET_POOLS, type BudgetPool } from '../core/fleet/pool-budget.js';
import { LANE_BACKENDS, rankLanes, type LaneResourceSnapshot, type LaneSlots } from '../core/fleet/lane-rank.js';
import type { EngineTier } from '../core/types.js';

const USAGE = 'Usage: ashlr router rank --tier local|mid|frontier [--routes FILE] [--slots pool=count ...] [--json]\n' +
  'Slots are currently free slots supplied by the dispatcher; omitted pools are unknown.\n' +
  'FILE maps pools to routeBackend decisions. Omitted routes are unknown. Reads budgets; never reserves or dispatches.';

export async function cmdRouter(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!) || args.join(' ') === 'rank --help') {
    console.log(USAGE); return 0;
  }
  let tier: EngineTier | undefined; let json = false; let routesFile: string | undefined;
  const slots: LaneSlots = {};
  try {
    if (args[0] !== 'rank') throw new Error();
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--tier' && !tier && ['local', 'mid', 'frontier'].includes(args[i + 1] ?? '')) tier = args[++i] as EngineTier;
      else if (arg === '--json' && !json) json = true;
      else if (arg === '--routes' && !routesFile && args[i + 1] && !args[i + 1]!.startsWith('--')) routesFile = args[++i];
      else if (arg === '--slots') {
        const match = /^([a-z-]+)=(0|[1-9]\d*)$/.exec(args[++i] ?? '');
        const pool = match?.[1] as BudgetPool;
        const count = Number(match?.[2]);
        if (!BUDGET_POOLS.includes(pool) || slots[pool] !== undefined || !Number.isSafeInteger(count)) throw new Error();
        slots[pool] = count;
      } else throw new Error();
    }
    if (!tier) throw new Error();
  } catch { console.error(USAGE); return 2; }
  try {
    const routes: LaneResourceSnapshot['routes'] = {};
    // routeBackend's subscription probes publish usage; consume its decisions rather than rerun it.
    if (routesFile) {
      const info = await stat(routesFile);
      if (!info.isFile() || info.size > 65_536) throw new Error();
      const text = await readFile(routesFile, 'utf8');
      if (Buffer.byteLength(text) > 65_536) throw new Error();
      const value = JSON.parse(text) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      for (const pool of BUDGET_POOLS) {
        const backend = LANE_BACKENDS[pool]; const row = value[pool] as { backend?: unknown; tier?: unknown } | undefined;
        if (backend !== null && row?.backend === backend && row.tier === tier) {
          routes[pool] = { backend, tier, reason: 'supplied route decision' };
        }
      }
    }
    const budgets = await readPoolBudgets();
    const lanes = rankLanes(tier, { budgets, routes }, slots);
    console.log(json ? JSON.stringify({ schema: 'fleet.lane-rank.v1', tier, lanes }) :
      lanes.map(l => `${l.pool}\t${l.availableSlots}\t${l.resetAt ?? 'unknown reset'}`).join('\n') || 'No eligible lanes.');
    return 0;
  } catch { console.error('Router rank unavailable.'); return 1; }
}
