import { describe, expect, it } from 'vitest';
import type { Account, AccountsSnapshot, AccountWindow } from '../usage/usage-contract.js';
import { codexPersonalRow, degradedSources, formatReset, laneTokens, rowsFromAccounts } from './usage-pane-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function window(over: Partial<AccountWindow> & { id: string }): AccountWindow {
  return { label: null, usedPercent: null, resetsAt: null, resetDescription: null, limitReached: false, measured: true, ...over };
}
function account(over: Partial<Account> & { id: string; provider: Account['provider'] }): Account {
  return {
    label: over.id, state: 'observed', authentication: 'signed-in', health: null, planType: null,
    observedAt: '2026-10-31T11:00:00Z', windows: [], binding: null, credits: null, reason: null,
    unsupported: null, reconnectCommand: null, notes: [], ...over,
  };
}
const snapshot = (accounts: Account[]): AccountsSnapshot => ({ sampledAt: '2026-10-31T12:00:00Z', refreshing: false, accounts, collectorNote: null });

describe('rowsFromAccounts', () => {
  it('yields exactly one window for a weekly-only Claude account — never a synthesized 5h one', () => {
    const rows = rowsFromAccounts(snapshot([account({ id: 'claude-1', label: 'Claude Max', provider: 'claude', windows: [window({ id: 'weekly', label: 'Weekly', usedPercent: 58 })] })]));
    expect(rows).toHaveLength(1);
    expect(rows[0].windows).toHaveLength(1);
    expect(rows[0].windows[0]).toMatchObject({ label: 'Weekly', usedPercent: 58, limitReached: false, measured: true });
    expect(rows[0].windows.map((w) => w.label).join()).not.toMatch(/5\s?h/i);
  });
  it('keeps an unmeasured reading unmeasured and falls back to the window id for the label', () => {
    const rows = rowsFromAccounts(snapshot([account({ id: 'codex-1', provider: 'codex', windows: [window({ id: 'primary_5h', usedPercent: 100, limitReached: true, measured: false })] })]));
    expect(rows[0].windows[0]).toMatchObject({ label: 'primary_5h', usedPercent: 100, limitReached: true, measured: false });
  });
  it('sorts Claude, Codex, Grok, then label', () => {
    const rows = rowsFromAccounts(snapshot([
      account({ id: 'grok-1', label: 'Grok', provider: 'grok' }),
      account({ id: 'codex-b', label: 'Zeta', provider: 'codex' }),
      account({ id: 'claude-1', label: 'Work Claude', provider: 'claude' }),
      account({ id: 'codex-a', label: 'Alpha', provider: 'codex' }),
      account({ id: 'claude-2', label: 'A Claude', provider: 'claude' }),
    ]));
    expect(rows.map((r) => r.label)).toEqual(['A Claude', 'Work Claude', 'Alpha', 'Zeta', 'Grok']);
  });
  it('returns an empty list for a missing snapshot and keeps the non-observed reason', () => {
    expect(rowsFromAccounts(null)).toEqual([]);
    const rows = rowsFromAccounts(snapshot([account({ id: 'grok-1', provider: 'grok', state: 'signed-out', authentication: 'signed-out', reason: 'reconnect required' })]));
    expect(rows[0]).toMatchObject({ state: 'signed-out', reason: 'reconnect required', windows: [] });
  });
});

describe('codexPersonalRow', () => {
  it('extracts the snapshot figure verbatim and tolerates missing pieces', () => {
    expect(codexPersonalRow({ codexPersonal: { usedPct: 44, resetsAt: '2026-10-31T15:00:00Z', asOf: '2026-10-31T11:58:00Z' } }))
      .toEqual({ usedPct: 44, resetsAt: '2026-10-31T15:00:00Z', asOf: '2026-10-31T11:58:00Z' });
    expect(codexPersonalRow({ codexPersonal: { usedPct: 12 } })).toEqual({ usedPct: 12, resetsAt: null, asOf: null });
  });
  it('is null when the snapshot does not carry the figure', () => {
    for (const runs of [null, {}, { codexPersonal: null }, { codexPersonal: 'x' }, 42]) expect(codexPersonalRow(runs)).toBeNull();
  });
});

describe('laneTokens', () => {
  const lane = (name: string, tokensLastHour: number | null) => ({ lane: name, running: 1, target: 2, tokensLastHour });
  it('sorts by tokens desc with null readings last, keeping their order', () => {
    const rows = laneTokens({ lanes: [lane('idle-a', null), lane('low', 5), lane('hot', 9000), lane('idle-b', null), lane('mid', 100)] });
    expect(rows.map((r) => r.lane)).toEqual(['hot', 'mid', 'low', 'idle-a', 'idle-b']);
    expect(rows[0]).toMatchObject({ running: 1, target: 2, tokensLastHour: 9000 });
  });
  it('returns an empty list when lanes are absent or malformed', () => {
    for (const runs of [null, {}, { lanes: 'x' }, { lanes: [{ running: 1 }, { lane: 7 }] }]) expect(laneTokens(runs)).toEqual([]);
  });
});

describe('degradedSources', () => {
  it('names only the non-healthy sources this pane reads', () => {
    expect(degradedSources({ sources: { runsDir: 'healthy', codex: 'healthy', merges: 'degraded' } })).toEqual([]);
    expect(degradedSources({ sources: { runsDir: 'degraded', codex: 'missing' } })).toEqual(['runsDir', 'codex']);
    expect(degradedSources(null)).toEqual([]);
    expect(degradedSources({})).toEqual([]);
  });
});

describe('formatReset', () => {
  const iso = (ms: number) => new Date(NOW + ms).toISOString();
  it('is — for no instant or an unparseable one', () => {
    expect(formatReset(null, NOW)).toBe('—');
    expect(formatReset('not-a-date', NOW)).toBe('—');
  });
  it('is reset once the moment has passed', () => {
    expect(formatReset(iso(-1), NOW)).toBe('reset');
    expect(formatReset(iso(0), NOW)).toBe('reset');
  });
  it('counts down in minutes under an hour and in h/m beyond it', () => {
    expect(formatReset(iso(30_000), NOW)).toBe('resets in <1 m');
    expect(formatReset(iso(45 * 60_000), NOW)).toBe('resets in 45 m');
    expect(formatReset(iso(60 * 60_000), NOW)).toBe('resets in 1 h');
    expect(formatReset(iso((2 * 60 + 10) * 60_000), NOW)).toBe('resets in 2 h 10 m');
  });
  it('counts down in days and hours beyond a day', () => {
    expect(formatReset(iso(26 * 60 * 60_000), NOW)).toBe('resets in 1 d 2 h');
    expect(formatReset(iso(48 * 60 * 60_000), NOW)).toBe('resets in 2 d');
  });
});
