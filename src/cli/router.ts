/** `ashlr router` — lane ranking (`rank`) and coding-pool regret backlog (`regret`).
 * `regret` writes a local JSON backlog only; it never opens GitHub issues. */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readPoolBudgets } from '../core/fleet/pool-budget-store.js';
import { BUDGET_POOLS, type BudgetPool } from '../core/fleet/pool-budget.js';
import { LANE_BACKENDS, rankLanes, type LaneEvalScores, type LaneResourceSnapshot, type LaneSlots } from '../core/fleet/lane-rank.js';
import { readLaneScores } from '../core/eval/passk.js';
import type { EngineTier } from '../core/types.js';
import { loadSchedulerConfig } from '../core/providers/coding-cli/scheduler/defaults.js';
import { emptyBandit, updateBandit } from '../core/providers/coding-cli/scheduler/learn.js';
import { computeRegret, readOutcomes, regretBacklog, writeRegretBacklog } from '../core/providers/coding-cli/scheduler/regret.js';
import type { BanditState } from '../core/providers/coding-cli/scheduler/types.js';

const USAGE = 'Usage: ashlr router rank --tier local|mid|frontier [--routes FILE] [--slots pool=count ...] [--json]\n' +
  'Slots are currently free slots supplied by the dispatcher; omitted pools are unknown.\n' +
  'FILE maps pools to routeBackend decisions. Omitted routes are unknown. Reads budgets; prioritizes lanes without imminent forecast exhaustion. Never reserves or dispatches.';

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
    const lanes = rankLanes(tier, { budgets, routes, evalScores }, slots);
    console.log(json ? JSON.stringify({ schema: 'fleet.lane-rank.v1', tier, lanes }) :
      lanes.map(l => `${l.pool}\t${l.availableSlots}\t${l.resetAt ?? 'unknown reset'}${l.evalScore ? `\tpass^k ${l.evalScore.passPowK === null ? 'n/a' : l.evalScore.passPowK.toFixed(3)} (${l.evalScore.trials} trials)` : ''}`).join('\n') || 'No eligible lanes.');
    return 0;
  } catch { console.error('Router rank unavailable.'); return 1; }
}

const REGRET_USAGE = [
  'usage:',
  '  phm router regret [--ledger <outcomes.jsonl>] [--bandit <state.json>] [--backlog <out.json>] [--json]',
  '  Posting to GitHub is off. --post and --post-issues do not create issues or comments.',
];

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

function routerDir(): string {
  const home = process.env['ASHLR_HOME'] ?? join(homedir(), '.ashlr');
  return join(home, 'router');
}

function readBandit(path: string | undefined): BanditState {
  if (!path) return emptyBandit();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return emptyBandit();
    const row = raw as { id?: unknown; arms?: unknown };
    if (typeof row.arms !== 'object' || row.arms === null) return emptyBandit();
    return { id: typeof row.id === 'string' ? row.id : 'incumbent', arms: row.arms as BanditState['arms'] };
  } catch {
    return emptyBandit();
  }
}

export async function runRouterCli(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === 'help' || args.includes('--help') || args.includes('-h') || sub === undefined) {
    for (const line of REGRET_USAGE) console.log(line);
    return sub === undefined ? 1 : 0;
  }
  if (sub !== 'regret') {
    console.error(`unknown router subcommand: ${sub}`);
    for (const line of REGRET_USAGE) console.error(line);
    return 1;
  }
  if (args.includes('--post') || args.includes('--post-issues')) {
    console.error('router regret does not post to GitHub. The posting flag stays off.');
  }
  const ledgerPath = flagValue(args, '--ledger') ?? join(routerDir(), 'outcomes.jsonl');
  const banditPath = flagValue(args, '--bandit');
  const backlogPath = flagValue(args, '--backlog') ?? join(routerDir(), 'regret-backlog.json');
  let text = '';
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    text = '';
  }
  const outcomes = readOutcomes(text);
  let bandit = readBandit(banditPath);
  for (const outcome of outcomes) bandit = updateBandit(bandit, outcome);
  const config = loadSchedulerConfig();
  const items = computeRegret({ outcomes, bandit, config });
  const generatedAt = new Date().toISOString();
  const backlog = regretBacklog(items, generatedAt);
  writeRegretBacklog(backlogPath, backlog);
  if (args.includes('--json')) console.log(JSON.stringify(backlog));
  else console.log(`router regret: ${items.length} item${items.length === 1 ? '' : 's'} in ${backlogPath}. posting is off.`);
  return 0;
}
