import { describe, expect, it } from 'vitest';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { EscalationInput } from '../src/core/routing/local-escalation.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeat } from '../src/core/routing/router.js';
import { classifyEngine, engineClassMayHoldSecrets, engineClassMayMergeOrPublish, engineIdentityOf, isLoopbackLocalSeat, routeSeatWithLocalEscalation, type LocalRouteContext } from '../src/core/routing/local-route.js';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const at = new Date(NOW - 60_000).toISOString();
const claude = {
  seatId: 'claude', engine: 'claude', label: 'Claude', free: false,
  windows: [
    { id: 'five_hour', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
    { id: 'seven_day', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
  ],
  signedOut: false, reachable: true, contextWindow: 200_000, observedAt: at, spentTodayUsd: 0,
} as unknown as SeatCapacity;
const local = { ...claude, seatId: 'local', engine: 'local', label: 'Local', free: true, windows: [] } as unknown as SeatCapacity;
// A custom engine on loopback that config promotes to tier 'frontier'.
const promoted = { ...claude, seatId: 'fast', engine: 'fast-coder', label: 'Fast' } as unknown as SeatCapacity;
const engines = { 'fast-coder': { baseUrl: 'http://127.0.0.1:11434/v1', tier: 'frontier' } };

const req = { task: 'code', difficulty: 'low', autonomous: true } as const;
const budget = { ...defaultBudgetPolicy(), mode: 'all-in' as const };
const opts = { nowMs: NOW };
const base: EscalationInput = { kind: 'edit', localAvailable: true, localModel: 'qwen3-coder:30b' };
const on: LocalRouteContext = { localInference: { provider: 'ollama' } };
const route = (input: EscalationInput, ctx: LocalRouteContext = on, seats: SeatCapacity[] = [claude, local]) =>
  routeSeatWithLocalEscalation(req as never, seats, budget, opts, input, ctx);
const MERGE_OR_PUBLISH: EscalationInput[] = [
  { ...base, mergesToMain: true },
  { ...base, holdsMergeRights: true },
  { ...base, publishes: true } as EscalationInput,
];
const iroute = (input: EscalationInput, ctx: LocalRouteContext, seats: SeatCapacity[]) =>
  routeSeatWithLocalEscalation({ ...req, autonomous: false } as never, seats, budget, opts, input, ctx);

describe('routeSeatWithLocalEscalation', () => {
  it('routes a plain coding loop to the local seat when localInference is configured', () => {
    expect(route(base)).toMatchObject({ lane: 'local', laneReason: 'local-ok', seatId: 'local' });
  });

  it('unconfigured or invalid localInference changes nothing for non-authority work', () => {
    const plain = routeSeat(req as never, [claude, local], budget, opts);
    for (const localInference of [undefined, null, { provider: 'nope' }, { provider: 'ollama', baseUrl: 'http://8.8.8.8:11434' }]) {
      const d = route(base, { localInference });
      expect(d).toMatchObject({ lane: 'frontier', laneReason: 'policy-off' });
      expect({ seatId: d.seatId, candidates: d.candidates }).toEqual({ seatId: plain.seatId, candidates: plain.candidates });
    }
  });

  it('classifies engines into frontier, local and unclassified', () => {
    expect(classifyEngine(claude)).toBe('frontier');
    expect(classifyEngine(local)).toBe('local');
    expect(classifyEngine(promoted)).toBe('unclassified');
    expect(classifyEngine(promoted, engines)).toBe('local');
    expect(classifyEngine(promoted, { 'fast-coder': { baseUrl: 'https://api.example.com/v1' } })).toBe('frontier');
    expect(classifyEngine(promoted, { 'fast-coder': { baseUrl: 'https://u:p@api.example.com/v1' } })).toBe('unclassified');
    expect(classifyEngine(claude, { claude: { baseUrl: 'http://127.0.0.1:9000' } })).toBe('local');
    expect(['frontier', 'local', 'unclassified'].map((c) => engineClassMayMergeOrPublish(c as never))).toEqual([true, true, false]);
    expect(['frontier', 'local', 'unclassified'].map((c) => engineClassMayHoldSecrets(c as never))).toEqual([false, false, false]);
  });

  it('local is eligible for merge and publish on equal terms with frontier (loopback, configured)', () => {
    for (const input of MERGE_OR_PUBLISH) {
      expect(route(input, on, [local]).seatId).toBe('local');
      expect(route(input, on, [local]).lane).toBe('local');
      expect(iroute(input, { ...on, engines }, [promoted]).seatId).toBe('fast');
      expect(route(input, on, [claude, local]).candidates).toEqual(expect.arrayContaining(['claude', 'local']));
      // Default-off: without localInference, local gets no grant.
      expect(route(input, { localInference: undefined }, [local]).seatId).toBeNull();
    }
  });

  it('no ctx.engines and an unknown loopback id: refused for authority work', () => {
    // 'fast-coder' really runs on loopback, but without ctx.engines routing cannot know that.
    for (const input of MERGE_OR_PUBLISH) {
      for (const ctx of [on, { localInference: undefined }]) {
        expect(iroute(input, ctx, [promoted]).seatId).toBeNull();
        const d = iroute(input, ctx, [claude, promoted]);
        expect(d.seatId).toBe('claude');
        expect(d.candidates).not.toContain('fast');
      }
    }
  });

  it('a non-loopback local seat is refused merge and publish, and the local lane', () => {
    for (const baseUrl of ['http://10.0.0.5:11434/v1', 'http://192.168.1.9:8080/v1', 'http://gpu.local:1234/v1']) {
      const eng = { 'fast-coder': { baseUrl } };
      expect(classifyEngine(promoted, eng)).toBe('local');
      expect(isLoopbackLocalSeat(promoted, eng)).toBe(false);
      for (const input of MERGE_OR_PUBLISH) expect(iroute(input, { ...on, engines: eng }, [promoted]).seatId).toBeNull();
    }
    for (const baseUrl of ['http://127.0.0.1:8080/v1', 'http://[::1]:11434/v1', 'http://localhost:1234/v1']) {
      expect(isLoopbackLocalSeat(promoted, { 'fast-coder': { baseUrl } })).toBe(true);
    }
    const remote = { localInference: { provider: 'openai-compat', baseUrl: 'https://llm.example.com/v1', allowRemote: true } };
    expect(route(base, remote)).toMatchObject({ lane: 'frontier', laneReason: 'local-unavailable', seatId: 'claude' });
    expect(route({ ...base, mergesToMain: true }, remote, [local]).seatId).toBeNull();
  });

  it('abliterated local models never get merge or publish work', () => {
    const abl = { ...base, localModel: 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64) };
    expect(route({ ...abl, mergesToMain: true }, on, [local]).seatId).toBeNull();
    expect(route({ ...abl, mergesToMain: true }, on, [claude, local]).seatId).toBe('claude');
  });

  it('credential and secret-value work is routed to no model seat', () => {
    for (const seats of [[claude], [local], [claude, local]]) {
      const d = route({ ...base, needsCredentials: true }, on, seats);
      expect(d).toMatchObject({ seatId: null, laneReason: 'credentials-frontier-only' });
    }
  });

  it('passes no secret, credential or publish key value into any seat routing context', () => {
    // Routing inputs carry only ids, endpoints, tiers and limits. Publish eligibility means a seat may
    // author or trigger the sanctioned release workflow, which holds the publish key; no seat holds it.
    const SECRET = 'sk-test-SENTINEL-0123456789';
    const leaky = { 'fast-coder': { baseUrl: 'https://api.example.com/v1', tier: 'frontier', apiKey: SECRET, publishKey: SECRET, headers: { Authorization: SECRET } } } as never;
    expect(engineIdentityOf('fast-coder', leaky)).toEqual({ engineId: 'fast-coder', baseUrl: 'https://api.example.com/v1', tier: 'frontier' });
    for (const input of [...MERGE_OR_PUBLISH, base]) {
      const d = iroute(input, { ...on, engines: leaky }, [claude, promoted, local]);
      expect(JSON.stringify(d)).not.toContain(SECRET);
    }
  });

  it('escalates to frontier on a missing or non-finite limit and on over-limit counts', () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const policy = { maxLocalVerifyFailures: bad, maxLocalRetries: 3 } as never;
      expect(route(base, { ...on, policy })).toMatchObject({ lane: 'frontier', laneReason: 'verify-failures', seatId: 'claude' });
    }
    expect(route({ ...base, failedVerifyAttempts: 2 })).toMatchObject({ lane: 'frontier', laneReason: 'verify-failures', seatId: 'claude' });
    expect(route({ ...base, retries: 3 })).toMatchObject({ laneReason: 'retry-cap', seatId: 'claude' });
    expect(route({ ...base, contextTokens: 40_000, localContextLimit: 32_000 })).toMatchObject({ laneReason: 'context-over-local-limit', seatId: 'claude' });
    expect(route({ ...base, kind: 'architecture' })).toMatchObject({ laneReason: 'complex-task-kind', seatId: 'claude' });
    expect(route({ ...base, localAvailable: false })).toMatchObject({ laneReason: 'local-unavailable', seatId: 'claude' });
    expect(route(base, on, [claude])).toMatchObject({ lane: 'frontier', laneReason: 'local-unavailable', seatId: 'claude' });
  });
});
