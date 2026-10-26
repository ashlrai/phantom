/**
 * Per-job regret against the posterior. The backlog is a local JSON file.
 * postIssues is fixed off: this module does not open GitHub issues or comments.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { SchedulerConfig } from './defaults.js';
import { expectedValue, getArm } from './learn.js';
import { roleEligible, roleOf } from './solve.js';
import {
  SCHEDULER_POOL_IDS,
  armKey,
  isJobKind,
  isSchedulerPoolId,
  isUltraConsumer,
  type BanditState,
  type JobKind,
  type RouterOutcome,
  type SchedulerPoolId,
  type UltraConsumer,
} from './types.js';

export interface RegretItem {
  jobId: string;
  jobType: JobKind;
  chosenPool: SchedulerPoolId;
  chosenConsumer: UltraConsumer | null;
  betterPool: SchedulerPoolId;
  betterConsumer: UltraConsumer | null;
  chosenValue: number;
  betterValue: number;
  regret: number;
}

export interface RegretBacklog {
  version: 1;
  postIssues: false;
  generatedAt: string;
  source: 'posterior';
  items: RegretItem[];
}

function consumers(poolId: SchedulerPoolId): readonly (UltraConsumer | null)[] {
  return poolId === 'grok-ultra-weekly' ? ['orchestrator', 'cloud-agent'] : [null];
}

/** Cases where another pool's posterior mean beats the pool that ran the job. */
export function computeRegret(input: {
  outcomes: readonly RouterOutcome[];
  bandit: BanditState;
  config: SchedulerConfig;
  epsilon?: number;
}): RegretItem[] {
  const epsilon = input.epsilon ?? 1e-6;
  const items: RegretItem[] = [];
  for (const outcome of input.outcomes) {
    const chosen = expectedValue(getArm(input.bandit, armKey(outcome.jobType, outcome.poolId, outcome.consumer)), input.config);
    let best: { poolId: SchedulerPoolId; consumer: UltraConsumer | null; value: number } | null = null;
    for (const poolId of SCHEDULER_POOL_IDS) {
      for (const consumer of consumers(poolId)) {
        if (poolId === outcome.poolId && consumer === outcome.consumer) continue;
        if (!roleEligible(roleOf(outcome), { id: poolId, ...input.config.pools[poolId] }, consumer)) continue;
        const arm = getArm(input.bandit, armKey(outcome.jobType, poolId, consumer));
        // An untried prior is an exploration candidate, not observed regret.
        if (arm.observations <= 0) continue;
        const value = expectedValue(arm, input.config);
        if (best === null || value > best.value) best = { poolId, consumer, value };
      }
    }
    if (!best || best.value - chosen <= epsilon) continue;
    items.push({
      jobId: outcome.jobId,
      jobType: outcome.jobType,
      chosenPool: outcome.poolId,
      chosenConsumer: outcome.consumer,
      betterPool: best.poolId,
      betterConsumer: best.consumer,
      chosenValue: chosen,
      betterValue: best.value,
      regret: best.value - chosen,
    });
  }
  return items;
}

export function regretBacklog(items: readonly RegretItem[], generatedAt: string): RegretBacklog {
  return {
    version: 1,
    postIssues: false,
    generatedAt,
    source: 'posterior',
    items: [...items],
  };
}

/** Write the backlog. A posting request is ignored; the file always says postIssues false. */
export function writeRegretBacklog(file: string, backlog: RegretBacklog): void {
  const body: RegretBacklog = { ...backlog, version: 1, postIssues: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

export function parseOutcome(line: string): RouterOutcome | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row['ts'] !== 'string' || typeof row['jobId'] !== 'string') return null;
  if (typeof row['jobType'] !== 'string' || !isJobKind(row['jobType'])) return null;
  if (typeof row['poolId'] !== 'string' || !isSchedulerPoolId(row['poolId'])) return null;
  if (row['consumer'] !== null && (typeof row['consumer'] !== 'string' || !isUltraConsumer(row['consumer']))) return null;
  if (typeof row['merged'] !== 'boolean' || typeof row['green'] !== 'boolean' || typeof row['reverted'] !== 'boolean') return null;
  if (typeof row['reviewRounds'] !== 'number' || typeof row['wallMs'] !== 'number') return null;
  if (row['tokens'] !== null && typeof row['tokens'] !== 'number') return null;
  if (row['cost'] !== null && typeof row['cost'] !== 'number') return null;
  if (row['propensity'] !== null && typeof row['propensity'] !== 'number') return null;
  return {
    ts: row['ts'],
    jobId: row['jobId'],
    jobType: row['jobType'],
    poolId: row['poolId'],
    consumer: row['consumer'] as UltraConsumer | null,
    merged: row['merged'],
    green: row['green'],
    reviewRounds: row['reviewRounds'],
    reverted: row['reverted'],
    tokens: row['tokens'] as number | null,
    wallMs: row['wallMs'],
    cost: row['cost'] as number | null,
    propensity: row['propensity'] as number | null,
  };
}

export function readOutcomes(text: string): RouterOutcome[] {
  return text.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const row = parseOutcome(trimmed);
    return row ? [row] : [];
  });
}
