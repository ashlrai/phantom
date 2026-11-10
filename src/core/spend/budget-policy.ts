/**
 * Owner spend budget. A missing provider is 0 USD for the month.
 * Pay-per-use may run only while measured spend this period is below that
 * budget and a fresh balance exists. Unknown spend is not under the budget.
 * A budget above 0 counts only when the file carries an attestation the
 * store can verify. A missing or bad attestation is 0.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/canonical-json.js';
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

/**
 * Shapes a file may carry. None of these is a trust root: a ledger note and an
 * operator approval are both writable by the same account, and this repo has
 * no mode-444 Security pin-chain verifier and no Masbot or owner signature
 * verifier for a spend budget. A nonzero amount therefore stays 0.
 */
export interface SpendBudgetPinAttestation {
  kind: 'pin-chain';
  hash: string;
  chain: string;
  epoch: number;
}

export interface SpendBudgetApprovalAttestation {
  kind: 'mason-approval';
  id: string;
  digest: string;
  epoch: number;
}

/** What `phm budget set` records. It does not authorize spend. */
export interface SpendBudgetRecordedAttestation {
  kind: 'recorded';
  hash: string;
  epoch: number;
}

export type SpendBudgetAttestation =
  | SpendBudgetPinAttestation
  | SpendBudgetApprovalAttestation
  | SpendBudgetRecordedAttestation;

export interface SpendBudgetDocument {
  policy: SpendBudgetPolicy;
  attestation: SpendBudgetAttestation | null;
}

export const DEFAULT_SPEND_BUDGET: SpendBudgetPolicy = {
  schema: SPEND_BUDGET_SCHEMA,
  entries: [{ provider: 'claude-api', period: 'month', usd: 0 }],
};

const PROVIDER = /^[a-z][a-z0-9-]{0,32}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SPEND_BUDGET_HASH_DOMAIN = 'ashlr:spend-budget:v1\0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function spendBudgetChangeRefused(env: NodeJS.ProcessEnv): string | null {
  return AGENT_ENV_MARKERS.find((key) => env[key] !== undefined && env[key] !== '') ?? null;
}

function epochOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function spendBudgetPolicyHash(policy: SpendBudgetPolicy, epoch: number): string {
  const entries = [...policy.entries].sort((left, right) => left.provider.localeCompare(right.provider) || left.period.localeCompare(right.period));
  return createHash('sha256')
    .update(SPEND_BUDGET_HASH_DOMAIN + canonicalJson({ schema: policy.schema, entries, epoch }))
    .digest('hex');
}

export function parseSpendBudgetAttestation(value: unknown): SpendBudgetAttestation | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  const epoch = epochOf(value['epoch']);
  if (epoch === null) return null;
  if (kind === 'pin-chain') {
    if (Object.keys(value).some((key) => key !== 'kind' && key !== 'hash' && key !== 'chain' && key !== 'epoch')) return null;
    if (typeof value['hash'] !== 'string' || !SHA256_HEX.test(value['hash'])) return null;
    if (typeof value['chain'] !== 'string' || !SHA256_HEX.test(value['chain'])) return null;
    return { kind: 'pin-chain', hash: value['hash'], chain: value['chain'], epoch };
  }
  if (kind === 'mason-approval') {
    if (Object.keys(value).some((key) => key !== 'kind' && key !== 'id' && key !== 'digest' && key !== 'epoch')) return null;
    if (typeof value['id'] !== 'string' || !SHA256_HEX.test(value['id'])) return null;
    if (typeof value['digest'] !== 'string' || !SHA256_HEX.test(value['digest'])) return null;
    if (value['id'] !== value['digest']) return null;
    return { kind: 'mason-approval', id: value['id'], digest: value['digest'], epoch };
  }
  if (kind === 'recorded') {
    if (Object.keys(value).some((key) => key !== 'kind' && key !== 'hash' && key !== 'epoch')) return null;
    if (typeof value['hash'] !== 'string' || !SHA256_HEX.test(value['hash'])) return null;
    return { kind: 'recorded', hash: value['hash'], epoch };
  }
  return null;
}

/** No in-repo verifier can prove a spend budget. Ledger notes and operator approvals are not roots. */
export function spendBudgetRootHonors(_attestation: SpendBudgetAttestation): boolean {
  return false;
}

/** Entries at 0 need no attestation. Any higher amount needs one that verifies. */
export function effectiveSpendBudget(policy: SpendBudgetPolicy, attested: boolean): SpendBudgetPolicy {
  if (attested || policy.entries.every((entry) => entry.usd === 0)) return policy;
  return {
    schema: policy.schema,
    entries: policy.entries.map((entry) => (entry.usd > 0 ? { ...entry, usd: 0 } : entry)),
  };
}

export function parseSpendBudgetDocument(value: unknown): SpendBudgetDocument | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== 'schema' && key !== 'entries' && key !== 'attestation')) return null;
  const policy = parseSpendBudget({ schema: value['schema'], entries: value['entries'] });
  if (!policy) return null;
  if (!Object.prototype.hasOwnProperty.call(value, 'attestation')) return { policy, attestation: null };
  const attestation = parseSpendBudgetAttestation(value['attestation']);
  if (!attestation) return null;
  return { policy, attestation };
}

export function parseSpendBudget(value: unknown): SpendBudgetPolicy | null {
  if (!isRecord(value)) return null;
  const body = value;
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
