import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobLatency, jobLatency } from '../src/cli/fleet-job-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

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
