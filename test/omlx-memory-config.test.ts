import { describe, expect, it } from 'vitest';
import { planOmlxConfig } from '../src/core/local-runtime/omlx/config.js';

const GiB = 1024 ** 3;
const now = 1_000_000;
const model = (id: string, budget = 8, engine = 'mlx', longContext = false) => ({ id, budgetBytes: budget * GiB, engine, longContext });
const request = () => ({
  version: '0.7.2',
  memguard: { totalBytes: 100 * GiB, freeBytes: 70 * GiB, headroomBytes: 50 * GiB, capturedAtMs: now },
  models: [model('coder'), model('reviewer', 8, 'mlx', true), model('planner', 12, 'splash')],
});

describe('oMLX local tier memory configuration', () => {
  it('binds IPv4 loopback and emits native 8-bit defaults, 4-bit long context and explicit Splash cap', () => {
    const plan = planOmlxConfig(request(), now);
    expect(plan.settings.server).toEqual({ host: '127.0.0.1', port: 8000 });
    expect(plan.settings.memory).toEqual({ prefill_memory_guard: true, memory_guard_tier: 'custom', memory_guard_custom_ceiling_gb: 40 });
    expect(plan.settings.integrations).toEqual({ splash_kv_format: 'int8', splash_max_memory_gb: 12 });
    expect(plan.modelSettings.models.coder).toMatchObject({ turboquant_kv_enabled: true, turboquant_kv_scheme: 'affine8', turboquant_kv_bits: 8, external_engine: null });
    expect(plan.modelSettings.models.reviewer).toMatchObject({ turboquant_kv_scheme: 'affine4', turboquant_kv_bits: 4 });
    expect(plan.modelSettings.models.planner.external_engine).toBe('splash');
  });

  it('runs several fake models concurrently within one fake memguard allowance', async () => {
    const input = request();
    input.memguard.headroomBytes = 28 * GiB;
    const plan = planOmlxConfig(input, now);
    let resident = 0;
    let peak = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const running = input.models.map(async (entry) => {
      resident += entry.budgetBytes;
      peak = Math.max(peak, resident);
      await barrier;
      resident -= entry.budgetBytes;
    });
    expect(peak).toBe(plan.allocatedBytes);
    expect(peak).toBeLessThanOrEqual(plan.budgetBytes);
    expect(input.memguard.freeBytes - peak).toBeGreaterThanOrEqual(plan.reserveBytes);
    expect(() => planOmlxConfig({ ...input, models: [...input.models, model('overflow', 1)] }, now)).toThrow('exceed');
    release();
    await Promise.all(running);
    expect(resident).toBe(0);
  });

  it('rounds the ceiling down and keeps at least 30% free at the boundary', () => {
    const input = request();
    input.memguard.freeBytes = 38 * GiB + 123;
    input.memguard.headroomBytes = 9 * GiB;
    input.models = [model('exact', 8)];
    const plan = planOmlxConfig(input, now);
    expect(plan.budgetBytes).toBe(8 * GiB);
    expect(input.memguard.freeBytes - plan.budgetBytes).toBeGreaterThanOrEqual(30 * GiB);
    expect(() => planOmlxConfig({ ...input, models: [model('too-large', 9)] }, now)).toThrow('exceed');
  });

  it.each([null, undefined, [], {}, { version: '0.7.2' }])('refuses absent snapshot input %j', (input) => {
    expect(() => planOmlxConfig(input, now)).toThrow();
  });

  it('accepts the freshness boundary and keeps prototype-like model IDs distinct', () => {
    const input = request();
    input.memguard.capturedAtMs = now - 30_000;
    input.models = [model('constructor'), model('toString')];
    const models = planOmlxConfig(input, now).modelSettings.models;
    expect(Object.keys(models)).toEqual(['constructor', 'toString']);
    expect(JSON.parse(JSON.stringify(models)).constructor.turboquant_kv_bits).toBe(8);
  });

  it('caps every Splash instance to the smallest allocation since its setting is global', () => {
    const plan = planOmlxConfig({ ...request(), models: [model('a', 12, 'splash'), model('b', 8, 'splash')] }, now);
    expect(plan.settings.integrations.splash_max_memory_gb).toBe(8);
  });

  it('refuses unsupported Splash 4-bit instead of silently using 8-bit', () => {
    expect(() => planOmlxConfig({ ...request(), models: [model('long', 8, 'splash', true)] }, now)).toThrow('require the MLX');
  });

  it.each(['0.7.1', '0.6.9', '0.7.2-rc1', '', 'garbage'])('refuses version %s', (version) => {
    expect(() => planOmlxConfig({ ...request(), version }, now)).toThrow('stable version');
  });
  it.each(['0.7.2', '0.7.10', '0.8.0', '1.0.0'])('accepts stable version %s', (version) => {
    expect(planOmlxConfig({ ...request(), version }, now).budgetBytes).toBe(40 * GiB);
  });

  it.each([
    { capturedAtMs: now - 30_001 }, { capturedAtMs: now + 1 },
    { totalBytes: 0 }, { freeBytes: 101 * GiB }, { freeBytes: 29 * GiB },
    { headroomBytes: 0 }, { headroomBytes: -1 }, { headroomBytes: NaN },
    { headroomBytes: Infinity }, { headroomBytes: '100' }, { headroomBytes: 1.5 },
  ])('fails closed on unusable memguard data %j', (patch) => {
    const input = request();
    expect(() => planOmlxConfig({ ...input, memguard: { ...input.memguard, ...patch } }, now)).toThrow();
  });

  it.each([
    [], [model('same'), model('same')], [model('bad id')], [model('zero', 0)],
    [model('bad', 1, 'other')], [{ ...model('bad'), longContext: 'true' }],
    [{ ...model('bad'), budgetBytes: 123 }],
  ])('refuses malformed model plans %j', (models) => {
    expect(() => planOmlxConfig({ ...request(), models }, now)).toThrow();
  });
});
