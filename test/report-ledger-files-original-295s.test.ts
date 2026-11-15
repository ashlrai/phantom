/**
 * RQ-PHX-REPORTSLOTRECOVER295S: recovers the report-file/ET-slot slice of
 * original PR #4284 (RQ-REPORTS-NO-GROK-1) — deterministic 07:30/20:00
 * recorded-activity report files under <runsDir>/export/ built from
 * metrics/jobs.jsonl with no model and no network. Assertions map the
 * original reportClockEt/dueReportSlots/reportMarkerDay/buildScheduledReports
 * contract onto the new ledger-only surface; the world model, intents,
 * Actions evidence and dispatcher scheduling remain out of scope (see
 * BRIDGE_NOTES.md).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetReportLedgerBuild } from '../src/cli/fleet-report-ledger-build.js';
import {
  buildReportLedgerFiles,
  dueReportSlots,
  reportClockEt,
  reportLedgerMarker,
  reportPath,
  REPORT_LEDGER_FILES_SCHEMA,
} from '../src/core/fleet/report-ledger-files.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runsRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'report-files-')); dirs.push(dir); return dir; };
const at = (iso: string): Date => new Date(iso);

// 2026-11-13/14 are EST (UTC-5): ET = UTC minus five hours.
const BEFORE_AM = at('2026-11-13T12:24:00Z'); // 07:24 ET — nothing due
const AM_DUE = at('2026-11-13T12:25:00Z');    // 07:25 ET — 0730 due
const BEFORE_PM = at('2026-11-14T00:54:00Z'); // 19:54 ET — only 0730 due
const PM_DUE = at('2026-11-14T00:55:00Z');    // 19:55 ET — both due

const row = (r: Record<string, unknown>): string => JSON.stringify(r);
const ledgerText = [
  row({ event: 'launch', job: 'RQ-FAKE-1', lane: 'devin', ts: '2026-11-13T01:00:00Z' }),
  row({ event: 'finish', job: 'RQ-FAKE-1', lane: 'devin', tokens_total: 4000, empty: false, ts: '2026-11-13T02:00:00Z' }),
  row({ event: 'publish', job: 'RQ-FAKE-1', lane: 'devin', url: 'https://github.com/ashlrai/phantom/pull/4284', ts: '2026-11-13T03:00:00Z' }),
  row({ event: 'outcome', job: 'RQ-FAKE-1', lane: 'devin', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/4284', ttm_s: 3200, mergedAt: '2026-11-13T04:00:00Z', ts: '2026-11-13T04:00:00Z' }),
].join('\n');
const withLedger = (root: string, text = ledgerText): void => {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(join(root, 'metrics', 'jobs.jsonl'), text);
};

describe('reportClockEt / dueReportSlots (original ET slot math)', () => {
  it('computes the ET day and minutes before and at both build boundaries', () => {
    expect(reportClockEt(BEFORE_AM)).toEqual({ day: '2026-11-13', minutes: 7 * 60 + 24 });
    expect(reportClockEt(AM_DUE)).toEqual({ day: '2026-11-13', minutes: 7 * 60 + 25 });
    expect(reportClockEt(BEFORE_PM)).toEqual({ day: '2026-11-13', minutes: 19 * 60 + 54 });
    expect(reportClockEt(PM_DUE)).toEqual({ day: '2026-11-13', minutes: 19 * 60 + 55 });
  });

  it('returns no slots before 07:25, 0730 until 19:55, both after', () => {
    expect(dueReportSlots(BEFORE_AM)).toEqual([]);
    expect(dueReportSlots(AM_DUE)).toEqual(['0730']);
    expect(dueReportSlots(BEFORE_PM)).toEqual(['0730']);
    expect(dueReportSlots(PM_DUE)).toEqual(['0730', '2000']);
  });

  it('rolls the ET day at midnight and stays correct across the Nov 1 DST transition', () => {
    expect(reportClockEt(at('2026-11-14T04:59:00Z'))).toEqual({ day: '2026-11-13', minutes: 23 * 60 + 59 });
    expect(reportClockEt(at('2026-11-14T05:00:00Z'))).toEqual({ day: '2026-11-14', minutes: 0 });
    // 2026-11-01 is the EDT->EST fallback: the ambiguous 01:25 face occurs
    // at two UTC instants and both resolve in America/New_York.
    expect(reportClockEt(at('2026-11-01T05:25:00Z'))).toEqual({ day: '2026-11-01', minutes: 85 }); // 01:25 EDT
    expect(reportClockEt(at('2026-11-01T06:25:00Z'))).toEqual({ day: '2026-11-01', minutes: 85 }); // 01:25 EST
    expect(reportClockEt(at('2026-11-01T12:25:00Z'))).toEqual({ day: '2026-11-01', minutes: 7 * 60 + 25 }); // 07:25 EST
    expect(dueReportSlots(at('2026-11-01T12:25:00Z'))).toEqual(['0730']);
  });
});

describe('reportLedgerMarker', () => {
  it('parses slot, day and generatedAt from the versioned marker and rejects anything else', () => {
    const good = '<!-- ashlr.fleet-report-ledger-files/v1 slot=0730 day=2026-11-13 generatedAt=2026-11-13T12:25:00.000Z -->\n# rest';
    expect(reportLedgerMarker(good)).toEqual({ slot: '0730', day: '2026-11-13', generatedAt: '2026-11-13T12:25:00.000Z' });
    expect(reportLedgerMarker('no marker here')).toBeNull();
    expect(reportLedgerMarker('<!-- ashlr.report-export/v1 slot=0730 day=2026-11-13 -->')).toBeNull(); // original schema does not count
  });
});

describe('buildReportLedgerFiles', () => {
  it('writes nothing before the first slot is due and creates no export directory', async () => {
    const root = runsRoot();
    const result = await buildReportLedgerFiles({ runsDir: root, now: BEFORE_AM });
    expect(result.day).toBe('2026-11-13');
    expect(result.entries).toEqual([]);
    expect(existsSync(join(root, 'export'))).toBe(false);
  });

  it('writes only the due slot at 07:25 with marker, coverage line and 0600 mode', async () => {
    const root = runsRoot();
    withLedger(root);
    const result = await buildReportLedgerFiles({ runsDir: root, now: AM_DUE });
    expect(result.schema).toBe(REPORT_LEDGER_FILES_SCHEMA);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ slot: '0730', outcome: 'wrote', reason: null });
    const path = reportPath(root, '0730');
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('slot=0730 day=2026-11-13 generatedAt=2026-11-13T12:25:00.000Z');
    expect(text).toContain('ledger only');
    expect(text).toContain('not collected');
    expect(text).toContain('launches 1');
    expect(text).toContain('https://github.com/ashlrai/phantom/pull/4284 — merged · RQ-FAKE-1');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(reportPath(root, '2000'))).toBe(false);
  });

  it('writes both slots at 19:55 and skips the valid same-day file on rerun', async () => {
    const root = runsRoot();
    withLedger(root);
    const first = await buildReportLedgerFiles({ runsDir: root, now: PM_DUE });
    expect(first.entries.map((e) => `${e.slot}:${e.outcome}`)).toEqual(['0730:wrote', '2000:wrote']);
    const path = reportPath(root, '0730');
    const stamp = at('2026-11-14T00:55:00Z');
    utimesSync(path, stamp, stamp);
    const bytes = readFileSync(path);
    const second = await buildReportLedgerFiles({ runsDir: root, now: at('2026-11-14T01:00:00Z') });
    expect(second.entries.every((e) => e.outcome === 'skipped' && e.reason === 'already-built-today')).toBe(true);
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(stamp.getTime());
  });

  it('rebuilds when the marker names another slot or another day', async () => {
    const root = runsRoot();
    withLedger(root);
    mkdirSync(join(root, 'export'), { recursive: true });
    writeFileSync(reportPath(root, '0730'), '<!-- ashlr.fleet-report-ledger-files/v1 slot=2000 day=2026-11-13 generatedAt=2026-11-13T00:55:00.000Z -->\n');
    const wrongSlot = await buildReportLedgerFiles({ runsDir: root, now: AM_DUE });
    expect(wrongSlot.entries[0]).toMatchObject({ slot: '0730', outcome: 'wrote' });
    expect(reportLedgerMarker(readFileSync(reportPath(root, '0730'), 'utf8'))?.slot).toBe('0730');
    const nextDay = await buildReportLedgerFiles({ runsDir: root, now: at('2026-11-14T12:25:00Z') });
    expect(nextDay.day).toBe('2026-11-14');
    expect(nextDay.entries[0]!.outcome).toBe('wrote');
    expect(reportLedgerMarker(readFileSync(reportPath(root, '0730'), 'utf8'))?.day).toBe('2026-11-14');
  });

  it('rebuilds a valid same-day file under --force and builds a named slot before it is due', async () => {
    const root = runsRoot();
    withLedger(root);
    await buildReportLedgerFiles({ runsDir: root, now: AM_DUE });
    const forced = await buildReportLedgerFiles({ runsDir: root, slot: '0730', force: true, now: at('2026-11-13T13:00:00Z') });
    expect(forced.entries[0]).toMatchObject({ outcome: 'wrote' });
    expect(readFileSync(reportPath(root, '0730'), 'utf8')).toContain('generatedAt=2026-11-13T13:00:00.000Z');
    const early = await buildReportLedgerFiles({ runsDir: root, slot: '2000', now: at('2026-11-13T15:00:00Z') }); // 10:00 ET
    expect(early.entries[0]).toMatchObject({ slot: '2000', outcome: 'wrote' });
  });

  it('keeps an unavailable ledger unknown and a truncated tail a lower bound', async () => {
    const missing = runsRoot();
    await buildReportLedgerFiles({ runsDir: missing, slot: '0730', now: AM_DUE });
    const unavailable = readFileSync(reportPath(missing, '0730'), 'utf8');
    expect(unavailable).toContain('unavailable');
    expect(unavailable).toContain('counts unknown');
    const truncated = runsRoot();
    withLedger(truncated, `${'x'.repeat(3 * 1024 * 1024)}\n${ledgerText}\n`);
    await buildReportLedgerFiles({ runsDir: truncated, slot: '0730', now: AM_DUE });
    expect(readFileSync(reportPath(truncated, '0730'), 'utf8')).toContain('lower bound');
  });

  it('never writes raw ledger rows or secret-shaped text into the report file', async () => {
    const root = runsRoot();
    withLedger(root, [
      row({ event: 'finish', job: 'RQ-LEAK', lane: 'devin token=sk-abcdefghijklmnop', message: 'PRIVATE-FIXTURE-MESSAGE-991', ts: '2026-11-13T02:00:00Z' }),
    ].join('\n'));
    await buildReportLedgerFiles({ runsDir: root, slot: '0730', now: AM_DUE });
    const text = readFileSync(reportPath(root, '0730'), 'utf8');
    expect(text).not.toContain('sk-abcdefghijklmnop');
    expect(text).not.toContain('PRIVATE-FIXTURE-MESSAGE-991');
  });
});

describe('cmdFleetReportLedgerBuild', () => {
  it('writes via the real command export and emits path-free --json', async () => {
    const root = runsRoot();
    withLedger(root);
    const lines: string[] = [];
    const code = await cmdFleetReportLedgerBuild(['--runs-dir', root, '--json'], { now: () => AM_DUE, output: (t) => lines.push(t) });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.schema).toBe(REPORT_LEDGER_FILES_SCHEMA);
    expect(parsed.day).toBe('2026-11-13');
    expect(parsed.entries).toEqual([{ slot: '0730', outcome: 'wrote', reason: null, bytes: expect.any(Number) }]);
    expect(lines[0]).not.toContain(root);
  });

  it('repeats as skipped and retains the original bytes', async () => {
    const root = runsRoot();
    withLedger(root);
    const out: string[] = [];
    const deps = { now: () => AM_DUE, output: (t: string) => out.push(t) };
    await cmdFleetReportLedgerBuild(['--runs-dir', root], deps);
    const bytes = readFileSync(reportPath(root, '0730'));
    const code = await cmdFleetReportLedgerBuild(['--runs-dir', root], deps);
    expect(code).toBe(0);
    expect(out.at(-1)).toContain('skipped 0730: already-built-today');
    expect(readFileSync(reportPath(root, '0730')).equals(bytes)).toBe(true);
  });

  it('rejects malformed args with exit 2 and never creates the export directory', async () => {
    const root = runsRoot();
    const missing = join(root, 'fresh-runs-dir');
    const errors: string[] = [];
    for (const args of [
      ['--bogus'],
      ['--slot'],
      ['--slot', '9999'],
      ['--slot', '--json'],
      ['--slot', '0730', '--slot', '0730'],
      ['--runs-dir', missing, '--runs-dir', missing],
      ['--json', '--json'],
      ['--runs-dir', missing, '--bogus'],
      ['--runs-dir', missing, '--slot', 'auto', '--force', '--force'],
    ]) {
      expect(await cmdFleetReportLedgerBuild(args, { error: (t) => errors.push(t) })).toBe(2);
    }
    expect(errors).toHaveLength(9);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(missing, 'export'))).toBe(false);
  });

  it('prints usage on --help with exit 0 and writes nothing', async () => {
    const root = runsRoot();
    const missing = join(root, 'help-runs-dir');
    const help: string[] = [];
    expect(await cmdFleetReportLedgerBuild(['--runs-dir', missing, '--help'], { output: (t) => help.push(t) })).toBe(0);
    expect(help[0]).toContain('fleet report-ledger-build');
    expect(existsSync(missing)).toBe(false);
  });

  it('reaches the verb through the real cmdFleet convention dispatch', async () => {
    const root = runsRoot();
    withLedger(root);
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((t: unknown) => out.push(String(t)));
    try {
      const loaders = { 'report-ledger-build': () => import('../src/cli/fleet-report-ledger-build.js') };
      const code = await cmdFleet(['report-ledger-build', '--runs-dir', root, '--json'], loaders);
      expect(code).toBe(0);
      expect(JSON.parse(out.join('\n')).schema).toBe(REPORT_LEDGER_FILES_SCHEMA);
    } finally {
      log.mockRestore();
    }
  });
});
