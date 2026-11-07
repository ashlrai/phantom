import { expect, it } from 'vitest';
import { liveNodeSteerPrefill, liveNodeSteerVisible } from './live-node-steer-prefill.js';

const row = { id: 'seat-fake', label: 'seat-fake', kind: 'seat', state: 'exhausted' as const,
  usedText: '100% used', resetText: 'reset unknown', ageText: 'no dated reading', reasons: ['quota', 'held'] };

it('formats node details and reasons, including empty reasons', () => {
  expect(liveNodeSteerPrefill(row)).toBe('Graph node seat-fake (seat) is exhausted: 100% used, reset unknown, no dated reading. Reasons: quota; held. Decide: route around it or wait for the reset.');
  expect(liveNodeSteerPrefill({ ...row, reasons: [] })).toContain('Reasons: none given.');
});

it('caps long orders below 500 characters', () => {
  expect(liveNodeSteerPrefill({ ...row, reasons: ['x'.repeat(1000)] }).length).toBeLessThan(500);
});

it('only offers steering for exhausted, held and stale nodes', () => {
  for (const state of ['exhausted', 'held', 'stale'] as const) expect(liveNodeSteerVisible({ ...row, state })).toBe(true);
  for (const state of ['ready', 'limited', 'unknown', 'untracked'] as const) expect(liveNodeSteerVisible({ ...row, state })).toBe(false);
});
