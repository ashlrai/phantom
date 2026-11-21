import { describe, expect, it } from 'vitest';
import { runway } from '../../../../core/usage/runway.js';
import { endingSummary, poolEnding, poolHours } from './pool-ending-model.js';

const pool = (usedPercent: number | null, burnPerHour: number | null, hoursToReset: number | null) => runway({ pool: 'claude', usedPercent, burnPerHour, hoursToReset });

describe('how a pool ends its window', () => {
  it('splits a pool that resets with usage left into used, more by the reset and unused', () => {
    // 20% used, 1%/h for 10 h: 10% more, 70% unused (the runway row says so itself).
    expect(poolEnding(pool(20, 1, 10))).toEqual({ kind: 'unused', used: 20, more: 10, unused: 70,
      words: '70% unused at its reset', meter: '20% used, 10% more by its reset, 70% unused at its reset' });
    // Nothing burning it: all that is left goes unused.
    expect(poolEnding(pool(50, 0, 10))).toMatchObject({ kind: 'unused', used: 50, more: 0, unused: 50, words: '50% unused at its reset' });
  });
  it('fills a pool that runs dry early to the end and says how long it sits empty', () => {
    expect(poolEnding(pool(97, 0.75, 50))).toEqual({ kind: 'dry', used: 97, more: 3, unused: 0,
      words: 'dry 46 h before its reset', meter: '97% used, dry 46 h before its reset' });
    // Already at its limit: idle, not about to run dry. A reading over 100 is drawn as the whole bar.
    expect(poolEnding(pool(104, null, 5))).toMatchObject({ kind: 'dry', used: 100, more: 0, unused: 0, words: 'idle 5 h before its reset' });
    expect(poolEnding({ ...pool(97, 0.75, 50), idleHours: null }).words).toBe('dry before its reset');
  });
  it('calls a pool on pace only when the runway does', () => {
    // 90% used, 1%/h, 10 h: empty right at the reset.
    expect(poolEnding(pool(90, 1, 10))).toEqual({ kind: 'even', used: 90, more: 10, unused: 0,
      words: 'on pace to use it all', meter: '90% used, on pace to use it all by its reset' });
  });
  it('projects nothing the runway did not project, and gives its reason', () => {
    expect(poolEnding(pool(50, null, 10))).toEqual({ kind: 'unprojected', used: 50, more: null, unused: null,
      words: 'not projected: no burn rate yet', meter: '50% used, the rest not projected: no burn rate yet' });
    expect(poolEnding(pool(50, 1, null)).words).toBe('not projected: reset time unknown');
    // An older server's row with a verdict and no unused share is not guessed at.
    expect(poolEnding({ ...pool(20, 1, 10), unusedAtResetPercent: null })).toMatchObject({ kind: 'unprojected', more: null, unused: null, words: 'not projected: the unused share was not reported' });
  });
  it('has no bar to split without a usage reading', () => {
    const unread = { kind: 'unread', used: null, more: null, unused: null, words: null, meter: 'unknown' };
    expect(poolEnding(undefined)).toEqual(unread);
    expect(poolEnding(pool(null, null, 6))).toEqual(unread);
    expect(poolEnding({ ...pool(20, 1, 10), usedPercent: NaN })).toEqual(unread);
  });
  it('never rounds a small unused share down to nothing', () => {
    expect(poolEnding({ ...pool(20, 1, 10), unusedAtResetPercent: 0.4 }).words).toBe('under 1% unused at its reset');
  });
  it('writes a wait the way the tile does', () => {
    expect([poolHours(0.5), poolHours(0.001), poolHours(46.4)]).toEqual(['30 min', '1 min', '46 h']);
  });
});

describe('the count under the tiles', () => {
  it('counts pools by how they end, dry first, and a pool with no row as not projected', () => {
    expect(endingSummary([pool(97, 0.75, 50), pool(20, 1, 10), pool(50, 0, 10), pool(90, 1, 10), pool(50, null, 10), undefined]))
      .toEqual({ text: 'At this burn: 1 runs dry early, 2 leave usage unused, 1 on pace, 2 not projected.', projected: true });
    expect(endingSummary([pool(20, 1, 10)])).toEqual({ text: 'At this burn: 1 leaves usage unused.', projected: true });
    expect(endingSummary([pool(97, 0.75, 50), pool(100, null, 5)]).text).toBe('At this burn: 2 run dry early.');
  });
  it('says so when nothing can be projected', () => {
    expect(endingSummary([undefined, pool(50, null, 10)])).toEqual({ text: 'No pool can be projected: each lacks a usage, burn or reset reading.', projected: false });
    expect(endingSummary([]).projected).toBe(false);
  });
});
