import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdFleetSkipped, cmdJobsSkipped } from '../src/cli/fleet-skipped.js';
import { buildPulseAlerts } from '../src/core/fleet/pulse-alerts.js';
import { readSkippedJobs, summarizeSkips } from '../src/core/fleet/skipped-jobs.js';

const now = Date.parse('2026-11-19T12:00:00Z');
const row = (job: string, code: unknown, minutes: number, extra: Record<string, unknown> = {}) => JSON.stringify({ event: 'precheck_skip', job, code, ts: new Date(now - minutes * 60000).toISOString(), lane: 'test', repo: 'phantom', ...extra });
const input = [row('RQ-REPEAT1', 10, 1), row('RQ-REPEAT1', 11, 2), row('RQ-LEAD1', 12, 3, { src: 'leader' }), row('RQ-OTHER1', 13, 4), row('RQ-UNKNOWN1', 99, 5), row('RQ-NOCODE1', null, 6), row('RQ-OLD1', 10, 1500), row('RQ-FUTURE1', 10, -1), row('RQ-UNRELATED1', 10, 1, { event: 'launch' }), 'invalid'].join('\n');
let dir = '';
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) await rm(dir, { recursive: true, force: true }); dir = ''; });

describe('original skipped jobs preservation', () => {
  it('reads bounded rows, meaningful codes, repeat and explicit leader provenance', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-original-'));
    await mkdir(join(dir, 'metrics'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), input);
    const report = await readSkippedJobs({ runsDir: dir, now });
    expect(report.total).toBe(6);
    expect(report.by_code.map(g => [g.code, g.meaning])).toEqual([
      [10, 'Already merged or closed.'], [11, 'A pull request is open and green.'],
      [12, 'A duplicate pull request is open.'], [13, 'The files or symbols it names already exist, or its family is stopped.'],
      [99, 'unknown'], [null, 'unknown'],
    ]);
    expect(report.repeated).toEqual(['RQ-REPEAT1']);
    expect(report.leader_skipped).toContain('RQ-LEAD1');
    const alert = buildPulseAlerts({ marks: [], starved: null, spend: null, skips: report }, now).alerts.find(a => a.kind === 'skipped');
    expect(alert?.detail).toContain('RQ-REPEAT1 was skipped more than once');
    expect(alert?.detail).toContain('RQ-LEAD1 was queued by the leader and skipped');
  });

  it('distinguishes an unreadable ledger from an empty one', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-original-'));
    const missing = await readSkippedJobs({ runsDir: dir, now });
    expect(missing.known).toBe(false);
    await mkdir(join(dir, 'metrics'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), '');
    expect(await readSkippedJobs({ runsDir: dir, now })).toMatchObject({ known: true, total: 0 });
    expect(buildPulseAlerts({ marks: [], starved: null, spend: null, skips: null }, now).unknown.join(' ')).toContain('Skipped jobs');
  });

  it('prints original JSON, text and usage through the exported command', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = async (hours: number) => summarizeSkips(input, now, hours);
    expect(await cmdJobsSkipped(['--json', '--since', '6h'], read)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ schema: 'jobs.skipped.v1', hours: 6, total: 6 });
    log.mockClear();
    expect(await cmdJobsSkipped([], read)).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('Skipped more than once: RQ-REPEAT1');
    expect(await cmdJobsSkipped(['--since', 'invalid'], read)).toBe(2);
    expect(error.mock.calls.flat().join(' ')).toContain('Usage: phm jobs skipped');
    expect(await cmdJobsSkipped([], async () => summarizeSkips(null, now))).toBe(1);
    expect(error.mock.calls.flat().join(' ')).toContain('jobs ledger could not be read');
  });

  it('dispatches the original jobs alias and fleet alias against an isolated ledger', async () => {
    dir = await mkdtemp(join(tmpdir(), 'skip-original-'));
    await mkdir(join(dir, 'metrics'));
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), row('RQ-DISPATCH1', 10, 0, { ts: new Date().toISOString() }));
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobs(['skipped', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ total: 1, known: true });
    expect(await cmdFleetSkipped(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ total: 1, known: true });
  });
});
