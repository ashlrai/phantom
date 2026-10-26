/**
 * Pick a coding backend for route:any. Spend order comes from the pool
 * ranker. Within the winning class, the existing seat router breaks headroom
 * ties, including reset spend-down and in-flight spread. The tier floor from
 * the job shape is a minimum. Merge and credential roles are never assigned.
 */

import type { JobShape } from '../../decide/job-shape.js';
import { classifyJob } from '../../decide/job-shape.js';
import { defaultBudgetPolicy } from '../../routing/policy.js';
import { routeSeat } from '../../routing/router.js';
import type { SeatCapacity } from '../../routing/headroom.js';
import { rankSpendPools, type SpendPool, type TierFloor } from '../../resources/pool-spend.js';
import { bestAccount, resolveAccounts, type AccountReading, type CodingAccount } from './accounts.js';
import type { CodingCliCatalog } from './catalog.js';
import { usableModelName } from './catalog.js';
import { seedCodingPools } from './pools.js';
import { planWorker, type IssueJob, type PlanInput, type WorkerPlan } from './worker-plan.js';

export interface CodingChoice {
  backend: string;
  accountId: string | null;
  model: string | null;
  poolId: string;
}

function floorOf(shape: JobShape): TierFloor {
  if (shape.complexity === 'high' || shape.risk === 'high') return 'frontier';
  if (shape.complexity === 'low' && shape.risk === 'low') return 'cheap';
  return 'workhorse';
}

function modelTier(shape: JobShape): 'frontier' | 'workhorse' | 'cheap' | 'local' {
  if (shape.complexity === 'high' || shape.risk === 'high') return 'frontier';
  if (shape.complexity === 'low' && shape.risk === 'low') return 'cheap';
  return 'workhorse';
}

function modelFor(catalog: CodingCliCatalog, backend: string, shape: JobShape): string | null {
  const names = backend === 'ollama' ? (['local', modelTier(shape)] as const) : ([modelTier(shape)] as const);
  for (const name of names) {
    const hit = catalog.tiers[name].find((row) => row.backend === backend && row.task !== 'embed');
    const usable = usableModelName(hit);
    if (usable) return usable;
  }
  return null;
}

function seatFor(pool: SpendPool, account: CodingAccount | null, nowMs: number, meteredEnabled: boolean): SeatCapacity | null {
  const engine = pool.billing === 'local' || account?.backend === 'ollama'
    ? 'local'
    : account?.backend === 'grok' || pool.id === 'devin-acu'
      ? 'grok'
      : account?.backend === 'claude' || pool.id === 'cloud-credits'
        ? 'claude'
        : 'codex';
  if (pool.billing === 'local' || engine === 'local') {
    return {
      seatId: pool.id,
      engine: 'local',
      label: pool.id,
      free: true,
      windows: [],
      signedOut: false,
      reachable: true,
      contextWindow: 65_536,
      observedAt: null,
      spentTodayUsd: null,
      costBasis: 'free',
      billingClass: 'local',
    };
  }
  if (pool.headroomPercent === null) return null;
  const used = Math.max(0, Math.min(100, 100 - pool.headroomPercent));
  return {
    seatId: pool.id,
    engine,
    label: pool.id,
    free: false,
    windows: [{
      id: engine === 'codex' ? 'codex_codex_secondary' : engine === 'grok' ? 'grok_unified_weekly' : 'seven_day',
      usedPercent: used,
      resetsAt: account?.resetsAt ?? pool.expiresAt,
      resetDescription: null,
      limitReached: false,
    }],
    signedOut: false,
    reachable: null,
    contextWindow: 200_000,
    observedAt: new Date(nowMs).toISOString(),
    spentTodayUsd: null,
    costBasis: pool.billing === 'metered' || pool.billing === 'credit' ? 'per-token' : 'subscription',
    billingClass: pool.billing === 'metered' || pool.billing === 'credit' ? 'metered' : 'subscription',
    meteredOptIn: meteredEnabled || pool.meteredOptIn === true,
  };
}

function accountForPool(pool: SpendPool, accounts: readonly CodingAccount[]): CodingAccount | null {
  const match = accounts.find((account) => pool.id === `${account.backend}:${account.id}`);
  return match ?? null;
}

