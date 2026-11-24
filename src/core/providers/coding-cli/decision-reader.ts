/**
 * Read-only reader for recorded router decisions (JSONL, one object per line).
 * Recovered from PR #5952 (scheduler/log.ts, scheduler/types.ts @ 3d6c8fb7).
 * Distinct from the human ROUTE/PICK text parsed by fleet/mission-control.
 *
 * Pool and consumer names are historical data, not runtime dependencies.
 * Explicit caller-provided file only. A missing or unreadable file yields [],
 * which is NOT evidence that nothing is running. Pure data out.
 */

import { readFileSync } from 'node:fs';

const POOL_IDS = ['codex-primary', 'codex-secondary', 'claude', 'devin', 'grok-build', 'local', 'grok-ultra-weekly', 'metered'] as const;
const CONSUMERS = ['orchestrator', 'cloud-agent'] as const;
const JOB_KINDS = ['coding', 'investigation', 'test-fixing', 'research', 'orchestration', 'review', 'merge-decision'] as const;

export type DecisionPoolId = (typeof POOL_IDS)[number];
export type DecisionConsumer = (typeof CONSUMERS)[number];
export type DecisionJobKind = (typeof JOB_KINDS)[number];

export interface DecisionEligibleRef {
  poolId: DecisionPoolId;
  consumer: DecisionConsumer | null;
}

export interface RecordedRouterDecision {
  ts: string;
  jobId: string;
  jobType: DecisionJobKind;
  poolId: DecisionPoolId | null;
  consumer: DecisionConsumer | null;
  policyId: string;
  canary: boolean;
  propensity: number;
  solver: 'highs' | 'greedy';
  fallback: boolean;
  /** Always false; a record claiming otherwise is rejected. */
  grantsMergeAuthority: false;
  netValue: number | null;
  /** Alternatives recorded as eligible. Malformed entries are dropped silently. */
  eligible: readonly DecisionEligibleRef[];
}

const isPool = (v: unknown): v is DecisionPoolId => typeof v === 'string' && (POOL_IDS as readonly string[]).includes(v);
const isConsumerOrNull = (v: unknown): v is DecisionConsumer | null =>
  v === null || (typeof v === 'string' && (CONSUMERS as readonly string[]).includes(v));
const isJobKind = (v: unknown): v is DecisionJobKind => typeof v === 'string' && (JOB_KINDS as readonly string[]).includes(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse one JSONL line. Returns null for anything that is not a complete decision. */
export function parseRouterDecision(line: string): RecordedRouterDecision | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['ts'] !== 'string' || typeof row['jobId'] !== 'string' || row['jobId'] === '') return null;
  const jobType = row['jobType'];
  if (!isJobKind(jobType)) return null;
  const poolId = row['poolId'];
  if (poolId !== null && !isPool(poolId)) return null;
  const consumer = row['consumer'];
  if (!isConsumerOrNull(consumer)) return null;
  if (typeof row['policyId'] !== 'string' || typeof row['canary'] !== 'boolean' || typeof row['fallback'] !== 'boolean') return null;
  const solver = row['solver'];
  if (solver !== 'highs' && solver !== 'greedy') return null;
  if (row['grantsMergeAuthority'] !== false) return null;
  const propensity = row['propensity'];
  if (!finite(propensity) || propensity < 0) return null;
  const netValue = row['netValue'];
  if (netValue !== null && !finite(netValue)) return null;
  if (!Array.isArray(row['eligible'])) return null;
  const eligible = (row['eligible'] as unknown[]).flatMap((item): DecisionEligibleRef[] => {
    if (typeof item !== 'object' || item === null) return [];
    const pair = item as Record<string, unknown>;
    if (!isPool(pair['poolId']) || !isConsumerOrNull(pair['consumer'])) return [];
    return [{ poolId: pair['poolId'], consumer: pair['consumer'] }];
  });
  return {
    ts: row['ts'], jobId: row['jobId'], jobType, poolId, consumer, policyId: row['policyId'],
    canary: row['canary'], propensity, solver, fallback: row['fallback'],
    grantsMergeAuthority: false, netValue, eligible,
  };
}

/** Read decisions in file order, skipping blank and malformed lines. Missing file => []. */
export function readRouterDecisions(file: string): RecordedRouterDecision[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    const row = trimmed ? parseRouterDecision(trimmed) : null;
    return row ? [row] : [];
  });
}
