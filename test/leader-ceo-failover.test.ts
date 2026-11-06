import { describe, expect, it, vi } from 'vitest';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeat } from '../src/core/routing/router.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import { inspectLeaderSeats, planLeaderSeats, type LeaderSeatCandidate, type LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import { runLeaderSeatChain } from '../src/core/vision/leader-run-chain.js';
import { resolveLeaderModelPreferences } from '../src/core/vision/leader-model-tiers.js';
import { makePolicy } from './helpers/leader-310b-fakes.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const OBSERVED = new Date(NOW - 60_000).toISOString();
const preferences = {
  modelTiers: { elite: ['fixture-elite', 'fixture-elite-two'], workhorse: ['fixture-work'], fast: ['fixture-fast'], local: [] },
};
function candidate(id: string, engine: VerseSeat['engine'], models: string[]): LeaderSeatCandidate {
  return { seat: { id, engine, label: id, accountId: id,
    models: models.map(model => ({ id: model, label: model, contextWindow: 100_000 })), contextWindow: 100_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: OBSERVED } },
  launcher: ['fixture-cli'], ollamaBaseUrl: engine === 'local' ? 'http://127.0.0.1:11434' : null };
}
const first = candidate('claude', 'claude', ['fixture-work', 'fixture-elite']);
const second = candidate('grok', 'grok', ['fixture-elite-two']);
const local = candidate('local', 'local', ['fixture-local']);

function fixture(opts: { config?: unknown; candidates?: LeaderSeatCandidate[]; used?: Record<string, number | null>; failed?: Set<string> } = {}) {
  const candidates = opts.candidates ?? [local, first, second];
  const recordDecision = vi.fn();
  const called: string[] = [];
  const completion = (model: string) => async () => {
    called.push(model);
    if (opts.failed?.has(model)) throw new Error('rate limited');
    return '{"ok":true}';
  };
  const capacity: SeatCapacity[] = candidates.filter(value => value.seat.engine !== 'local').map(value => ({
    seatId: value.seat.id, engine: value.seat.engine as SeatCapacity['engine'], label: value.seat.id,
    free: false, windows: [{ id: 'weekly', usedPercent: Object.hasOwn(opts.used ?? {}, value.seat.id) ? opts.used![value.seat.id]! : 10,
      resetsAt: null, resetDescription: null, limitReached: false }], signedOut: false, reachable: true,
    contextWindow: 100_000, observedAt: OBSERVED, spentTodayUsd: null,
  }));
  const deps: LeaderSeatDeps = {
    cfg: { foundry: { leader: opts.config ?? preferences } } as unknown as AshlrConfig,
    now: () => NOW, candidates: async () => candidates,
    capacitySnapshot: () => ({ publishedAt: OBSERVED, seats: capacity }),
    budgetPolicy: () => ({ ...defaultBudgetPolicy(), seats: {
      claude: { seatId: 'claude', enabled: true, reservePercent: 0 },
      grok: { seatId: 'grok', enabled: true, reservePercent: 0 },
    } }), standingPolicy: () => makePolicy(), clampBudget: policy => policy,
    route: (request, values, policy, nowMs) => routeSeat(request, values, policy, { nowMs }),
    capacityFromSeat, recordDecision,
    transports: { local: (_base, model) => completion(model), grok: (_launcher, model) => completion(model),
      claude: (_launcher, model) => completion(model) },
    claudeCredential: async () => undefined,
  };
  return { deps, recordDecision, called };
}
const full = { deep: true, promptChars: 1000, mode: 'full' as const };

