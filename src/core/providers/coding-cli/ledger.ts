/**
 * Append-only spend ledger for coding pools. Offline reweight reads it and
 * returns pick weights. It does not write routing policy, role refusals, or
 * the merge gate.
 */

import { appendFileSync, readFileSync } from 'node:fs';

import type { PoolBilling } from '../../resources/pool-spend.js';

export interface SpendDecision {
  ts: string;
  /** Optional explicit PR identity; costs are never joined by title or task text. */
  repo?: string;
  pr?: number;
  poolId: string;
  billing: PoolBilling;
  balanceKnown: boolean;
  expiryKnown: boolean;
  complexity: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  backend: string;
  accountId: string | null;
  model: string | null;
  escalations: number;
  verification: 'passed' | 'failed' | 'unknown';
  ci: 'passed' | 'failed' | 'unknown';
  merged: boolean;
  timeMs: number;
  /** Quota used, when the provider reported it. */
  quota: number | null;
  /** Cost in the pool's unit, when known. */
  cost: number | null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseSpendDecision(line: string): SpendDecision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const billing = row['billing'];
  const band = (value: unknown): value is SpendDecision['complexity'] => value === 'low' || value === 'medium' || value === 'high';
  const outcome = (value: unknown): value is SpendDecision['verification'] => value === 'passed' || value === 'failed' || value === 'unknown';
  if (typeof row['ts'] !== 'string' || typeof row['poolId'] !== 'string' || row['poolId'] === '') return null;
  if (billing !== 'credit' && billing !== 'subscription' && billing !== 'metered' && billing !== 'local') return null;
  if (typeof row['balanceKnown'] !== 'boolean' || typeof row['expiryKnown'] !== 'boolean') return null;
  if (!band(row['complexity']) || !band(row['risk'])) return null;
  if (typeof row['backend'] !== 'string' || !outcome(row['verification']) || !outcome(row['ci'])) return null;
  if (typeof row['merged'] !== 'boolean' || !finite(row['escalations']) || !finite(row['timeMs'])) return null;
  if (row['accountId'] !== null && typeof row['accountId'] !== 'string') return null;
  if (row['model'] !== null && typeof row['model'] !== 'string') return null;
  if (row['quota'] !== null && !finite(row['quota'])) return null;
  if (row['cost'] !== null && !finite(row['cost'])) return null;
  const repo = row['repo'];
  const pr = row['pr'];
  if ((repo !== undefined || pr !== undefined) &&
    (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(repo) ||
      typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1)) return null;
  return {
    ts: row['ts'],
    ...(typeof repo === 'string' && typeof pr === 'number' ? { repo, pr } : {}),
    poolId: row['poolId'],
    billing,
    balanceKnown: row['balanceKnown'],
    expiryKnown: row['expiryKnown'],
    complexity: row['complexity'],
    risk: row['risk'],
    backend: row['backend'],
    accountId: row['accountId'] as string | null,
    model: row['model'] as string | null,
    escalations: row['escalations'],
    verification: row['verification'],
    ci: row['ci'],
    merged: row['merged'],
    timeMs: row['timeMs'],
    quota: row['quota'] as number | null,
    cost: row['cost'] as number | null,
  };
}

/** Append one JSON line. Earlier lines are left untouched. */
export function appendSpendDecision(file: string, row: SpendDecision): void {
  const encoded = parseSpendDecision(JSON.stringify(row));
  if (!encoded) throw new Error('spend decision is incomplete');
  appendFileSync(file, `${JSON.stringify(encoded)}\n`, 'utf8');
}

export function readSpendDecisions(file: string): SpendDecision[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const row = parseSpendDecision(trimmed);
    return row ? [row] : [];
  });
}

/**
 * Weight per pool from merge rate, CI pass rate, and cost per merged PR.
 * A pool with no merges weighs 0. Unknown cost adds nothing to the denominator
 * beyond 1. The result is numbers only.
 */
export function reweight(rows: readonly SpendDecision[]): Readonly<Record<string, number>> {
  const groups = new Map<string, SpendDecision[]>();
  for (const row of rows) {
    const list = groups.get(row.poolId) ?? [];
    list.push(row);
    groups.set(row.poolId, list);
  }
  const weights: Record<string, number> = {};
  for (const [poolId, list] of groups) {
    const merges = list.filter((row) => row.merged);
    if (merges.length === 0 || list.length === 0) {
      weights[poolId] = 0;
      continue;
    }
    const mergeRate = merges.length / list.length;
    const ciKnown = list.filter((row) => row.ci !== 'unknown');
    const ciRate = ciKnown.length === 0 ? 0 : ciKnown.filter((row) => row.ci === 'passed').length / ciKnown.length;
    const costKnown = merges.filter((row) => row.cost !== null);
    const costPerMerged = costKnown.length === 0
      ? 0
      : costKnown.reduce((sum, row) => sum + (row.cost ?? 0), 0) / merges.length;
    weights[poolId] = Math.round((mergeRate * ciRate / (1 + costPerMerged)) * 1_000_000) / 1_000_000;
  }
  return weights;
}
