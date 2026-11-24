/**
 * A lane's readings → the shares its bar draws. A missing reading leaves a part out; it is never a zero.
 */
import { describe, expect, it } from 'vitest';
import { laneBar, sameLaneBar, type LaneBarInput } from './world-lane-bar.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

function input(patch: Partial<LaneBarInput>): LaneBarInput {
  return { used: null, limit: null, unit: null, burn: null, resetAt: null, verdict: 'unknown', nowMs: NOW, ...patch };
}

describe('lane bar', () => {
  it('has no share without a usage reading', () => {
    expect(laneBar(input({}))).toEqual({ used: null, more: null, unused: null, ending: 'unread', figure: null, note: 'no usage reading', text: 'no usage reading' });
  });

  it('has no share when usage is read but there is nothing to divide it by', () => {
    const bar = laneBar(input({ used: 42, unit: 'tok' }));
    expect(bar).toMatchObject({ used: null, ending: 'unread', figure: null, note: 'no limit recorded, so no share' });
    expect(laneBar(input({ used: 42, limit: 0, unit: 'acu' })).ending).toBe('unread');
  });

  it('divides by the limit, or by 100 for a percent unit', () => {
    expect(laneBar(input({ used: 3, limit: 10, unit: 'acu' }))).toMatchObject({ used: 30, figure: '30%', ending: 'open' });
    expect(laneBar(input({ used: 42, unit: 'percent' }))).toMatchObject({ used: 42, figure: '42%', ending: 'open' });
    expect(laneBar(input({ used: 0, unit: 'percent' }))).toMatchObject({ used: 0, figure: '0%' });
    expect(laneBar(input({ used: 0.4, unit: 'percent' })).figure).toBe('under 1%');
  });

  it('projects nothing without the verdict, the burn and a reset still ahead', () => {
    const open = { more: null, unused: null, ending: 'open', note: 'not projected', text: '40% used; nothing projected' };
    expect(laneBar(input({ used: 40, unit: 'percent', burn: 2, resetAt: inHours(5) }))).toMatchObject(open);
    expect(laneBar(input({ used: 40, unit: 'percent', resetAt: inHours(5), verdict: 'underuse' }))).toMatchObject(open);
    expect(laneBar(input({ used: 40, unit: 'percent', burn: 2, verdict: 'underuse' }))).toMatchObject(open);
    expect(laneBar(input({ used: 40, unit: 'percent', burn: 2, resetAt: inHours(-1), verdict: 'underuse' }))).toMatchObject(open);
  });

  it('adds the burn over the hours left and leaves the rest unused', () => {
    const bar = laneBar(input({ used: 40, unit: 'percent', burn: 2, resetAt: inHours(5), verdict: 'underuse' }));
    expect(bar).toEqual({ used: 40, more: 10, unused: 50, ending: 'unused', figure: '40%', note: '50% left unused at the reset',
      text: '40% used; 10% more by the reset at the measured burn; 50% left unused' });
    expect(laneBar(input({ used: 2, limit: 8, unit: 'acu', burn: 0.5, resetAt: inHours(4), verdict: 'underuse' }))).toMatchObject({ used: 25, more: 25, unused: 50 });
    expect(laneBar(input({ used: 40, unit: 'percent', burn: 0, resetAt: inHours(5), verdict: 'underuse' }))).toMatchObject({ more: 0, unused: 60 });
  });

  it('fills to the end for a window that runs dry early or is used up at the reset', () => {
    expect(laneBar(input({ used: 42, limit: 100, unit: 'percent', burn: 14.5, resetAt: inHours(10), verdict: 'early' })))
      .toMatchObject({ used: 42, more: 58, unused: 0, ending: 'dry', note: 'runs out before the reset' });
    expect(laneBar(input({ used: 20, unit: 'percent', burn: 16, resetAt: inHours(5), verdict: 'on-pace' })))
      .toMatchObject({ used: 20, more: 80, unused: 0, ending: 'meets', note: 'used up at about the reset' });
  });

  it('calls a window at or past its limit spent, with nothing projected', () => {
    expect(laneBar(input({ used: 12, limit: 10, unit: 'acu', burn: 1, resetAt: inHours(5), verdict: 'early' })))
      .toEqual({ used: 100, more: null, unused: null, ending: 'spent', figure: '100%', note: 'all used', text: 'all of it used' });
  });

  it('compares every drawn field', () => {
    const bar = laneBar(input({ used: 40, unit: 'percent', burn: 2, resetAt: inHours(5), verdict: 'underuse' }));
    expect(sameLaneBar(bar, { ...bar })).toBe(true);
    expect(sameLaneBar(bar, { ...bar, more: 11 })).toBe(false);
    expect(sameLaneBar(bar, { ...bar, ending: 'meets' })).toBe(false);
  });
});
