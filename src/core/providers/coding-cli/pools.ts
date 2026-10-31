/**
 * Seed coding pools from the budgets Phantom already records. Live balance
 * and expiry stay unknown until a reading arrives. The configured totals are
 * estimates, shown beside the unknown, and are not treated as a live balance.
 */

import { DEFAULT_CLOUD_BUDGET } from '../../cloud/types.js';
import { DevinClient, type DevinFetch } from '../../devin/client.js';
import { DEFAULT_DEVIN_BUDGET } from '../../devin/types.js';
import {
  UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
  poolNeedsFigures,
  type SpendPool,
  type TierFloor,
} from '../../resources/pool-spend.js';
import { grokBillingFromStatus } from './adapters.js';
import type { CodingAccount } from './accounts.js';
import type { CodingCliCatalog } from './catalog.js';
import { devinApiKeyFromProcess, devinCredentials, resolveDevinOrgId } from './devin-gate.js';

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
  /** Undefined when this pool has no usage API. Null means the read failed. */
  usage?: number | null;
}

export interface PoolSeedInput {
  catalog: CodingCliCatalog;
  accounts: readonly CodingAccount[];
  env?: NodeJS.ProcessEnv;
  /** Known live readings. Absent fields stay unknown. */
  balances?: Readonly<Record<string, { balance?: number | null; expiresAt?: string | null; usedToday?: number }>>;
  usedToday?: Readonly<Record<string, number>>;
  /** `grok models` text. A subscription line outranks the metered API key. */
  grokStatus?: string;
}

function figure(
  pool: SpendPool,
  unit: string,
  estimate: number | null,
  estimateSource: string,
  usage?: number | null,
): PoolFigure {
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
    ...(usage !== undefined ? { usage } : {}),
  };
}

function laneFor(account: CodingAccount): SpendPool['lane'] {
  if (account.id === 'codex-primary') return 'codex-primary';
  if (account.id === 'codex-secondary') return 'codex-secondary';
  if (account.backend === 'omlx') return 'local-omlx';
  if (account.backend === 'ollama') return 'local-fallback';
  return undefined;
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
  omlx: 'cheap',
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
    lane: 'devin',
    spendFully: true,
  }, input.balances);
  pools.push(devin);
  figures.push(figure(
    devin,
    'ACU',
    DEFAULT_DEVIN_BUDGET.acuBudgetTotal,
    'operator estimate, not a live balance',
    null,
  ));

  const seen = new Set<string>();
  for (const account of input.accounts) {
    if (account.health === 'unavailable' || account.health === 'dead') continue;
    const backend = input.catalog.backends[account.backend];
    if (!backend) continue;
    const id = `${account.backend}:${account.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const grokSubscription = account.backend === 'grok' && input.grokStatus !== undefined && grokBillingFromStatus(input.grokStatus) === 'subscription';
    const billing = grokSubscription
      ? 'subscription'
      : backend.billing === 'loopback' ? 'local' : backend.billing === 'metered' ? 'metered' : backend.billing;
    const pool = applyReading({
      id,
      billing,
      balance: null,
      expiresAt: account.resetsAt,
      usedToday: used[id] ?? 0,
      softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
      tier: SUBSCRIPTION_TIER[account.backend] ?? 'workhorse',
      headroomPercent: account.usedPercent === null ? null : Math.max(0, 100 - account.usedPercent),
      cooledUntilMs: account.cooledUntilMs,
      meteredOptIn: account.backend === 'devin' ? devinOn : false,
      lane: grokSubscription ? 'grok-subscription' : laneFor(account),
      spendFully: account.id === 'codex-primary',
    }, input.balances);
    pools.push(pool);
    figures.push(figure(pool, backend.billing === 'subscription' ? 'percent' : 'unit', null, 'no live reading'));
  }
  if (input.grokStatus && grokBillingFromStatus(input.grokStatus) === 'subscription' && !pools.some((pool) => pool.lane === 'grok-subscription')) {
    const grok: SpendPool = {
      id: 'grok:subscription',
      billing: 'subscription',
      balance: null,
      expiresAt: null,
      usedToday: used['grok:subscription'] ?? 0,
      softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
      tier: 'workhorse',
      headroomPercent: null,
      lane: 'grok-subscription',
    };
    pools.push(grok);
    figures.push(figure(grok, 'percent', null, 'no live reading'));
  }
  return { pools, figures };
}

export interface LiveFigureInput extends PoolSeedInput {
  /** Injected Devin transport. Absent skips the live read and leaves usage unknown. */
  devinFetch?: DevinFetch;
}

/**
 * Seed pools, then read Devin organization consumption when the process key
 * is present. Consumption is usage, not a remaining balance. A failed or
 * absent read stays unknown. The operator allotment stays an estimate.
 */
export async function loadCodingFigures(input: LiveFigureInput): Promise<{ pools: SpendPool[]; figures: PoolFigure[] }> {
  const seeded = seedCodingPools(input);
  const key = devinApiKeyFromProcess();
  const orgId = resolveDevinOrgId(input.env ?? {}, input.catalog.backends['devin']?.orgId);
  if (!key || !orgId || !input.devinFetch) return seeded;
  let usage: number | null = null;
  try {
    const client = new DevinClient({ apiKey: key, fetch: input.devinFetch, retries: 0, sleep: async () => undefined });
    usage = (await client.getDailyConsumption(orgId)).totalAcus;
  } catch {
    usage = null;
  }
  return {
    pools: seeded.pools,
    figures: seeded.figures.map((row) => row.id === 'devin-acu' ? { ...row, usage, balance: null } : row),
  };
}

export function formatPoolFigures(figures: readonly PoolFigure[]): string {
  const missing = figures.filter((row) => row.needsFigures);
  const lines = [`pools needing figures: ${missing.length}`];
  for (const row of figures) {
    const balance = row.balance === null ? 'balance unknown' : `balance ${row.balance} ${row.unit}`;
    const usage = row.usage === undefined ? '' : row.usage === null ? ' usage unknown' : ` usage ${row.usage} ${row.unit}`;
    const expiry = row.expiresAt === null ? 'expiry unknown' : `expiry ${row.expiresAt}`;
    const estimate = row.estimate === null ? '' : ` estimate ${row.estimate} ${row.unit} (${row.estimateSource})`;
    const need = row.needsFigures ? ' needs figures' : '';
    lines.push(`${row.id} ${row.billing} ${balance}${usage} ${expiry} soft cap ${row.softCapPerDay}/day${estimate}${need}`);
  }
  return lines.join('\n');
}
