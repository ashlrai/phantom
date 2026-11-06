import { describe, expect, it } from 'vitest';
import { holdClearsIn, holdReleasable, mergeLaneRows } from './lane-target-model.js';

const lane = { lane: 'codex-personal', running: 0, target: 0, queued: 3, held: true, heldReason: 'autobackoff codex_usage_limit' };
const heldUntil = '2026-11-01T00:02:00Z';
const control = { ...lane, floor: 0, ceiling: 8, heldUntil, lastChange: '2026-10-31T20:02:00Z', changedBy: 'autobackoff', pausedFrom: null };
const targets = { v: 1 as const, generatedAt: '', sourceState: 'healthy' as const, lanes: [control] };

describe('lane hold model', () => {
  it('carries the hold expiry and attribution from the control row', () => {
    expect(mergeLaneRows([lane], targets)[0]).toMatchObject({ heldUntil, changedBy: 'autobackoff' });
  });
  it('reads no expiry or attribution without a control read', () => {
    expect(mergeLaneRows([lane], null)[0]).toMatchObject({ heldUntil: null, changedBy: null });
    expect(mergeLaneRows([lane], { ...targets, lanes: [] })[0]).toMatchObject({ heldUntil: null, changedBy: null });
  });
  it('releases only a held lane attributed to autobackoff', () => {
    const row = mergeLaneRows([lane], targets)[0]!;
    expect(holdReleasable(row)).toBe(true);
    for (const changedBy of ['Mason t1221u', 'Phantom desktop', 'autobackof', null]) {
      expect(holdReleasable({ ...row, changedBy })).toBe(false);
    }
    expect(holdReleasable({ ...row, held: false })).toBe(false);
  });
  it('times the hold relative to now', () => {
    const now = Date.parse('2026-10-31T22:00:00Z');
    expect(holdClearsIn(heldUntil, now)).toBe('in 2 h');
    expect(holdClearsIn('2026-10-31T22:40:00Z', now)).toBe('in 40 m');
    expect(holdClearsIn('2026-10-31T22:00:30Z', now)).toBe('soon');
    expect(holdClearsIn('2026-10-31T21:00:00Z', now)).toBe('soon');
    expect(holdClearsIn('2026-11-03T00:00:00Z', now)).toBe('in 2 d');
    expect(holdClearsIn('not a date', now)).toBeNull();
  });
});
