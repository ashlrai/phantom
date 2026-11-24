import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdUsageLimits } from '../src/cli/usage-limits.js';
import {
  accountLimitsReport, accountLimitsText, accountStanding, nextAccountReset, resetCountdown, usageHeadline,
  type AccountLimitsSource,
} from '../src/core/usage/account-limits.js';
import { buildVerseAccountsSnapshot } from '../src/core/verse/accounts.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

type SourceAccount = AccountLimitsSource['accounts'][number];
type SourceWindow = SourceAccount['windows'][number];
const win = (id: string, over: Partial<SourceWindow> = {}): SourceWindow =>
  ({ id, usedPercent: 40, resetsAt: null, nativeReport: null, limitReached: false, measured: true, ...over });
const account = (id: string, provider: string, windows: SourceWindow[], over: Partial<SourceAccount> = {}): SourceAccount =>
  ({ id, label: id, provider, planType: null, state: 'observed', reason: '', observedAt: at(-0.1), windows, ...over });
const source = (accounts: SourceAccount[]): AccountLimitsSource =>
  ({ sampledAt: at(0), evidenceSource: 'shared-evidence', collector: { mode: 'read-only', state: 'running' }, accounts });

const FLEET = source([
  account('Codex Team', 'codex', [
    win('primary', { usedPercent: 100, limitReached: true, measured: false, resetsAt: at(2.5) }),
    win('secondary', { usedPercent: 61, resetsAt: at(100) }),
  ], { planType: 'team' }),
  account('Claude Code', 'claude', [
    win('five_hour', { usedPercent: 99 }),
    win('seven_day', { usedPercent: 12, nativeReport: { resetDescription: 'resets Fri 2 am' } }),
  ]),
  account('Grok', 'grok', [], { state: 'signed-out', reason: 'not-signed-in', observedAt: null }),
  account('Codex Spare', 'codex', [win('primary', { usedPercent: null, measured: false })]),
]);

describe('account standing, headline and next reset', () => {
  it('takes a limit only from the provider flag, never from a measured 100', () => {
    expect(accountStanding({ state: 'observed', windows: [win('w', { usedPercent: 100 })] })).toBe('read');
    expect(accountStanding({ state: 'observed', windows: [win('w', { limitReached: true, measured: false })] })).toBe('limit');
    expect(accountStanding({ state: 'observed', windows: [win('w', { usedPercent: null })] })).toBe('no-reading');
    expect(accountStanding({ state: 'unavailable', windows: [win('w')] })).toBe('unread');
    expect(accountStanding({ state: 'checking', windows: [] })).toBe('checking');
  });

  it('makes no claim with no accounts and counts each standing in words', () => {
    expect(usageHeadline([])).toBeNull();
    expect(usageHeadline([{ state: 'observed', windows: [win('w')] }])).toBe('1 account read, none flagged at a limit.');
  });

  it('skips resets that are prose-only, passed, unparseable or on an unread account', () => {
    const rows = [
      { label: 'a', state: 'observed' as const, windows: [{ ...win('w'), label: 'old', resetsAt: at(-1) }, { ...win('w'), label: 'bad', resetsAt: 'soon' }] },
      { label: 'b', state: 'unavailable' as const, windows: [{ ...win('w'), label: 'hidden', resetsAt: at(1) }] },
    ];
    expect(nextAccountReset(rows, NOW)).toBeNull();
    expect(nextAccountReset([...rows, { label: 'c', state: 'observed' as const, windows: [{ ...win('w'), label: 'weekly', resetsAt: at(30) }] }], NOW))
      .toEqual({ account: 'c', window: 'weekly', resetsAt: at(30) });
  });

  it('words a countdown in days, hours or minutes and gives none for a passed instant', () => {
    expect(resetCountdown(at(2.5), NOW)).toBe('in 2h 30m');
    expect(resetCountdown(at(100), NOW)).toBe('in 4d 4h');
    expect(resetCountdown(at(0.2), NOW)).toBe('in 12m');
    expect(resetCountdown(at(-1), NOW)).toBeNull();
    expect(resetCountdown(null, NOW)).toBeNull();
  });
});

