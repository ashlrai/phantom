import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetSkipForecast, readSkipForecast } from '../src/cli/fleet-skip-forecast.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T18:00:00Z');
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'skip-forecast-')); dirs.push(dir);
  const jobs = join(dir, 'jobs.jsonl'), queue = join(dir, 'router-queue.md');
  const row = (job: string, extra = {}) => JSON.stringify({ event: 'precheck_skip', code: 13, job, repo: 'phantom', ts: '2026-11-03T17:00:00Z', ...extra });
  await writeFile(queue, [
    '- READY RQ-A (repo=phantom): edit `src/a.ts` then `src/second.ts`',
    '- DONE RQ-B (repo=phantom): edit `src/a.ts`',
    '- READY RQ-A-LONG (repo=phantom): edit `wrong.ts`',
    '- READY RQ-NOPATH (repo=phantom): plain text',
    ...Array.from({ length: 12 }, (_, i) => `- READY RQ-${i} (repo=other): edit \`src/${i}.ts\``),
  ].join('\n'));
  await writeFile(jobs, [row('RQ-A'), row('RQ-B'), row('RQ-A'), row('RQ-A', { repo: 'alpha' }),
    row('RQ-A', { code: 12 }), row('RQ-A', { event: 'finish' }),
    row('RQ-A', { ts: '2026-11-03T11:59:59Z' }), row('RQ-A', { ts: '2026-11-03T18:00:01Z' }),
    row('RQ-A', { ts: 'bad' }), row('RQ-MISSING'), row('RQ-NOPATH'),
    row('RQ-A', { ts: '2026-11-03T12:00:00Z' }), 'broken', 'null',
    ...Array.from({ length: 12 }, (_, i) => row(`RQ-${i}`, { repo: 'other' })),
  ].join('\n'));
  return { readJobs: () => readFile(jobs, 'utf8'), readQueue: () => readFile(queue, 'utf8'), now: () => now };
}

it('counts code 13 rows by repo and first path, filters time, and limits results to ten', async () => {
  const readers = await fixture();
  const report = await readSkipForecast(6, readers);
  expect(report).toMatchObject({ matched_skips: 17, unmatched_skips: 2 });
  expect(report.top_paths).toHaveLength(10);
  expect(report.top_paths[0]).toEqual({ repo: 'phantom', path: 'src/a.ts', skip_count: 4 });
  expect(report.top_paths).toContainEqual({ repo: 'alpha', path: 'src/a.ts', skip_count: 1 });
  expect(await readSkipForecast(0.5, readers)).toMatchObject({ matched_skips: 0, top_paths: [] });
  expect(await readSkipForecast(6, readers)).toEqual(report);
});

it('offers JSON and plain output, validates flags before reads, and reports missing files', async () => {
  const readers = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetSkipForecast(['--json'], readers)).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ hours: 6, matched_skips: 17 });
  expect(await cmdFleetSkipForecast(['--hours', '6'], readers)).toBe(0);
  expect(log.mock.lastCall?.[0]).toContain('phantom src/a.ts: 4 skips');
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'Infinity'], ['--hours', 'no'], ['--json', '--json'], ['--bad'], ['--hours', '2', '--hours', '3']]) {
    expect(await cmdFleetSkipForecast(args, { readJobs: () => { throw new Error('must not read'); } })).toBe(2);
  }
  expect(await cmdFleetSkipForecast(['--json'], { ...readers, readQueue: () => readFile('/missing/queue.md', 'utf8') })).toBe(1);
  expect(await cmdFleetSkipForecast(['--help'], readers)).toBe(0);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['skip-forecast']!()).cmdFleetSkipForecast).toBe('function');
});