describe('model-agnostic Leader task tiers and failover', () => {
  it('selects configured task models within a real account, keeps local last and does no work during inspection', async () => {
    const { deps, called, recordDecision } = fixture({ used: { claude: 5, grok: 20 } });
    const report = await inspectLeaderSeats(deps, full);
    expect(report).toMatchObject({ configured: true, taskTier: 'elite', selected: 'claude' });
    expect(report.seats.map(value => value.model)).toEqual(['fixture-elite', 'fixture-elite-two', 'fixture-local']);
    expect(report.seats[0]?.remainingIncludedPercent).toBeGreaterThan(report.seats[1]!.remainingIncludedPercent!);
    expect(called).toEqual([]);
    expect(recordDecision).not.toHaveBeenCalled();
    const reply = await inspectLeaderSeats(deps, { ...full, purpose: 'reply' });
    expect(reply.taskTier).toBe('workhorse');
    expect(reply.seats[0]?.model).toBe('fixture-work');
  });

  it('walks available accounts by remaining included usage within a task tier', async () => {
    const { deps } = fixture({ used: { claude: 25, grok: 5 } });
    const plan = await planLeaderSeats(deps, full);
    expect(plan.ok && plan.steps.map(value => value.choice.seatId)).toEqual(['grok', 'claude', 'local']);
  });

  it('retries a rate-limited run on the next planned lane and records both choices', async () => {
    const { deps, called, recordDecision } = fixture({ used: { claude: 5, grok: 20 }, failed: new Set(['fixture-elite']) });
    const plan = await planLeaderSeats(deps, full);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    const result = await runLeaderSeatChain(plan.steps, {
      system: 'Synthetic task', user: 'Synthetic request',
      parse: raw => ({ ok: true, draft: JSON.parse(raw) as { ok: boolean } }), reask: () => 'Synthetic retry',
    }, () => NOW);
    expect(result.ok).toBe(true);
    expect(called).toEqual(['fixture-elite', 'fixture-elite-two']);
    expect(result.attempts.map(value => [value.seatId, value.model, value.outcome])).toEqual([
      ['claude', 'fixture-elite', 'failed'], ['grok', 'fixture-elite-two', 'served'],
    ]);
    expect(recordDecision).toHaveBeenCalledOnce();
    expect(recordDecision.mock.calls[0]?.[1].seatId).toBe('claude');
  });

  it('does not let an elite preference bypass unknown or exhausted usage', async () => {
    for (const used of [null, 100]) {
      const { deps } = fixture({ used: { claude: used, grok: used } });
      const report = await inspectLeaderSeats(deps, full);
      expect(report.seats.map(value => value.seatId)).toEqual(['local']);
      expect(report.skipped.map(value => value.seatId)).toEqual(expect.arrayContaining(['claude', 'grok']));
    }
  });

  it('supports new configured model ids without code or provider-family matching', async () => {
    const novel = candidate('grok', 'grok', ['fixture-next-generation']);
    const { deps } = fixture({ candidates: [local, novel], config: { modelTiers: { elite: ['fixture-next-generation'] } } });
    const report = await inspectLeaderSeats(deps, full);
    expect(report.seats.map(value => value.model)).toEqual(['fixture-next-generation', 'fixture-local']);
  });

  it('honors an explicit local-only task preference without falling back to remote accounts', async () => {
    const { deps, called } = fixture({ config: { ...preferences, taskTier: { full: 'local' } } });
    const report = await inspectLeaderSeats(deps, full);
    expect(report.taskTier).toBe('local');
    expect(report.seats.map(value => value.seatId)).toEqual(['local']);
    expect(report.skipped.map(value => value.seatId)).toEqual(expect.arrayContaining(['claude', 'grok']));
    expect(called).toEqual([]);
  });

  it('preserves the shared-router default when no operator preference is configured', async () => {
    const { deps } = fixture({ config: {} });
    const report = await inspectLeaderSeats(deps, full);
    expect(report.configured).toBe(false);
    expect(report.selected).toBe('local');
  });

  it('fails closed on invalid config, duplicate models or invalid task tiers', async () => {
    for (const config of [
      { modelTiers: { elite: ['fixture-a'], workhorse: ['fixture-a'] } },
      { modelTiers: { elite: ['fixture-a\n'] } },
      { modelTiers: { unexpected: ['fixture-a'] } },
      { ...preferences, taskTier: { reply: 'unknown' } },
      { taskTier: { full: 'elite' } },
    ]) {
      const { deps, called } = fixture({ config });
      expect(resolveLeaderModelPreferences(deps.cfg).status).toBe('invalid');
      const report = await inspectLeaderSeats(deps, full);
      expect(report.selected).toBeNull();
      expect(report.reason).toContain('Invalid');
      expect(called).toEqual([]);
    }
  });
});
