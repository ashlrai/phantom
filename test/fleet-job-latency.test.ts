import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobLatency, jobLatency } from '../src/cli/fleet-job-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdPulse } from '../src/cli/pulse.js';
import { mergeQueueLatency } from '../src/core/fleet/job-latency.js';

const fixture = 'test/fixtures/job-latency/jobs.jsonl';
afterEach(() => vi.restoreAllMocks());

it('ranks measured phases and excludes ambiguous and missing boundaries', async () => {
  const report = jobLatency(await readFile(fixture, 'utf8'));
  expect(report).toMatchObject({ jobs: 2, ignored_events: 1 });
  expect(report.top_wastes.map(x => [x.phase, x.total_seconds, x.measured_jobs, x.missing_jobs])).toEqual([
    ['merge', 50, 1, 1], ['ci', 40, 1, 1], ['model', 30, 1, 1], ['checkout', 20, 1, 1], ['queue_wait', 10, 1, 1],
  ]);
  expect(report.top_wastes.every(x => x.fix_line.length > 0)).toBe(true);
  expect(jobLatency('{"job":"a","event":"launch","ts":"2026-01-01T00:00:02Z"}\n{"job":"a","event":"queued","ts":"2026-01-01T00:00:03Z"}').top_wastes).toEqual([]);
});

it('supports JSON, reports read errors, and is registered', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetJobLatency(['--jobs', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('fleet.job-latency.v1');
  expect(await cmdFleetJobLatency(['--jobs', '/missing'])).toBe(1);
  expect(await cmdFleetJobLatency(['--json', '--json'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['job-latency']!()).cmdFleetJobLatency).toBe('function');
});

const event = (event: string, ts: string | null) => ({ job: 'attempt-1', event, ts });
const start = '2026-01-01T00:00:00Z', end = '2026-01-01T00:01:00Z';
it.each([
  ['missing', [event('ci_start', start)]],
  ['reversed', [event('ci_start', end), event('ci_complete', start)]],
  ['ambiguous', [event('ci_start', start), event('ci_start', end), event('ci_complete', end)]],
  ['invalid', [event('ci_start', 'bad-date'), event('ci_complete', end)]],
  ['invalid duplicate', [event('ci_start', start), event('ci_start', null), event('ci_complete', end)]],
] as const)('keeps %s check boundaries unknown', (_name, rows) => {
  const report = mergeQueueLatency(rows.map(row => JSON.stringify(row)).join('\n'));
  expect(report.phases[1]).toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it('uses actual merge time, aliases and shuffled events without counting duplicate boundaries twice', () => {
  const rows = [
    { job_id: 'attempt-1', type: 'outcome', state: 'MERGED', timestamp: '2026-01-02T00:00:00Z', mergedAt: '2026-01-01T00:03:00Z' },
    event('ci_complete', '2026-01-01T00:02:00Z'), event('publish', start), event('ci_start', end), event('ci_start', end),
  ];
  const report = mergeQueueLatency(rows.map(row => JSON.stringify(row)).join('\n'));
  expect(report.schema).toBe('pulse.merge-latency.v1');
  expect(report.phases.map(p => [p.phase, p.total_seconds, p.measured_jobs, p.missing_jobs])).toEqual([
    ['check_wait', 60, 1, 0], ['ci', 60, 1, 0], ['merge', 60, 1, 0],
  ]);
  expect(mergeQueueLatency([event('ci_start', start), event('ci_complete', start)].map(row => JSON.stringify(row)).join('\n')).phases[1]?.total_seconds).toBe(0);
});

it('exposes versioned pulse JSON and plain text, including unreadable ledgers and usage errors', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdPulse(['merge-latency', '--jobs', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'pulse.merge-latency.v1', known: true, jobs: 2 });
  expect(await cmdPulse(['merge-latency', '--jobs', fixture])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('Waiting for checks: unknown');
  expect(log.mock.calls.at(-1)![0]).toContain('Running checks: 40s total observed');
  expect(await cmdPulse(['merge-latency', '--jobs', '/missing', '--json'])).toBe(1);
  const missing = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(missing).toMatchObject({ schema: 'pulse.merge-latency.v1', known: false, jobs: null });
  expect(missing.phases.every((p: { total_seconds: null }) => p.total_seconds === null)).toBe(true);
  expect(await cmdPulse(['merge-latency', '--jobs'])).toBe(2);
  expect(await cmdPulse(['merge-latency', '--json', '--json'])).toBe(2);
  expect(await cmdPulse(['merge-latency', '--help'])).toBe(0);
});