describe('accountLimitsReport', () => {
  const report = accountLimitsReport(FLEET, NOW);

  it('counts the accounts and names the next reset from the records alone', () => {
    expect(report.schema).toBe('usage.limits.v1');
    expect(report.counts).toEqual({ limit: 1, unread: 1, checking: 0, 'no-reading': 1, read: 1 });
    expect(report.headline).toBe('4 accounts: 1 flagged at a limit, 1 not readable, 1 with no reading.');
    expect(report.nextReset).toEqual({ account: 'Codex Team', window: 'primary', resetsAt: at(2.5) });
    expect(report.evidenceSource).toBe('shared-evidence');
  });

  it('drops the retired Claude 5-hour window and keeps the provider reset sentence', () => {
    const claude = report.accounts.find((a) => a.id === 'Claude Code')!;
    expect(claude.windows.map((w) => w.id)).toEqual(['seven_day']);
    expect(claude.windows[0]!.resetDescription).toBe('resets Fri 2 am');
    expect(claude.standing).toBe('read');
    // A Codex account keeps every window it reported.
    expect(report.accounts[0]!.windows.map((w) => w.id)).toEqual(['primary', 'secondary']);
  });

  it('prints unknown in words, never 0%, and a flagged limit without a percent', () => {
    const text = accountLimitsText(report, NOW).join('\n');
    expect(text).toContain('Provider accounts: 4 accounts: 1 flagged at a limit, 1 not readable, 1 with no reading.');
    expect(text).toContain(`Next reset: Codex Team, primary, ${at(2.5)} (in 2h 30m).`);
    expect(text).toContain('Codex Team (codex, team): flagged at a limit');
    expect(text).toContain(`  primary: limit reached, resets ${at(2.5)} (in 2h 30m)`);
    expect(text).toContain(`  secondary: 61% used, resets ${at(100)} (in 4d 4h)`);
    expect(text).toContain('  seven_day: 12% used, resets Fri 2 am');
    expect(text).toContain('Grok (grok): not readable (signed-out: not-signed-in)');
    expect(text).toContain('  primary: usage unknown, reset unknown');
    expect(text).not.toMatch(/\b0% used/);
    expect(text).not.toContain('five_hour');
  });

  it('says so when no account is enrolled or none gave a reset instant', () => {
    const text = accountLimitsText(accountLimitsReport(source([]), NOW), NOW);
    expect(text[0]).toBe('Provider accounts: none enrolled.');
    expect(text[1]).toBe('Next reset: no account gave one as a date and time.');
  });
});

describe('phm usage limits', () => {
  let root: string;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'usage-limits-')); });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('prints the report as JSON or text from the injected read', async () => {
    const json: string[] = [];
    expect(await cmdUsageLimits(['--json'], { now: () => NOW, out: (l) => json.push(l), read: async () => FLEET })).toBe(0);
    expect(JSON.parse(json[0]!)).toEqual(accountLimitsReport(FLEET, NOW));
    const text: string[] = [];
    expect(await cmdUsageLimits([], { now: () => NOW, out: (l) => text.push(l), read: async () => FLEET })).toBe(0);
    expect(text[0]).toBe(accountLimitsText(accountLimitsReport(FLEET, NOW), NOW).join('\n'));
  });

  it('reads a real accounts root, and an empty one is no accounts rather than a healthy fleet', async () => {
    // The live snapshot type must keep satisfying the report's source shape.
    const snapshot: AccountLimitsSource = buildVerseAccountsSnapshot({ accountsRoot: root, collector: null });
    expect(snapshot.accounts).toEqual([]);
    const lines: string[] = [];
    expect(await cmdUsageLimits(['--json', '--accounts-root', root], { now: () => NOW, out: (l) => lines.push(l) })).toBe(0);
    const report = JSON.parse(lines[0]!);
    expect(report).toMatchObject({ schema: 'usage.limits.v1', accounts: [], headline: null, nextReset: null, evidenceSource: 'none' });
    expect(report.counts).toEqual({ limit: 0, unread: 0, checking: 0, 'no-reading': 0, read: 0 });
  });

  it('prints help without reading and refuses an unknown option', async () => {
    const out: string[] = [], err: string[] = [];
    const read = async (): Promise<AccountLimitsSource> => { throw new Error('must not read'); };
    expect(await cmdUsageLimits(['--help'], { out: (l) => out.push(l), read })).toBe(0);
    expect(out[0]).toContain('Usage: phm usage limits');
    expect(await cmdUsageLimits(['--nope'], { err: (l) => err.push(l), read })).toBe(2);
    expect(await cmdUsageLimits(['--accounts-root'], { err: (l) => err.push(l), read })).toBe(2);
    expect(err).toHaveLength(2);
  });
});
