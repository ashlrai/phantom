import { expect, it } from 'vitest';
import { dispatchTick } from '../src/core/fleet/compact-brief-evidence.js';

const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
const tick = (at = '2026-01-15 12:00:00', running = '{"fake-alpha":2,"fake-beta":0}', wall = '1', suffix = '') =>
  `${at} tick run=${running} q=3 launched=1 reap=0 pause=False wall=${wall}s${suffix}`;
const valid = { running: { 'fake-alpha': 2, 'fake-beta': 0 }, why: 'latest tick in the bounded log tail' };

it.each([['1', ''], ['0.25', ''], ['2.50', ' why=synthetic-reason'], ['0', ' why=synthetic-reason']])(
  'accepts original ticks with wall=%s and suffix=%s without exposing the reason', (wall, suffix) => {
    expect(dispatchTick(tick(undefined, undefined, wall, suffix), now)).toEqual(valid);
  },
);

it('does not fall back when the latest tick is malformed', () => {
  expect(dispatchTick(`${tick()}\n${tick(undefined, '{broken}')}`, now).running).toEqual({});
});

it.each([
  tick('2026-01-15 11:57:59'), tick('2026-01-15 12:00:01'), tick('2026-02-30 12:00:00'),
  tick(undefined, '{}'), tick(undefined, '{"fake-alpha":-1}'), tick(undefined, '{"fake-alpha":1.5}'),
  tick(undefined, '{"fake-alpha":1e400}'), tick(undefined, '{"fake-alpha":"1"}'),
  tick(undefined, undefined, '-1'), tick(undefined, undefined, '1'.repeat(400)),
  tick().replace('q=3', 'q=999999999999999999999'),
])('rejects invalid, stale, future, or nonfinite tick evidence', line => {
  expect(dispatchTick(line, now).running).toEqual({});
});

it('accepts the inclusive freshness boundary', () => {
  expect(dispatchTick(tick('2026-01-15 11:58:00'), now)).toEqual(valid);
});
