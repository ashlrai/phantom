import { describe, expect, it } from 'vitest';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { heldHeadline, laneVerdict } from './fleet-dispatch-model.js';

const nowMs = Date.parse('2026-10-31T13:22:00Z');
const ctx = { nowMs, lastTickAgeMs: 0, paused: false, claudeLane: null };
const heldLane = (heldReason: string | null) =>
  withLane(fleetRunsFixture(), { lane: 'codex-personal', held: true, heldReason }).lanes[0]!;

describe('held lane headlines', () => {
  it('shows the time until a future reset in Eastern Time across the daylight saving change', () => {
    const reason = 'out of usage until 2026-11-01 06:22';
    expect(heldHeadline(reason, nowMs)).toBe('held — Out of usage · back in 17 h (Nov 1 01:22 ET)');
    expect(laneVerdict(heldLane(reason), ctx)).toMatchObject({
      headline: heldHeadline(reason, nowMs), tone: 'warn', action: 'Waits for the provider reset; put jobs on other lanes',
    });
  });

  it('escalates an elapsed reset, including the exact reset time', () => {
    for (const reason of ['out of usage until 2026-10-31 12:22', 'out of usage until 2026-10-31 13:22']) {
      expect(heldHeadline(reason, nowMs)).toBe('held — Out of usage · reset time passed; lane should resume');
      expect(laneVerdict(heldLane(reason), ctx)).toMatchObject({
        tone: 'danger', action: 'Check the dispatcher: the hold outlived its reset time',
      });
    }
  });

  it('shows how long ago a timestamped rejection occurred and preserves the action', () => {
    const reason = 'token rejected 2026-10-31 08:22:00';
    expect(heldHeadline(reason, nowMs)).toBe('held — Token rejected · 5 h ago');
    expect(laneVerdict(heldLane(reason), ctx)).toMatchObject({ tone: 'warn', action: 'Re-authenticate this lane' });
  });

  it('shows a parsed label when no timestamp is present', () => {
    expect(heldHeadline('  scheduled   maintenance  ', nowMs)).toBe('held — Scheduled maintenance');
  });

  it('provides a fallback for a missing or blank reason', () => {
    expect(heldHeadline(null, nowMs)).toBe('held — no reason given');
    expect(heldHeadline('  ', nowMs)).toBe('held — no reason given');
  });

  it('does not display a duration for invalid timestamps or an invalid clock', () => {
    expect(heldHeadline('out of usage until 2026-99-99 00:00', nowMs)).toBe('held — Out of usage');
    expect(heldHeadline('out of usage until 2026-11-01 06:22', NaN)).toBe('held — Out of usage');
  });
});
