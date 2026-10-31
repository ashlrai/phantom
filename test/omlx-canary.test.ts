import { describe, expect, it } from 'vitest';
import { planOmlxConfig } from '../src/core/local-runtime/omlx/config.js';

const GiB = 1024 ** 3;
const now = 1_000_000;
const model = (id: string, budget = 8, engine = 'mlx', longContext = false) => ({ id, budgetBytes: budget * GiB, engine, longContext });
const canary = (lane = 'planner', patch: Record<string, unknown> = {}) => ({
  lane,
  version: '0.7.3rc1',
  provenance: { cut: 'core', pin: 'security', install: 'masbot' },
  incompleteToolCall: 'retry-then-reroute',
  judge: { cacheStore: false, logprobs: true },
  eval: 'flint',
  ...patch,
});
const request = (patch: Record<string, unknown> = {}) => ({
  version: '0.7.2',
  memguard: { totalBytes: 100 * GiB, freeBytes: 70 * GiB, headroomBytes: 50 * GiB, wiredLimitBytes: 60 * GiB, capturedAtMs: now },
  models: [model('coder'), model('reviewer', 8, 'mlx', true), model('planner', 12, 'splash')],
  canary: canary(),
  ...patch,
});

describe('oMLX 0.7.3rc1 canary on one loopback lane', () => {
  it('keeps 0.7.2 the default and pins one model to the rc on its own loopback port', () => {
    const plan = planOmlxConfig(request(), now);
    expect(plan.settings.server).toEqual({ host: '127.0.0.1', port: 8000 });
    expect(Object.keys(plan.modelSettings.models)).toEqual(['coder', 'reviewer']);
    expect(plan.canary).toMatchObject({
      lane: 'planner', version: '0.7.3rc1', budgetBytes: 12 * GiB,
      provenance: { cut: 'core', pin: 'security', install: 'masbot' },
      settings: { server: { host: '127.0.0.1', port: 8001 } },
      policy: {
        on_incomplete_tool_call: 'retry-then-reroute',
        judge: { cache_store: false, logprobs_confidence: true },
        eval: 'flint',
      },
    });
    expect(plan.canary?.modelSettings.models.planner.external_engine).toBe('splash');
  });

  it('splits the wired-limit ceiling so neither lane can oversubscribe the host', () => {
    const input = request();
    input.memguard.headroomBytes = 100 * GiB;
    input.memguard.wiredLimitBytes = 40 * GiB;
    const plan = planOmlxConfig(input, now);
    expect(plan.budgetBytes).toBe(40 * GiB);
    expect(plan.settings.memory.memory_guard_custom_ceiling_gb).toBe(28);
    expect(plan.canary?.budgetBytes).toBe(12 * GiB);
    expect(plan.canary?.settings.memory.memory_guard_custom_ceiling_gb).toBe(12);
    expect(plan.canary?.settings.integrations).toEqual({ splash_kv_format: 'int8', splash_max_memory_gb: 12 });
    expect(plan.settings.integrations.splash_max_memory_gb).toBe(28);
  });

  it('emits no splash cap on an mlx canary lane and lets the canary keep 4-bit long context', () => {
    const input = request({ models: [model('coder'), model('judge-lane', 16, 'mlx', true)], canary: canary('judge-lane') });
    const plan = planOmlxConfig(input, now);
    expect(plan.canary?.modelSettings.models['judge-lane']).toMatchObject({ turboquant_kv_scheme: 'affine4', turboquant_kv_bits: 4 });
    expect(plan.canary?.settings.integrations).toBeUndefined();
    expect(plan.settings.integrations.splash_max_memory_gb).toBe(24);
  });

  it('tightens the default ceiling with a live wired limit even without a canary', () => {
    const input = request();
    delete input.canary;
    const plan = planOmlxConfig(input, now);
    expect(plan.budgetBytes).toBe(40 * GiB);
    expect(plan.settings.memory.memory_guard_custom_ceiling_gb).toBe(40);
    expect(plan.canary).toBeUndefined();
  });

  it('refuses a canary without the live memguard wired limit', () => {
    const input = request();
    delete (input.memguard as Record<string, unknown>).wiredLimitBytes;
    expect(() => planOmlxConfig(input, now)).toThrow('wired limit');
    expect(() => planOmlxConfig({ ...input, memguard: { ...input.memguard, wiredLimitBytes: 101 * GiB } }, now)).toThrow('Inconsistent');
  });

  it.each([
    '0.7.3', '0.7.2', '0.7.4rc1', '0.7.3rc0', '0.7.3-rc1', '0.8.0rc1', '', 'garbage',
  ])('refuses canary version %s — only the 0.7.3 rc line canaries', (version) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { version }) }), now)).toThrow('release candidate');
  });
  it.each(['0.7.3rc1', '0.7.3rc2', '0.7.3rc12'])('accepts canary version %s', (version) => {
    expect(planOmlxConfig(request({ canary: canary('planner', { version }) }), now).canary?.version).toBe(version);
  });

  it.each([
    { cut: 'qa' }, { pin: 'qa' }, { install: 'brew' },
    { cut: 'core', pin: 'security' }, { cut: 'core', pin: 'security', install: 'masbot', by: 'anyone' },
  ])('refuses install provenance %j — only a Core cut, Security pin and Masbot', (provenance) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { provenance }) }), now)).toThrow('Core cut, Security pin and Masbot');
  });
  it.each(['masbot', null, []])('refuses non-object provenance %j', (provenance) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { provenance }) }), now)).toThrow();
  });

  it.each(['retry', 'fail', 'reroute', null, true])('refuses incomplete_tool_call policy %j — retry then reroute only', (incompleteToolCall) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { incompleteToolCall }) }), now)).toThrow('retry-then-reroute');
  });

  it.each([
    { cacheStore: true, logprobs: true }, { cacheStore: false, logprobs: false },
    { cacheStore: false }, { logprobs: true }, { cacheStore: false, logprobs: true, extra: 1 },
    null, 'off',
  ])('refuses judge config %j — cache-store off and logprobs confidence only', (judge) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { judge }) }), now)).toThrow();
  });

  it.each(['other-eval', 'flint2', '', null, false])('refuses eval %j — the Flint eval rerun is required', (evalName) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { eval: evalName }) }), now)).toThrow('Flint');
  });

  it.each([8000, 0, -1, 65536, 1.5, '8001', null])('refuses canary port %j', (port) => {
    expect(() => planOmlxConfig(request({ canary: canary('planner', { port }) }), now)).toThrow('port');
  });
  it('accepts a distinct loopback port', () => {
    expect(planOmlxConfig(request({ canary: canary('planner', { port: 8002 }) }), now).canary?.settings.server.port).toBe(8002);
  });

  it('refuses a lane that is not a planned model, an all-canary plan and unknown keys', () => {
    expect(() => planOmlxConfig(request({ canary: canary('ghost') }), now)).toThrow('one planned model');
    expect(() => planOmlxConfig(request({ models: [model('planner', 12, 'splash')] }), now)).toThrow('default lane');
    expect(() => planOmlxConfig(request({ canary: canary('planner', { extra: true }) }), now)).toThrow('Unrecognized canary key');
    expect(() => planOmlxConfig(request({ canary: 'planner' }), now)).toThrow();
    expect(() => planOmlxConfig(request({ canary: canary('bad lane') }), now)).toThrow('model id');
  });

  it('still enforces the shared budget across both lanes', () => {
    const input = request({ models: [model('coder', 30), model('planner', 12, 'splash')] });
    expect(() => planOmlxConfig(input, now)).toThrow('exceed');
    expect(planOmlxConfig(request(), now).allocatedBytes).toBe(28 * GiB);
  });
});
