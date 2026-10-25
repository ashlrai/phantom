import { describe, expect, it } from 'vitest';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { decideLocalRouteLane, routeSeatWithLocalEscalation, type LocalRouteInput } from '../src/core/routing/local-route.js';

const NOW = Date.parse('2026-10-25T20:00:00Z');
const at = new Date(NOW - 60_000).toISOString();
const claude: SeatCapacity = {
  seatId: 'claude', engine: 'claude', label: 'Claude', free: false,
  windows: [
    { id: 'five_hour', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
    { id: 'seven_day', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
  ],
  signedOut: false, reachable: true, contextWindow: 200_000, observedAt: at, spentTodayUsd: 0,
} as SeatCapacity;
const local: SeatCapacity = { ...claude, seatId: 'local', engine: 'local', label: 'Local', free: true, windows: [] } as SeatCapacity;
const req = { task: 'code', difficulty: 'low', autonomous: true } as const;
const budget = { ...defaultBudgetPolicy(), mode: 'all-in' as const };
const base: LocalRouteInput = { kind: 'edit', localAvailable: true, localModel: 'qwen3.8:27b' };
const route = (input: LocalRouteInput, seats: SeatCapacity[] = [claude, local]) =>
  routeSeatWithLocalEscalation(req as never, seats, budget, { nowMs: NOW }, input);

describe('routeSeatWithLocalEscalation', () => {
  it('routes a plain coding loop to the local seat', () => {
    expect(route(base)).toMatchObject({ lane: 'local', laneReason: 'local-ok', seatId: 'local' });
  });

  it('merges to main are frontier-only: the local seat is never offered', () => {
    const d = route({ ...base, mergesToMain: true });
    expect(d).toMatchObject({ lane: 'frontier', laneReason: 'merge-to-main-frontier-only', seatId: 'claude' });
    expect(d.candidates).not.toContain('local');
    // Only a local seat: nothing routes rather than falling back to local.
    expect(route({ ...base, mergesToMain: true }, [local]).seatId).toBeNull();
  });

  it('a role holding merge rights or credentials never gets a local seat, abliterated or not', () => {
    for (const input of [
      { ...base, holdsMergeRights: true },
      { ...base, needsCredentials: true },
      { ...base, needsCredentials: true, localModel: 'huihui-qwen-abliterated@sha256:' + 'a'.repeat(64) },
    ]) {
      const d = route(input);
      expect(d.lane).toBe('frontier');
      expect(d.seatId).toBe('claude');
      expect(d.candidates).not.toContain('local');
      expect(route(input, [local]).seatId).toBeNull();
    }
    expect(decideLocalRouteLane({ ...base, holdsMergeRights: true }).reason).toBe('merge-rights-frontier-only');
    expect(decideLocalRouteLane({ ...base, needsCredentials: true }).reason).toBe('credentials-frontier-only');
  });

  it('escalates to frontier on failures, retries, complexity, or no local seat', () => {
    expect(route({ ...base, failedVerifyAttempts: 2 })).toMatchObject({ lane: 'frontier', laneReason: 'verify-failures', seatId: 'claude' });
    expect(route({ ...base, retries: 3 })).toMatchObject({ laneReason: 'retry-cap', seatId: 'claude' });
    expect(route({ ...base, kind: 'architecture' })).toMatchObject({ laneReason: 'complex-task-kind', seatId: 'claude' });
    expect(route({ ...base, localAvailable: false })).toMatchObject({ laneReason: 'local-unavailable', seatId: 'claude' });
    expect(route(base, [claude])).toMatchObject({ lane: 'frontier', laneReason: 'local-unavailable', seatId: 'claude' });
  });
});
