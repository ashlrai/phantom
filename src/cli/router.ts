import { readFile, stat } from 'node:fs/promises';
import { cmdRouterCatalog, ROUTER_CATALOG_USAGE } from './router-catalog.js';
import { readPoolBudgets } from '../core/fleet/pool-budget-store.js';
import { BUDGET_POOLS, type BudgetPool } from '../core/fleet/pool-budget.js';
import { LANE_BACKENDS, rankLanes, selfHeldSkips, type LaneEvalScores, type LaneResourceSnapshot, type LaneSlots } from '../core/fleet/lane-rank.js';
import { readDispatchEventsLog } from '../core/fleet/dispatch-events-read.js';
import { computeLanesHeld } from '../core/fleet/lane-held.js';
import { readLaneScores } from '../core/eval/passk.js';
import type { EngineTier } from '../core/types.js';
import { cmdRouterGateway, ROUTER_GATEWAY_USAGE, ROUTER_GATEWAY_VERBS } from './router-gateway.js';
import { cmdRouterOutcomes, ROUTER_OUTCOMES_USAGE } from './router-outcomes.js';
import { cmdRouterTune, ROUTER_TUNE_USAGE } from './router-tune.js';

const USAGE = 'Usage: ashlr router rank --tier local|mid|frontier [--routes FILE] [--slots pool=count ...] [--json]\n' +
  'Slots are currently free slots supplied by the dispatcher; omitted pools are unknown.\n' +
  'FILE maps pools to routeBackend decisions. Omitted routes are unknown. Reads budgets; prioritizes lanes without imminent forecast exhaustion. Never reserves or dispatches.';

export async function cmdRouter(args: string[]): Promise<number> {
  if (args[0] === 'catalog') return cmdRouterCatalog(args.slice(1));
  if (args[0] === 'tune') return cmdRouterTune(args.slice(1));
  if (args[0] === 'outcomes') return cmdRouterOutcomes(args.slice(1));
  if ((ROUTER_GATEWAY_VERBS as readonly string[]).includes(args[0] ?? '')) return cmdRouterGateway(args);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!) || ['rank --help', 'rank -h'].includes(args.join(' '))) {
    console.log(`${USAGE}\n\n${ROUTER_GATEWAY_USAGE}\n\n${ROUTER_CATALOG_USAGE}\n\n${ROUTER_OUTCOMES_USAGE}\n\n${ROUTER_TUNE_USAGE}`); return 0;
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
    // Advisory pass^k evidence from the nightly eval: lane-scores rows land
    // on pools by name; absent/degraded state leaves evalScore null.
    const evalScores: LaneEvalScores = {};
    const { scores } = readLaneScores();
    if (scores) {
      for (const row of scores.lanes) {
        if ((BUDGET_POOLS as readonly string[]).includes(row.lane)) {
          evalScores[row.lane as BudgetPool] = { pass1: row.pass1, passPowK: row.passPowK, trials: row.trials };
        }
      }
    }
    // A lane whose own wrapper holds every launch is skipped until a launch there finishes or 60 min pass.
    const selfHeld: Record<string, string> = {};
    for (const row of computeLanesHeld(await readDispatchEventsLog().catch(() => null), Date.now()).lanes) {
      if (row.reason) selfHeld[row.lane] = row.reason;
    }
    const lanes = rankLanes(tier, { budgets, routes, evalScores, selfHeld }, slots);
    const skipped = selfHeldSkips(selfHeld);
    console.log(json ? JSON.stringify({ schema: 'fleet.lane-rank.v1', tier, lanes, skipped }) :
      [...skipped.map(s => `skipped ${s.pool}: ${s.reason}`), ...lanes.map(l => `${l.pool}\t${l.availableSlots}\t${l.resetAt ?? 'unknown reset'}${l.evalScore ? `\tpass^k ${l.evalScore.passPowK === null ? 'n/a' : l.evalScore.passPowK.toFixed(3)} (${l.evalScore.trials} trials)` : ''}`)].join('\n') || 'No eligible lanes.');
    return 0;
  } catch { console.error('Router rank unavailable.'); return 1; }
}
