/**
 * rail-bar: what a rail row draws on the shared WindowBar. It restates the row's own reading and nothing else:
 * no reading is never an empty bar, a retained reading is never drawn as current, and held is never used.
 */
import { describe, expect, it } from 'vitest';
import { railBar, railMetered } from './rail-bar.js';

describe('railBar', () => {
  it('draws what is used, with the reserve and the time gone it is handed', () => {
    expect(railBar({ left: 37, level: 'ok', kept: 40, elapsed: 71.4 }))
      .toEqual({ used: 63, more: null, kept: 40, elapsed: 71.4, ending: 'open', valueNow: 63 });
    // A low row keeps its measured fill; the verdict colours the value beside the bar, not the bar.
    expect(railBar({ left: 13, level: 'low' })).toEqual({ used: 87, more: null, kept: null, elapsed: null, ending: 'open', valueNow: 87 });
  });

  it('keeps a measured zero apart from no reading', () => {
    expect(railBar({ left: 100, level: 'ok' })).toMatchObject({ used: 0, ending: 'open', valueNow: 0 });
    expect(railBar({ left: null, level: 'ok' })).toEqual({ used: null, more: null, kept: null, elapsed: null, ending: 'unread', valueNow: null });
    expect(railBar({ left: Number.NaN, level: 'ok' }).ending).toBe('unread');
  });

  it('never draws a retained reading as the current one, whatever it last said', () => {
    expect(railBar({ left: 22, level: 'unknown', current: false, kept: 40, elapsed: 50 }))
      .toEqual({ used: null, more: null, kept: null, elapsed: null, ending: 'unread', valueNow: null });
    // A current reading on a row whose health check is still running is still a reading.
    expect(railBar({ left: 22, level: 'unknown' })).toMatchObject({ used: 78, ending: 'open', valueNow: 78 });
  });

  it('shows nothing left on a row that is out as spent, with no number and no reserve', () => {
    expect(railBar({ left: 0, level: 'out', kept: 40, elapsed: 30 }))
      .toEqual({ used: 100, more: null, kept: null, elapsed: null, ending: 'spent', valueNow: null });
    // Out for another reason (paused, signed out) with capacity left is not spent.
    expect(railBar({ left: 60, level: 'out' })).toMatchObject({ used: 40, ending: 'open' });
    expect(railBar({ left: null, level: 'out' }).ending).toBe('unread');
  });

  it('draws a held share after the reported use and never adds it to it', () => {
    expect(railBar({ left: 60, level: 'ok', held: 36 })).toEqual({ used: 4, more: 36, kept: null, elapsed: null, ending: 'open', valueNow: 40 });
    expect(railBar({ left: 20, level: 'ok', held: 80 })).toMatchObject({ used: 0, more: 80, valueNow: 80 });
    expect(railBar({ left: 0, level: 'out', held: 0 })).toEqual({ used: 100, more: null, kept: null, elapsed: null, ending: 'spent', valueNow: 100 });
    // A held figure larger than what is taken cannot push the reported use below zero.
    expect(railBar({ left: 90, level: 'ok', held: 30 })).toMatchObject({ used: 0, more: 10 });
  });

  it('clamps shares to the bar', () => {
    expect(railBar({ left: 140, level: 'ok' })).toMatchObject({ used: 0, valueNow: 0 });
    expect(railBar({ left: -5, level: 'ok', kept: 0 })).toMatchObject({ used: 100, kept: null, ending: 'open' });
  });
});

describe('railMetered', () => {
  it('treats only local models as not metered', () => {
    expect(railMetered('local')).toBe(false);
    for (const engine of ['claude', 'codex', 'grok', 'devin']) expect(railMetered(engine)).toBe(true);
  });
});
