/** `phm host disk`: canned samples and a canned folder audit in, one typed report out. Nothing here reads the real home or deletes anything. */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import {
  HOST_DISK_SAMPLES_FILE, diskBurn, diskLowLine, readDiskLowLine, readHostDisk, recordDiskSample, type HostDiskDeps,
} from '../src/core/fleet/host-disk.js';
import { gatherStatusDigestInput } from '../src/core/leader/status-digest-sources.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';

const NOW = 1_800_000_000_000;
const at = (hoursAgo: number): number => NOW / 1000 - hoursAgo * 3600;
const sample = (hoursAgo: number, freeGb: number) => ({ at: at(hoursAgo), freeGb });
const entry = (name: string, state: string, gb: number, ageHours: number | null, reapable = false) =>
  ({ name, state, bytes: gb * 1e9, ageHours, reapable, sizeComplete: true });
const audit = (worktrees: unknown[], complete = true): HostDiskDeps['audit'] => async () => ({
  sources: { worktrees: 'healthy' }, worktrees, totals: { complete },
}) as never;

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'host-disk-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });
const quiet = {
  installedVersion: () => '1.0.0', publishedVersion: async () => '1.0.0',
  mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: false }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never, lanes: [] }),
  needs: () => ({ status: 'available', items: [] }), inbox: async () => ({ sourceState: 'healthy', entries: [] }),
  workClaims: undefined, peers: undefined, nodeRuns: undefined, gapLine: async () => null,
};
const deps = (over: HostDiskDeps = {}): HostDiskDeps => ({ now: NOW, runsDir, skipWorktrees: true, ...over });

describe('host disk burn', () => {
  it('steady: a flat disk is not falling and has no hours to freeze', async () => {
    const report = await readHostDisk(deps({ samples: [sample(5, 300), sample(3, 299.9), sample(0, 300)] }));
    expect(report.status).toBe('steady');
    expect(report.freeGb).toBe(300);
    expect(report.hoursToFreeze).toBeNull();
    expect(report.warning).toBeNull();
    expect(report.freezeBelowGb).toBe(60);
    expect(report.freezeSource).toBe('default');
  });

  it('falling fast: rate over 6 hours, hours to the freeze line, and a disk_low warning', async () => {
    const report = await readHostDisk(deps({ samples: [sample(7, 400), sample(6, 380), sample(3, 296), sample(0, 206)] }));
    expect(report.status).toBe('falling');
    expect(report.burnGbPerHour).toBe(29); // 380 -> 206 over 6 hours; the 7-hour-old row is outside the window
    expect(report.samples).toBe(3);
    expect(report.hoursToFreeze).toBe(5); // (206 - 60) / 29
    expect(report.warning).toBe('disk_low');
  });

  it('falling slowly: more than 24 hours left means no warning', async () => {
    const burn = diskBurn([sample(6, 306), sample(0, 300)], 60, NOW);
    expect(burn.status).toBe('falling');
    expect(burn.hoursToFreeze).toBe(240);
    expect(diskLowLine(burn)).toBeNull();
  });

  it('no samples: everything unknown, said as unknown', async () => {
    const report = await readHostDisk(deps({ samples: [] }));
    expect(report).toMatchObject({ status: 'unknown', freeGb: null, burnGbPerHour: null, hoursToFreeze: null, warning: null, samples: 0 });
    expect(report.gaps.join(' ')).toContain('Free disk is unknown');
    expect(await cmdHost(['disk'], { ...deps({ samples: [] }), write: () => undefined })).toBe(1);
  });

  it('one sample: free GB is known, the rate is unknown', async () => {
    const report = await readHostDisk(deps({ samples: [sample(0, 250)] }));
    expect(report).toMatchObject({ status: 'unknown', freeGb: 250, burnGbPerHour: null });
    expect(report.gaps.join(' ')).toContain('Burn rate is unknown');
  });

  it('below threshold: zero hours left and a warning, whatever the rate', async () => {
    const report = await readHostDisk(deps({ samples: [sample(2, 58), sample(0, 55)] }));
    expect(report.status).toBe('below-threshold');
    expect(report.hoursToFreeze).toBe(0);
    expect(report.warning).toBe('disk_low');
    expect(diskLowLine(diskBurn([sample(0, 55)], 60, NOW))).toContain('below the 60 GB line');
  });

  it('reads the freeze line from the live config and names its layer', async () => {
    mkdirSync(join(runsDir, 'queue'));
    writeFileSync(join(runsDir, 'queue', 'live-config.json'), JSON.stringify({ v: 1, last_change_by: 'test', overrides: { 'compact.lanes.raise_freeze_below_gb': { value: 150, by: 'test', at: '2026-11-19T00:00:00Z', reason: 'fixture' } } }));
    const report = await readHostDisk(deps({ samples: [sample(2, 200), sample(0, 190)] }));
    expect(report.freezeBelowGb).toBe(150);
    expect(report.freezeSource).toBe('live');
    expect(report.hoursToFreeze).toBe(8);
  });

  it('ignores junk and future rows, merges the sampler file, and shows samples only with --history', async () => {
    mkdirSync(join(runsDir, 'queue'));
    writeFileSync(join(runsDir, 'queue', 'disk-growth-history.json'), JSON.stringify([
      { at: at(4), free_gb: 260 }, { at: -5, free_gb: 1 }, { at: at(-2), free_gb: 5 }, { at: at(3), free_gb: -1 }, 'junk',
    ]));
    const plain = await readHostDisk(deps({ samples: [sample(0, 250)] }));
    expect(plain.samples).toBe(2);
    expect(plain.history).toBeUndefined();
    const withHistory = await readHostDisk(deps({ samples: [sample(0, 250)] }), true);
    expect(withHistory.history?.map(h => h.freeGb)).toEqual([260, 250]);
  });
});

