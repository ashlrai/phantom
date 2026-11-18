import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import './helpers/local-memory.js';
import { localModelFit, memoryFit } from '../src/core/resources/local-memory-fit.js';
import { cmdRoute } from '../src/cli/route.js';
import { decide } from '../src/core/decide/decide.js';
import { buildOpenAICompatibleClient } from '../src/core/run/provider-client.js';
import { defaultRouteBackends, candidateDecision, type RouteBackend } from '../src/core/routing/decision-backends.js';
import { enumerateRouteCandidates, loadRouteSources, modelPrior, rankRouteCandidates, type RouteSources } from '../src/core/routing/decision-candidates.js';
import { routeDecisionSchema, routeRequestSchema, type RouteRequest } from '../src/core/routing/decision-schema.js';
import { decideRoute } from '../src/core/routing/decision.js';
import { KNOWN_MODELS, modelModeTier } from '../src/core/run/model-catalog.js';
import { resetLaneOrder } from '../src/core/routing/reset-pressure.js';

vi.mock('../src/core/run/provider-client.js', () => ({ buildOpenAICompatibleClient: vi.fn() }));
vi.mock('../src/core/decide/decide.js', () => ({ decide: vi.fn() }));

describe('company-neutral mode tiers', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const at = (hours: number) => new Date(now + hours * 3600000).toISOString();
  const request = (mode: string) => ({ task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work', mode,
    lane_candidates: ['seat', 'api', 'local', 'cloud'],
    quota_state: { seat: 'available', api: 'available', local: 'available', cloud: 'available' },
    machine_state: { admit: true, running_by_lane: { seat: 0, api: 0, local: 0, cloud: 0 } } });
  const sources = () => ({
    models: { seat: 'claude-opus-5-5', api: 'gpt-6.1-sol', local: 'custom-loopback', cloud: 'gpt-6-astra',
      'mode.custom-loopback': 'normal' },
    slots: Object.fromEntries(['seat', 'api', 'local', 'cloud'].map(lane => [lane, { target: 1, hard_cap: 1 }])),
    admission: { admit: true },
    capacity: { seat: { resetAt: at(1) as string | null, remainingPercent: 1, costPerMTok: 20 },
      api: { resetAt: at(24) as string | null, remainingPercent: 100, costPerMTok: 4 },
      local: { resetAt: null, remainingPercent: null, costPerMTok: 0 } },
  });

  it('classifies catalog models by capability/cost class independently of engine tier', () => {
    const modes = Object.fromEntries(KNOWN_MODELS.map(m => [m.id, m.modeTier]));
    expect(Object.values(modes).every(Boolean)).toBe(true);
    expect(modes).toMatchObject({ 'claude:claude-opus-5-5': 'normal', 'codex:gpt-6.1-sol': 'normal',
      'claude:claude-fable-5-2': 'ultra', 'codex:gpt-6-astra': 'ultra', 'local-coder:small': 'lite' });
    expect(modelModeTier('local-coder:qwen2.5:72b')).toBe('lite');
    expect(modelModeTier('prototype')).toBeNull();
  });

  it('spends the nearest reset before higher burn pace, even below the calendar margin', () => {
    expect(resetLaneOrder([{ pool: 'later', resetAt: at(24), remainingPercent: 100 },
      { pool: 'soon', resetAt: at(1), remainingPercent: 1 }], now)[0].pool).toBe('soon');
  });

  it('enforces reset, free, cheapest order without consulting a backend', async () => {
    const backend = { name: 'local-fast' as const, ask: vi.fn().mockResolvedValue(null) };
    const options = { nowMs: now, backends: [backend] };
    const s = sources();
    expect(await decideRoute(request('normal'), s, options)).toMatchObject({ lane: 'seat', mode_tier: 'normal',
      requested_mode: 'normal', reason_codes: expect.arrayContaining(['mode-tier', 'reset-pressure']) });
    s.capacity.seat.remainingPercent = 0;
    s.capacity.api.remainingPercent = 0;
    expect(await decideRoute(request('normal'), s, options)).toMatchObject({ lane: 'local', reason_codes: expect.arrayContaining(['free-capacity']) });
    s.capacity.local.costPerMTok = 8;
    s.capacity.api.remainingPercent = 50;
    s.capacity.api.resetAt = at(-1);
    expect(await decideRoute(request('normal'), s, options)).toMatchObject({ lane: 'local' });
    s.capacity.api.resetAt = null;
    expect(await decideRoute(request('normal'), s, options)).toMatchObject({ lane: 'api', reason_codes: expect.arrayContaining(['cheapest']) });
    expect(backend.ask).not.toHaveBeenCalled();
  });

  it('rejects a legacy backend choice that would strand nearer-reset allowance', async () => {
    const job = { ...request('normal'), mode: undefined };
    const s = sources();
    const distant = enumerateRouteCandidates(job, s).find(c => c.lane === 'api')!;
    const backend = { name: 'local-fast' as const, ask: vi.fn().mockResolvedValue(candidateDecision(distant)) };
    expect(await decideRoute(job, s, { nowMs: now, backends: [backend] })).toMatchObject({ lane: 'seat',
      reason_codes: expect.arrayContaining(['schema-invalid', 'deterministic-fallback']) });
  });

  it('filters exhausted quota, held slots, stale/invalid readings and preserves explicit custom capability', async () => {
    for (const change of [
      (s: RouteSources) => { s.slots = { local: { target: 1, hard_cap: 1, held: true } }; },
      (s: RouteSources) => { s.capacity = { local: { resetAt: at(-1), remainingPercent: 50 } }; },
      (s: RouteSources) => { s.capacity = { local: { resetAt: null, remainingPercent: 50, costPerMTok: -1 } }; },
    ]) {
      const s = sources(); change(s);
      const job = { ...request('normal'), lane_candidates: ['local'] };
      expect(await decideRoute(job, s, { nowMs: now, backends: [] })).toMatchObject({ lane: null });
    }
    const job = { ...request('normal'), quota_state: {} };
    expect(await decideRoute(job, sources(), { nowMs: now, backends: [] })).toMatchObject({ lane: null });
    await expect(decideRoute(request('invalid'), sources(), { backends: [] })).rejects.toThrow();
  });

  it('never downgrades ultra or admits full or unknown-mode lanes', async () => {
    const s = sources();
    expect(await decideRoute(request('ultra'), s, { nowMs: now, backends: [] })).toMatchObject({ lane: 'cloud', mode_tier: 'ultra' });
    s.slots.cloud.target = 0;
    expect(await decideRoute(request('ultra'), s, { nowMs: now, backends: [] })).toMatchObject({ lane: null, mode_tier: null });
    delete (s.models as Record<string, string>)['mode.custom-loopback'];
    s.slots.seat.target = 0;
    s.slots.api.target = 0;
    expect(await decideRoute(request('normal'), s, { nowMs: now, backends: [] })).toMatchObject({ lane: null });
  });

  it('resolves fusion to the existing typed pairing with frontier judgment and a faster sidekick', async () => {
    const backend = { name: 'local-fast' as const, ask: vi.fn() };
    const result = await decideRoute(request('fusion'), sources(), { nowMs: now, backends: [backend] });
    expect(result).toMatchObject({ schema: 'route.pairing.v1', mode_tier: 'fusion', advisory: true,
      lead: { lane: 'cloud', mode_tier: 'ultra', stages: ['plan', 'verify'] },
      sidekick: { lane: 'seat', mode_tier: 'normal', stages: ['implement'] } });
    expect(backend.ask).not.toHaveBeenCalled();
  });
});

