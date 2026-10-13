/** Pure additive compatibility; importing it never opens a store. */
import { canonical, digest } from '../universe/artifacts.js';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { validateResourcePool } from './pool-policy.js';
import { validateResourceBindings } from './worker.js';
import type { ResourcePoolCommissioningTransition, ResourcePoolConfigSnapshot } from './pool-evolution-types.js';
export const MAX_RESOURCE_POOL_CONFIGURATIONS = 16;
export function resourcePoolConfigSnapshot(pool: unknown, bindings: unknown): ResourcePoolConfigSnapshot {
  const text = canonicalEvidencePackJsonV3({ pool, bindings });
  if (text === null || Buffer.byteLength(text) > 256 * 1024) throw new Error('Invalid resource configuration snapshot');
  const input = JSON.parse(text) as { pool: unknown; bindings: unknown };
  const checkedPool = validateResourcePool(input.pool); const checkedBindings = validateResourceBindings(input.bindings, checkedPool);
  return { poolDigest: digest(canonical({ pool: checkedPool, bindings: checkedBindings })), pool: checkedPool, bindings: checkedBindings };
}
export function validateResourcePoolAdditiveEvolution(from: ResourcePoolConfigSnapshot, to: ResourcePoolConfigSnapshot): { addedWorkerIds: string[]; annotatedWorkerIds: string[] } {
  if (from.pool.id !== to.pool.id || from.poolDigest === to.poolDigest) throw new Error('Resource evolution requires a changed additive pool');
  const annotatedWorkerIds: string[] = [];
  for (const worker of from.pool.workers) {
    const next = to.pool.workers.find(row => row.id === worker.id);
    if (!next) throw new Error('Resource evolution cannot remove a worker');
    const { quotaScope: oldScope, ...oldRest } = worker; const { quotaScope: nextScope, ...nextRest } = next;
    if (canonical(oldRest) !== canonical(nextRest) || oldScope !== undefined && oldScope !== nextScope) throw new Error('Resource evolution cannot change existing worker policy');
    if (oldScope === undefined && nextScope !== undefined) annotatedWorkerIds.push(worker.id);
    if (canonical(from.bindings.find(row => row.workerId === worker.id)) !== canonical(to.bindings.find(row => row.workerId === worker.id))) {
      throw new Error('Resource evolution cannot change existing account bindings');
    }
  }
  const addedWorkerIds = to.pool.workers.filter(row => !from.pool.workers.some(old => old.id === row.id)).map(row => row.id);
  for (const id of addedWorkerIds) {
    const worker = to.pool.workers.find(row => row.id === id)!; const binding = to.bindings.find(row => row.workerId === id)!;
    const { workerId: _workerId, capacityKey: _capacityKey, ...locator } = binding;
    if (to.bindings.some(old => {
      const { workerId: _oldId, capacityKey: oldCapacity, ...oldLocator } = old;
      return oldCapacity !== binding.capacityKey && canonical(oldLocator) === canonical(locator);
    })) throw new Error('Resource evolution cannot split an existing account locator across capacities');
    const aliases = from.bindings.filter(row => row.capacityKey === binding.capacityKey);
    for (const alias of aliases) {
      const prior = from.pool.workers.find(row => row.id === alias.workerId)!;
      const { workerId: _old, ...oldLocator } = alias; const { workerId: _next, ...nextLocator } = binding;
      if (canonical(oldLocator) !== canonical(nextLocator) || worker.provider !== prior.provider ||
        worker.maxConcurrent !== prior.maxConcurrent || worker.maxTasksPerWindow !== prior.maxTasksPerWindow || worker.taskWindowMs !== prior.taskWindowMs ||
        worker.reservePercent < prior.reservePercent || worker.allowUnknownQuota === true && prior.allowUnknownQuota !== true) {
        throw new Error('Resource evolution cannot weaken an existing account capacity or reserve');
      }
    }
  }
  if (!addedWorkerIds.length && !annotatedWorkerIds.length) throw new Error('Resource evolution has no supported additions');
  return { addedWorkerIds, annotatedWorkerIds };
}
/** Explicit enrollment changes locators only. This is not identity or execution authority. */
export function validateResourcePoolNativeCommissioning(from: ResourcePoolConfigSnapshot, to: ResourcePoolConfigSnapshot): string[] {
  if (canonical(from.pool) !== canonical(to.pool) || from.poolDigest === to.poolDigest || from.bindings.length !== to.bindings.length) throw new Error('Invalid native commissioning policy');
  const changed: string[] = [];
  for (let index = 0; index < from.bindings.length; index++) {
    const a = from.bindings[index]!; const b = to.bindings[index]!;
    if (canonical(a) === canonical(b)) continue;
    if (a.kind !== 'native-cli' || b.kind !== 'native-cli' || a.workerId !== b.workerId || a.capacityKey !== b.capacityKey) throw new Error('Invalid native commissioning binding');
    const { command: _old, ...oldPolicy } = a; const { command: _new, ...newPolicy } = b;
    if (canonical(oldPolicy) !== canonical(newPolicy) || !['codex', 'claude'].includes(to.pool.workers.find(w => w.id === b.workerId)!.provider)) throw new Error('Invalid native commissioning provider');
    changed.push(b.workerId);
  }
  if (!changed.length) throw new Error('Empty native commissioning');
  for (const b of to.bindings.filter(row => changed.includes(row.workerId))) {
    const aliases = to.bindings.filter(row => row.capacityKey === b.capacityKey);
    if (aliases.some(row => !changed.includes(row.workerId) || row.kind !== 'native-cli' || b.kind !== 'native-cli' || canonical(row.command) !== canonical(b.command))) throw new Error('Native commissioning must include whole capacity');
    if (to.bindings.some(row => row.capacityKey !== b.capacityKey && row.kind === 'native-cli' && b.kind === 'native-cli' && canonical(row.command) === canonical(b.command))) throw new Error('Native commissioning locator is shared across capacities');
  }
  return changed;
}
function transition(value: unknown, from: ResourcePoolConfigSnapshot, to: ResourcePoolConfigSnapshot): ResourcePoolCommissioningTransition {
  const v = value as ResourcePoolCommissioningTransition; const hash = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
  if (!v || Object.keys(v).sort().join(',') !== 'kind,planDigest,requestDigest,rosterDigest,schemaVersion,subscriptionOnlyBoundaryRequired,workers' || v.schemaVersion !== 1 ||
    v.kind !== 'explicit-native-roster-enrollment' || v.subscriptionOnlyBoundaryRequired !== true || !hash(v.requestDigest) || !hash(v.planDigest) || !hash(v.rosterDigest) || !Array.isArray(v.workers)) throw new Error('Invalid commissioning transition');
  const changed = validateResourcePoolNativeCommissioning(from, to);
  if (canonical(v.workers.map(row => row.workerId)) !== canonical(changed)) throw new Error('Invalid commissioning worker inventory');
  for (const w of v.workers) {
    const binding = to.bindings.find(row => row.workerId === w.workerId)!;
    if (Object.keys(w).sort().join(',') !== 'capacityKey,collectorBindingDigest,profileMetadataDigest,quotaAccountHint,quotaBucketIds,seatId,workerId' || w.capacityKey !== binding.capacityKey ||
      typeof w.seatId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(w.seatId) || !hash(w.profileMetadataDigest) || !hash(w.collectorBindingDigest) ||
      (to.pool.workers.find(row => row.id === w.workerId)!.provider === 'codex' ? !hash(w.quotaAccountHint) || !Array.isArray(w.quotaBucketIds) || !w.quotaBucketIds.length || w.quotaBucketIds.length > 4 || w.quotaBucketIds.some(id => typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) || new Set(w.quotaBucketIds).size !== w.quotaBucketIds.length : w.quotaAccountHint !== null || canonical(w.quotaBucketIds) !== '[]')) throw new Error('Invalid commissioning worker proof');
    if (v.workers.some(row => row.capacityKey === w.capacityKey && (row.seatId !== w.seatId || row.profileMetadataDigest !== w.profileMetadataDigest || row.quotaAccountHint !== w.quotaAccountHint) ||
      row.capacityKey !== w.capacityKey && (row.seatId === w.seatId || row.quotaAccountHint !== null && row.quotaAccountHint === w.quotaAccountHint))) throw new Error('Invalid commissioning capacity proof');
  }
  return v;
}
export function crossesResourceCommissioning(history: ResourcePoolConfigSnapshot[], fromDigest: string, toDigest: string): boolean {
  const a = history.findIndex(row => row.poolDigest === fromDigest); const b = history.findIndex(row => row.poolDigest === toDigest);
  if (a < 0 || b < 0) throw new Error('Unknown resource commissioning origin');
  return history.slice(Math.min(a, b) + 1, Math.max(a, b) + 1).some(row => row.commissioning !== undefined);
}
export function validateResourcePoolConfigHistory(value: unknown): ResourcePoolConfigSnapshot[] {
  const json = canonicalEvidencePackJsonV3(value);
  if (json === null || Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('Invalid resource configuration history');
  const rows = JSON.parse(json) as ResourcePoolConfigSnapshot[];
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_RESOURCE_POOL_CONFIGURATIONS) throw new Error('Invalid resource configuration history');
  const result = rows.map(row => {
    if (!row || Object.keys(row).sort().join(',') !== (row.commissioning === undefined ? 'bindings,pool,poolDigest' : 'bindings,commissioning,pool,poolDigest')) throw new Error('Invalid resource configuration snapshot');
    const checked = resourcePoolConfigSnapshot(row.pool, row.bindings);
    if (checked.poolDigest !== row.poolDigest) throw new Error('Resource configuration digest mismatch'); return { ...checked, ...(row.commissioning === undefined ? {} : { commissioning: row.commissioning }) };
  });
  if (new Set(result.map(row => row.poolDigest)).size !== result.length) throw new Error('Duplicate resource configuration epoch');
  if (result[0]!.commissioning !== undefined) throw new Error('Commissioning needs an original epoch');
  for (let index = 1; index < result.length; index++) {
    const from = result[index - 1]!; const to = result[index]!;
    if (to.commissioning) to.commissioning = transition(to.commissioning, from, to);
    else validateResourcePoolAdditiveEvolution(from, to);
  }
  return result;
}
