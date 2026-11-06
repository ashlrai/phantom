import { readFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetRunning, parseTs, runningJobs } from '../src/cli/fleet-running.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const fixture = 'test/fixtures/fleet-running/jobs.jsonl';
const now = Date.parse('2026-11-03T12:00:00Z');
afterEach(() => vi.restoreAllMocks());

it('lists unfinished launches from the last 6 hours, sorted by lane then age', async () => {
  const report = runningJobs(await readFile(fixture, 'utf8'), now);
  expect(report.by_lane).toEqual({ claude: 2, codex: 2 });
  expect(report.jobs.map(j => [j.job, j.lane, j.minutes])).toEqual([
    ['redo', 'claude', 40], ['b1', 'claude', 10], ['a1', 'codex', 60], ['a2', 'codex', 30],
  ]);
  expect(report.jobs[3]).toMatchObject({ model: 'gpt-x', repo: 'hub', tier: 'fix' });
});

it('accepts -0500 style offsets', () => {
  expect(parseTs('2026-11-03T06:00:00-0500')).toBe(Date.parse('2026-11-03T11:00:00Z'));
  expect(parseTs('2026-11-03 06:00:00+0530')).toBe(Date.parse('2026-11-03T00:30:00Z'));
  expect(parseTs('nope')).toBeNaN();
});

it('only reads the last 3000 lines', () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `{"job":"x${i}","event":"finish","ts":"2026-11-03T11:00:00Z"}`);
  const first = '{"job":"early","event":"launch","ts":"2026-11-03T11:00:00Z","lane":"l"}';
  expect(runningJobs([first, ...filler].join('\n'), now).total).toBe(0);
  expect(runningJobs([...filler.slice(1), first].join('\n'), now).total).toBe(1);
});

it('prints the count line first, supports --json, errors and is registered', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const read = () => readFile(fixture, 'utf8');
  expect(await cmdFleetRunning([], read, () => now)).toBe(0);
  expect((log.mock.calls[0]![0] as string).split('\n')[0]).toBe('Running now: 4 (claude=2 codex=2)');
  expect(await cmdFleetRunning(['--json'], read, () => now)).toBe(0);
  expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({ schema: 'fleet.running.v1', total: 4 });
  expect(await cmdFleetRunning([], async () => { throw new Error('x'); })).toBe(1);
  expect(await cmdFleetRunning(['--bad'])).toBe(2);
  expect(err).toHaveBeenCalled();
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['running']!()).cmdFleetRunning).toBe('function');
});
