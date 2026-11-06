import { afterEach, expect, it, vi } from 'vitest';
import * as drainEta from '../fleet/queue-drain-eta.js';
import { laneDrainText } from './queue-lane-drain.js';

const row = { lane: 'codex-personal', ready: 2 };
afterEach(() => vi.restoreAllMocks());

it('reports a held lane', () => {
  expect(laneDrainText(row, { running: 2, target: 4, held: true })).toBe('held · nothing drains');
});

it('reports a draining lane using ready jobs and next-pass capacity', () => {
  expect(laneDrainText(row, { running: 2, target: 4, held: false })).toBe('drains in ~0 min · 2 free at next pass');
});

it('reports idle and saturated lanes', () => {
  expect(laneDrainText({ ...row, ready: 0 }, { running: 2, target: 4, held: false })).toBe('idle · 2 free slots');
  expect(laneDrainText({ ...row, ready: 9 }, { running: 4, target: 4, held: false })).toBe('saturated · 0 free');
  expect(laneDrainText({ ...row, ready: 0 }, { running: 4, target: 4, held: false })).toBe('saturated · 0 free');
});

it('omits an estimate for a missing snapshot lane', () => {
  expect(laneDrainText(row, undefined)).toBeNull();
});

it.each([[8.6, 9], [10, 10], [11, 10], [13, 15]])('rounds %s minutes to %s', (duration, expected) => {
  vi.spyOn(drainEta, 'queueDrainEta').mockReturnValue({
    state: 'draining', drainMinutes: duration, freeSlots: 1, freeSlotsAtNextPass: 3,
  });
  expect(laneDrainText(row, { running: 2, target: 4, held: false }))
    .toBe(`drains in ~${expected} min · 3 free at next pass`);
});
