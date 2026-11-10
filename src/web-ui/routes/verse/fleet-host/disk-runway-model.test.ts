import { expect, it } from 'vitest';
import { diskRunwayLine, narrowDiskRunway } from './disk-runway-model.js';
const wrap = (forecast: object, advice = 'ok') => ({ v: 1, advice, forecast });
const crossing = new Date(2026, 10, 10, 9, 5).toISOString();
it.each([
  [wrap({ status: 'projected', hoursUntilThreshold: 5.6, crossingAt: crossing }), 'About 6 h of disk left before 150 GB (at 09:05)', 'ok'],
  [wrap({ status: 'projected', hoursUntilThreshold: 2, crossingAt: crossing }, 'avoid-large-writes'), 'About 2 h of disk left before 150 GB (at 09:05)', 'warn'],
  [wrap({ status: 'reached', hoursUntilThreshold: 0 }, 'avoid-large-writes'), 'Below 150 GB free now', 'warn'],
  [wrap({ status: 'not-falling' }), 'Free disk is not falling', 'ok'],
  [wrap({ status: 'unknown' }, 'unknown'), 'Not enough disk samples yet', 'muted'],
])('maps status to headline and tone', (raw, text, tone) => {
  const view = narrowDiskRunway(raw);
  expect(view && diskRunwayLine(view)).toEqual({ text, tone });
});
it.each([null, 'x', [], {}, { v: 2, forecast: { status: 'unknown' } }, wrap({ status: 'bogus' }), wrap({ status: 'projected' }), { v: 1, unavailable: true }])('rejects malformed input %#', raw => {
  expect(narrowDiskRunway(raw)).toBeNull();
});
