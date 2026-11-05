/**
 * routes/verse/fleet/lane-runsdir-fallback.test.ts — laneFallback: only the
 * stale-standing lane may borrow dispatchd's figures, and only while the runs
 * read is fresh.
 */
import { describe, expect, it } from 'vitest';
import type { FleetLaneState } from '../../../../core/fleet/fleet-types.js';
import { laneFallback, STALE_STANDING_LANES, type FallbackRunsLane } from './lane-runsdir-fallback.js';

const NOW = Date.parse('2026-11-04T22:53:00Z');
const MIN = 60_000;

const staleLane = (overrides: Partial<FleetLaneState> = {}): FleetLaneState => ({
  lane: 'devin-cli', slots: 0, busy: 0, capReason: STALE_STANDING_LANES, ...overrides,
});
const runsLane = (overrides: Partial<FallbackRunsLane> = {}): FallbackRunsLane => ({
  lane: 'devin', running: 7, target: 10, queued: 0, held: false, ...overrides,
});
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('laneFallback', () => {
  it('reads running of target plus the queued count for a fresh match', () => {
    const result = laneFallback(staleLane(), [runsLane({ queued: 712 })], ago(MIN), NOW);
    expect(result).toEqual({ slots: '7 of 10 · 712 queued', note: 'from dispatchd, read 1m ago' });
  });

  it('drops the queued suffix when nothing is queued', () => {
    const result = laneFallback(staleLane(), [runsLane()], ago(MIN), NOW);
    expect(result?.slots).toBe('7 of 10');
  });

  it('reports a held lane as held', () => {
    const result = laneFallback(staleLane(), [runsLane({ held: true, queued: 40 })], ago(MIN), NOW);
    expect(result?.slots).toBe('held');
  });

  it('maps each fleet lane to its dispatchd id', () => {
    const runs = [
      runsLane({ lane: 'codex-local', running: 2, target: 6 }),
      runsLane({ lane: 'claude', running: 1, target: 4 }),
      runsLane({ lane: 'codex-cmp', running: 9, target: 10 }),
    ];
    expect(laneFallback(staleLane({ lane: 'local' }), runs, ago(MIN), NOW)?.slots).toBe('2 of 6');
    expect(laneFallback(staleLane({ lane: 'claude-cli' }), runs, ago(MIN), NOW)?.slots).toBe('1 of 4');
    expect(laneFallback(staleLane({ lane: 'codex' }), runs, ago(MIN), NOW)?.slots).toBe('9 of 10');
  });

  it('returns null when the runs read has no lane for the chip', () => {
    expect(laneFallback(staleLane(), [runsLane({ lane: 'claude' })], ago(MIN), NOW)).toBeNull();
    expect(laneFallback(staleLane({ lane: 'grok-cli' }), [runsLane()], ago(MIN), NOW)).toBeNull();
  });

  it('returns null when the runs read is missing, unreadable, or over 15 minutes old', () => {
    expect(laneFallback(staleLane(), null, ago(MIN), NOW)).toBeNull();
    expect(laneFallback(staleLane(), [runsLane()], null, NOW)).toBeNull();
    expect(laneFallback(staleLane(), [runsLane()], 'not a time', NOW)).toBeNull();
    expect(laneFallback(staleLane(), [runsLane()], ago(16 * MIN), NOW)).toBeNull();
  });

  it('returns null for a lane that is not the stale-standing case', () => {
    const runs = [runsLane()];
    expect(laneFallback(staleLane({ slots: 4, capReason: null }), runs, ago(MIN), NOW)).toBeNull();
    expect(laneFallback(staleLane({ capReason: 'off until its window resets' }), runs, ago(MIN), NOW)).toBeNull();
    expect(laneFallback(staleLane({ slots: 2 }), runs, ago(MIN), NOW)).toBeNull();
  });
});
