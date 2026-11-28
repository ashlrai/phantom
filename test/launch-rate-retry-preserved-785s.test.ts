import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdFleetLaunches } from '../src/cli/fleet-launches.js';
import { buildLaunchRate } from '../src/core/fleet/launch-rate.js';
import { buildRelaunches } from '../src/core/fleet/relaunches.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const row = (job: string, event: string, hoursAgo: number, extra = {}) =>
  JSON.stringify({ job, event, ts: new Date(now - hoursAgo * 3_600_000).toISOString(), ...extra });
const ledger = [
  ...[20, 10, 2].map(h => row('fake-retry', 'launch', h, { lane: 'retry-lane' })),
  row('fake-merged', 'launch', 3, { lane: 'merged-lane' }),
  row('fake-merged', 'merged', 1, { url: 'https://github.com/example/example/pull/1' }),
  row('fake-old', 'launch', 25, { lane: 'old-lane' }),
].join('\n');

describe('launch rate retry preservation', () => {
  it('exposes the 24-hour analyzer and per-lane starts per merge for any display window', () => {
    const expected = buildRelaunches(ledger, now);
    for (const hours of [1, 48]) {
      const report = buildLaunchRate({ ledger, now, hours });
      expect(report.relaunches).toEqual(expected.jobs);
      expect(report.repeat_jobs).toEqual(expected.repeat_jobs);
      expect(report.repeat_jobs.map(job => job.job)).toEqual(['fake-retry']);
      expect(report.relaunches['fake-retry']?.launches).toBe(3);
      expect(report.relaunches['fake-merged']?.merged).toBe(1);
      expect(report.relaunches['fake-old']).toBeUndefined();
      expect(report.lanes.find(lane => lane.lane === 'merged-lane')?.starts_per_merged_pr).toBe(1);
      expect(report.lanes.find(lane => lane.lane === 'retry-lane')?.starts_per_merged_pr).toBeNull();
    }
    const unreadable = buildLaunchRate({ ledger: null, now, hours: 24 });
    expect(unreadable.metrics).toBe('unreadable');
    expect(unreadable.relaunches).toEqual({});
    expect(unreadable.repeat_jobs).toEqual([]);
  });

  it('returns the same fields through the launches JSON CLI and retains unreadable status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-retry-785s-'));
    try {
      await mkdir(join(dir, 'metrics'));
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger);
      const output: string[] = [];
      const run = (root: string) => cmdFleetLaunches(['--runs-dir', root, '--hours', '1', '--json'], {
        now: () => now, out: line => output.push(line),
      });
      expect(await run(dir)).toBe(0);
      const report = JSON.parse(output.pop()!);
      expect(report.relaunches).toEqual(buildRelaunches(ledger, now).jobs);
      expect(report.repeat_jobs.map((job: { job: string }) => job.job)).toEqual(['fake-retry']);
      expect(report.lanes.find((lane: { lane: string }) => lane.lane === 'merged-lane').starts_per_merged_pr).toBe(1);
      expect(await run(join(dir, 'missing'))).toBe(1);
      expect(JSON.parse(output.pop()!).metrics).toBe('unreadable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
