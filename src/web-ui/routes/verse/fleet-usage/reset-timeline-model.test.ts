import { describe, expect, it } from 'vitest';
import { resetTicks, resetTimeline } from './reset-timeline-model.js';
import type { UsageRow, UsageWindowRow } from './usage-pane-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

const win = (over: Partial<UsageWindowRow> = {}): UsageWindowRow =>
  ({ label: 'Weekly', usedPercent: 40, resetsAt: null, resetDescription: null, limitReached: false, measured: true, ...over });
const row = (label: string, windows: UsageWindowRow[], over: Partial<UsageRow> = {}): UsageRow =>
  ({ id: label, label, provider: 'codex', state: 'observed', reason: null, windows, note: null, ...over });

describe('resetTimeline', () => {
  it('is null when no window gave a reset instant still ahead', () => {
    expect(resetTimeline([], null, NOW)).toBeNull();
    expect(resetTimeline([row('Claude Max', [win({ resetDescription: 'resets Thu at midnight' })])], null, NOW)).toBeNull();
    expect(resetTimeline([row('Codex', [win({ resetsAt: at(-1) })])], null, NOW)).toBeNull();
  });

  it('orders the dated windows soonest first and places the furthest at the end of the line', () => {
    const line = resetTimeline([
      row('Codex Team', [win({ label: 'Secondary', resetsAt: at(100) }), win({ label: 'Primary', usedPercent: 32, resetsAt: at(25) })]),
      row('Grok', [win({ label: 'Monthly', resetsAt: at(50) })], { provider: 'grok' }),
    ], null, NOW);
    expect(line?.marks.map((mark) => [mark.name, mark.leftPct])).toEqual([
      ['Codex Team · Primary', 25], ['Grok · Monthly', 50], ['Codex Team · Secondary', 100],
    ]);
    expect(line?.marks[0]).toMatchObject({ key: 'Codex Team:1', provider: 'codex', resetsAt: at(25), usage: '32% used', limit: false });
    expect(line?.marks[0].when).toMatch(/^in 1 d 1 h · /);
    expect(line?.summary).toBe('3 windows reset, the last in 4 d 4 h.');
  });

  it('says a flagged limit and an unmeasured window in words, never as a percent', () => {
    const line = resetTimeline([row('Codex', [
      win({ label: 'Primary', usedPercent: 100, limitReached: true, measured: false, resetsAt: at(2) }),
      win({ label: 'Spark', usedPercent: null, resetsAt: at(4) }),
      win({ label: 'Bulk', usedPercent: 0, measured: false, resetsAt: at(4) }),
    ])], null, NOW);
    expect(line?.marks.map((mark) => [mark.usage, mark.limit])).toEqual([
      ['limit reached', true], ['usage unknown', false], ['usage unknown', false],
    ]);
    expect(line?.summary).toBe('3 windows reset, the last in 4 h; 1 flagged at a limit until its reset.');
  });

  it('lists the windows it cannot place with the reason, and skips accounts that were not read', () => {
    const line = resetTimeline([
      row('Claude Max', [win({ resetDescription: 'resets Thu at midnight' })], { provider: 'claude' }),
      row('Codex', [win({ label: 'Primary', resetsAt: at(3) }), win({ label: 'Old', resetsAt: at(-2) }), win({ label: 'Spark' })]),
      row('Grok', [win({ resetsAt: at(1) })], { provider: 'grok', state: 'signed-out' }),
    ], null, NOW);
    expect(line?.marks.map((mark) => mark.name)).toEqual(['Codex · Primary']);
    expect(line?.undated).toEqual([
      { key: 'Claude Max:0', name: 'Claude Max · Weekly', why: 'resets Thu at midnight' },
      { key: 'Codex:1', name: 'Codex · Old', why: 'its reset time has passed' },
      { key: 'Codex:2', name: 'Codex · Spark', why: 'no reset time given' },
    ]);
    expect(line?.summary).toBe('1 window resets in 3 h; 3 gave no time to place.');
  });

  it("places the fleet's own Codex personal reading beside the account windows", () => {
    const line = resetTimeline([row('Codex', [win({ resetsAt: at(10) })])], { usedPct: 71, resetsAt: at(5), asOf: null }, NOW);
    expect(line?.marks.map((mark) => [mark.name, mark.usage, mark.leftPct])).toEqual([
      ['Codex personal · fleet reading', '71% used', 50], ['Codex · Weekly', '40% used', 100],
    ]);
    const unread = resetTimeline([row('Codex', [win({ resetsAt: at(10) })])], { usedPct: null, resetsAt: null, asOf: null }, NOW);
    expect(unread?.undated).toEqual([{ key: 'fleet:codex-personal', name: 'Codex personal · fleet reading', why: 'no reset time given' }]);
  });
});

describe('resetTicks', () => {
  it('marks hours from now on a short line, at a step that keeps the scale readable', () => {
    expect(resetTicks(NOW, 4 * HOUR)).toEqual([
      { leftPct: 25, label: '+1 h' }, { leftPct: 50, label: '+2 h' }, { leftPct: 75, label: '+3 h' },
    ]);
    expect(resetTicks(NOW, 30 * HOUR).map((tick) => tick.label)).toEqual(['+6 h', '+12 h', '+18 h', '+24 h']);
  });

  it('marks local midnights on a long line, one per day inside a week', () => {
    const ticks = resetTicks(NOW, 100 * HOUR);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(5);
    for (const tick of ticks) {
      const when = new Date(NOW + tick.leftPct / 100 * 100 * HOUR);
      expect(Math.abs(when.getHours() * 60 + when.getMinutes() - (when.getHours() > 12 ? 1440 : 0))).toBeLessThanOrEqual(4);
      expect(tick.label).toBe(new Date(when.getTime() + HOUR).toLocaleDateString(undefined, { weekday: 'short' }));
    }
  });

  it('never draws more than eight ticks, and none for an empty span', () => {
    expect(resetTicks(NOW, 30 * 24 * HOUR).length).toBeLessThanOrEqual(8);
    expect(resetTicks(NOW, 0)).toEqual([]);
  });
});