describe('host disk folders', () => {
  const folders = [
    entry('job-a', 'merged', 9, 30, true), entry('job-b', 'running', 8, 1), entry('job-c', 'empty', 7, 40, true),
    entry('job-d', 'unknown', 6, null), entry('job-e', 'open', 5, 12), entry('job-f', 'merged', 4, 2, true), entry('job-g', 'merged', 0.5, 50, true),
    entry('.hidden', 'excluded', 99, 1),
  ];

  it('lists the 5 largest with age and finished, and says what to run', async () => {
    const report = await readHostDisk(deps({ samples: [sample(0, 250)], skipWorktrees: false, audit: audit(folders) }));
    expect(report.worktrees.largest.map(f => [f.job, f.gb, f.ageHours, f.finished])).toEqual([
      ['job-a', 9, 30, true], ['job-b', 8, 1, false], ['job-c', 7, 40, true], ['job-d', 6, null, null], ['job-e', 5, 12, true],
    ]);
    expect(report.worktrees).toMatchObject({ folders: 7, finished: 5, reapable: 3, reapableGb: 16.5, sizesComplete: true });
    expect(report.fix).toBe('7 job folders, 5 of them finished. `phm worktrees --reap --apply` removes 3 and frees about 16.5 GB.');
  });

  it('says at least when sizes were cut short, and unknown when folders cannot be read', async () => {
    const partial = await readHostDisk(deps({ samples: [sample(0, 250)], skipWorktrees: false, audit: audit(folders, false) }));
    expect(partial.fix).toContain('frees at least 16.5 GB');
    expect(partial.gaps.join(' ')).toContain('floors');
    const broken = await readHostDisk(deps({ samples: [sample(0, 250)], skipWorktrees: false, audit: async () => { throw new Error('no'); } }));
    expect(broken.worktrees).toMatchObject({ folders: null, largest: [] });
    expect(broken.fix).toContain('could not be read');
  });
});

describe('host disk samples and digest', () => {
  it('records at most one sample per 5 minutes and keeps 48 hours', async () => {
    const live = (free: number) => async () => ({ at: 0, freeGb: free });
    await recordDiskSample(runsDir, NOW - 50 * 3600_000, live(400));
    await recordDiskSample(runsDir, NOW - 3600_000, live(300));
    await recordDiskSample(runsDir, NOW - 3600_000 + 60_000, live(299));
    await recordDiskSample(runsDir, NOW, live(290));
    const rows = JSON.parse(readFileSync(join(runsDir, HOST_DISK_SAMPLES_FILE), 'utf8')) as Array<{ at: number; free_gb: number }>;
    expect(rows.map(r => r.free_gb)).toEqual([300, 290]);
  });

  it('does not write when the live reading fails', async () => {
    await recordDiskSample(runsDir, NOW, async () => null);
    expect(existsSync(join(runsDir, HOST_DISK_SAMPLES_FILE))).toBe(false);
  });

  it('puts a disk_low line in the hourly digest only when under 24 hours remain', async () => {
    mkdirSync(join(runsDir, 'queue'));
    const write = (rows: Array<[number, number]>) => writeFileSync(join(runsDir, HOST_DISK_SAMPLES_FILE),
      JSON.stringify(rows.map(([h, free]) => ({ at: at(h), free_gb: free }))));
    write([[6, 380], [0, 206]]);
    const line = await readDiskLowLine(runsDir, NOW);
    expect(line).toBe('disk_low: 206 GB free, falling 29 GB an hour; lanes freeze at 60 GB in about 5 hours. Run `phm host disk`.');
    const digest = buildStatusDigest(await gatherStatusDigestInput(runsDir, new Date(NOW), { ...quiet, diskLine: readDiskLowLine }));
    expect(digest.join('\n')).toContain('disk_low: 206 GB free');
    write([[6, 380], [0, 379]]);
    expect(await readDiskLowLine(runsDir, NOW)).toBeNull();
    write([]);
    expect(await readDiskLowLine(runsDir, NOW)).toBeNull();
  });
});

describe('phm host disk', () => {
  it('--json carries the schema id; the plain output is words; bad flags exit 2', async () => {
    const out: string[] = [];
    const base = { ...deps({ samples: [sample(6, 380), sample(0, 206)], skipWorktrees: false, audit: audit([entry('job-a', 'merged', 9, 30, true)]) }), write: (t: string) => { out.push(t); } };
    expect(await cmdHost(['disk', '--json'], base)).toBe(0);
    const json = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(json).toMatchObject({ schema: 'host.disk.v1', status: 'falling', freeGb: 206, warning: 'disk_low' });
    out.length = 0;
    expect(await cmdHost(['disk', '--history'], base)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Free disk: 206 GB');
    expect(text).toContain('falling 29 GB an hour');
    expect(text).toContain('Lanes freeze below 60 GB (default setting): about 5 hours');
    expect(text).toContain('Samples:');
    expect(await cmdHost(['disk', '--bogus'], base)).toBe(2);
    expect(await cmdHost(['disk', '--json', '--json'], base)).toBe(2);
  });
});
