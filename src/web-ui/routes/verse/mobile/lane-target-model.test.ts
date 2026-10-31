import { describe, expect, it } from 'vitest';
import { clampTarget, confirmText, mergeLaneRows } from './lane-target-model.js';

const lane = { lane: 'claude', running: 2, target: 2, queued: 1, held: false, heldReason: null };
const targets = { v: 1 as const, generatedAt: '', sourceState: 'healthy' as const,
  lanes: [{ ...lane, floor: 1, ceiling: 4, heldUntil: null, lastChange: null, changedBy: null }] };

describe('lane target model', () => {
  it('merges control bounds and held state with run counts', () => {
    expect(mergeLaneRows([lane], targets)[0]).toMatchObject({ running: 2, floor: 1, ceiling: 4, writable: true });
    expect(mergeLaneRows([lane], { ...targets, lanes: [{ ...targets.lanes[0]!, held: true, heldReason: 'hold' }] })[0]).toMatchObject({ held: true, heldReason: 'hold', writable: false });
  });
  it('uses snapshot bounds when the control row or route is missing', () => {
    expect(mergeLaneRows([lane], null)[0]).toMatchObject({ floor: 0, ceiling: 2, writable: false });
    expect(mergeLaneRows([lane], { ...targets, lanes: [] })[0]).toMatchObject({ floor: 0, ceiling: 2, writable: true });
  });
  it('clamps integers and invalid input', () => {
    expect([0, 7, 2.9, NaN].map((n) => clampTarget(n, 1, 4))).toEqual([1, 4, 2, 1]);
  });
  it('names both directions in the confirmation', () => {
    expect(confirmText('claude', 2, 3)).toMatchObject({ title: 'Set claude target to 3?', body: expect.stringContaining('launch'), confirmLabel: 'Set target', done: 'claude target is now 3.' });
    expect(confirmText('claude', 2, 1).body).toContain('wind down');
  });
});
