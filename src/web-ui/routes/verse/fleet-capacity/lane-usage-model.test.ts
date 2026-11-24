/** The words and shares of a Capacity card's usage window, for each state pools.v1 can hand it. */
import { expect, it } from 'vitest';
import { anyMeasured, laneUsage } from './lane-usage-model.js';
import { at, poolLane, poolsView } from './usage.test-support.js';

const time = (iso: string) => `<${iso}>`;
const idle = (lane: string, idleSlotMinutes = 0) => ({ lane, idleSlotMinutes });

it('pairs usage set to lapse with the slots the lane left open', () => {
  const view = poolsView(poolLane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }));
  const usage = laneUsage(idle('codex-personal', 270), view, 'ok', 24, time)!;
  expect(usage).toMatchObject({ kind: 'window', figure: '20% used', meta: ['resets in 1 d', 'read 6 min ago'], resetAt: at(24), tone: 'warning' });
  expect(usage.bar).toEqual({ words: '20% used, 85.7% of the window elapsed, 32% by reset at this burn, 68% left unused', used: 20, more: 12, unused: 68, elapsed: 85.7, ending: 'unused' });
  expect(usage.note).toBe('68% set to go unused at the reset, and 4.5 slot-h of its slots sat open in the last 24 h.');
  // No open slots in the window: the lapse is still said, without the warning the pairing carries.
  const full = laneUsage(idle('codex-personal'), view, 'ok', 6, time)!;
  expect(full.note).toBe('68% set to go unused at the reset.');
  expect(full.tone).toBeUndefined();
});

it('says a window is on pace, or runs dry before its reset', () => {
  const view = poolsView(
    poolLane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
    poolLane('codex-cmp', { usedPct: 90, resetAt: at(100), burnPctPerHour: 2, projectedExhaustion: at(5) }),
    poolLane('codex-personal', { usedPct: 30, resetAt: at(84) }),
  );
  expect(laneUsage(idle('claude', 90), view, 'ok', 24, time)).toMatchObject({ kind: 'window', figure: '60% used', note: 'On pace to use its whole window by the reset.' });
  const dry = laneUsage(idle('codex-cmp'), view, 'ok', 24, time)!;
  expect(dry.bar?.ending).toBe('dry');
  expect(dry.tone).toBe('warning');
  expect(dry.note).toMatch(/^Runs empty (<.+>, )?before its reset/);
  // A reading with no burn projects nothing: the bar is the used share alone.
  const flat = laneUsage(idle('codex-personal', 90), view, 'ok', 24, time)!;
  expect(flat.bar).toMatchObject({ used: 30, more: null, unused: null, ending: 'unprojected' });
  expect(flat.note).toBe('No burn measured, so how the window ends is not projected.');
  expect(flat.tone).toBeUndefined();
});

it('never turns a missing reading into a percentage', () => {
  const view = poolsView(poolLane('claude', { usedPct: null }), poolLane('local', { window: 'none', usedPct: null, resetAt: null }),
    poolLane('devin', { window: 'credits', usedPct: null, resetAt: null, creditsRemaining: 1250.5 }), poolLane('grok', { window: 'credits', usedPct: null, resetAt: null }));
  const unread = laneUsage(idle('claude', 60), view, 'ok', 24, time)!;
  expect(unread).toMatchObject({ kind: 'unknown', figure: 'usage unknown', resetAt: at(84) });
  expect(unread.meta[0]).toBe('resets in 3 d 12 h');
  expect(unread.bar).toMatchObject({ used: null, ending: 'unread', words: 'usage unknown' });
  expect(unread.note).toBeTruthy();
  expect(laneUsage(idle('local'), view, 'ok', 24, time)).toMatchObject({ kind: 'plain', figure: 'no usage window', bar: null, note: null });
  expect(laneUsage(idle('devin'), view, 'ok', 24, time)).toMatchObject({ kind: 'plain', figure: '1,250.5 credits', bar: null });
  expect(laneUsage(idle('grok'), view, 'ok', 24, time)).toMatchObject({ kind: 'unknown', figure: 'balance unknown', bar: null });
  // A lane the view does not list, and a view that never arrived.
  expect(laneUsage(idle('cursor'), view, 'ok', 24, time)).toMatchObject({ kind: 'unknown', figure: 'usage unknown', note: 'phm pools does not list cursor.' });
  expect(laneUsage(idle('claude'), undefined, 'failed', 24, time)).toMatchObject({ kind: 'unknown', figure: 'usage unknown', note: 'phm pools could not be read.' });
  expect(laneUsage(idle('claude'), undefined, 'loading', 24, time)).toBeNull();
});

it('labels a view whose refresh failed as the last reading', () => {
  const view = poolsView(poolLane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }));
  expect(laneUsage(idle('claude'), view, 'stale', 24, time)!.meta).toEqual(['resets in 2 d 12 h', 'read 6 min ago', 'last reading']);
});

it('offers the key only when a listed lane has a measured window', () => {
  const view = poolsView(poolLane('claude', { usedPct: 60 }), poolLane('codex-cmp', { usedPct: null }));
  expect(anyMeasured(['claude', 'devin'], view)).toBe(true);
  expect(anyMeasured(['codex-cmp', 'devin'], view)).toBe(false);
  expect(anyMeasured(['claude'], undefined)).toBe(false);
});