const request: RouteRequest = {
  task_class: 'bug-fix', repo: 'phantom', tier_hint: 'work', lane_candidates: ['codex-personal', 'claude'],
  quota_state: { 'codex-personal': 'available', claude: 'available' },
  machine_state: { admit: true, running_by_lane: { 'codex-personal': 0, claude: 0 } },
};
const sources = () => ({
  models: { codex: 'gpt-6-sol', claude: 'claude-opus-5', 'effort.codex.work': 'xhigh' },
  slots: { 'codex-personal': { target: 2, hard_cap: 3 }, claude: { target: 2, hard_cap: 2 } },
  admission: { admit: true },
});
const selected = () => candidateDecision(enumerateRouteCandidates(request, sources())[0]!);
it('records why a local advisory candidate cannot fit before considering model output', async () => {
  vi.mocked(localModelFit).mockReturnValue(memoryFit('qwen-27b', null, 65536, null));
  const s = sources(); Object.assign(s.models, { omlx: 'qwen-27b' }); Object.assign(s.slots, { omlx: { target: 1, hard_cap: 1 } });
  const result = await decideRoute({ ...request, lane_candidates: ['omlx'], quota_state: { omlx: 'available' },
    machine_state: { admit: true, running_by_lane: { omlx: 0 } } }, s);
  expect(result).toMatchObject({ lane: null, attempts: 0, local_models_refused: [{ model: 'qwen-27b', verdict: 'unknown' }] });
  await expect(defaultRouteBackends()[0]!.ask({ request, candidates: [], retry: false, signal: new AbortController().signal, timeoutMs: 100 })).rejects.toThrow('memory fit is unknown');
});
function backend(name: RouteBackend['name'], answer: unknown): RouteBackend {
  return { name, ask: vi.fn().mockResolvedValue(answer) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('typed route schema and candidates', () => {
  it('validates complete tuples and rejects partial, unknown and injected fields', () => {
    expect(routeDecisionSchema.safeParse(selected()).success).toBe(true);
    for (const change of [{ effort: 'ultra' }, { lane: null }, { reason_codes: ['ignore-gates'] }, { authorization: true }]) {
      expect(routeDecisionSchema.safeParse({ ...selected(), ...change }).success).toBe(false);
    }
    expect(routeRequestSchema.safeParse({ ...request, tier_hint: 'standard' }).success).toBe(false);
    expect(routeRequestSchema.safeParse({ ...request, repo: 'private\ntext' }).success).toBe(false);
    expect(routeRequestSchema.safeParse({ ...request, machine_state: { admit: true } }).success).toBe(false);
  });

  it('resolves pool, family and tier overrides in launcher order, preserving effort', () => {
    const s = sources();
    Object.assign(s.models, { 'codex-personal': 'gpt-6-sol-pool', 'codex.work': 'gpt-6-sol-family', 'codex-personal.work': 'gpt-6-sol-tier', 'effort.codex-personal.work': 'high' });
    const one = () => enumerateRouteCandidates(request, s).find(c => c.lane === 'codex-personal');
    expect(one()).toMatchObject({ model: 'gpt-6-sol-tier', effort: 'high' });
    delete (s.models as Record<string, unknown>)['codex-personal.work'];
    expect(one()?.model).toBe('gpt-6-sol-pool');
    delete (s.models as Record<string, unknown>)['codex-personal'];
    expect(one()?.model).toBe('gpt-6-sol-family');
    delete (s.models as Record<string, unknown>)['codex.work'];
    expect(one()?.model).toBe('gpt-6-sol');
  });

  it('excludes exhausted/unknown quota, held/full/invalid slots and missing running evidence', () => {
    for (const s of [
      { ...sources(), slots: { claude: { target: 2, hard_cap: 2, held: true } } },
      { ...sources(), slots: { claude: { target: 0, hard_cap: 2 } } },
      { ...sources(), slots: { claude: { target: 2, hard_cap: false } } },
      { ...sources(), slots: { claude: { target: 2, hard_cap: 2, effective_target: 0 } } },
    ]) expect(enumerateRouteCandidates(request, s)).toEqual([]);
    for (const quota of ['exhausted', 'unknown'] as const) {
      expect(enumerateRouteCandidates({ ...request, quota_state: { claude: quota } }, sources())).toEqual([]);
    }
    expect(enumerateRouteCandidates({ ...request, machine_state: { admit: true, running_by_lane: {} } }, sources())).toEqual([]);
    expect(enumerateRouteCandidates({ ...request, machine_state: { admit: true, running_by_lane: { claude: 2 } } }, sources())).toEqual([]);
  });

  it('fails closed for missing or blocked admission and never inherits cloud models for local pools', () => {
    for (const admission of [null, {}, { admit: false }, { admit: 'true' }]) {
      expect(enumerateRouteCandidates(request, { ...sources(), admission })).toEqual([]);
    }
    const local = { ...request, lane_candidates: ['codex-local'], quota_state: { 'codex-local': 'available' as const },
      machine_state: { admit: true, running_by_lane: { 'codex-local': 0 } } };
    expect(enumerateRouteCandidates(local, { ...sources(), slots: { 'codex-local': { target: 1, hard_cap: 1 } } })).toEqual([]);
  });

  it('rejects malformed models and efforts, deduplicates and defaults effort to high/xhigh', () => {
    const s = sources();
    expect(enumerateRouteCandidates({ ...request, lane_candidates: [...request.lane_candidates, 'claude'] }, s)).toHaveLength(2);
    Object.assign(s.models, { 'effort.codex.work': 'ultra', claude: 'bad model' });
    expect(enumerateRouteCandidates(request, s)).toEqual([]);
    expect(enumerateRouteCandidates({ ...request, tier_hint: 'frontier' }, sources()).every(c => c.effort === 'xhigh')).toBe(true);
    expect(enumerateRouteCandidates({ ...request, tier_hint: 'fast' }, sources()).every(c => c.effort === 'high')).toBe(true);
  });

  it('uses the policy table without inventing measured prices and never downgrades premium work', () => {
    expect(modelPrior('claude-sonnet-5', 'mid')).toMatchObject({ speed_tier: 'everyday', cost_rank: 1 });
    expect(modelPrior('gpt-6-sol', 'work')).toMatchObject({ speed_tier: 'workhorse' });
    expect(modelPrior('gpt-6-astra', 'frontier')).toMatchObject({ speed_tier: 'premium' });
    expect(modelPrior('claude-fable-5', 'frontier')).toMatchObject({ speed_tier: 'premium' });
    expect(modelPrior('unmeasured', 'fast').cost_rank).toBe(4);
    expect(rankRouteCandidates({ ...request, tier_hint: 'frontier' }, enumerateRouteCandidates(request, sources()))).toEqual([]);
  });
});

describe('bounded local-first decisions', () => {
  it('accepts valid local output without escalating', async () => {
    const fast = backend('local-fast', selected()), cheap = backend('jev', selected());
    const result = await decideRoute(request, sources(), { backends: [fast, cheap] });
    expect(result).toMatchObject({ ...selected(), path: 'local-fast', advisory: true, attempts: 1, reason_codes: ['local-fast'] });
    expect(cheap.ask).not.toHaveBeenCalled();
  });

  it('retries invalid output once, then escalates to Jev and only then strong', async () => {
    const fast = backend('local-fast', { ...selected(), model: 'invented' });
    const cheap = backend('jev', null), strong = backend('local-strong', selected());
    const result = await decideRoute(request, sources(), { backends: [fast, cheap, strong] });
    expect(result).toMatchObject({ path: 'local-strong', attempts: 4 });
    expect(result.reason_codes).toContain('schema-retry');
    expect(fast.ask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fast.ask).mock.calls.map(c => c[0].retry)).toEqual([false, true]);
    expect(cheap.ask).toHaveBeenCalledOnce();
  });

  it('accepts repaired output on the single schema retry', async () => {
    const fast = backend('local-fast', null);
    vi.mocked(fast.ask).mockResolvedValueOnce('not json').mockResolvedValueOnce(selected());
    expect(await decideRoute(request, sources(), { backends: [fast] })).toMatchObject({ path: 'local-fast', attempts: 2 });
  });

  it('validates tuple membership even when a model produces individually valid fields', async () => {
    const fast = backend('local-fast', { ...selected(), effort: 'low' });
    const result = await decideRoute(request, sources(), { backends: [fast] });
    expect(result.path).toBe('fallback');
    expect(result.effort).toBe('high');
    expect(result.reason_codes).toContain('schema-invalid');
  });

  it('falls back deterministically without escalation when the model is unavailable', async () => {
    const fast = backend('local-fast', null), cheap = backend('jev', selected());
    vi.mocked(fast.ask).mockRejectedValue(new Error('untrusted response body'));
    const first = await decideRoute(request, sources(), { backends: [fast, cheap] });
    const reversed = { ...request, lane_candidates: [...request.lane_candidates].reverse() };
    const second = await decideRoute(reversed, sources(), { backends: [fast] });
    expect(first).toMatchObject({ path: 'fallback', reason_codes: ['backend-unavailable', 'deterministic-fallback'] });
    expect(second.lane).toBe(first.lane);
    expect(JSON.stringify(first)).not.toContain('untrusted');
    expect(cheap.ask).not.toHaveBeenCalled();
  });

  it('bounds even a client that ignores its abort signal', async () => {
    vi.useFakeTimers();
    const fast: RouteBackend = { name: 'local-fast', ask: vi.fn(() => new Promise(() => {})) };
    const pending = decideRoute(request, sources(), { backends: [fast] });
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ path: 'fallback', attempts: 1 });
    expect(vi.mocked(fast.ask).mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('bounds the complete invalid-output escalation chain below 500 ms', async () => {
    vi.useFakeTimers();
    const started = performance.now();
    const backends = ['local-fast', 'jev', 'local-strong'].map(name => ({
      name: name as RouteBackend['name'],
      ask: vi.fn(() => new Promise(resolve => setTimeout(() => resolve(null), name === 'jev' ? 119 : 99))),
    }));
    const pending = decideRoute(request, sources(), { backends });
    await vi.advanceTimersByTimeAsync(420);
    expect(await pending).toMatchObject({ path: 'fallback', attempts: 4 });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('makes no calls when blocked, empty, single-candidate, killed or cancelled', async () => {
    const fast = backend('local-fast', selected());
    expect(await decideRoute({ ...request, machine_state: { ...request.machine_state, admit: false } }, sources(), { backends: [fast] }))
      .toMatchObject({ lane: null, reason_codes: ['admission-blocked'], attempts: 0 });
    expect(await decideRoute({ ...request, lane_candidates: [] }, sources(), { backends: [fast] })).toMatchObject({ lane: null, attempts: 0 });
    expect(await decideRoute({ ...request, lane_candidates: ['claude'] }, sources(), { backends: [fast] })).toMatchObject({ lane: 'claude', attempts: 0 });
    expect(await decideRoute(request, sources(), { backends: [fast], signal: AbortSignal.abort() })).toMatchObject({ attempts: 0 });
    vi.stubEnv('ASHLR_JEV_DISABLE', '1');
    expect(await decideRoute(request, sources(), { backends: [fast] })).toMatchObject({ path: 'fallback', attempts: 0 });
    expect(fast.ask).not.toHaveBeenCalled();
  });
});

describe('existing transport adapters', () => {
  it('pins both local stages to numeric loopback, forbids redirects and bounds bytes', async () => {
    const chatStream = vi.fn().mockResolvedValue({ content: JSON.stringify(selected()) });
    vi.mocked(buildOpenAICompatibleClient).mockReturnValue({ chatStream } as unknown as ReturnType<typeof buildOpenAICompatibleClient>);
    const input = { request, candidates: enumerateRouteCandidates(request, sources()), retry: false, signal: new AbortController().signal, timeoutMs: 100 };
    const backends = defaultRouteBackends();
    expect(await backends[0].ask(input)).toEqual(selected());
    await backends[2].ask(input);
    expect(vi.mocked(buildOpenAICompatibleClient).mock.calls.map(c => [c[0], c[2], c[6]])).toEqual([
      ['http://127.0.0.1:8123/v1', 'fast', expect.objectContaining({ redirect: 'error', timeoutMs: 100, maxResponseBytes: 16384 })],
      ['http://127.0.0.1:8123/v1', 'strong', expect.objectContaining({ redirect: 'error', timeoutMs: 100 })],
    ]);
    expect(JSON.stringify(chatStream.mock.calls)).not.toContain('phantom');
    chatStream.mockResolvedValue({ content: 'not json' });
    expect(await backends[0].ask(input)).toBeNull();
  });

  it('uses Jev existing decision controls and maps ordinals only to the eligible set', async () => {
    const candidates = enumerateRouteCandidates(request, sources());
    vi.mocked(decide).mockResolvedValue({ path: 'jev', value: 'c1' } as Awaited<ReturnType<typeof decide>>);
    expect(await defaultRouteBackends()[1].ask({ request, candidates, retry: false, signal: AbortSignal.timeout(100), timeoutMs: 100 }))
      .toEqual(candidateDecision(candidates[1]));
    const call = vi.mocked(decide).mock.calls.at(-1)!;
    expect(call[0]).toBe('resource-choice');
    expect(call[3]).toMatchObject({ timeoutMs: 100, fallback: null });
    expect(JSON.stringify(call[1])).not.toContain('phantom');
    expect(JSON.stringify(call[2])).not.toContain('codex-personal');
    vi.mocked(decide).mockResolvedValue({ path: 'fallback', reason: 'budget-exhausted' } as Awaited<ReturnType<typeof decide>>);
    await expect(defaultRouteBackends()[1].ask({ request, candidates, retry: false, signal: AbortSignal.timeout(100), timeoutMs: 100 }))
      .rejects.toThrow('unavailable');
  });
});

describe('snapshot loading and JSON CLI', () => {
  it('loads explicit bounded snapshots and rejects symlink sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'route-sources-'));
    try {
      await mkdir(join(root, 'queue'));
      const s = sources();
      await writeFile(join(root, 'models.json'), JSON.stringify(s.models));
      await writeFile(join(root, 'queue/slots.json'), JSON.stringify(s.slots));
      await writeFile(join(root, 'queue/admission.json'), JSON.stringify(s.admission));
      expect(await loadRouteSources(root)).toEqual(s);
      await rm(join(root, 'queue/admission.json'));
      await symlink(join(root, 'models.json'), join(root, 'queue/admission.json'));
      expect((await loadRouteSources(root)).admission).toBeNull();
      await writeFile(join(root, 'models.json'), 'x'.repeat(1024 * 1024 + 1));
      expect((await loadRouteSources(root)).models).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('prints machine-readable fallback and fixed errors with no input reflection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'route-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const file = join(root, 'request.json');
      await writeFile(file, JSON.stringify(request));
      expect(await cmdRoute(['decide', '--input', file, '--root', root, '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ schema: 'route.decision.v1', advisory: true, lane: null });
      await writeFile(file, '{"private":"do not reflect"}');
      expect(await cmdRoute(['decide', '--input', file, '--json'])).toBe(2);
      expect(await cmdRoute(['decide', '--input', join(root, 'missing'), '--json'])).toBe(1);
      for (const args of [[], ['--json'], ['--input', file], ['--input'], ['--input', file, '--unknown'], ['--json', '--json']]) {
        expect(await cmdRoute(['decide', ...args])).toBe(2);
      }
      expect(JSON.stringify(error.mock.calls)).not.toContain('do not reflect');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
