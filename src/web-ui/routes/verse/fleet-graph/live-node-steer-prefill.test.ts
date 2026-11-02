import { expect, it } from 'vitest';
import { liveNodeSteerPrefill } from './live-node-steer-prefill.js';

const row = { id: 'seat-fake', label: 'seat-fake', kind: 'seat', state: 'exhausted' as const,
  usedText: '100% used', resetText: 'reset unknown', ageText: 'no dated reading', reasons: ['quota', 'held'] };

it('formats node details and reasons, including empty reasons', () => {
  expect(liveNodeSteerPrefill(row)).toBe('Graph node seat-fake (seat) is exhausted: 100% used, reset unknown, no dated reading. Reasons: quota; held. Decide: route around it or wait for the reset.');
  expect(liveNodeSteerPrefill({ ...row, reasons: [] })).toContain('Reasons: none given.');
});

it('caps long orders below 500 characters', () => {
  expect(liveNodeSteerPrefill({ ...row, reasons: ['x'.repeat(1000)] }).length).toBeLessThan(500);
});

it('offers a neutral question for healthy nodes and keeps unknown readings as written', () => {
  const text = liveNodeSteerPrefill({ ...row, state: 'ready', usedText: 'unknown', reasons: [] });
  expect(text).toContain('ready: unknown,');
  expect(text).toContain('Anything to change here?');
  expect(text).not.toContain('%');
});

it('words a hand-off request for any node state', () => {
  for (const state of ['exhausted', 'ready', 'unknown'] as const) {
    expect(liveNodeSteerPrefill({ ...row, state }, 'handoff')).toContain('Hand off this node');
  }
});
