import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdDiskRunway } from '../src/cli/disk-runway.js';
import { buildDiskPlanReport, type WorktreeRecord, type WorktreeResult } from '../src/core/disk-maint/removal-plan.js';
import { buildDiskRunway, diskAlertStep, postDiskAlert, readDiskRunway } from '../src/core/fleet/disk-runway.js';
import { diskTrend, type HostDiskSample } from '../src/core/fleet/host-top-view.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const H = 3_600_000;
const at = (hoursAgo: number): number => Math.floor((NOW - hoursAgo * H) / 1000);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** 8 h ago is outside the 6 h window; inside it free space falls 19 GB an hour, 200 then 86. */
const falling: HostDiskSample[] = [
  { at: at(8), freeGb: 400 }, { at: at(6), freeGb: 200 }, { at: at(3), freeGb: 143 }, { at: at(0), freeGb: 86 },
];

const record = (jobId: string, result: WorktreeResult, gb: number): WorktreeRecord =>
  ({ jobId, bytes: gb * 1e9, modifiedMs: NOW - 48 * H, result, uncommitted: 'no', commitsAhead: 0 });
const records = [
  ...Array.from({ length: 8 }, (_, i) => record(`empty-${i}`, 'empty', 2 + i)),
  record('merged-a', 'pr-merged', 30), record('merged-b', 'pr-merged', 20),
  record('stuck-a', 'publish-aborted', 15), record('open-a', 'pr-open', 1),
];
const plan = buildDiskPlanReport(records, diskTrend([], 100, NOW), { nowMs: NOW });

describe('disk runway builder', () => {
  it('reads free GB, the 6 h rate, hours to the 60 GB freeze and the grouped top 10', () => {
    const r = buildDiskRunway(falling, plan, NOW);
    expect(r).toMatchObject({ schema: 'fleet.disk-runway.v1', freeGb: 86, samples: 3, gbPerHour: 19, freezeGb: 60, hoursToFreeze: 1.4, status: 'falling', worktrees: 12 });
    expect(r.sentence).toBe('Disk: 86 GB free, falling 19 GB an hour, 1.4 h to the launch freeze');
    expect(r.reclaim).toEqual({ count: 10, gb: 94 }); // every finished folder except the unpublished one and the open PR
    // Top 10 by size: both merged, the unpublished one, and seven of the eight empty ones; grouped merged, empty, unpublished.
    expect(r.groups.map(g => [g.label, g.count])).toEqual([['merged PR', 2], ['empty', 7], ['unpublished', 1]]);
    expect(r.groups.flatMap(g => g.folders).length).toBe(10);
    expect(r.groups[0]!.folders[0]).toEqual({ jobId: 'merged-a', gb: 30, result: 'pr-merged' });
  });

  it('says unknown, steady and frozen in plain words and never invents a rate', () => {
    expect(buildDiskRunway([], null, NOW)).toMatchObject({ freeGb: null, gbPerHour: null, hoursToFreeze: null, status: 'unknown', sentence: 'Disk: free space unknown' });
    const steady = buildDiskRunway([{ at: at(4), freeGb: 90 }, { at: at(0), freeGb: 91 }], plan, NOW);
    expect(steady).toMatchObject({ status: 'steady', hoursToFreeze: null });
    expect(buildDiskRunway([{ at: at(4), freeGb: 90 }, { at: at(0), freeGb: 55 }], plan, NOW)).toMatchObject({ status: 'frozen', hoursToFreeze: 0 });
  });

  it('prints through the CLI, typed with --json, and rejects stray arguments', async () => {
    const out: string[] = [];
    const deps = { now: NOW, samples: async () => falling, plan: async () => plan, output: { log: (m: string) => { out.push(m); }, error: (m: string) => { out.push(m); } } };
    expect(await cmdDiskRunway([], deps)).toBe(0);
    expect(out).toContain('free now: 86 GB');
    expect(out).toContain('rate over the last 6 h: 19 GB an hour');
    expect(out).toContain('hours to the 60 GB launch freeze: 1.4');
    expect(out).toContain('  merged PR (2, 50 GB):');
    out.length = 0;
    expect(await cmdDiskRunway(['--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.disk-runway.v1', freeGb: 86, hoursToFreeze: 1.4 });
    expect(await cmdDiskRunway(['--apply'], deps)).toBe(2);
    expect((await readDiskRunway({ now: NOW, samples: async () => { throw new Error('down'); }, plan: async () => { throw new Error('down'); } })).status).toBe('unknown');
  });
});

describe('disk runway alert', () => {
  const at6 = (freeNow: number, hours: number): HostDiskSample[] => [{ at: at(hours), freeGb: freeNow + 19 * hours }, { at: at(0), freeGb: freeNow }];
  it('fires once under 6 h, stays quiet until the runway clears, then fires again', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'disk-alert-'));
    dirs.push(stateDir);
    const lines: string[] = [];
    const deps = { stateDir, post: (t: string) => { lines.push(t); } };
    const near = buildDiskRunway(at6(60 + 19 * 5, 4), plan, NOW);          // 5 h to the freeze
    const far = buildDiskRunway(at6(60 + 19 * 20, 4), plan, NOW);          // 20 h
    const unknown = buildDiskRunway([], null, NOW);
    expect(await postDiskAlert(far, deps)).toEqual([]);
    expect(await postDiskAlert(near, deps)).toEqual(['Disk: 5 h to the launch freeze; 10 finished worktrees could free about 94 GB']);
    expect(await postDiskAlert(near, deps)).toEqual([]);                    // same episode
    expect(await postDiskAlert(unknown, deps)).toEqual([]);                 // unreadable does not clear it
    expect(await postDiskAlert(near, deps)).toEqual([]);
    expect(await postDiskAlert(far, deps)).toEqual([]);                     // clears
    expect(await postDiskAlert(near, deps)).toHaveLength(1);                // next episode
    // A failed post is retried on the next pass.
    expect(await postDiskAlert(far, deps)).toEqual([]);
    expect(await postDiskAlert(near, { stateDir, post: () => { throw new Error('down'); } })).toEqual([]);
    expect(await postDiskAlert(near, deps)).toHaveLength(1);
    expect(lines).toHaveLength(3);
    expect(diskAlertStep(near, { active: false }).post).toMatch(/^Disk: /);
  });
});
