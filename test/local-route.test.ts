import { describe, expect, it } from 'vitest';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { EscalationInput } from '../src/core/routing/local-escalation.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeat } from '../src/core/routing/router.js';
import { classifyEngine, engineClassMayHoldAuthority, engineIdentityOf, isKnownRemoteSeat, isLocalSeat, routeSeatWithLocalEscalation, type LocalRouteContext } from '../src/core/routing/local-route.js';

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
const AUTHORITY: EscalationInput[] = [
  { ...base, mergesToMain: true },
  { ...base, holdsMergeRights: true },
  { ...base, needsCredentials: true },
  { ...base, publishes: true } as EscalationInput,
  { ...base, needsCredentials: true, localModel: 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64) },
];

describe('routeSeatWithLocalEscalation', () => {
  it('routes a plain coding loop to the local seat when localInference is configured', () => {
    expect(route(base)).toMatchObject({ lane: 'local', laneReason: 'local-ok', seatId: 'local' });
  });

  it('merge and credential seats always route to frontier, configured or not', () => {
    for (const ctx of [on, { localInference: undefined }]) {
      for (const input of AUTHORITY) {
        const d = route(input, ctx);
        expect(d.lane).toBe('frontier');
        expect(d.seatId).toBe('claude');
        expect(d.candidates).not.toContain('local');
        // Only local seats: nothing routes rather than falling back to local.
        expect(route(input, ctx, [local]).seatId).toBeNull();
      }
    }
    expect(route({ ...base, mergesToMain: true }).laneReason).toBe('merge-to-main-frontier-only');
    expect(route({ ...base, needsCredentials: true }).laneReason).toBe('credentials-frontier-only');
  });

  it('unconfigured or invalid localInference changes nothing for non-authority work', () => {
    const plain = routeSeat(req as never, [claude, local], budget, opts);
    for (const localInference of [undefined, null, { provider: 'nope' }, { provider: 'ollama', baseUrl: 'http://8.8.8.8:11434' }]) {
      const d = route(base, { localInference });
      expect(d).toMatchObject({ lane: 'frontier', laneReason: 'policy-off' });
      expect({ seatId: d.seatId, candidates: d.candidates }).toEqual({ seatId: plain.seatId, candidates: plain.candidates });
    }
  });

  it('a config-promoted local engine is still refused merge authority', () => {
    expect(isLocalSeat(promoted, engines)).toBe(true);
    expect(isLocalSeat(promoted)).toBe(false);
    for (const input of AUTHORITY) {
      for (const ctx of [{ ...on, engines }, { localInference: undefined, engines }]) {
        const d = route(input, ctx, [claude, promoted]);
        expect(d.seatId).toBe('claude');
        expect(d.candidates).not.toContain('fast');
        expect(route(input, ctx, [promoted]).seatId).toBeNull();
      }
    }
  });

  it('fails closed with no ctx.engines: an unknown-id seat is refused merge and credential work', () => {
    expect(isKnownRemoteSeat(promoted)).toBe(false);
    for (const input of AUTHORITY) {
      for (const ctx of [on, { localInference: undefined }]) {
        const d = route(input, ctx, [claude, promoted]);
        expect(d.seatId).toBe('claude');
        expect(d.candidates).not.toContain('fast');
        expect(route(input, ctx, [promoted]).seatId).toBeNull();
      }
    }
  });

  it('refuses an unknown id listed with a loopback endpoint, including [::1] and localhost', () => {
    for (const baseUrl of ['http://127.0.0.1:8080/v1', 'http://[::1]:11434/v1', 'http://localhost:1234/v1']) {
      const eng = { 'fast-coder': { baseUrl } };
      expect(isLocalSeat(promoted, eng)).toBe(true);
      expect(isKnownRemoteSeat(promoted, eng)).toBe(false);
      expect(route({ ...base, mergesToMain: true }, { ...on, engines: eng }, [promoted]).seatId).toBeNull();
    }
  });

  it('allows a known hosted id and a listed public https endpoint for authority work', () => {
    expect(isKnownRemoteSeat(claude)).toBe(true);
    expect(route({ ...base, needsCredentials: true }, { localInference: undefined }, [claude]).seatId).toBe('claude');
    const eng = { 'fast-coder': { baseUrl: 'https://api.example.com/v1' } };
    expect(isKnownRemoteSeat(promoted, eng)).toBe(true);
    // Interactive request: the budget policy has no autonomous seat entry for the custom 'fast' seat.
    const d = routeSeatWithLocalEscalation({ ...req, autonomous: false } as never, [promoted], budget, opts, { ...base, mergesToMain: true }, { ...on, engines: eng });
    expect(d.seatId).toBe('fast');
    // A hosted id re-pointed at loopback is local again.
    expect(isKnownRemoteSeat(claude, { claude: { baseUrl: 'http://127.0.0.1:9000' } })).toBe(false);
  });

  it('no ctx.engines and an unknown loopback id: refused for authority work', () => {
    // 'fast-coder' really runs on loopback, but without ctx.engines routing cannot know that.
    expect(classifyEngine(promoted)).toBe('unclassified');
    for (const input of AUTHORITY) {
      expect(route(input, { localInference: undefined }, [promoted]).seatId).toBeNull();
      expect(route(input, on, [promoted]).seatId).toBeNull();
    }
  });

  it('classifies engines into frontier, local and unclassified; only frontier may hold authority', () => {
    expect(classifyEngine(claude)).toBe('frontier');
    expect(classifyEngine(local)).toBe('local');
    expect(classifyEngine(promoted)).toBe('unclassified');
    expect(classifyEngine(promoted, engines)).toBe('local');
    expect(classifyEngine(promoted, { 'fast-coder': { baseUrl: 'https://api.example.com/v1' } })).toBe('frontier');
    expect(classifyEngine(promoted, { 'fast-coder': { baseUrl: 'https://u:p@api.example.com/v1' } })).toBe('unclassified');
    expect(['frontier', 'local', 'unclassified'].map((c) => engineClassMayHoldAuthority(c as never))).toEqual([true, false, false]);
  });

  it('passes no secret or credential value into any seat routing context', () => {
    const SECRET = 'sk-test-SENTINEL-0123456789';
    const leaky = { 'fast-coder': { baseUrl: 'https://api.example.com/v1', tier: 'frontier', apiKey: SECRET, headers: { Authorization: SECRET } } } as never;
    expect(engineIdentityOf('fast-coder', leaky)).toEqual({ engineId: 'fast-coder', baseUrl: 'https://api.example.com/v1', tier: 'frontier' });
    const d = routeSeatWithLocalEscalation({ ...req, autonomous: false } as never, [claude, promoted], budget, opts, { ...base, mergesToMain: true }, { ...on, engines: leaky });
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });

  it('the local lane is loopback-only: an allowRemote endpoint escalates to frontier', () => {
    const remote = { localInference: { provider: 'openai-compat', baseUrl: 'https://llm.example.com/v1', allowRemote: true } };
    expect(route(base, remote)).toMatchObject({ lane: 'frontier', laneReason: 'local-unavailable', seatId: 'claude' });
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
