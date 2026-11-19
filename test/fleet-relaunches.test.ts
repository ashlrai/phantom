import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetRelaunches } from '../src/cli/fleet-relaunches.js';
import { buildLaunchRate } from '../src/core/fleet/launch-rate.js';
import { buildRelaunches, relaunchesText } from '../src/core/fleet/relaunches.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const row = (event: string, minutesAgo: number, extra: Record<string, unknown>) => JSON.stringify({ event, ts: at(minutesAgo), ...extra });
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const launch = (job: string, lane: string, ago: number) => row('launch', ago, { job, lane });
const finish = (job: string, ago: number, wall_s: number) => row('finish', ago, { job, wall_s });
const merged = (job: string, n: number, ago: number) => row('outcome', ago, { job, url: pr(n), state: 'MERGED' });

// Four launches on zai at about 25 minutes each (98 minutes in all), no PR; and one launch on claude that merged.
const LEDGER = [
  ...[0, 1, 2, 3].flatMap(i => [launch('RQ-RED', 'zai', 400 - 100 * i), finish('RQ-RED', 380 - 100 * i, i === 3 ? 1380 : 1500)]),
  launch('RQ-GOOD', 'claude', 200), finish('RQ-GOOD', 170, 1800), merged('RQ-GOOD', 7001, 150),
  launch('RQ-TWICE', 'zai', 90), launch('RQ-TWICE', 'zai', 60),
  // Older than 24 hours: not counted.
  launch('RQ-OLD', 'zai', 30 * 60), launch('RQ-OLD', 'zai', 29 * 60), launch('RQ-OLD', 'zai', 28 * 60),
];

describe('buildRelaunches', () => {
  const report = buildRelaunches(LEDGER.join('\n'), NOW);

  it('counts launches, lanes, minutes, PRs and merges per job over 24 hours', () => {
    expect(report.schema).toBe('fleet.relaunches.v1');
    expect(report.jobs['RQ-RED']).toEqual({ launches: 4, lanes: ['zai'], minutes_spent: 98, prs: 0, merged: 0 });
    expect(report.jobs['RQ-GOOD']).toEqual({ launches: 1, lanes: ['claude'], minutes_spent: 30, prs: 1, merged: 1 });
    expect(report.jobs['RQ-TWICE']).toMatchObject({ launches: 2, minutes_spent: 0 });
    expect(report.jobs['RQ-OLD']).toBeUndefined();
  });

  it('lists the 4-launch job with no merge and not the 1-launch merged job', () => {
    expect(report.repeat_jobs.map(j => j.job)).toEqual(['RQ-RED']);
    expect(report.repeat_jobs[0]).toMatchObject({
      summary: 'launched 4 times on zai, 98 minutes, no PR came out', suggest: 'move to another lane or retire',
    });
    expect(report.next_step).toBe('RQ-RED: move to another lane or retire');
    expect(relaunchesText(report)).toEqual([
      '1 job launched 3 or more times in 24 h with no merged PR.',
      '- RQ-RED: launched 4 times on zai, 98 minutes, no PR came out; suggest: move to another lane or retire',
      'Next: RQ-RED: move to another lane or retire',
    ]);
  });

  it('does not list a job that launched often but merged a PR, and says unknown when unreadable', () => {
    const lines = [...[0, 1, 2].map(i => launch('RQ-OK', 'claude', 100 + i)), merged('RQ-OK', 9, 10)];
    expect(buildRelaunches(lines.join('\n'), NOW).repeat_jobs).toEqual([]);
    const none = buildRelaunches(null, NOW);
    expect(none).toMatchObject({ metrics: 'unreadable', repeat_jobs: [], next_step: null });
    expect(relaunchesText(none)).toEqual(['Repeat launches: unknown (cannot read the job metrics file).']);
  });
});

describe('launches read carries the same rollup', () => {
  it('adds relaunches per job, repeat_jobs and starts_per_merged_pr per lane', () => {
    const report = buildLaunchRate({ ledger: LEDGER.join('\n'), now: NOW, hours: 24 });
    expect(report.relaunches['RQ-RED']).toMatchObject({ launches: 4, minutes_spent: 98 });
    expect(report.repeat_jobs.map(j => j.job)).toEqual(['RQ-RED']);
    const zai = report.lanes.find(l => l.lane === 'zai')!, claude = report.lanes.find(l => l.lane === 'claude')!;
    expect(zai).toMatchObject({ starts_24h: 6, merged_24h: 0, starts_per_merged_pr: null });
    expect(claude).toMatchObject({ starts_24h: 1, merged_24h: 1, starts_per_merged_pr: 1 });
    const busy = buildLaunchRate({ ledger: [...['A', 'B', 'C', 'D'].map(j => launch(`RQ-${j}`, 'codex', 50)), merged('RQ-A', 5, 10)].join('\n'), now: NOW, hours: 24 });
    expect(busy.lanes.find(l => l.lane === 'codex')!.starts_per_merged_pr).toBe(4);
    expect(buildLaunchRate({ ledger: null, now: NOW, hours: 24 })).toMatchObject({ relaunches: {}, repeat_jobs: [] });
  });
});

describe('phm fleet relaunches', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relaunches-'));
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), LEDGER.join('\n') + '\n');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const run = async (args: string[]) => {
    const lines: string[] = [], errs: string[] = [];
    const code = await cmdFleetRelaunches(args, { now: () => NOW, out: l => lines.push(l), err: l => errs.push(l) });
    return { code, text: lines.join('\n'), errs: errs.join('\n') };
  };

  it('prints typed JSON with a schema id', async () => {
    const { code, text } = await run(['--json', '--runs-dir', dir]);
    expect(code).toBe(0);
    const parsed = JSON.parse(text);
    expect(parsed.schema).toBe('fleet.relaunches.v1');
    expect(parsed.repeat_jobs[0]).toMatchObject({ job: 'RQ-RED', launches: 4, lanes: ['zai'], minutes_spent: 98, prs: 0, merged: 0 });
  });

  it('prints plain words, exits 1 without metrics, 2 on a bad option, 0 on help', async () => {
    expect((await run(['--runs-dir', dir])).text).toContain('launched 4 times on zai, 98 minutes, no PR came out; suggest: move to another lane or retire');
    expect((await run(['--runs-dir', join(dir, 'missing')])).code).toBe(1);
    expect((await run(['--nope'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});
