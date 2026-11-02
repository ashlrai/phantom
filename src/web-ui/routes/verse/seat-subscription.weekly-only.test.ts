import { describe, expect, it } from 'vitest';
import { capacity, nativeSeat, seatWindow } from './seat-fixtures.test-support.js';
import { seatReopensAt, seatSubscription, seatSubscriptionSentence } from './seat-subscription.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const RESET = '2026-11-02T12:00:00.000Z';
const week = seatWindow({ id: 'seven_day', usedPercent: 62, resetsAt: RESET });

describe('weekly-only Claude subscription', () => {
  it('binds a complete weekly reading even without a server binding', () => {
    const seat = nativeSeat(capacity({ windows: [week], usability: 'ready' }));
    const view = seatSubscription(seat, NOW);
    expect(view.sessionCap).toBe('none');
    expect(view.summary).toBe('62% of weekly window used');
    expect(view.binding?.resetsAt).toBe(RESET);
    expect(seatReopensAt(view)).toBe(RESET);
    expect(seatSubscriptionSentence(seat, view)).toContain('Anthropic removed the 5-hour limit on this plan. Only the weekly window applies.');
  });

  it('selects the worst model window and retains the other weekly windows', () => {
    const opus = seatWindow({ id: 'seven_day_opus', usedPercent: 85, resetsAt: RESET });
    const view = seatSubscription(nativeSeat(capacity({ windows: [week, opus], binding: week, usability: 'tight' })), NOW);
    expect(view.binding?.id).toBe('seven_day_opus');
    expect(view.others.map((w) => w.id)).toEqual(['seven_day']);
  });

  it('retains model windows when the all-model weekly window binds', () => {
    const opus = seatWindow({ id: 'seven_day_opus', usedPercent: 20, resetsAt: RESET });
    const view = seatSubscription(nativeSeat(capacity({ windows: [week, opus], usability: 'ready' })), NOW);
    expect(view.binding?.id).toBe('seven_day');
    expect(view.others.map((w) => w.id)).toEqual(['seven_day_opus']);
  });

  it('drops a stale five_hour window even when the server names it binding', () => {
    const session = seatWindow({ id: 'five_hour', usedPercent: 75, resetsAt: RESET });
    const view = seatSubscription(nativeSeat(capacity({ windows: [session, week], binding: session, usability: 'ready' })), NOW);
    expect(view.sessionCap).toBe('none');
    expect(view.binding?.id).toBe('seven_day');
    expect(view.summary).toBe('62% of weekly window used');
    expect(view.others.map((w) => w.id)).toEqual([]);
  });

  it('leads with a flagged weekly limit and reopens at its reset', () => {
    const spent = { ...week, limitReached: true, measured: false };
    const view = seatSubscription(nativeSeat(capacity({ windows: [spent], usability: 'exhausted' })), NOW);
    expect(view.summary).toBe('weekly window limit reached');
    expect(seatReopensAt(view)).toBe(RESET);
  });

  it.each(['claude', 'codex', 'grok'] as const)('classifies %s without inventing a session-cap exemption', (engine) => {
    expect(seatSubscription(nativeSeat(capacity(), { engine }), NOW).sessionCap).toBe('unknown');
    const both = [week, seatWindow({ id: 'five_hour', usedPercent: 10 })];
    // Claude's five_hour is filtered before the cap is judged; every other
    // provider's session window still counts.
    expect(seatSubscription(nativeSeat(capacity({ windows: both, binding: week }), { engine }), NOW).sessionCap)
      .toBe(engine === 'claude' ? 'none' : 'present');
    if (engine !== 'claude') expect(seatSubscription(nativeSeat(capacity({ windows: [week] }), { engine }), NOW).sessionCap).toBe('present');
  });
});
