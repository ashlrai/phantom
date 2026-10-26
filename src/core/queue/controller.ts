import { createHash } from 'node:crypto';
import { parseQueueSnapshot } from './snapshot.js';
import type { QueueAction, QueueAllocation, QueueControlDecision, QueueStage } from './types.js';
export type { QueueControlDecision, QueueSnapshot } from './types.js';

function serviceRate(stage: QueueStage, allocation: QueueAllocation): number {
  return stage.kind === 'merge'
    ? stage.batches.find((b) => b.size === allocation.batchSize)!.serviceRate
    : stage.tiers.find((t) => t.id === allocation.tier)!.serviceRate;
}

/** Deterministic bounded controller. Outputs an overlay; never launches work or alters authority. */
export function controlQueue(value: unknown): QueueControlDecision {
  const input = parseQueueSnapshot(value);
  const { stages, pools, windowSeconds, targetUtilization } = input;
  const inputDigest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const id = createHash('sha256').update(`${input.stream}:${input.observedAt}`).digest('hex');
  const allocations: QueueAllocation[] = stages.map((s) => ({
    stage: s.id, pool: s.pool, slots: pools.find((p) => p.id === s.pool)!.available ? s.slots : 0,
    tier: s.tier, impact: s.impact, batchSize: s.batchSize, capacity: 0,
  }));
  const refresh = (): void => { allocations.forEach((a, i) => { a.capacity = a.slots * serviceRate(stages[i], a); }); };
  refresh();
  const metrics = stages.map((s, i) => {
    const arrivalRate = s.arrivals / windowSeconds;
    const growth = (s.queued - s.previousQueued) / windowSeconds;
    const capacity = allocations[i].capacity;
    return { stage: s.id, queued: s.queued, arrivalRate, growth,
      // null means infinite pressure (demand with zero capacity), never a JSON Infinity.
      rho: capacity > 0 ? arrivalRate / capacity : arrivalRate > 0 || s.queued > 0 ? null : 0 };
  });
  const pressure = (i: number): number => metrics[i].rho ?? Infinity;
  const active = stages.map((_, i) => i).filter((i) => metrics[i].queued > 0 || metrics[i].arrivalRate > 0);
  const overloaded = active.filter((i) => pressure(i) >= 1);
  const growing = active.filter((i) => metrics[i].growth > 0);
  const candidates = overloaded.length ? overloaded : growing.length ? growing : active.filter((i) => stages[i].queued > 0);
  candidates.sort((a, b) => {
    const left = overloaded.length ? pressure(a) : growing.length ? metrics[a].growth : stages[a].queued / Math.max(allocations[a].capacity, 1e-9);
    const right = overloaded.length ? pressure(b) : growing.length ? metrics[b].growth : stages[b].queued / Math.max(allocations[b].capacity, 1e-9);
    return (right > left ? 1 : right < left ? -1 : 0) || metrics[b].growth - metrics[a].growth || a - b;
  });
  // Idle pools with zero admitted work still need an allocation before RQ-PLAN can restock.
  const restock = stages.map((_, i) => i)
    .filter((i) => input.plannerRate > allocations[i].capacity * targetUtilization)
    .sort((a, b) => allocations[a].capacity - allocations[b].capacity || a - b);
  const selected = candidates[0] ?? restock[0];
  const bottleneck = selected === undefined ? null : {
    stage: stages[selected].id,
    reason: overloaded.length ? 'highest-rho' : growing.length ? 'fastest-growing-queue' : candidates.length ? 'longest-drain-time' : 'restock-capacity',
    rho: metrics[selected].rho, growth: metrics[selected].growth,
  };
  const actions: QueueAction[] = [];
  function change(i: number, control: QueueAction['control'], from: QueueAction['from'], to: QueueAction['to'], reason: string): void {
    if (from !== to) actions.push({ stage: stages[i].id, control, from, to, reason });
  }
  allocations.forEach((a, i) => change(i, 'slots', stages[i].slots, a.slots, 'pool-unavailable'));
  if (selected !== undefined) {
    const stage = stages[selected];
    const allocation = allocations[selected];
    const pool = pools.find((p) => p.id === stage.pool)!;
    if (pool.available) {
      // Reserve enough headroom to drain backlog within a window, subject to hard pool bounds.
      const demand = Math.max(metrics[selected].arrivalRate, input.plannerRate) + stage.queued / windowSeconds;
      const desired = (): number => Math.min(stage.maxSlots, Math.max(stage.minSlots,
        serviceRate(stage, allocation) > 0 ? Math.ceil(demand / (serviceRate(stage, allocation) * targetUtilization)) : stage.maxSlots));
      let free = pool.slots - allocations.filter((a) => a.pool === pool.id).reduce((n, a) => n + a.slots, 0);
      const admittedPlannerRate = stages.some((s) => s.queued > 0) ? 0
        : Math.min(input.plannerRate, ...allocations.map((a) => a.capacity * targetUtilization));
      const simultaneousSlots = stages.filter((s) => s.pool === pool.id)
        .reduce((sum, s) => sum + Math.max(s.minSlots, 1), 0);
      // Only take genuinely spare slots; never move a donor below its observed load or floor.
      for (let i = 0; i < stages.length && allocation.slots + free < desired(); i++) {
        if (i === selected || stages[i].pool !== pool.id || stages[i].queued > 0 || metrics[i].growth > 0) continue;
        const donor = allocations[i];
        const rate = serviceRate(stages[i], donor);
        const load = Math.max(metrics[i].arrivalRate, admittedPlannerRate);
        // Requested demand may itself exceed total capacity. Reserving against it
        // would strand idle slots forever while planning is throttled to zero.
        const reserve = rate > 0 ? Math.max(stages[i].minSlots, input.plannerRate > 0 && pool.slots >= simultaneousSlots ? 1 : 0,
          Math.ceil(load / (rate * targetUtilization))) : load > 0 ? donor.slots : stages[i].minSlots;
        const moved = Math.max(0, Math.min(donor.slots - reserve, desired() - allocation.slots - free));
        change(i, 'slots', donor.slots, donor.slots - moved, `transfer-to-${stage.id}`);
        donor.slots -= moved;
        free += moved;
      }
      const slots = Math.min(desired(), allocation.slots + free);
      // Do not reduce the bottleneck's existing allocation as telemetry settles.
      const nextSlots = Math.max(allocation.slots, slots);
      change(selected, 'slots', allocation.slots, nextSlots, 'bottleneck-capacity');
      allocation.slots = nextSlots;
      if (allocation.slots * serviceRate(stage, allocation) * targetUtilization < demand) {
        if (stage.kind === 'merge') {
          const fastest = [...stage.batches].sort((a, b) => b.serviceRate - a.serviceRate || a.size - b.size)[0];
          if (fastest.serviceRate > serviceRate(stage, allocation)) {
            change(selected, 'merge-batch', allocation.batchSize, fastest.size, 'measured-faster-batch');
            allocation.batchSize = fastest.size;
          }
        } else {
          const fastest = [...stage.tiers].sort((a, b) => b.serviceRate - a.serviceRate || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
          if (fastest.serviceRate > serviceRate(stage, allocation)) {
            change(selected, 'tier', allocation.tier, fastest.id, 'measured-faster-tier');
            allocation.tier = fastest.id;
          }
        }
      }
      if (stage.kind === 'test' && !allocation.impact) {
        change(selected, 'test-impact', false, true, 'impact-preflight-with-required-checks-preserved');
        allocation.impact = true;
      }
    }
  }
  refresh();
  const downstreamBusy = stages.some((s, i) => i > 0 && (s.queued > 0 || metrics[i].growth > 0));
  const pipelineBusy = stages.some((s) => s.queued > 0);
  const sustainableRate = Math.min(...allocations.map((a) => a.capacity)) * targetUtilization;
  // Stop new planning while any existing work drains. Already-admitted work is never dropped.
  // Once empty, reopen at the slowest stage's sustainable rate, not at the overloaded request rate.
  const rate = pipelineBusy || downstreamBusy ? 0 : Math.min(input.plannerRate, sustainableRate);
  const idle = pools.some((p) => p.available && allocations.filter((a) => a.pool === p.id).reduce((n, a) => n + a.slots, 0) < p.slots);
  const planner: QueueControlDecision['planner'] = {
    mode: rate < input.plannerRate ? 'throttle' : !pipelineBusy && idle && rate > 0 ? 'restock' : 'steady',
    rate,
    reason: downstreamBusy ? 'downstream-queue-draining' : pipelineBusy ? 'admitted-work-draining' : sustainableRate === 0 ? 'capacity-unavailable' : rate < input.plannerRate ? 'pipeline-capacity-limit' : idle ? 'idle-pool-restock' : 'sustainable-throughput',
  };
  return {
    schema: 'phantom-queue-control/v1', id, observedAt: input.observedAt, inputDigest, input,
    bottleneck, actions, allocations, planner,
    bandit: {
      schema: 'phantom-queue-bandit/v1', decisionId: id,
      context: metrics.map(({ stage, queued, rho, growth }) => ({ stage, queued, rho, growth })),
      actions, reward: null, status: 'awaiting-observation',
    },
    lpInputs: {
      schema: 'phantom-queue-lp-inputs/v1', issue: 938, decisionId: id, pools,
      stages: allocations.map((a, i) => ({ ...a, backlog: stages[i].queued,
        arrivalRate: metrics[i].arrivalRate, minSlots: stages[i].minSlots, maxSlots: stages[i].maxSlots })),
      plannerRateLimit: rate, targetUtilization, requiredChecks: 'preserved',
    },
  };
}
