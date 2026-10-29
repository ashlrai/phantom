import type { QueueSnapshot, QueueStage } from './types.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('queue: expected an object');
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string, max = 1e9, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`queue: invalid ${name}`);
  }
  return value;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('queue: invalid identifier');
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('queue: expected boolean');
  return value;
}
function serviceRate(value: unknown): number {
  const rate = number(value, 'service rate', 1e6);
  if (rate > 0 && rate < 1e-6) throw new Error('queue: service rate below measurement precision');
  return rate;
}
function list(value: unknown, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || value.length > 128 || (!allowEmpty && !value.length)) throw new Error('queue: invalid list length');
  return value;
}
function unique(values: Array<string | number>): void {
  if (new Set(values).size !== values.length) throw new Error('queue: duplicate identifier or batch size');
}

/** Reconstruct the contract so unrecognized input (including private metadata) is never persisted. */
export function parseQueueSnapshot(value: unknown): QueueSnapshot {
  const raw = object(value);
  if (raw.schema !== 'phantom-queue-snapshot/v1') throw new Error('queue: unsupported snapshot schema');
  const pools = list(raw.pools).map((value) => {
    const p = object(value);
    return { id: id(p.id), slots: number(p.slots, 'pool slots', 10000, true), available: bool(p.available) };
  });
  unique(pools.map((p) => p.id));
  const stages: QueueStage[] = list(raw.stages).map((value) => {
    const s = object(value);
    if (s.kind !== 'work' && s.kind !== 'test' && s.kind !== 'merge') throw new Error('queue: invalid stage kind');
    const tiers = list(s.tiers).map((value) => {
      const t = object(value);
      return { id: id(t.id), serviceRate: serviceRate(t.serviceRate) };
    });
    unique(tiers.map((t) => t.id));
    const batches = list(s.batches, true).map((value) => {
      const b = object(value);
      const size = number(b.size, 'batch size', 1000, true);
      if (!size) throw new Error('queue: batch size must be positive');
      return { size, serviceRate: serviceRate(b.serviceRate) };
    });
    unique(batches.map((b) => b.size));
    const stage: QueueStage = {
      id: id(s.id), kind: s.kind, pool: id(s.pool),
      queued: number(s.queued, 'queued'), previousQueued: number(s.previousQueued, 'previous queued'),
      arrivals: number(s.arrivals, 'arrivals'), slots: number(s.slots, 'slots', 10000, true),
      minSlots: number(s.minSlots, 'min slots', 10000, true), maxSlots: number(s.maxSlots, 'max slots', 10000, true),
      tier: id(s.tier), tiers, impact: bool(s.impact),
      batchSize: number(s.batchSize, 'batch size', 1000, true), batches,
    };
    if (!pools.some((p) => p.id === stage.pool) || !tiers.some((t) => t.id === stage.tier)) throw new Error('queue: unknown pool or tier');
    // Current allocation may be below its floor after an outage; the floor constrains
    // transfers, not telemetry admission. Otherwise zero-capacity recovery deadlocks.
    if (stage.minSlots > stage.maxSlots || stage.slots > stage.maxSlots) throw new Error('queue: invalid slot bounds');
    if (stage.kind === 'merge') {
      // Batch profiles are measured with one fixed tier: do not multiply two unrelated speedups.
      if (tiers.length !== 1 || !batches.some((b) => b.size === stage.batchSize)) throw new Error('queue: merge requires one tier and a current batch profile');
    } else if (stage.batchSize !== 1 || batches.length) throw new Error('queue: only merge stages can batch');
    if (stage.impact && stage.kind !== 'test') throw new Error('queue: impact only applies to test stages');
    return stage;
  });
  unique(stages.map((s) => s.id));
  for (const pool of pools) {
    if (stages.filter((s) => s.pool === pool.id).reduce((n, s) => n + s.slots, 0) > pool.slots) throw new Error('queue: pool is overallocated');
  }
  const windowSeconds = number(raw.windowSeconds, 'window seconds', 86400);
  const targetUtilization = number(raw.targetUtilization, 'target utilization', 0.95);
  if (windowSeconds < 0.001 || targetUtilization < 0.1) throw new Error('queue: invalid observation window or utilization target');
  return {
    schema: 'phantom-queue-snapshot/v1', stream: id(raw.stream),
    observedAt: number(raw.observedAt, 'observation timestamp', Number.MAX_SAFE_INTEGER, true),
    windowSeconds, plannerRate: number(raw.plannerRate, 'planner rate', 1e6), targetUtilization, pools, stages,
  };
}
