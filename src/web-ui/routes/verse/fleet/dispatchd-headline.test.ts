import { describe, expect, it } from 'vitest';
import { dispatchdLine, dispatchdWorking } from './dispatchd-headline.js';

const now = Date.parse('2026-11-05T04:00:00Z');
const runs = { runsDirPresent: true, lastTick: new Date(now - 60_000).toISOString(),
  lanes: [{ running: 12, held: true }, { running: 10, held: false }, { running: 0, held: true }] };

describe('dispatchd headline', () => {
  it('sums workers and counts active and held lanes independently', () => {
    expect(dispatchdWorking(runs, now)).toBe(22);
    expect(dispatchdLine(runs, now)).toBe('dispatchd · 22 workers on 2 lanes · 2 held · read 1 m ago');
  });
  it('uses singular forms and omits zero held lanes', () => {
    expect(dispatchdLine({ ...runs, lanes: [{ running: 1, held: false }] }, now))
      .toBe('dispatchd · 1 worker on 1 lane · read 1 m ago');
    expect(dispatchdLine({ ...runs, lanes: [{ running: 1, held: true }] }, now)).toContain('· 1 held');
  });
  it.each([null, { ...runs, runsDirPresent: false }, { ...runs, lastTick: null },
    { ...runs, lastTick: 'invalid' }, { ...runs, lastTick: new Date(now - 900_001).toISOString() }])('withholds unavailable or stale readings', value => {
    expect(dispatchdLine(value, now)).toBeNull();
    expect(dispatchdWorking(value, now)).toBeNull();
  });
  it('keeps unknown counts unknown and accepts the freshness boundary', () => {
    expect(dispatchdWorking({ ...runs, lanes: [{ running: null, held: false }] }, now)).toBeNull();
    expect(dispatchdWorking({ ...runs, lastTick: new Date(now - 900_000).toISOString() }, now)).toBe(22);
  });
});
