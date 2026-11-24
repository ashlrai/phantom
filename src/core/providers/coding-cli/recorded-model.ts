/**
 * Offline serializer for a recorded assignment model, recovered from PR #5952
 * (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886): scheduler/solve.ts buildModel and
 * lpName. Pure: prepared records in, LP text and a variable-to-record mapping out.
 * No scoring, eligibility, solving, quota reads, I/O or dispatch. A historical
 * model only, never evidence of feasibility or current quota.
 *
 * Preserved: six-decimal coefficients; nonpositive coefficients dropped; per-job
 * `<= 1` or `= 1`; a required job with no pair gets an infeasible `force_` row;
 * `cap_` rows for concurrency minus in-flight; `quota_` rows for known quota;
 * binary bounds and Generals; `noop` for an empty model.
 * Differences: pairs arrive pre-eligible; quota is explicit (unknown emits no row,
 * known 0 forces zero); shared limits are caller-supplied, not a pace policy;
 * names come from ordinals only; variables sort by (job, pool, consumer ordinal);
 * round6 is not carried, since buildModel never calls it.
 */

/** Provenance attached to every model. Historical and offline only. */
export const RECORDED_MODEL_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-prepared-inputs',
} as const);

/** `unknown` emits no quota row. It is not zero. */
export type RecordedQuota = { state: 'unknown' } | { state: 'known'; remaining: number };

export interface RecordedModelJob {
  id: string;
  /** Equality row when true, `<= 1` otherwise. */
  requireAssignment: boolean;
}

export interface RecordedModelPool {
  id: string;
  concurrency: number;
  inFlight: number;
  quota: RecordedQuota;
}

/** An already-eligible (job, pool, consumer) option. `consumer` null means no consumer. */
export interface RecordedModelPair {
  jobId: string;
  poolId: string;
  consumer: string | null;
  coefficient: number;
  demand: number;
}

/** Total demand across a pool, plus optional per-consumer demand. */
export interface RecordedSharedLimit {
  poolId: string;
  totalDemand: number;
  consumerDemand?: readonly { consumer: string; demand: number }[];
}

export interface RecordedModelInput {
  jobs: readonly RecordedModelJob[];
  pools: readonly RecordedModelPool[];
  pairs: readonly RecordedModelPair[];
  sharedLimits?: readonly RecordedSharedLimit[];
}

/** One LP variable and the recorded (job, pool, consumer) it stands for. */
export interface RecordedModelVariable {
  name: string;
  jobId: string;
  poolId: string;
  consumer: string | null;
  coefficient: number;
  demand: number;
}

export interface RecordedModel {
  provenance: typeof RECORDED_MODEL_PROVENANCE;
  lp: string;
  variables: RecordedModelVariable[];
  constraintCount: number;
  /** Pools with unknown quota. Their demand is not bounded by a quota row. */
  quotaUnknownPoolIds: string[];
  /** Required jobs with no eligible pair. The model is infeasible by design. */
  forcedJobIds: string[];
  feasibilityAsserted: false;
  grantsMergeAuthority: false;
}

/** Thrown for malformed input. The message names the offending field. */
export class RecordedModelError extends Error {
  override name = 'RecordedModelError';
}

function fail(message: string): never {
  throw new RecordedModelError(message);
}

const asArray = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value as unknown[];
};

const asObject = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
};

const asId = (value: unknown, where: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${where} must be a non-empty string`);
  return value as string;
};

/** Finite number, optionally bounded below. Rejects NaN and both infinities. */
const asNumber = (value: unknown, where: string, min = -Infinity): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${where} must be a finite number`);
  if ((value as number) < min) fail(`${where} must be a finite number >= ${min}`);
  return value as number;
};

/** Ordinal lookup for ids. Duplicates are rejected. */
const indexIds = (ids: readonly string[], what: string): Map<string, number> => {
  const index = new Map<string, number>();
  ids.forEach((id, i) => {
    if (index.has(id)) fail(`duplicate ${what} id at ${what}s[${i}]`);
    index.set(id, i);
  });
  return index;
};

const coef = (value: number): string => value.toFixed(6);

