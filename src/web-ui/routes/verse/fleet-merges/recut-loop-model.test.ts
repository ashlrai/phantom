import { expect, it } from 'vitest';
import { narrowRecutLoop, recutLoopLine } from './recut-loop-model.js';

const now = Date.parse('2026-11-09T12:00:00Z');
it('rejects malformed state', () => {
  for (const raw of [null, {}, { v: 1, off: false, lastTickAt: 'bad' }]) expect(narrowRecutLoop(raw)).toBeNull();
});
it('describes off, unrun, stale and recent states', () => {
  expect(recutLoopLine({ off: true, lastTickAt: null }, now)).toEqual({ text: 'Recut loop is off.', tone: 'warn' });
  expect(recutLoopLine({ off: false, lastTickAt: null }, now)).toEqual({ text: 'Recut loop has not run yet.', tone: 'muted' });
  expect(recutLoopLine({ off: false, lastTickAt: '2026-11-09T11:00:00Z' }, now)).toEqual({ text: 'Recut loop last ran 1 h ago.', tone: 'warn' });
  expect(recutLoopLine(narrowRecutLoop({ v: 1, off: false, lastTickAt: '2026-11-09T11:55:00Z' })!, now)).toEqual({ text: 'Recut loop last ran 5 min ago. 24 h recut count unavailable.', tone: 'ok' });
});
