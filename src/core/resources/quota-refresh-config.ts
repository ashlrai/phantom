/** Pure quota configuration schema; importing it never starts or imports a collector. */
import { canonical, digest } from '../universe/artifacts.js';
import { validateResourcePool, type ResourcePool } from './pool-policy.js';
import { validateResourceBindings, type ResourceBinding } from './worker-bindings.js';
import { resourceQuotaBuckets } from './quota-scope.js';

export const RESOURCE_QUOTA_REFRESH_INTERVAL_MS = 30_000;
export const RESOURCE_QUOTA_REFRESH_TTL_MS = 60_000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;

export interface ResourceQuotaRefreshWorker { workerId: string; accountHint: string; bucketIds: string[] }
export interface ResourceQuotaRefreshConfig { schemaVersion: 1; poolDigest: string; workers: ResourceQuotaRefreshWorker[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every((key) => typeof key === 'string' && keys.includes(key) &&
    'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function array(value: unknown, minimum: number, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length >= minimum && value.length <= maximum &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => index).every((index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!);
}
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const nested of Object.values(value)) immutable(nested); Object.freeze(value); }
  return value;
}
/** Account hints are pinned reported metadata, NOT proof of globally unique subscription identity. */
export function validateResourceQuotaRefreshConfig(value: unknown, poolValue: ResourcePool,
  bindingsValue: ResourceBinding[]): ResourceQuotaRefreshConfig {
  const pool = validateResourcePool(poolValue); const bindings = validateResourceBindings(bindingsValue, pool);
  const invalid = (): never => { throw new Error('Invalid resource quota refresh configuration'); };
  if (!object(value) || !exact(value, ['schemaVersion', 'poolDigest', 'workers']) || value.schemaVersion !== 1 ||
    typeof value.poolDigest !== 'string' || !HASH.test(value.poolDigest) || value.poolDigest !== digest(canonical({ pool, bindings })) ||
    !array(value.workers, 1, pool.workers.length)) return invalid();
  const seen = new Set<string>(); const workers: ResourceQuotaRefreshWorker[] = [];
  for (const row of value.workers) {
    if (!object(row) || !exact(row, ['workerId', 'accountHint', 'bucketIds']) || typeof row.workerId !== 'string' ||
      !ID.test(row.workerId) || seen.has(row.workerId) || typeof row.accountHint !== 'string' || !HASH.test(row.accountHint) ||
      !array(row.bucketIds, 1, 4) || row.bucketIds.some((bucket) => typeof bucket !== 'string' || !ID.test(bucket)) ||
      new Set(row.bucketIds).size !== row.bucketIds.length ||
      pool.workers.find((worker) => worker.id === row.workerId)?.provider !== 'codex' ||
      bindings.find((binding) => binding.workerId === row.workerId)?.kind !== 'native-cli') return invalid();
    seen.add(row.workerId);
    const expected = resourceQuotaBuckets(pool.workers.find((worker) => worker.id === row.workerId)!);
    if (expected && canonical([...row.bucketIds].sort()) !== canonical(expected)) return invalid();
    workers.push({ workerId: row.workerId, accountHint: row.accountHint, bucketIds: [...row.bucketIds as string[]].sort() });
  }
  const hints = new Map<string, string>(); const byWorker = new Map(workers.map((worker) => [worker.workerId, worker]));
  for (const row of workers) {
    const binding = bindings.find((candidate) => candidate.workerId === row.workerId)!;
    const previousCapacity = hints.get(row.accountHint);
    if (previousCapacity !== undefined && previousCapacity !== binding.capacityKey) return invalid();
    hints.set(row.accountHint, binding.capacityKey);
    for (const alias of bindings.filter((candidate) => candidate.capacityKey === binding.capacityKey)) {
      const enrolled = byWorker.get(alias.workerId);
      if (!enrolled || enrolled.accountHint !== row.accountHint) return invalid();
      const a = resourceQuotaBuckets(pool.workers.find((worker) => worker.id === row.workerId)!);
      const b = resourceQuotaBuckets(pool.workers.find((worker) => worker.id === alias.workerId)!);
      if ((!a || !b) && canonical(enrolled.bucketIds) !== canonical(row.bucketIds)) return invalid();
    }
  }
  return immutable({ schemaVersion: 1, poolDigest: value.poolDigest, workers });
}
