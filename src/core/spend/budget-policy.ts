/**
 * Owner spend budget. A missing provider is 0 USD for the month.
 * Pay-per-use may run only while measured spend this period is below that
 * budget and a fresh balance exists. Unknown spend is not under the budget.
 */
import { AGENT_ENV_MARKERS } from '../teams/identity.js';

export const SPEND_BUDGET_SCHEMA = 'spend.budget.v1' as const;
export const SPEND_BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type SpendBudgetPeriod = (typeof SPEND_BUDGET_PERIODS)[number];

export interface SpendBudgetEntry {
  provider: string;
  period: SpendBudgetPeriod;
  usd: number;
}

export interface SpendBudgetPolicy {
  schema: typeof SPEND_BUDGET_SCHEMA;
  entries: SpendBudgetEntry[];
}

export const DEFAULT_SPEND_BUDGET: SpendBudgetPolicy = {
  schema: SPEND_BUDGET_SCHEMA,
  entries: [{ provider: 'claude-api', period: 'month', usd: 0 }],
};

const PROVIDER = /^[a-z][a-z0-9-]{0,32}$/;

export function spendBudgetChangeRefused(env: NodeJS.ProcessEnv): string | null {
  return AGENT_ENV_MARKERS.find((key) => env[key] !== undefined && env[key] !== '') ?? null;
}

export function parseSpendBudget(value: unknown): SpendBudgetPolicy | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body['schema'] !== SPEND_BUDGET_SCHEMA || !Array.isArray(body['entries'])) return null;
  if (Object.keys(body).some((key) => key !== 'schema' && key !== 'entries')) return null;
  const entries: SpendBudgetEntry[] = [];
  const seen = new Set<string>();
  for (const row of body['entries']) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    if (Object.keys(item).some((key) => key !== 'provider' && key !== 'period' && key !== 'usd')) return null;
    if (typeof item['provider'] !== 'string' || !PROVIDER.test(item['provider'])) return null;
    if (item['period'] !== 'day' && item['period'] !== 'week' && item['period'] !== 'month') return null;
    if (typeof item['usd'] !== 'number' || !Number.isFinite(item['usd']) || item['usd'] < 0 || item['usd'] > 1_000_000) return null;
    const key = `${item['provider']}:${item['period']}`;
    if (seen.has(key)) return null;
    seen.add(key);
    entries.push({ provider: item['provider'], period: item['period'], usd: item['usd'] });
  }
  return { schema: SPEND_BUDGET_SCHEMA, entries };
}

/** Declared budget, or 0 USD per month when the owner has not named the provider. */
export function budgetFor(policy: SpendBudgetPolicy, provider: string, period: SpendBudgetPeriod = 'month'): number {
  const match = policy.entries.find((entry) => entry.provider === provider && entry.period === period);
  return match ? match.usd : 0;
}

export type SpendGateReason = 'kill' | 'within-budget' | 'budget' | 'unknown-spend' | 'stale-balance';

export function spendAllowsPayPerUse(input: {
  killed: boolean;
  budgetUsd: number;
  spentUsd: number | null;
  balanceFresh: boolean;
}): { allow: boolean; reason: SpendGateReason } {
  if (input.killed) return { allow: false, reason: 'kill' };
  if (!input.balanceFresh) return { allow: false, reason: 'stale-balance' };
  if (input.spentUsd === null || !Number.isFinite(input.spentUsd) || input.spentUsd < 0) {
    return { allow: false, reason: 'unknown-spend' };
  }
  if (!(Number.isFinite(input.budgetUsd) && input.budgetUsd >= 0)) return { allow: false, reason: 'budget' };
  if (input.spentUsd < input.budgetUsd) return { allow: true, reason: 'within-budget' };
  return { allow: false, reason: 'budget' };
}

export function withSpendEntry(policy: SpendBudgetPolicy, entry: SpendBudgetEntry): SpendBudgetPolicy {
  const entries = policy.entries.filter((row) => !(row.provider === entry.provider && row.period === entry.period));
  entries.push(entry);
  entries.sort((left, right) => left.provider.localeCompare(right.provider) || left.period.localeCompare(right.period));
  return { schema: SPEND_BUDGET_SCHEMA, entries };
}
