/**
 * Append-only scheduler decision log. A later line does not rewrite an
 * earlier one. Malformed lines are skipped. Secret-shaped text is scrubbed.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { scrubSecrets } from '../../../util/scrub.js';
import { isJobKind, isSchedulerPoolId, isUltraConsumer, type RouterDecision, type SchedulerPoolId, type UltraConsumer } from './types.js';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseRouterDecision(line: string): RouterDecision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['ts'] !== 'string' || typeof row['jobId'] !== 'string' || row['jobId'] === '') return null;
  const jobType = typeof row['jobType'] === 'string' ? row['jobType'] : '';
  if (!isJobKind(jobType)) return null;
  if (row['poolId'] !== null && (typeof row['poolId'] !== 'string' || !isSchedulerPoolId(row['poolId']))) return null;
  if (row['consumer'] !== null && (typeof row['consumer'] !== 'string' || !isUltraConsumer(row['consumer']))) return null;
  if (typeof row['policyId'] !== 'string' || typeof row['canary'] !== 'boolean' || typeof row['fallback'] !== 'boolean') return null;
  if (row['solver'] !== 'highs' && row['solver'] !== 'greedy') return null;
  if (row['grantsMergeAuthority'] !== false) return null;
  if (!finite(row['propensity']) || row['propensity'] < 0) return null;
  if (row['netValue'] !== null && !finite(row['netValue'])) return null;
  if (!Array.isArray(row['eligible'])) return null;
  const eligible = row['eligible'].flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const pair = item as Record<string, unknown>;
    if (typeof pair['poolId'] !== 'string' || !isSchedulerPoolId(pair['poolId'])) return [];
    if (pair['consumer'] !== null && (typeof pair['consumer'] !== 'string' || !isUltraConsumer(pair['consumer']))) return [];
    return [{ poolId: pair['poolId'], consumer: pair['consumer'] as UltraConsumer | null }];
  });
  return {
    ts: row['ts'],
    jobId: row['jobId'],
    jobType,
    poolId: row['poolId'] as SchedulerPoolId | null,
    consumer: row['consumer'] as UltraConsumer | null,
    policyId: row['policyId'],
    canary: row['canary'],
    propensity: row['propensity'],
    solver: row['solver'],
    fallback: row['fallback'],
    grantsMergeAuthority: false,
    netValue: row['netValue'] as number | null,
    eligible,
  };
}

/** Append one JSON line. Earlier lines are left untouched. */
export function appendRouterDecision(file: string, row: RouterDecision): void {
  const encoded = parseRouterDecision(JSON.stringify(row));
  if (!encoded) throw new Error('router decision is incomplete');
  const safe = scrubSecrets(JSON.stringify({ ...encoded, grantsMergeAuthority: false }));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${safe}\n`, 'utf8');
}

export function readRouterDecisions(file: string): RouterDecision[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const row = parseRouterDecision(trimmed);
    return row ? [row] : [];
  });
}
