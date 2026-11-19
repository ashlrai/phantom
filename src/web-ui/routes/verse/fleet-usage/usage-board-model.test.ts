import { describe, expect, it } from 'vitest';
import { accountStanding, laneSharePct, laneTotals, nextAccountReset, resetLocalTime, usageHeadline } from './usage-board-model.js';
import type { LaneTokenRow, UsageRow, UsageWindowRow } from './usage-pane-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

const win = (over: Partial<UsageWindowRow> = {}): UsageWindowRow =>
  ({ label: 'Weekly', usedPercent: 40, resetsAt: null, resetDescription: null, limitReached: false, measured: true, ...over });
const row = (label: string, windows: UsageWindowRow[], over: Partial<UsageRow> = {}): UsageRow =>
  ({ id: label, label, provider: 'codex', state: 'observed', reason: null, windows, note: null, ...over });
const lane = (name: string, tokensLastHour: number | null): LaneTokenRow => ({ lane: name, running: null, target: null, tokensLastHour });

describe('accountStanding', () => {
  it('takes the limit only from the provider flag, never from a measured 100', () => {
    expect(accountStanding(row('a', [win({ usedPercent: 100 })]))).toBe('read');
    expect(accountStanding(row('a', [win(), win({ usedPercent: 100, limitReached: true, measured: false })]))).toBe('limit');
  });
  it('separates an account that could not be read from one that reported nothing', () => {
    expect(accountStanding(row('a', [], { state: 'signed-out' }))).toBe('unread');
    expect(accountStanding(row('a', [], { state: 'unavailable' }))).toBe('unread');
    expect(accountStanding(row('a', [], { state: 'checking' }))).toBe('checking');
    expect(accountStanding(row('a', []))).toBe('no-reading');
    expect(accountStanding(row('a', [win({ usedPercent: null })]))).toBe('no-reading');
  });
});

describe('usageHeadline', () => {
  it('is null with no accounts, so the pane draws no claim at all', () => {
    expect(usageHeadline([])).toBeNull();
  });
  it('says every account was read only when each one has a reading and no flag', () => {
    expect(usageHeadline([row('a', [win()])])).toBe('1 account read, none flagged at a limit.');
    expect(usageHeadline([row('a', [win()]), row('b', [win()])])).toBe('2 accounts read, none flagged at a limit.');
  });
  it('counts flagged, unreadable, checking and unread accounts by name of state', () => {
    expect(usageHeadline([
      row('a', [win()]),
      row('b', [win({ limitReached: true, measured: false })]),
      row('c', [], { state: 'signed-out' }),
      row('d', [], { state: 'checking' }),
      row('e', []),
    ])).toBe('5 accounts: 1 flagged at a limit, 1 not readable, 1 still checking, 1 with no reading.');
  });
});

describe('nextAccountReset', () => {
  it('picks the soonest reset still ahead and names its account and window', () => {
    const rows = [
      row('Codex Team', [win({ label: 'Primary', resetsAt: at(3.5) }), win({ label: 'Secondary', resetsAt: at(90) })]),
      row('Grok', [win({ resetsAt: at(1) })], { state: 'unavailable' }),
      row('Old', [win({ resetsAt: at(-2) })]),
    ];
    expect(nextAccountReset(rows, NOW)).toEqual({ account: 'Codex Team', window: 'Primary', resetsAt: at(3.5) });
  });
  it('is null when resets are prose-only, passed or unparseable', () => {
    expect(nextAccountReset([row('Claude', [win({ resetDescription: 'resets Thu at midnight' })]), row('b', [win({ resetsAt: 'soon' })]), row('c', [win({ resetsAt: at(-1) })])], NOW)).toBeNull();
  });
});

describe('resetLocalTime', () => {
  it('gives no clock time without a future instant', () => {
    expect(resetLocalTime(null, NOW)).toBeNull();
    expect(resetLocalTime('not-a-date', NOW)).toBeNull();
    expect(resetLocalTime(at(-1), NOW)).toBeNull();
  });
  it('uses weekday and time inside six days, a date beyond', () => {
    expect(resetLocalTime(at(30), NOW)).toBe(new Date(NOW + 30 * HOUR).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
    expect(resetLocalTime(at(24 * 20), NOW)).toBe(new Date(NOW + 480 * HOUR).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  });
});

describe('lane tokens', () => {
  it('sums only lanes that reported a figure and counts the rest as unread', () => {
    expect(laneTotals([lane('a', 2500), lane('b', 500), lane('c', null)])).toEqual({ total: 3000, read: 2, unread: 1 });
    expect(laneTotals([lane('a', null)])).toEqual({ total: null, read: 0, unread: 1 });
    expect(laneTotals([lane('a', 0)])).toEqual({ total: 0, read: 1, unread: 0 });
  });
  it('scales each bar to the busiest lane and draws none without a reading', () => {
    const lanes = [lane('a', 2500), lane('b', 500), lane('c', null)];
    expect(lanes.map((entry) => laneSharePct(entry, lanes))).toEqual([100, 20, null]);
    expect(laneSharePct(lane('a', 0), [lane('a', 0)])).toBeNull();
  });
});
