import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetLaunches } from '../src/cli/fleet-launches.js';
import { buildLaunchRate, launchRateText } from '../src/core/fleet/launch-rate.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const row = (job: string, event: string, ago: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ job, event, ts: new Date(now - ago * 60_000).toISOString(), ...extra });
const url = (n: number) => `https://github.com/example/fake/pull/${n}`;
const ledger = [
  row('RQ-REPEAT', 'launch', 900, { lane: 'alpha' }),
  row('RQ-REPEAT', 'finish', 890, { wall_s: 120 }),
  row('RQ-REPEAT', 'launch', 120, { lane: 'beta' }),
  row('RQ-REPEAT', 'launch', 30, { lane: 'beta' }),
  row('RQ-REPEAT', 'publish', 20, { url: url(1) }),
  row('RQ-MERGED', 'launch', 100, { lane: 'alpha' }),
  row('RQ-MERGED', 'outcome', 80, { url: url(2), state: 'MERGED' }),
  row('RQ-MERGED', 'outcome', 70, { url: url(2), state: 'MERGED' }),
  row('RQ-MERGED', 'outcome', 60, { url: url(3), state: 'MERGED' }),
  row('RQ-OLD', 'launch', 1500, { lane: 'gamma' }),
].join('\n');

describe('original launch-rate relaunch integration', () => {
  it('preserves 24-hour job spend and distinct merge rates with a six-hour window', () => {
    const report = buildLaunchRate({ ledger, now, hours: 6 });
    expect(report).toMatchObject({ schema: 'fleet.launches.v1', metrics: 'ok', plans: 'unknown', hours: 6, starts: 3, starts_per_hour: 0.5, wasted_starts: 0 });
    expect(report.lanes.find(l => l.lane === 'alpha')).toMatchObject({ starts: 1, starts_24h: 1, merged: 2, merged_24h: 2, starts_per_merged_pr: 0.5 });
    expect(report.lanes.find(l => l.lane === 'beta')).toMatchObject({ starts: 2, starts_24h: 3, merged_24h: 0, starts_per_merged_pr: null });
    expect(report.relaunches['RQ-REPEAT']).toEqual({ launches: 3, lanes: ['beta', 'alpha'], minutes_spent: 2, prs: 1, merged: 0 });
    expect(report.relaunches['RQ-OLD']).toBeUndefined();
    expect(report.repeat_jobs.map(j => j.job)).toEqual(['RQ-REPEAT']);
    expect(launchRateText(report)[0]).toBe(`${report.headline}.`);
  });

  it('exposes the same fields through the real JSON command and reports missing metrics honestly', async () => {
    const runs = await mkdtemp(join(tmpdir(), 'launch-rate-812s-'));
    const out: string[] = [], err: string[] = [];
    const run = (root: string) => cmdFleetLaunches(['--runs-dir', root, '--hours', '6', '--json'], { now: () => now, out: s => out.push(s), err: s => err.push(s) });
    try {
      await mkdir(join(runs, 'metrics'));
      await writeFile(join(runs, 'metrics', 'jobs.jsonl'), ledger);
      expect(await run(runs)).toBe(0);
      const report = JSON.parse(out.pop()!);
      expect(report).toMatchObject({ schema: 'fleet.launches.v1', hours: 6, starts: 3, metrics: 'ok', relaunches: { 'RQ-REPEAT': { launches: 3 } }, repeat_jobs: [{ job: 'RQ-REPEAT' }] });
      expect(report.lanes.find((l: { lane: string }) => l.lane === 'alpha').starts_per_merged_pr).toBe(0.5);
      expect(await run(join(runs, 'missing'))).toBe(1);
      expect(JSON.parse(out.pop()!)).toMatchObject({ metrics: 'unreadable', starts: null, longest_gap: null, lanes: [], relaunches: {}, repeat_jobs: [] });
      expect(err).toEqual([]);
    } finally { await rm(runs, { recursive: true, force: true }); }
  });
});
