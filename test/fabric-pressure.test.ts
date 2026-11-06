import { describe, expect, it } from 'vitest';
import {
  computePressureVectors, PRESSURE_LIMITS,
  type PoolPressureEvent, type PressureInput, type PressureLane, type PressureReading,
} from '../src/core/fabric/pressure.js';

const NOW = Date.parse('2026-10-26T16:28:00Z');
const reading = <T>(value: T, ageMs = 0): PressureReading<T> => ({ value, observedAtMs: NOW - ageMs });

function lane(overrides: Partial<PressureLane> = {}): PressureLane {
  return {
    laneId: 'TEST-code', poolId: 'TEST-pool', modelId: 'TEST-model', seatId: 'TEST-seat', configuredSlots: 8,
    credit: {
      capacity: {
        seatId: 'TEST-seat', engine: 'codex', label: 'TEST-seat', free: false,
        windows: [{ id: 'primary', usedPercent: 10, resetsAt: new Date(NOW + 3_600_000).toISOString(),
          resetDescription: null, limitReached: false }],
        signedOut: false, reachable: true, contextWindow: null,
        observedAt: new Date(NOW).toISOString(), spentTodayUsd: 0,
      },
      policy: { seatId: 'TEST-seat', enabled: true, reservePercent: 20 },
    },
    ...overrides,
  };
}

function input(overrides: Partial<PressureInput> = {}): PressureInput {
  return {
    nowMs: NOW, lanes: [lane()],
    host: { memguard: reading('RUN'), freeDiskBytes: reading(100 * 1024 ** 3), swapUsedBytes: reading(0) },
    poolEvents: reading([]), ...overrides,
  };
}

function project(value = input()) {
  const vectors = computePressureVectors(value);
  expect(vectors).toHaveLength(value.lanes.length);
  return vectors[0]!;
}

const rateLimit = (overrides: Partial<Extract<PoolPressureEvent, { kind: 'rate_limit' }>> = {}): PoolPressureEvent =>
  ({ kind: 'rate_limit', poolId: 'TEST-pool', retryAtMs: NOW + 60_000, ...overrides });
const modelCapacity = (overrides: Partial<Extract<PoolPressureEvent, { kind: 'model_capacity' }>> = {}): PoolPressureEvent =>
  ({ kind: 'model_capacity', poolId: 'TEST-pool', modelId: 'TEST-model', slotTarget: 2, retryAtMs: null, ...overrides });

