import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetPrWait, fleetPrWait } from '../src/cli/fleet-pr-wait.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const queue = ['- PR-OPEN A (pool=x)', '- PR-OPEN B (pool=x)', '- PR-OPEN C (pool=x)', '- PR-OPEN D (pool=x)', '- READY X (pool=x)'].join('\n');
const row = (value: object) => JSON.stringify(value);
const jobs = [
  row({ class: 'pr', job: 'A', ts: '2026-11-03T05:00:00Z' }),
  row({ event: 'outcome', state: 'OPEN', job: 'B', ts: '2026-11-03T06:00:00Z' }),
  row({ event: 'outcome', state: 'MERGED', job: 'D', ts: '2026-11-01T00:00:00Z', ttm_s: 9 }),
  ...[10, 20, 30, 40].map(ttm_s => row({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T11:00:00Z', ttm_s })),
  row({ event: 'outcome', state: 'MERGED', ts: '2026-11-04T11:00:00Z', ttm_s: 999 }),
  '{bad',
].join('\n');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('reports waiting jobs with evidence-based ages and windowed percentiles', () => {
  const report = fleetPrWait(queue, jobs, 24, 6, now);
  expect(report.waiting).toEqual([
    { id: 'A', opened_at: '2026-11-03T05:00:00.000Z', age_hours: 7, overdue: true },
    { id: 'B', opened_at: '2026-11-03T06:00:00.000Z', age_hours: 6, overdue: false },
    { id: 'C', opened_at: null, age_hours: null, overdue: false },
  ]);
  expect(report).toMatchObject({ merged_rows: 4, p50_ttm_s: 25, p90_ttm_s: 40 });
  expect(fleetPrWait('', '', 24, 6, now)).toMatchObject({ waiting: [], p50_ttm_s: null, p90_ttm_s: null });
});

it('reads the override root, validates flags, reports failures and registers the verb', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-wait-'));
  try {
    await mkdir(join(root, 'queue')); await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'queue/router-queue.md'), queue);
    await writeFile(join(root, 'metrics/jobs.jsonl'), jobs);
    vi.stubEnv('ASHLR_RUNS_DIR', root); vi.spyOn(Date, 'now').mockReturnValue(now);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetPrWait(['--json'])).toBe(1);
    expect(JSON.parse(log.mock.lastCall![0] as string).waiting[0].id).toBe('A');
    expect(await cmdFleetPrWait(['--hours', '1', '--max-hours', '8'])).toBe(0);
    expect(log.mock.lastCall![0]).toContain('C: age unknown');
    for (const args of [['--hours'], ['--hours', '0'], ['--max-hours', 'NaN'], ['--json', '--json'], ['bad']]) expect(await cmdFleetPrWait(args)).toBe(2);
    expect(await cmdFleetPrWait(['--help'])).toBe(0);
    await rm(join(root, 'metrics/jobs.jsonl'));
    expect(await cmdFleetPrWait([])).toBe(1);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['pr-wait']!()).cmdFleetPrWait).toBe('function');
  } finally { await rm(root, { recursive: true, force: true }); }
});
