import { describe, expect, it } from 'vitest';
import { spendDown, WASTE_RISK_MAX_HOURS_TO_RESET, WASTE_RISK_MIN_LEFT_PERCENT } from './spend-down-model.js';
import type { UsageRow, UsageWindowRow } from './usage-pane-model.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

const win = (over: Partial<UsageWindowRow> = {}): UsageWindowRow => ({
  label: 'weekly', usedPercent: 50, resetsAt: at(10), resetDescription: null, limitReached: false, measured: true, ...over,
});
const row = (id: string, windows: UsageWindowRow[], over: Partial<UsageRow> = {}): UsageRow => ({
  id, label: `Fake ${id}`, provider: 'codex', state: 'observed', reason: null, windows, note: null, ...over,
});

describe('spendDown', () => {
  it('flags waste-risk at exactly 48 h and 30% left, and not just past either boundary', () => {
    expect(WASTE_RISK_MAX_HOURS_TO_RESET).toBe(48);
    expect(WASTE_RISK_MIN_LEFT_PERCENT).toBe(30);
    const items = spendDown([
      row('edge', [win({ usedPercent: 70, resetsAt: at(48) })]),
      row('late', [win({ usedPercent: 70, resetsAt: at(48.01) })]),
      row('used', [win({ usedPercent: 70.5, resetsAt: at(48) })]),
    ], NOW);
    expect(Object.fromEntries(items.map((i) => [i.accountId, i.level]))).toEqual({ edge: 'waste-risk', late: 'on-track', used: 'on-track' });
    expect(items.find((i) => i.accountId === 'edge')).toMatchObject({ leftPercent: 30, hoursToReset: 48 });
  });

  it('skips unmeasured, null-percent, past, unparseable and non-observed windows', () => {
    const items = spendDown([
      row('a', [
        win({ measured: false }),
        win({ usedPercent: null }),
        win({ resetsAt: at(-1) }),
        win({ resetsAt: null }),
        win({ resetsAt: 'not a date' }),
        win({ label: 'kept' }),
      ]),
      row('b', [win()], { state: 'signed-out' }),
      row('c', [win()], { state: 'unavailable' }),
    ], NOW);
    expect(items.map((i) => `${i.accountId}:${i.windowLabel}`)).toEqual(['a:kept']);
  });

  it('clamps left percent to 0–100', () => {
    const items = spendDown([
      row('over', [win({ usedPercent: 104 })]),
      row('under', [win({ usedPercent: -5, resetsAt: at(20) })]),
    ], NOW);
    expect(items.find((i) => i.accountId === 'over')?.leftPercent).toBe(0);
    expect(items.find((i) => i.accountId === 'under')?.leftPercent).toBe(100);
  });

  it('orders waste-risk first, then soonest reset, then label', () => {
    const items = spendDown([
      row('slow', [win({ usedPercent: 10, resetsAt: at(40) })]),
      row('fast-low', [win({ usedPercent: 95, resetsAt: at(1) })]),
      row('b', [win({ usedPercent: 10, resetsAt: at(5) })]),
      row('a', [win({ usedPercent: 10, resetsAt: at(5) })]),
      row('far', [win({ usedPercent: 10, resetsAt: at(100) })]),
    ], NOW);
    expect(items.map((i) => [i.accountId, i.level])).toEqual([
      ['a', 'waste-risk'], ['b', 'waste-risk'], ['slow', 'waste-risk'], ['fast-low', 'on-track'], ['far', 'on-track'],
    ]);
  });
});
