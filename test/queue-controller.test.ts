import { describe, expect, it } from 'vitest';
import { controlQueue, type QueueSnapshot } from '../src/core/queue/controller.js';

function fixture(): QueueSnapshot {
  return {
    schema: 'phantom-queue-snapshot/v1', stream: 'sim', observedAt: 1000,
    windowSeconds: 10, plannerRate: 1, targetUtilization: 0.8,
    pools: [{ id: 'shared', slots: 8, available: true }],
    stages: ['build', 'test', 'merge'].map((id, i) => ({
      id, kind: i === 2 ? 'merge' : i === 1 ? 'test' : 'work', pool: 'shared',
      queued: 0, previousQueued: 0, arrivals: 0, slots: 1, minSlots: 1, maxSlots: 4,
      tier: 'normal', tiers: [{ id: 'normal', serviceRate: 2 }], impact: false,
      batchSize: 1, batches: i === 2 ? [{ size: 1, serviceRate: 2 }] : [],
    })),
  };
}

describe('queue controller', () => {
  it('names highest rho, assigns idle slots, and throttles downstream pressure', () => {
    const input = fixture();
    input.stages[1].arrivals = 60;
    input.stages[1].queued = 40;
    const result = controlQueue(input);
    expect(result.bottleneck).toEqual({ stage: 'test', reason: 'highest-rho', rho: 3, growth: 4 });
    expect(result.allocations[1].slots).toBe(4);
    expect(result.planner).toMatchObject({ mode: 'throttle', rate: 0 });
    expect(result.actions).toContainEqual(expect.objectContaining({ control: 'test-impact', to: true }));
    expect(result.lpInputs.requiredChecks).toBe('preserved');
    // Impact does not invent a speedup by omitting required verification.
    expect(result.allocations[1].capacity).toBe(8);
  });

  it('uses fastest-growing queue when none is overloaded', () => {
    const input = fixture();
    input.stages[0].queued = 4;
    input.stages[1].queued = 8;
    expect(controlQueue(input).bottleneck).toMatchObject({ stage: 'test', reason: 'fastest-growing-queue' });
  });

  it('drains old backlog even when arrival and growth rates are zero', () => {
    const input = fixture();
    input.stages[2].queued = input.stages[2].previousQueued = 7;
    expect(controlQueue(input).bottleneck).toMatchObject({ stage: 'merge', reason: 'longest-drain-time' });
  });

  it('transfers spare slots without starving the donor or exceeding pool capacity', () => {
    const input = fixture();
    input.pools[0].slots = 6;
    input.stages[0].slots = 4;
    input.stages[1].queued = 50;
    const result = controlQueue(input);
    expect(result.allocations.map((a) => a.slots)).toEqual([1, 4, 1]);
    expect(result.actions[0]).toMatchObject({ stage: 'build', control: 'slots', from: 4, to: 1 });
  });

  it('never steals slots from a loaded donor', () => {
    const input = fixture();
    input.pools[0].slots = 6;
    input.stages[0].slots = 4;
    input.stages[0].queued = 1;
    input.stages[1].queued = 30;
    expect(controlQueue(input).allocations.map((a) => a.slots)).toEqual([4, 1, 1]);
  });

  it.each([0, 1])('drains a zero-slot queue despite infeasible requested demand (donor rate %i)', (donorRate) => {
    const input = fixture();
    input.stages = input.stages.slice(0, 2);
    input.pools[0].slots = 2;
    input.plannerRate = 2;
    Object.assign(input.stages[0], { slots: 2, minSlots: 0, maxSlots: 2, tiers: [{ id: 'normal', serviceRate: donorRate }] });
    Object.assign(input.stages[1], { slots: 0, minSlots: 0, maxSlots: 2, queued: 1, tiers: [{ id: 'normal', serviceRate: 1 }] });
    const result = controlQueue(input);
    expect(result.allocations[1].capacity).toBeGreaterThan(0);
    expect(result.allocations.reduce((sum, a) => sum + a.slots, 0)).toBe(2);
    expect(result.planner.rate).toBe(0);
    if (donorRate > 0) {
      result.allocations.forEach((a, i) => { input.stages[i].slots = a.slots; });
      input.stages[1].queued = 0;
      expect(controlQueue(input).planner.rate).toBeGreaterThan(0);
    }
  });

  it('selects a measured faster authorized tier when slots are exhausted', () => {
    const input = fixture();
    input.pools[0].slots = 3;
    input.stages[0].queued = 30;
    input.stages[0].tiers.push({ id: 'fast', serviceRate: 5 });
    const result = controlQueue(input);
    expect(result.allocations[0]).toMatchObject({ slots: 1, tier: 'fast', capacity: 5 });
  });

  it('drains finite work even when a pool cannot run every stage simultaneously', () => {
    const input = fixture();
    input.stages = input.stages.slice(0, 2);
    input.pools[0].slots = 1;
    input.stages.forEach((s) => { s.minSlots = 0; s.maxSlots = 1; });
    input.stages[1].slots = 0;
    input.stages[1].queued = 5;
    const result = controlQueue(input);
    expect(result.allocations.map((a) => a.slots)).toEqual([0, 1]);
    expect(result.allocations[1].capacity * input.windowSeconds).toBeGreaterThanOrEqual(5);
    expect(result.planner.rate).toBe(0);
  });

  it('uses measured batch throughput rather than multiplying batch size', () => {
    const input = fixture();
    input.pools[0].slots = 3;
    input.stages[2].queued = 100;
    input.stages[2].batches.push({ size: 2, serviceRate: 3 }, { size: 8, serviceRate: 2.5 });
    expect(controlQueue(input).allocations[2]).toMatchObject({ batchSize: 2, capacity: 3 });
  });

  it('cannot turn an unavailable pool into capacity, and emits JSON-safe infinite pressure', () => {
    const input = fixture();
    input.pools[0].available = false;
    input.stages[0].queued = 1;
    const result = controlQueue(input);
    expect(result.bottleneck?.rho).toBeNull();
    expect(result.allocations.every((a) => a.capacity === 0 && a.slots === 0)).toBe(true);
    expect(result.planner.rate).toBe(0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('restocks idle pools and writes correlated pending bandit / LP inputs', () => {
    const result = controlQueue(fixture());
    expect(result.planner).toMatchObject({ mode: 'restock', rate: 1 });
    expect(result.bandit).toMatchObject({ decisionId: result.id, reward: null, status: 'awaiting-observation' });
    expect(result.lpInputs).toMatchObject({ issue: 938, decisionId: result.id, plannerRateLimit: 1 });
    expect(result.lpInputs.stages.map((s) => s.capacity)).toEqual(result.allocations.map((s) => s.capacity));
  });

  it('allocates idle zero-slot stages until planning can resume', () => {
    const input = fixture();
    input.stages.forEach((s) => { s.slots = 0; s.minSlots = 0; });
    for (let tick = 0; tick < 3; tick++) {
      const result = controlQueue(input);
      result.allocations.forEach((a, i) => { input.stages[i].slots = a.slots; });
    }
    expect(controlQueue(input).planner.rate).toBe(1);
  });

  it('is pure, deterministic, and strips unrelated metadata before persistence', () => {
    const input = fixture();
    const copy = structuredClone(input);
    const result = controlQueue({ ...input, unrelated: 'not-for-output' });
    expect(input).toEqual(copy);
    expect(controlQueue(input)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain('not-for-output');
  });

  it.each([
    (s: QueueSnapshot) => { s.windowSeconds = 0; },
    (s: QueueSnapshot) => { s.targetUtilization = 1; },
    (s: QueueSnapshot) => { s.stages[0].queued = NaN; },
    (s: QueueSnapshot) => { s.stages[0].tiers[0].serviceRate = Number.MIN_VALUE; },
    (s: QueueSnapshot) => { s.stages[0].arrivals = -1; },
    (s: QueueSnapshot) => { s.stages[0].slots = 1.5; },
    (s: QueueSnapshot) => { s.stages[0].maxSlots = 0; },
    (s: QueueSnapshot) => { s.stages[0].tier = 'missing'; },
    (s: QueueSnapshot) => { s.stages[0].pool = 'missing'; },
    (s: QueueSnapshot) => { s.stages[1].id = s.stages[0].id; },
    (s: QueueSnapshot) => { s.pools[0].slots = 1; },
    (s: QueueSnapshot) => { s.stream = '../escape'; },
    (s: QueueSnapshot) => { s.stages[2].batches = []; },
    (s: QueueSnapshot) => { s.stages[0].impact = true; },
    (s: QueueSnapshot) => { s.stages[2].tiers.push({ id: 'fast', serviceRate: 4 }); },
  ])('rejects invalid or contradictory telemetry %#', (mutate) => {
    const input = fixture(); mutate(input);
    expect(() => controlQueue(input)).toThrow('queue:');
  });
});

describe('overload acceptance: work-conserving pipeline simulation', () => {
  it.each([1, 7, 19, 41])('converges under variable arrivals with no persistent queue (seed %i)', (seed) => {
    const input = fixture();
    input.plannerRate = 1.2;
    input.stages[1].tiers = [{ id: 'normal', serviceRate: 0.3 }, { id: 'fast', serviceRate: 1.2 }];
    input.stages[2].batches = [{ size: 1, serviceRate: 0.5 }, { size: 3, serviceRate: 2 }];
    input.stages[0].queued = 100;
    let admitted = 100;
    let completed = 0;
    let state = seed;
    const tail: number[] = [];
    const seenBottlenecks = new Set<string>();
    for (let tick = 0; tick < 200; tick++) {
      input.observedAt += 10000;
      const decision = controlQueue(input);
      if (decision.bottleneck) seenBottlenecks.add(decision.bottleneck.stage);
      decision.allocations.forEach((a, i) => {
        Object.assign(input.stages[i], { slots: a.slots, tier: a.tier, impact: a.impact, batchSize: a.batchSize });
      });
      // Deterministic jitter never exceeds the admitted rate; no work is discarded.
      state = (state * 1664525 + 1013904223) >>> 0;
      let incoming = decision.planner.rate * input.windowSeconds * (0.6 + (state / 2 ** 32) * 0.4);
      admitted += incoming;
      input.stages.forEach((stage, i) => {
        stage.previousQueued = stage.queued;
        stage.arrivals = incoming;
        const available = stage.queued + incoming;
        const processed = Math.min(available, decision.allocations[i].capacity * input.windowSeconds);
        stage.queued = available - processed;
        incoming = processed;
      });
      completed += incoming;
      const backlog = input.stages.reduce((sum, s) => sum + s.queued, 0);
      expect(completed + backlog).toBeCloseTo(admitted, 6);
      expect(decision.allocations.reduce((n, a) => n + a.slots, 0)).toBeLessThanOrEqual(input.pools[0].slots);
      if (tick >= 170) {
        tail.push(backlog);
        expect(decision.planner.rate).toBeGreaterThan(0);
      }
    }
    expect(seenBottlenecks.size).toBeGreaterThan(1);
    expect(Math.max(...tail)).toBe(0);
    expect(completed).toBeGreaterThan(1000);
  });

  it('keeps work during an outage, then drains and resumes without persistent queues', () => {
    const input = fixture();
    input.stages[1].queued = 50;
    let completed = 0;
    let admitted = 50;
    for (let tick = 0; tick < 50; tick++) {
      input.pools[0].available = tick >= 5;
      const decision = controlQueue(input);
      let incoming = decision.planner.rate * input.windowSeconds;
      admitted += incoming;
      input.stages.forEach((s, i) => {
        s.previousQueued = s.queued;
        s.arrivals = incoming;
        const processed = Math.min(s.queued + incoming, decision.allocations[i].capacity * input.windowSeconds);
        s.queued += incoming - processed;
        incoming = processed;
        s.slots = decision.allocations[i].slots;
      });
      completed += incoming;
      expect(completed + input.stages.reduce((n, s) => n + s.queued, 0)).toBeCloseTo(admitted);
      if (tick < 5) expect(completed).toBe(0);
      if (tick > 20) {
        expect(input.stages.every((s) => s.queued === 0)).toBe(true);
        expect(decision.planner.rate).toBeGreaterThan(0);
      }
    }
  });
});
