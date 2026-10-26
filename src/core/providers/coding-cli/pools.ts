/**
 * Seed coding pools from the budgets Phantom already records. Live balance
 * and expiry stay unknown until a reading arrives. The configured totals are
 * estimates, shown beside the unknown, and are not treated as a live balance.
 */

import { DEFAULT_CLOUD_BUDGET } from '../../cloud/types.js';
import { DEFAULT_DEVIN_BUDGET } from '../../devin/types.js';
import {
  UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
  poolNeedsFigures,
  type SpendPool,
  type TierFloor,
} from '../../resources/pool-spend.js';
import type { CodingAccount } from './accounts.js';
import type { CodingCliCatalog } from './catalog.js';
import { devinCredentials } from './devin-gate.js';

export interface PoolFigure {
  id: string;
  billing: SpendPool['billing'];
  balance: number | null;
  unit: string;
  expiresAt: string | null;
  needsFigures: boolean;
  estimate: number | null;
  estimateSource: string;
  softCapPerDay: number;
}

export interface PoolSeedInput {
  catalog: CodingCliCatalog;
  accounts: readonly CodingAccount[];
  env?: NodeJS.ProcessEnv;
  /** Known live readings. Absent fields stay unknown. */
  balances?: Readonly<Record<string, { balance?: number | null; expiresAt?: string | null; usedToday?: number }>>;
  usedToday?: Readonly<Record<string, number>>;
}

function figure(pool: SpendPool, unit: string, estimate: number | null, estimateSource: string): PoolFigure {
  return {
    id: pool.id,
    billing: pool.billing,
    balance: pool.balance,
    unit,
    expiresAt: pool.expiresAt,
    needsFigures: poolNeedsFigures(pool),
    estimate,
    estimateSource,
    softCapPerDay: pool.softCapPerDay,
  };
}

function applyReading(pool: SpendPool, readings: PoolSeedInput['balances']): SpendPool {
  const reading = readings?.[pool.id];
  if (!reading) return pool;
  return {
    ...pool,
    balance: reading.balance === undefined ? pool.balance : reading.balance,
    expiresAt: reading.expiresAt === undefined ? pool.expiresAt : reading.expiresAt,
    usedToday: reading.usedToday ?? pool.usedToday,
  };
}

const SUBSCRIPTION_TIER: Readonly<Record<string, TierFloor>> = {
  codex: 'frontier',
  claude: 'frontier',
  cursor: 'frontier',
  ollama: 'cheap',
  grok: 'workhorse',
  devin: 'frontier',
};

/** Pools the worker can spend, plus the figure rows `phm resources figures` prints. */
export function seedCodingPools(input: PoolSeedInput): { pools: SpendPool[]; figures: PoolFigure[] } {
  const pools: SpendPool[] = [];
  const figures: PoolFigure[] = [];
  const used = input.usedToday ?? {};
  const cloud: SpendPool = applyReading({
    id: 'cloud-credits',
    billing: 'credit',
    balance: null,
    expiresAt: null,
    usedToday: used['cloud-credits'] ?? 0,
    softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
    tier: 'frontier',
    headroomPercent: null,
  }, input.balances);
  pools.push(cloud);
  figures.push(figure(
    cloud,
    'USD',
    DEFAULT_CLOUD_BUDGET.creditsTotalUsd,
    'cloud budget creditsTotalUsd, an operator estimate, not a live balance',
  ));

  const devinOn = devinCredentials(input.env ?? {}, input.catalog.backends['devin']?.orgId) !== null;
  const devin: SpendPool = applyReading({
    id: 'devin-acu',
    billing: 'metered',
    balance: null,
    expiresAt: null,
    usedToday: used['devin-acu'] ?? 0,
    softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
    tier: 'frontier',
    headroomPercent: null,
    meteredOptIn: devinOn,
  }, input.balances);
  pools.push(devin);
  figures.push(figure(
    devin,
    'ACU',
    DEFAULT_DEVIN_BUDGET.acuBudgetTotal,
    'devin budget acuBudgetTotal, an allotment, not a live balance',
  ));

  const seen = new Set<string>();
  for (const account of input.accounts) {
    if (account.health === 'unavailable') continue;
    const backend = input.catalog.backends[account.backend];
    if (!backend) continue;
    const id = `${account.backend}:${account.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const billing = backend.billing === 'loopback' ? 'local' : backend.billing === 'metered' ? 'metered' : backend.billing;
    const pool = applyReading({
      id,
      billing,
      balance: null,
      // A quota reset replenishes a seat; it is not a credit expiry.
      expiresAt: null,
      usedToday: used[id] ?? 0,
      // The unknown-balance credit cap must not throttle prepaid seats or
      // local models. Keep the sentinel finite so JSON figure rows retain it.
      softCapPerDay: billing === 'subscription' || billing === 'local'
        ? Number.MAX_SAFE_INTEGER
        : UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
      tier: SUBSCRIPTION_TIER[account.backend] ?? 'workhorse',
      headroomPercent: account.usedPercent === null ? null : Math.max(0, 100 - account.usedPercent),
      cooledUntilMs: account.cooledUntilMs,
      meteredOptIn: account.backend === 'devin' ? devinOn : false,
    }, input.balances);
    pools.push(pool);
    figures.push(figure(pool, backend.billing === 'subscription' ? 'percent' : 'unit', null, 'no live reading'));
  }
  return { pools, figures };
}

export function formatPoolFigures(figures: readonly PoolFigure[]): string {
  const missing = figures.filter((row) => row.needsFigures);
  const lines = [`pools needing figures: ${missing.length}`];
  for (const row of figures) {
    const balance = row.balance === null ? 'balance unknown' : `balance ${row.balance} ${row.unit}`;
    const expiry = row.expiresAt === null ? 'expiry unknown' : `expiry ${row.expiresAt}`;
    const estimate = row.estimate === null ? '' : ` estimate ${row.estimate} ${row.unit} (${row.estimateSource})`;
    const need = row.needsFigures ? ' needs figures' : '';
    lines.push(`${row.id} ${row.billing} ${balance} ${expiry} soft cap ${row.softCapPerDay}/day${estimate}${need}`);
  }
  return lines.join('\n');
}