interface Entry extends RecordedModelVariable {
  jobOrd: number;
  poolOrd: number;
}

/**
 * Serialize a recorded assignment problem to LP text. Pure and deterministic:
 * the same records always give the same text. Throws RecordedModelError on
 * malformed input. Never mutates its input.
 */
export function buildRecordedModel(input: RecordedModelInput): RecordedModel {
  const root = asObject(input, 'input');
  const jobs = asArray(root.jobs, 'jobs').map((raw, i) => {
    const r = asObject(raw, `jobs[${i}]`);
    if (typeof r.requireAssignment !== 'boolean') fail(`jobs[${i}].requireAssignment must be a boolean`);
    return { id: asId(r.id, `jobs[${i}].id`), requireAssignment: r.requireAssignment };
  });
  const pools = asArray(root.pools, 'pools').map((raw, i) => {
    const where = `pools[${i}]`;
    const r = asObject(raw, where);
    const q = asObject(r.quota, `${where}.quota`);
    const quota: RecordedQuota = q.state === 'unknown'
      ? { state: 'unknown' }
      : q.state === 'known'
        ? { state: 'known', remaining: asNumber(q.remaining, `${where}.quota.remaining`, 0) }
        : fail(`${where}.quota.state must be 'known' or 'unknown'`);
    return {
      id: asId(r.id, `${where}.id`),
      concurrency: asNumber(r.concurrency, `${where}.concurrency`, 0),
      inFlight: asNumber(r.inFlight, `${where}.inFlight`, 0),
      quota,
    };
  });
  const pairs = asArray(root.pairs, 'pairs').map((raw, i) => {
    const where = `pairs[${i}]`;
    const r = asObject(raw, where);
    return {
      jobId: asId(r.jobId, `${where}.jobId`),
      poolId: asId(r.poolId, `${where}.poolId`),
      consumer: r.consumer === null ? null : asId(r.consumer, `${where}.consumer`),
      coefficient: asNumber(r.coefficient, `${where}.coefficient`),
      demand: asNumber(r.demand, `${where}.demand`, 0),
    };
  });
  const sharedLimits = (root.sharedLimits === undefined ? [] : asArray(root.sharedLimits, 'sharedLimits')).map((raw, s) => {
    const where = `sharedLimits[${s}]`;
    const r = asObject(raw, where);
    const consumerDemand = (r.consumerDemand === undefined ? [] : asArray(r.consumerDemand, `${where}.consumerDemand`))
      .map((entry, m) => {
        const e = asObject(entry, `${where}.consumerDemand[${m}]`);
        return {
          consumer: asId(e.consumer, `${where}.consumerDemand[${m}].consumer`),
          demand: asNumber(e.demand, `${where}.consumerDemand[${m}].demand`, 0),
        };
      });
    return { poolId: asId(r.poolId, `${where}.poolId`), totalDemand: asNumber(r.totalDemand, `${where}.totalDemand`, 0), consumerDemand };
  });

  const jobOrd = indexIds(jobs.map((job) => job.id), 'job');
  const poolOrd = indexIds(pools.map((pool) => pool.id), 'pool');
  // Consumer 0 is "no consumer"; named consumers are numbered from 1 in sorted order.
  const consumers = [...new Set(pairs.map((pair) => pair.consumer).filter((c): c is string => c !== null))].sort();
  const consumerOrd = (consumer: string | null): number => (consumer === null ? 0 : consumers.indexOf(consumer) + 1);

  const seen = new Set<string>();
  const entries: Entry[] = [];
  pairs.forEach((pair, i) => {
    const j = jobOrd.get(pair.jobId);
    const p = poolOrd.get(pair.poolId);
    if (j === undefined) fail(`pairs[${i}].jobId references an unknown job`);
    if (p === undefined) fail(`pairs[${i}].poolId references an unknown pool`);
    const k = consumerOrd(pair.consumer);
    const key = `${j}|${p}|${k}`;
    if (seen.has(key)) fail(`pairs[${i}] duplicates an earlier job, pool and consumer`);
    seen.add(key);
    // Nonpositive coefficients are excluded after validation, as the source does.
    if (pair.coefficient <= 0) return;
    entries.push({
      name: `x_${j}_${p}_${k}`,
      jobId: pair.jobId,
      poolId: pair.poolId,
      consumer: pair.consumer,
      coefficient: pair.coefficient,
      demand: pair.demand,
      jobOrd: j,
      poolOrd: p,
    });
  });
  entries.sort((a, b) => a.jobOrd - b.jobOrd || a.poolOrd - b.poolOrd || consumerOrd(a.consumer) - consumerOrd(b.consumer));
  for (const limit of sharedLimits) {
    if (!poolOrd.has(limit.poolId)) fail('sharedLimits references an unknown pool');
    const named = limit.consumerDemand.map((entry) => entry.consumer);
    if (new Set(named).size !== named.length) fail('sharedLimits consumerDemand lists a consumer twice');
  }

  const byJob = jobs.map((): Entry[] => []);
  const byPool = pools.map((): Entry[] => []);
  for (const entry of entries) {
    byJob[entry.jobOrd].push(entry);
    byPool[entry.poolOrd].push(entry);
  }

  const rows: string[] = [];
  const forced = jobs.flatMap((job, j) => (job.requireAssignment && byJob[j].length === 0 ? [j] : []));
  // Per job index, as in the source: a required job without pairs is an infeasible force row.
  jobs.forEach((job, j) => {
    const names = byJob[j].map((entry) => entry.name);
    if (job.requireAssignment && names.length === 0) rows.push(` force_${j}: d_${j} = 1`);
    else if (names.length > 0) rows.push(` job_${j}: ${names.join(' + ')} ${job.requireAssignment ? '=' : '<='} 1`);
  });

  const quotaUnknownPoolIds: string[] = [];
  const weighted = (vars: Entry[]): string => vars.map((entry) => `${coef(entry.demand)} ${entry.name}`).join(' + ');
  pools.forEach((pool, p) => {
    const list = byPool[p];
    if (list.length === 0) return;
    rows.push(` cap_${p}: ${list.map((entry) => entry.name).join(' + ')} <= ${(pool.concurrency - pool.inFlight).toFixed(6)}`);
    if (pool.quota.state === 'unknown') quotaUnknownPoolIds.push(pool.id);
    else rows.push(` quota_${p}: ${weighted(list)} <= ${pool.quota.remaining.toFixed(6)}`);
  });
  sharedLimits.forEach((limit, s) => {
    const list = byPool[poolOrd.get(limit.poolId) as number];
    if (list.length === 0) return;
    rows.push(` shared_${s}: ${weighted(list)} <= ${coef(limit.totalDemand)}`);
    limit.consumerDemand.forEach((entry, m) => {
      const sub = list.filter((candidate) => candidate.consumer === entry.consumer);
      if (sub.length > 0) rows.push(` shared_${s}_c${m}: ${weighted(sub)} <= ${coef(entry.demand)}`);
    });
  });

  const constraintCount = rows.length;
  const objective = entries.map((entry) => `${coef(entry.coefficient)} ${entry.name}`);
  const lines = [
    'Maximize',
    objective.length === 0 ? ' obj: 0' : ` obj: ${objective.join(' + ')}`,
    'Subject To',
    ...(constraintCount === 0 ? [' noop: 0 <= 1'] : rows),
    'Bounds',
    ...entries.map((entry) => ` 0 <= ${entry.name} <= 1`),
    ...forced.map((j) => ` 0 <= d_${j} <= 0`),
  ];
  const generals = [...entries.map((entry) => entry.name), ...forced.map((j) => `d_${j}`)];
  if (generals.length > 0) lines.push('Generals', ` ${generals.join(' ')}`);
  lines.push('End');

  return {
    provenance: { ...RECORDED_MODEL_PROVENANCE },
    lp: `${lines.join('\n')}\n`,
    variables: entries.map(({ name, jobId, poolId, consumer, coefficient, demand }) => ({
      name, jobId, poolId, consumer, coefficient, demand,
    })),
    constraintCount,
    quotaUnknownPoolIds,
    forcedJobIds: forced.map((j) => jobs[j].id),
    feasibilityAsserted: false,
    grantsMergeAuthority: false,
  };
}