export function chooseCodingSeat(input: {
  catalog: CodingCliCatalog;
  shape: JobShape;
  nowMs: number;
  meteredEnabled?: boolean;
  accounts?: readonly CodingAccount[];
  readings?: Readonly<Record<string, AccountReading>>;
  env?: NodeJS.ProcessEnv;
  inFlight?: Readonly<Record<string, number>>;
  usedToday?: Readonly<Record<string, number>>;
  balances?: Parameters<typeof seedCodingPools>[0]['balances'];
}): CodingChoice | null {
  const meteredEnabled = input.meteredEnabled === true || input.catalog.meteredEnabledByDefault;
  const accounts = input.accounts ?? resolveAccounts(input.catalog, input.env ?? {}, input.readings ?? {});
  const seeded = seedCodingPools({
    catalog: input.catalog,
    accounts,
    ...(input.env ? { env: input.env } : {}),
    ...(input.usedToday ? { usedToday: input.usedToday } : {}),
    ...(input.balances ? { balances: input.balances } : {}),
  });
  const floor = floorOf(input.shape);
  const ranked = rankSpendPools(seeded.pools, { nowMs: input.nowMs, floor, meteredEnabled });
  const poolInFlight: Record<string, number> = {};
  const poolCaps: Record<string, number> = {};
  for (const pool of ranked) {
    const account = accountForPool(pool, accounts);
    const backend = account?.backend ?? (pool.id === 'devin-acu' ? 'devin' : 'cloud');
    const slot = account?.id ?? (backend === 'cloud' ? 'cloud-credits' : backend);
    // The worker counts actual account slots, while routeSeat ranks pool ids.
    poolInFlight[pool.id] = input.inFlight?.[slot] ?? 0;
    poolCaps[pool.id] = backend === 'cloud' ? 1 : input.catalog.concurrency[backend] ?? 1;
  }
  const groups = new Map<string, SpendPool[]>();
  for (const pool of ranked) {
    const kind = pool.billing === 'credit' && pool.expiresAt ? 'credit-dated' : pool.billing;
    const group = groups.get(kind) ?? [];
    group.push(pool);
    groups.set(kind, group);
  }
  let chosen: SpendPool | null = null;
  let seatRefused = false;
  for (const group of groups.values()) {
    const available = group.filter((pool) => poolInFlight[pool.id]! < poolCaps[pool.id]!);
    // Credit and metered pools use their explicit balance/expiry admission.
    // Every prepaid or local seat, including a sole candidate, must pass the
    // same headroom policy; a router refusal must never become a fallback.
    if (group[0]!.billing === 'credit' || group[0]!.billing === 'metered') {
      // Credentials can expose a metered pool, but a rejected prepaid seat
      // must not silently escalate to paid work without an explicit opt-in.
      if (group[0]!.billing === 'metered' && seatRefused && input.meteredEnabled !== true) continue;
      chosen = available[0] ?? null;
      if (chosen) break;
      continue;
    }
    const seats = available.flatMap((pool) => {
      const seat = seatFor(pool, accountForPool(pool, accounts), input.nowMs, meteredEnabled);
      return seat ? [seat] : [];
    });
    if (seats.length > 0) {
      const decision = routeSeat(
        {
          task: floor === 'cheap' ? 'bulk' : 'code',
          difficulty: floor === 'frontier' ? 'high' : floor === 'cheap' ? 'low' : 'medium',
          autonomous: true,
          contextTokens: input.shape.contextTokens,
        },
        seats,
        defaultBudgetPolicy(),
        {
          nowMs: input.nowMs,
          enforceMeteredOptIn: true,
          spendDown: true,
          inFlight: poolInFlight,
        },
      );
      const match = available.find((pool) => pool.id === decision.seatId);
      if (match) {
        chosen = match;
        break;
      }
    }
    seatRefused = true;
  }
  if (!chosen) return null;
  const account = accountForPool(chosen, accounts);
  const backend = account?.backend
    ?? (chosen.id === 'devin-acu' ? 'devin' : chosen.id === 'cloud-credits' ? 'cloud' : chosen.id.split(':')[0] ?? chosen.id);
  const open = bestAccount(accounts, backend, input.nowMs);
  return {
    backend,
    accountId: account?.id ?? open?.id ?? null,
    model: modelFor(input.catalog, backend, input.shape),
    poolId: chosen.id,
  };
}

export async function planLabelledWork(input: PlanInput & {
  env?: NodeJS.ProcessEnv;
  readings?: Readonly<Record<string, AccountReading>>;
  classify?: typeof classifyJob;
  usedToday?: Readonly<Record<string, number>>;
  balances?: Parameters<typeof seedCodingPools>[0]['balances'];
}): Promise<WorkerPlan> {
  const env = input.env ?? {};
  const accounts = resolveAccounts(input.catalog, env, input.readings ?? {});
  const anyChoices: Record<number, { backend: string; model: string | null; accountId: string | null; poolId: string | null }> = {};
  for (const [key, value] of Object.entries(input.anyChoices ?? {})) {
    anyChoices[Number(key)] = {
      backend: value.backend,
      model: value.model,
      accountId: value.accountId ?? null,
      poolId: value.poolId ?? null,
    };
  }
  const running = { ...(input.inFlight ?? {}) };
  const usedToday: Record<string, number> = { ...(input.usedToday ?? {}) };
  const classify = input.classify ?? classifyJob;
  for (const issue of input.issues) {
    const labels = issue.labels.filter((label) => label === 'route:codex' || label === 'route:claude' || label === 'route:grok' || label === 'route:any');
    if (labels.length !== 1 || labels[0] !== 'route:any' || anyChoices[issue.number]) continue;
    const shape = await classify(`${issue.title}\n${issue.body}`);
    const choice = chooseCodingSeat({
      catalog: input.catalog,
      shape,
      nowMs: input.nowMs,
      ...(input.meteredEnabled !== undefined ? { meteredEnabled: input.meteredEnabled } : {}),
      accounts,
      env,
      inFlight: running,
      usedToday,
      ...(input.balances ? { balances: input.balances } : {}),
    });
    if (!choice) continue;
    anyChoices[issue.number] = { backend: choice.backend, model: choice.model, accountId: choice.accountId, poolId: choice.poolId };
    usedToday[choice.poolId] = (usedToday[choice.poolId] ?? 0) + 1;
    const slot = choice.accountId ?? (choice.backend === 'cloud' ? 'cloud-credits' : choice.backend);
    running[slot] = (running[slot] ?? 0) + 1;
  }
  return planWorker({ ...input, anyChoices, accounts });
}

export type { IssueJob };