describe('ONE-TEAM lane pressure', () => {
  it('returns all six signals and full capacity for fresh healthy evidence', () => {
    const result = project();
    expect(result).toMatchObject({ laneId: 'TEST-code', evaluatedAtMs: NOW, recommendedSlotTarget: 8 });
    expect(Object.keys(result.signals)).toEqual(['memguard', 'freeDisk', 'swap', 'rateLimit', 'modelCapacity', 'credit']);
    expect(Object.values(result.signals).every(signal => signal.state === 'clear' && signal.slotTarget === 8)).toBe(true);
  });

  it('memguard PAUSE stops the lane', () => {
    const base = input();
    expect(project({ ...base, host: { ...base.host, memguard: reading('PAUSE') } }).recommendedSlotTarget).toBe(0);
  });

  it.each([
    [PRESSURE_LIMITS.diskStopBytes, 0], [PRESSURE_LIMITS.diskStopBytes + 1, 4],
    [PRESSURE_LIMITS.diskWarningBytes, 4], [PRESSURE_LIMITS.diskWarningBytes + 1, 8],
  ])('free disk %s bytes clamps to %s slots', (bytes, target) => {
    const base = input();
    expect(project({ ...base, host: { ...base.host, freeDiskBytes: reading(bytes) } }).recommendedSlotTarget).toBe(target);
  });

  it.each([
    [PRESSURE_LIMITS.swapWarningBytes - 1, 8], [PRESSURE_LIMITS.swapWarningBytes, 4],
    [PRESSURE_LIMITS.swapStopBytes - 1, 4], [PRESSURE_LIMITS.swapStopBytes, 0],
  ])('swap %s bytes clamps to %s slots', (bytes, target) => {
    const base = input();
    expect(project({ ...base, host: { ...base.host, swapUsedBytes: reading(bytes) } }).recommendedSlotTarget).toBe(target);
  });

  it('rate limits affect the whole matching pool, regardless of model', () => {
    const lanes = [lane(), lane({ laneId: 'TEST-second', modelId: 'TEST-other-model' }),
      lane({ laneId: 'TEST-other-pool', poolId: 'TEST-other-pool' })];
    const result = computePressureVectors(input({ lanes, poolEvents: reading([rateLimit()]) }));
    expect(result.map(vector => vector.recommendedSlotTarget)).toEqual([0, 0, 8]);
  });

  it('model capacity only clamps matching pool and model', () => {
    const lanes = [lane(), lane({ laneId: 'TEST-second', modelId: 'TEST-other-model' }),
      lane({ laneId: 'TEST-other-pool', poolId: 'TEST-other-pool' })];
    const result = computePressureVectors(input({ lanes, poolEvents: reading([modelCapacity()]) }));
    expect(result.map(vector => vector.recommendedSlotTarget)).toEqual([2, 8, 8]);
  });

  it.each([0, 1, 12])('model ceiling %s never increases configured capacity', slotTarget => {
    expect(project(input({ poolEvents: reading([modelCapacity({ slotTarget })]) })).recommendedSlotTarget)
      .toBe(Math.min(slotTarget, 8));
  });

  it.each([NOW - 1, NOW])('expired events at %s do not clamp a fresh snapshot', retryAtMs => {
    expect(project(input({ poolEvents: reading([rateLimit({ retryAtMs }), modelCapacity({ retryAtMs })]) }))
      .recommendedSlotTarget).toBe(8);
  });

  it('an event without a retry time remains active until removed from a fresh snapshot', () => {
    expect(project(input({ poolEvents: reading([rateLimit({ retryAtMs: null })]) })).recommendedSlotTarget).toBe(0);
    expect(project(input({ poolEvents: reading([]) })).recommendedSlotTarget).toBe(8);
  });

  it.each([NaN, Infinity, -1])('invalid matching event expiry %s is unknown', retryAtMs => {
    expect(project(input({ poolEvents: reading([rateLimit({ retryAtMs })]) })).signals.rateLimit.state).toBe('unknown');
  });

  it.each([NaN, Infinity, -1, 1.5])('invalid model capacity %s is unknown', slotTarget => {
    expect(project(input({ poolEvents: reading([modelCapacity({ slotTarget })]) })).signals.modelCapacity.state).toBe('unknown');
  });

  it.each([0, 60, 80, 100])('uses credit headroom after the configured reserve at %s percent used', usedPercent => {
    const current = lane();
    current.credit!.capacity.windows[0]!.usedPercent = usedPercent;
    const target = usedPercent >= 80 ? 0 : usedPercent >= 60 ? 4 : 8;
    expect(project(input({ lanes: [current] })).recommendedSlotTarget).toBe(target);
  });

  it.each(['disabled', 'signed-out', 'stale', 'future', 'missing', 'spent', 'session-ceiling', 'daily-cap', 'unknown-spend', 'wrong-seat'])(
    'preserves routing credit denial for %s evidence', cause => {
      const current = lane();
      const { capacity, policy } = current.credit!;
      if (cause === 'disabled') policy.enabled = false;
      if (cause === 'signed-out') capacity.signedOut = true;
      if (cause === 'stale') capacity.observedAt = new Date(NOW - 16 * 60_000).toISOString();
      if (cause === 'future') capacity.observedAt = new Date(NOW + 1).toISOString();
      if (cause === 'missing') capacity.windows[0]!.usedPercent = null;
      if (cause === 'spent') capacity.windows[0]!.limitReached = true;
      if (cause === 'session-ceiling') policy.maxSessionWindowPercent = 10;
      if (cause === 'daily-cap') policy.dailyUsdCap = 0;
      if (cause === 'unknown-spend') { policy.dailyUsdCap = 10; capacity.spentTodayUsd = null; }
      if (cause === 'wrong-seat') policy.seatId = 'TEST-other-seat';
      expect(project(input({ lanes: [current] })).recommendedSlotTarget).toBe(0);
    });

  it('holds unknown credit and respects windowless local headroom', () => {
    expect(project(input({ lanes: [lane({ credit: null })] })).signals.credit.state).toBe('unknown');
    const local = lane();
    Object.assign(local.credit!.capacity, { engine: 'local', free: true, windows: [], observedAt: null });
    expect(project(input({ lanes: [local] })).recommendedSlotTarget).toBe(8);
  });

  it('marks stale credit as unknown, including when a cached percentage remains', () => {
    const current = lane();
    current.credit!.capacity.observedAt = new Date(NOW - 16 * 60_000).toISOString();
    expect(project(input({ lanes: [current] })).signals.credit).toMatchObject({ state: 'unknown', slotTarget: 0 });
  });

  it('does not turn rounded zero credit headroom into additional concurrency', () => {
    const current = lane();
    current.credit!.capacity.windows[0]!.usedPercent = 79.8;
    expect(project(input({ lanes: [current] })).recommendedSlotTarget).toBe(0);
  });

  it('preserves the API grant boundary even for a claimed free seat', () => {
    const current = lane();
    Object.assign(current.credit!.capacity, { engine: 'claude-api', free: true, windows: [] });
    expect(project(input({ lanes: [current] })).recommendedSlotTarget).toBe(0);
  });

  it.each([NaN, Infinity, -1, 101])('rejects malformed credit percentages %s', usedPercent => {
    const current = lane();
    current.credit!.capacity.windows[0]!.usedPercent = usedPercent;
    expect(project(input({ lanes: [current] })).signals.credit.state).toBe('unknown');
  });

  it('takes the combined minimum, never multiplying warning reductions', () => {
    const current = lane();
    current.credit!.capacity.windows[0]!.usedPercent = 60;
    const combined = input({ lanes: [current],
      host: { memguard: reading('RUN'), freeDiskBytes: reading(PRESSURE_LIMITS.diskWarningBytes),
        swapUsedBytes: reading(PRESSURE_LIMITS.swapWarningBytes) },
      poolEvents: reading([modelCapacity({ slotTarget: 3 })]),
    });
    expect(project(combined).recommendedSlotTarget).toBe(3);
    expect(project({ ...combined, poolEvents: reading([]) }).recommendedSlotTarget).toBe(4);
    expect(project({ ...combined, poolEvents: reading([rateLimit(), modelCapacity()]) }).recommendedSlotTarget).toBe(0);
    expect(project({ ...combined, host: { ...combined.host, memguard: reading('PAUSE') } }).recommendedSlotTarget).toBe(0);
  });

  it.each(['memguard', 'freeDiskBytes', 'swapUsedBytes', 'poolEvents'] as const)(
    'missing, stale and future %s observations fail closed', key => {
      for (const age of [null, PRESSURE_LIMITS.readingMaxAgeMs + 1, -1]) {
        const base = input();
        const original = key === 'poolEvents' ? base.poolEvents! : base.host[key]!;
        const observation = age === null ? null : { ...original, observedAtMs: NOW - age };
        const changed = key === 'poolEvents' ? { ...base, poolEvents: observation } : { ...base, host: { ...base.host, [key]: observation } };
        expect(project(changed as PressureInput).recommendedSlotTarget).toBe(0);
      }
    });

  it('accepts the exact freshness boundary', () => {
    const age = PRESSURE_LIMITS.readingMaxAgeMs;
    expect(project(input({
      host: { memguard: reading('RUN', age), freeDiskBytes: reading(100 * 1024 ** 3, age), swapUsedBytes: reading(0, age) },
      poolEvents: reading([], age),
    })).recommendedSlotTarget).toBe(8);
  });

  it.each([NaN, Infinity, -1, 1.5])('invalid host byte value %s is unknown', value => {
    const base = input();
    const result = project({ ...base, host: { ...base.host, freeDiskBytes: reading(value), swapUsedBytes: reading(value) } });
    expect(result.signals.freeDisk.state).toBe('unknown');
    expect(result.signals.swap.state).toBe('unknown');
    expect(result.recommendedSlotTarget).toBe(0);
  });

  it.each([0, 1, 3])('preserves zero and rounds warning capacity upward for %s slots', configuredSlots => {
    const base = input({ lanes: [lane({ configuredSlots })] });
    expect(project({ ...base, host: { ...base.host, swapUsedBytes: reading(PRESSURE_LIMITS.swapWarningBytes) } })
      .recommendedSlotTarget).toBe(Math.ceil(configuredSlots / 2));
  });

  it('distinguishes configured zero concurrency from an actual signal brake', () => {
    const base = input({ lanes: [lane({ configuredSlots: 0 })] });
    expect(Object.values(project(base).signals).every(signal => signal.state === 'clear')).toBe(true);
    expect(project({ ...base, host: { ...base.host, memguard: reading('PAUSE') } }).signals.memguard.state).toBe('blocked');
    expect(project({ ...base, poolEvents: reading([rateLimit()]) }).signals.rateLimit.state).toBe('blocked');
    expect(project({ ...base, poolEvents: reading([modelCapacity({ slotTarget: 0 })]) }).signals.modelCapacity.state).toBe('blocked');
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid configured slot count %s', configuredSlots => {
    expect(() => computePressureVectors(input({ lanes: [lane({ configuredSlots })] }))).toThrow(RangeError);
  });

  it('rejects duplicate lane IDs, empty scope and invalid clocks', () => {
    expect(() => computePressureVectors(input({ lanes: [lane(), lane()] }))).toThrow(RangeError);
    expect(() => computePressureVectors(input({ lanes: [lane({ poolId: '' })] }))).toThrow(RangeError);
    expect(() => computePressureVectors(input({ nowMs: NaN }))).toThrow(RangeError);
    expect(computePressureVectors(input({ lanes: [] }))).toEqual([]);
  });

  it('is deterministic, order independent and leaves snapshots untouched', () => {
    const events = [modelCapacity(), modelCapacity({ slotTarget: 5 }), modelCapacity()];
    const snapshot = input({ poolEvents: reading(events) });
    const before = structuredClone(snapshot);
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
    };
    freeze(snapshot);
    const first = project(snapshot);
    expect(project(snapshot)).toEqual(first);
    expect(project(input({ poolEvents: reading([...events].reverse()) }))).toEqual(first);
    expect(snapshot).toEqual(before);
  });
});
