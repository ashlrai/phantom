/**
 * Read-only reader for the recorded coding-pool spend ledger.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886,
 * src/core/providers/coding-cli/ledger.ts): the SpendDecision schema,
 * parseSpendDecision, and a bounded read. The append and reweight functions of
 * the source are intentionally not recovered: this module cannot write the
 * ledger or derive routing weights.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Local copy of the source's four-value billing type (pool-spend policy is not recovered). */
export type PoolBilling = 'credit' | 'subscription' | 'metered' | 'local';

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

/** Deterministic read ceilings. Bytes past the cap are not read. */
export const SPEND_LEDGER_MAX_BYTES = 1024 * 1024;
export const SPEND_LEDGER_MAX_ROWS = 200;

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

export interface SpendLedgerRead {
  /** Valid rows in file order, at most maxRows. */
  rows: SpendDecision[];
  /** Valid rows found in the bytes read, including those past maxRows. */
  validRows: number;
  invalidRows: number;
  fileBytes: number;
  bytesRead: number;
  /** True when the file is larger than the byte ceiling. */
  bytesTruncated: boolean;
  /** True when validRows exceeds the row ceiling. */
  rowsTruncated: boolean;
  mtimeMs: number;
}

/**
 * Read at most maxBytes from the start of an existing file; a partial last
 * line cut by the ceiling is dropped, not counted invalid. Throws when the
 * file is missing or unreadable, so callers cannot mistake it for an empty ledger.
 */
export function readSpendLedger(
  file: string,
  limits: { maxBytes?: number; maxRows?: number } = {},
): SpendLedgerRead {
  const maxBytes = limits.maxBytes ?? SPEND_LEDGER_MAX_BYTES;
  const maxRows = limits.maxRows ?? SPEND_LEDGER_MAX_ROWS;
  const fd = openSync(file, 'r');
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    let bytesRead = 0;
    while (bytesRead < buf.length) {
      const n = readSync(fd, buf, bytesRead, buf.length - bytesRead, bytesRead);
      if (n === 0) break;
      bytesRead += n;
    }
    const bytesTruncated = st.size > maxBytes;
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesTruncated) lines.pop();
    const rows: SpendDecision[] = [];
    let validRows = 0;
    let invalidRows = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseSpendDecision(trimmed);
      if (!row) { invalidRows++; continue; }
      validRows++;
      if (rows.length < maxRows) rows.push(row);
    }
    return {
      rows, validRows, invalidRows, fileBytes: st.size, bytesRead, bytesTruncated,
      rowsTruncated: validRows > rows.length, mtimeMs: st.mtimeMs,
    };
  } finally {
    closeSync(fd);
  }
}
