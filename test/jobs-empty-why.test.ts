import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readJobsEmptyWhy } from '../src/core/fleet/jobs-empty-why.js';
import { readMetricsPanel } from '../src/core/fleet/metrics-panel.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
const now = Date.parse('2026-11-18T00:00:00Z');
const row = (job: string, fields = {}) => JSON.stringify({ job, ts: new Date(now).toISOString(), event: 'finish', empty: true, ...fields });
afterEach(() => vi.restoreAllMocks());
it.each([
  ['no diff', 'no-diff'], ['already on main', 'already-on-main'], ['no eligible targets found', 'precheck-catchable'],
  ['MCP tool failed; no diff', 'tool-error'], ['RESULT EMPTY', 'unknown'], ['covered by an existing PR', 'precheck-catchable'],
])('classifies the fixture %s without exposing evidence', async (log, reason) => {
  const report = await readJobsEmptyWhy(row('RQ-FIX-1'), '/runs', 24, now, async () => log);
  expect(report.jobs).toEqual([{ id: 'RQ-FIX-1', family: 'RQ-FIX', reason, tokens: null }]);
  expect(report.families[0]).toMatchObject({ wasted_tokens: null, tokens_unknown_jobs: 1, reasons: { [reason]: 1 } });
});
it('ranks measured waste first, preserves partial totals and excludes skips, productive, unsafe and out-of-window rows', async () => {
  const ledger = [row('RQ-BIG-1', { tokens_total: 90 }), row('RQ-BIG-2'), row('RQ-ZERO-1', { tokens_total: 0 }), row('RQ-UNKNOWN-1'),
    row('RQ-SKIP-1', { event: 'precheck_skip', tokens_total: 900 }), row('../escape'), row('RQ-GOOD-1', { empty: false }),
    row('RQ-OLD-1', { ts: '2026-11-01' }), row('RQ-FUTURE-1', { ts: '2026-12-01' }), 'bad JSON', row('RQ-BIG-1', { event: 'outcome' })].join('\n');
  const report = await readJobsEmptyWhy(ledger, '/runs', 24, now, async () => null);
  expect(report.total).toBe(4);
  expect(report.families.map(f => [f.family, f.wasted_tokens, f.tokens_unknown_jobs])).toEqual([['RQ-BIG', 90, 1], ['RQ-ZERO', 0, 0], ['RQ-UNKNOWN', null, 1]]);
  expect(await readJobsEmptyWhy(null, '/runs', 24, now)).toMatchObject({ known: false, total: null, families: [] });
  expect(await readJobsEmptyWhy('', '/runs', 24, now)).toMatchObject({ known: true, total: 0, families: [] });
});
it('routes the CLI and serves identical versioned reasons in the yield view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-why-'));
  try {
    await mkdir(join(root, 'metrics'));
    const metrics = join(root, 'metrics/jobs.jsonl');
    await writeFile(metrics, row('RQ-FIX-1', { tokens_total: 42 }));
    await writeFile(join(root, 'RQ-FIX-1.publish'), 'already on main');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdJobs(['empty-why', '--metrics', metrics, '--json'])).toBe(0);
    const report = JSON.parse(out.mock.calls[0]![0] as string);
    expect(report).toMatchObject({ schema: 'jobs.empty-why.v1', version: 1, total: 1, jobs: [{ reason: 'already-on-main', tokens: 42 }] });
    expect((await readMetricsPanel(root, now)).jobYield.empty_why).toEqual(report);
    expect(await cmdJobs(['empty-why', '--metrics', metrics])).toBe(0);
    expect(out.mock.calls.at(-1)![0]).toContain('42 wasted tokens');
    expect(await cmdJobs(['empty-why', '--metrics', join(root, 'missing'), '--json'])).toBe(1);
    expect(JSON.parse(out.mock.calls.at(-1)![0] as string)).toMatchObject({ known: false, total: null });
    expect(await cmdJobs(['empty-why', '--since', '0h'])).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('ignores echoed prompt heads, keeps absent evidence unknown and gives failed exits precedence', async () => {
  const log = `already on main\n${'working\n'.repeat(70)}`;
  expect((await readJobsEmptyWhy(row('RQ-TAIL-1', { exit_code: 0 }), '/runs', 24, now, async () => log)).jobs[0]!.reason).toBe('unknown');
  expect((await readJobsEmptyWhy(row('RQ-FAIL-1', { exit_code: 1 }), '/runs', 24, now, async () => 'already on main')).jobs[0]!.reason).toBe('tool-error');
});


it('empty-why rejects yield stop-file controls without performing any write', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const args of [['--stop-file'], ['--stop-list'], ['--dry-run'], ['--out', '/tmp/no-write'], ['--ttl-hours', '1']]) {
    expect(await cmdJobs(['empty-why', ...args])).toBe(2);
  }
});
