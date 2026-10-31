import { describe, expect, it } from 'vitest';
import { personalDisagreement, type CodexPersonalRow, type UsageRow, type UsageWindowRow } from './usage-pane-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const FLEET_TIME = '2026-10-31T11:30:00Z';
const ACCOUNT_TIME = '2026-10-31T11:55:00Z';
const personal: CodexPersonalRow = { usedPct: 80, resetsAt: null, asOf: FLEET_TIME };
const window = (over: Partial<UsageWindowRow> = {}): UsageWindowRow => ({
  label: 'Weekly', usedPercent: 99, resetsAt: null, resetDescription: null, limitReached: false, measured: true, ...over,
});
const account = (over: Partial<UsageRow> = {}): UsageRow => ({
  id: 'codex-personal', label: 'Codex Personal', provider: 'codex', state: 'observed', reason: null,
  windows: [window()], note: null, ...over,
});
const compare = (rows: UsageRow[], fleet: CodexPersonalRow | null = personal, observedAt: string | null = ACCOUNT_TIME) =>
  personalDisagreement(rows, fleet, observedAt, NOW);

describe('personalDisagreement', () => {
  it('names both readings, their ages and the figure used for dispatch', () => {
    const result = compare([account()]);
    expect(result).toMatchObject({ fleetPct: 80, accountPct: 99, fleetAsOf: FLEET_TIME, accountAsOf: ACCOUNT_TIME, deltaPoints: 19 });
    expect(result?.text).toContain('fleet reads 80% (as of 30m ago, used for dispatch)');
    expect(result?.text).toContain('account reader says 99% (observed 5m ago)');
    expect(result?.text).toContain('leaders act on');
  });
  it('uses the ten point boundary and ignores smaller differences', () => {
    expect(compare([account({ windows: [window({ usedPercent: 89 })] })])).toBeNull();
    expect(compare([account({ windows: [window({ usedPercent: 90 })] })])?.deltaPoints).toBe(10);
  });
  it('requires a finite fleet reading and a measured, finite account reading', () => {
    expect(compare([account()], null)).toBeNull();
    expect(compare([account()], { ...personal, usedPct: null })).toBeNull();
    expect(compare([account({ windows: [window({ measured: false })] })])).toBeNull();
    expect(compare([account({ windows: [window({ usedPercent: NaN })] })])).toBeNull();
  });
  it('selects an explicitly personal account or a sole Codex account, but not an ambiguous one', () => {
    const team = account({ id: 'team', label: 'Team' });
    const other = account({ id: 'other', label: 'Other' });
    expect(compare([team, other])).toBeNull();
    expect(compare([team])).not.toBeNull();
    expect(compare([team, account()])).not.toBeNull();
    expect(compare([account(), account({ id: 'personal-other' })])).toBeNull();
  });
  it('selects a weekly or only window without guessing among multiple windows', () => {
    const session = window({ label: '5-hour', usedPercent: 82 });
    expect(compare([account({ windows: [session, window()] })])?.accountPct).toBe(99);
    expect(compare([account({ windows: [window({ label: 'Only' })] })])?.accountPct).toBe(99);
    expect(compare([account({ windows: [session, window({ label: 'Other' })] })])).toBeNull();
    expect(compare([account({ windows: [session, window({ measured: false })] })])).toBeNull();
  });
  it('omits invalid timestamps from the sentence', () => {
    const result = compare([account()], { ...personal, asOf: 'invalid' }, 'invalid');
    expect(result?.text).not.toMatch(/as of|observed|invalid/);
    expect(result?.text).toContain('(used for dispatch)');
  });
});
