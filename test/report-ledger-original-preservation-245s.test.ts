/**
 * RQ-PHX-REPORTLEDGERRECOVER245S: recovers the recorded-jobs reporting slice
 * of original PR #4284 (RQ-REPORTS-NO-GROK-1) — a deterministic 12 h
 * `ashlr fleet report-ledger` read of metrics/jobs.jsonl with no model and no
 * network. Assertions map the original summarizeJobsLedger/readJobsTail and
 * cmdFleetReportExport contract onto the new ledger-only surface; scheduler,
 * world-model, intents and desktop integration remain out of scope (see
 * BRIDGE_NOTES.md).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetReportLedger } from '../src/cli/fleet-report-ledger.js';
import {
  buildReportLedger,
  readJobsTail,
  renderReportLedgerText,
  summarizeJobsLedger,
  REPORT_LEDGER_SCHEMA,
  REPORT_LEDGER_WINDOW_MS,
} from '../src/core/fleet/report-ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const runsRoot = (): string => { const dir = mkdtempSync(join(tmpdir(), 'report-ledger-')); dirs.push(dir); return dir; };
const at = (iso: string): Date => new Date(iso);
const NOW = at('2026-11-09T12:00:00Z').getTime(); // window: 2026-11-09T00:00Z..12:00Z

const row = (r: Record<string, unknown>): string => JSON.stringify(r);
const ledgerText = [
  row({ event: 'launch', job: 'RQ-A-1', lane: 'devin', ts: '2026-11-09T01:00:00Z' }),
  row({ event: 'finish', job: 'RQ-A-1', lane: 'devin', tokens_total: 4000, empty: false, ts: '2026-11-09T02:00:00Z' }),
  row({ event: 'publish', job: 'RQ-A-1', lane: 'devin', url: 'https://github.com/ashlrai/phantom/pull/4231', ts: '2026-11-09T03:00:00Z' }),
  row({ event: 'outcome', job: 'RQ-A-1', lane: 'devin', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/4231', ttm_s: 3200, mergedAt: '2026-11-09T04:00:00Z', ts: '2026-11-09T04:00:00Z' }),
  row({ event: 'launch', job: 'RQ-B-2', lane: 'claude', ts: '2026-11-09T05:00:00Z' }),
  row({ event: 'finish', job: 'RQ-B-2', lane: 'claude', tokens: 800, empty: true, ts: '2026-11-09T06:00:00Z' }),
  row({ event: 'publish', job: 'RQ-B-2', lane: 'claude', url: 'https://github.com/ashlrai/lexicon/pull/77', ts: '2026-11-09T07:00:00Z' }),
  // duplicate identities: same publish URL and same merge URL must not double-count evidence
  row({ event: 'publish', job: 'RQ-A-1', lane: 'devin', url: 'https://github.com/ashlrai/phantom/pull/4231', ts: '2026-11-09T07:30:00Z' }),
  row({ event: 'outcome', job: 'RQ-A-1', lane: 'devin', outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/4231', ts: '2026-11-09T08:00:00Z' }),
  row({ event: 'finish', job: 'RQ-OLD-9', lane: 'devin', tokens_total: 99999, ts: '2026-11-08T20:00:00Z' }), // outside window
  'not json at all',
  row({ event: 'outcome', job: 'RQ-C-3', outcome: 'CLOSED', ts: '2026-11-09T09:00:00Z' }),
].join('\n');

const LOADERS = { 'report-ledger': () => import('../src/cli/fleet-report-ledger.js') };

describe('summarizeJobsLedger', () => {
  it('counts the window, dedupes publish/merge identities and skips malformed rows', () => {
    const growth = summarizeJobsLedger(ledgerText, false, NOW);
    expect(growth.launches).toBe(2);
    expect(growth.finishes).toBe(2);
    expect(growth.empty).toBe(1);
    expect(growth.publishes).toBe(3); // raw publish events count; evidence dedupes
    expect(growth.merges).toBe(2);    // both MERGED outcome rows count
    expect(growth.tokens).toBe(4800);
    expect(growth.ledger).toBe('available');
    expect(growth.published).toHaveLength(2); // URL-deduped: 4231 once + lexicon/77
    expect(growth.merged).toHaveLength(1);    // both MERGED rows share the 4231 URL
    expect(growth.merged[0]).toMatchObject({ job: 'RQ-A-1', url: 'https://github.com/ashlrai/phantom/pull/4231', ttmSeconds: 3200 });
    expect(growth.byLane.find((r) => r.lane === 'devin')).toMatchObject({ launches: 1, finishes: 1, merges: 2 });
  });

  it('honors boundary timestamps and drops far-future rows', () => {
    const edge = [
      row({ event: 'launch', job: 'RQ-EDGE', ts: new Date(NOW - REPORT_LEDGER_WINDOW_MS).toISOString() }), // == since: in
      row({ event: 'launch', job: 'RQ-NOW', ts: new Date(NOW).toISOString() }),                            // == now: in
      row({ event: 'launch', job: 'RQ-PAST', ts: new Date(NOW - REPORT_LEDGER_WINDOW_MS - 1).toISOString() }), // just out
      row({ event: 'launch', job: 'RQ-FUTURE', ts: new Date(NOW + 86_400_001).toISOString() }),             // beyond +24h guard: out
      row({ event: 'launch', job: 'RQ-PLUS0000', ts: '2026-11-09T10:00:00+0000' }),                          // offset alias
      row({ type: 'launch', job_id: 'RQ-TYPE', timestamp: '2026-11-09T11:00:00Z' }),                         // type/job_id/timestamp aliases
    ].join('\n');
    const growth = summarizeJobsLedger(edge, false, NOW);
    expect(growth.launches).toBe(4);
    expect(growth.ledger).toBe('available');
  });

  it('marks empty text unavailable, out-of-window-only text incomplete, truncation incomplete', () => {
    expect(summarizeJobsLedger('', false, NOW).ledger).toBe('unavailable');
    expect(summarizeJobsLedger('   \n', false, NOW).ledger).toBe('unavailable');
    const stale = row({ event: 'launch', job: 'RQ-X', ts: '2026-11-01T00:00:00Z' });
    expect(summarizeJobsLedger(stale, false, NOW).ledger).toBe('incomplete');
    expect(summarizeJobsLedger(ledgerText, true, NOW).ledger).toBe('incomplete');
  });
});

describe('readJobsTail', () => {
  it('returns null for a missing file and drops the partial first line of a >2MiB tail', async () => {
    const root = runsRoot();
    expect((await readJobsTail(join(root, 'metrics', 'jobs.jsonl'))).text).toBeNull();
    const metrics = join(root, 'metrics');
    mkdirSync(metrics, { recursive: true });
    const path = join(metrics, 'jobs.jsonl');
    const pad = 'x'.repeat(3 * 1024 * 1024);
    writeFileSync(path, `${pad}\n${ledgerText}\n`);
    const read = await readJobsTail(path);
    expect(read.truncated).toBe(true);
    expect(read.text).not.toContain(pad);
    expect(read.text).toContain('RQ-A-1');
    const small = join(root, 'small.jsonl');
    writeFileSync(small, ledgerText);
    const whole = await readJobsTail(small);
    expect(whole.truncated).toBe(false);
    expect(whole.text).toBe(ledgerText);
  });
});

describe('buildReportLedger / renderReportLedgerText', () => {
  it('emits a versioned schema with window, counts, lanes and bounded evidence', async () => {
    const root = runsRoot();
    const report = await buildReportLedger({ runsDir: root, now: at('2026-11-09T12:00:00Z'), jobsText: async () => ({ text: ledgerText, truncated: false }) });
    expect(report.schema).toBe(REPORT_LEDGER_SCHEMA);
    expect(report.window).toEqual({ hours: 12, since: '2026-11-09T00:00:00.000Z', until: '2026-11-09T12:00:00.000Z' });
    expect(report.ledger).toBe('available');
    expect(report.counts).toMatchObject({ launches: 2, finishes: 2, empty: 1, publishes: 3, merges: 2, tokens: 4800 });
    expect(report.countsAreLowerBound).toBe(false);
    expect(report.evidence.published).toHaveLength(2);
    expect(report.evidence.merged).toHaveLength(1); // same URL dedupes to one row
    const text = renderReportLedgerText(report);
    expect(text).toContain('launches 2');
    expect(text).toContain('https://github.com/ashlrai/phantom/pull/4231 — merged · RQ-A-1');
    expect(text).not.toContain('not json at all');
  });

  it('keeps unavailable counts null and flags truncated tails as lower bounds', async () => {
    const root = runsRoot();
    const missing = await buildReportLedger({ runsDir: root, now: at('2026-11-09T12:00:00Z') });
    expect(missing.ledger).toBe('unavailable');
    expect(missing.counts.launches).toBeNull();
    expect(missing.counts.tokens).toBeNull();
    expect(renderReportLedgerText(missing)).toContain('counts unknown');
    const partial = await buildReportLedger({ runsDir: root, now: at('2026-11-09T12:00:00Z'), jobsText: async () => ({ text: ledgerText, truncated: true }) });
    expect(partial.ledger).toBe('incomplete');
    expect(partial.countsAreLowerBound).toBe(true);
    expect(renderReportLedgerText(partial)).toContain('lower bound');
  });

  it('scrubs secret-shaped lane text out of JSON and plain output', async () => {
    const leaky = row({ event: 'launch', job: 'RQ-LEAK', lane: 'devin token=sk-abcdefghijklmnop', ts: '2026-11-09T10:00:00Z' });
    const report = await buildReportLedger({ runsDir: runsRoot(), now: at('2026-11-09T12:00:00Z'), jobsText: async () => ({ text: leaky, truncated: false }) });
    const json = JSON.stringify(report);
    const plain = renderReportLedgerText(report);
    expect(json).not.toContain('sk-abcdefghijklmnop');
    expect(plain).not.toContain('sk-abcdefghijklmnop');
  });
});

describe('cmdFleetReportLedger', () => {
  it('prints plain and --json output from a real file-backed ledger', async () => {
    const root = runsRoot();
    mkdirSync(join(root, 'metrics'), { recursive: true });
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), ledgerText);
    const lines: string[] = [];
    const code = await cmdFleetReportLedger(['--runs-dir', root], { now: () => at('2026-11-09T12:00:00Z'), output: (t) => lines.push(t) });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('launches 2');
    const jsonLines: string[] = [];
    await cmdFleetReportLedger(['--runs-dir', root, '--json'], { now: () => at('2026-11-09T12:00:00Z'), output: (t) => jsonLines.push(t) });
    const parsed = JSON.parse(jsonLines[0]!);
    expect(parsed.schema).toBe(REPORT_LEDGER_SCHEMA);
    expect(parsed.counts.merges).toBe(2);
    expect(parsed.evidence.merged).toHaveLength(1);
  });

  it('reaches the verb through the real cmdFleet convention dispatch', async () => {
    const root = runsRoot();
    mkdirSync(join(root, 'metrics'), { recursive: true });
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), ledgerText);
    // The loader path calls the verb with console output; spy to capture it.
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((t: unknown) => out.push(String(t)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((t: unknown) => err.push(String(t)));
    try {
      const code = await cmdFleet(['report-ledger', '--runs-dir', root, '--json'], LOADERS);
      expect(code).toBe(0);
      expect(err.join('\n')).not.toContain('unknown fleet subcommand');
      const parsed = JSON.parse(out.join('\n'));
      expect(parsed.schema).toBe(REPORT_LEDGER_SCHEMA);
      expect(parsed.counts).not.toBeNull();
    } finally {
      log.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('rejects invalid flags before any read and honors --help', async () => {
    const errors: string[] = [];
    const missing = join(runsRoot(), 'nope');
    for (const args of [
      ['--bogus'],
      ['--runs-dir'],
      ['--runs-dir', '--json'],
      ['--json', '--json'],
      ['--runs-dir', missing, '--runs-dir', missing],
    ]) {
      expect(await cmdFleetReportLedger(args, { error: (t) => errors.push(t) })).toBe(2);
    }
    expect(errors.length).toBe(5);
    const help: string[] = [];
    expect(await cmdFleetReportLedger(['--help'], { output: (t) => help.push(t) })).toBe(0);
    expect(help[0]).toContain('fleet report-ledger');
  });
});
