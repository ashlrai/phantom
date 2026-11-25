import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISK_MIN_DAYS,
  DISK_RECURRING_HOURS,
  DISK_WINDOW_HOURS,
  diskBacklogItems,
  foldDiskEvidence,
  type DiskSampleSource,
} from '../src/core/improve/disk-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { HostDiskSample } from '../src/core/fleet/host-top-view.js';

const HOUR_S = 3600;
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const FREEZE_GB = 60;

const source = (
  name: string,
  pairs: ReadonlyArray<readonly [number, number]>,
  extra: Partial<DiskSampleSource> = {},
): DiskSampleSource => ({
  name,
  state: 'healthy',
  samples: pairs.map(([at, freeGb]) => ({ at, freeGb })),
  invalidRows: 0,
  ...extra,
});
const TICK = 'queue/host-disk-samples.json';
const SAMPLER = 'queue/disk-growth-history.json';

/** `n` samples inside one hour bucket starting at `hourStartS`, freeGb following `values` (last wins the closing verdict). */
const hourSamples = (hourStartS: number, values: readonly number[], stepS = 300): Array<readonly [number, number]> =>
  values.map((freeGb, i) => [hourStartS + i * stepS, freeGb] as const);

/** Hour-aligned epoch seconds `hours` before NOW. */
const hoursAgo = (hours: number): number => Math.floor(NOW_S / HOUR_S) * HOUR_S - hours * HOUR_S;

/**
 * A uniform 10-minute ramp: `hours` of samples falling linearly from
 * `startFree` to `endFree` GB, so every judged hour's burn is the same
 * slope — the production diskBurn reads it as 'falling' throughout.
 */
const ramp = (endHoursAgo: number, hours: number, startFree: number, endFree: number): Array<readonly [number, number]> => {
  const endS = Math.floor(NOW_S / HOUR_S) * HOUR_S - endHoursAgo * HOUR_S;
  const startS = endS - hours * HOUR_S;
  const steps = hours * 6;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const at = startS + i * 600;
    return [at, startFree + (endFree - startFree) * (i / steps)] as const;
  });
};

describe('foldDiskEvidence', () => {
  it('counts invalid rows, out-of-window rows and per-source states honestly', () => {
    const inside = hoursAgo(3);
    const ev = foldDiskEvidence([
      source(TICK, [
        [inside, 200],
        [inside + 600, 190],
        [inside + 1200, 185],
        [inside + 1800, 180],
      ]),
      source(SAMPLER, [[inside + 60, 195]], { invalidRows: 2 }),
      source('queue/missing.json', [], { state: 'missing' }),
      source('queue/bad.json', [], { state: 'invalid', invalidRows: 1 }),
    ], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB, freezeSource: 'default' });
    // The sampler row at inside+60 merges with the tick rows: 5 in-window samples.
    expect(ev.samples).toBe(5);
    expect(ev.invalidRows).toBe(3);
    expect(ev.sources).toEqual([
      { name: TICK, state: 'healthy', rows: 4, invalidRows: 0 },
      { name: SAMPLER, state: 'healthy', rows: 1, invalidRows: 2 },
      { name: 'queue/missing.json', state: 'missing', rows: 0, invalidRows: 0 },
      { name: 'queue/bad.json', state: 'invalid', rows: 0, invalidRows: 1 },
    ]);
    expect(ev.freezeBelowGb).toBe(FREEZE_GB);
    expect(ev.freezeSource).toBe('default');
    expect(ev.oldestAt).toBe(new Date((inside) * 1000).toISOString());
    expect(ev.newestAt).toBe(new Date((inside + 1800) * 1000).toISOString());
  });

  it('drops future and out-of-window rows without judging them', () => {
    const inside = hoursAgo(3);
    const ev = foldDiskEvidence([
      source(TICK, [
        [inside, 200], [inside + 600, 195], [inside + 1200, 190], [inside + 1800, 185],
        [NOW_S + 3600, 400],                                  // future: outsideWindow
        [NOW_S - (DISK_WINDOW_HOURS + 1) * HOUR_S, 500],      // older than the window
      ]),
    ], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(ev.samples).toBe(4);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.sources[0]!.rows).toBe(6);
  });

  it('classifies below-freeze, runway and steady hours on the production verdicts', () => {
    // Below: four readings in the hour, the last under the freeze line.
    const belowStart = hoursAgo(30);
    const below = hourSamples(belowStart, [70, 65, 58, 55]);
    // Runway: a 7-hour ramp ending 8 hours ago, free disk falling toward the line.
    // Burn ≈ (240-130)/7 ≈ 15.7 GB/h; newest ≈ 130 → hoursToFreeze ≈ 4.5 < 24.
    const runway = ramp(8, 7, 240, 130);
    // Steady: flat high readings — judged, never convicting.
    const steadyStart = hoursAgo(20);
    const steady = hourSamples(steadyStart, [300, 300, 300, 300, 300, 300]);
    const ev = foldDiskEvidence([source(TICK, [...below, ...runway, ...steady])], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    // Below hour: 1 judged hour closing below-threshold; two of its
    // four readings sat under the freeze line.
    expect(ev.belowHours).toEqual({ hours: 1, days: 1 });
    expect(ev.samplesBelowFreeze).toBe(2);
    // Runway: every judged hour of the 7-hour ramp closes falling with <24h runway
    // (newest free 240→130 all under 60 + 24*burn ≈ 437 GB).
    expect(ev.runwayHours.hours).toBeGreaterThanOrEqual(6);
    expect(ev.judgedHours).toBeGreaterThanOrEqual(ev.runwayHours.hours + 1);
    // The steady hour judged but convicted neither axis.
    expect(ev.samples).toBe(below.length + runway.length + steady.length);
  });

  it('an hour below the sample floor or with an undetermined verdict never judges', () => {
    // Sparse: 3 below-freeze readings — under DISK_HOUR_MIN_SAMPLES.
    const sparse = hourSamples(hoursAgo(30), [55, 55, 55]);
    // Undetermined: 4 readings clustered inside 3 minutes, nothing else
    // within 6 hours — the burn span stays under the 10-minute floor.
    const clustered = hourSamples(hoursAgo(20), [300, 300, 300, 300], 60);
    const ev = foldDiskEvidence([source(TICK, [...sparse, ...clustered])], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(ev.samples).toBe(7);
    expect(ev.judgedHours).toBe(0);
    expect(ev.belowHours).toEqual({ hours: 0, days: 0 });
    expect(ev.runwayHours).toEqual({ hours: 0, days: 0 });
    // The sparse hour's readings still count as below-freeze samples.
    expect(ev.samplesBelowFreeze).toBe(3);
  });

  it('requires the recurring bar: enough judged hours, spanning enough days', () => {
    // Five below-freeze hours across two days: under DISK_RECURRING_HOURS.
    const day1 = Date.parse('2026-11-21T00:00:00.000Z') / 1000;
    const day2 = Date.parse('2026-11-22T00:00:00.000Z') / 1000;
    const belowHour = (h: number): Array<readonly [number, number]> => hourSamples(h, [70, 65, 58, 55]);
    const few = [
      ...[8, 9, 10].map((h) => belowHour(day1 + h * HOUR_S)).flat(),
      ...[9, 10].map((h) => belowHour(day2 + h * HOUR_S)).flat(),
    ];
    const evFew = foldDiskEvidence([source(TICK, few)], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(evFew.belowHours.hours).toBe(5);
    expect(evFew.belowHours.days).toBe(2);

    // Six below-freeze hours but all on one UTC day: recurrence needs two days.
    const oneDay = [8, 9, 10, 11, 12, 13].map((h) => belowHour(day2 + h * HOUR_S)).flat();
    const evOne = foldDiskEvidence([source(TICK, oneDay)], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(evOne.belowHours.hours).toBe(DISK_RECURRING_HOURS);
    expect(evOne.belowHours.days).toBe(1);

    // Six below-freeze hours across two days: recurring.
    const across = [
      ...[8, 9, 10].map((h) => belowHour(day1 + h * HOUR_S)).flat(),
      ...[9, 10, 11].map((h) => belowHour(day2 + h * HOUR_S)).flat(),
    ];
    const evAcross = foldDiskEvidence([source(TICK, across)], { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(evAcross.belowHours).toEqual({ hours: DISK_RECURRING_HOURS, days: DISK_MIN_DAYS });
  });
});

describe('diskBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'disk-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const day1 = Date.parse('2026-11-21T00:00:00.000Z') / 1000;
  const day2 = Date.parse('2026-11-22T00:00:00.000Z') / 1000;
  const belowHour = (h: number): Array<readonly [number, number]> => hourSamples(h, [70, 65, 58, 55]);
  /** Six below-freeze hours across two UTC days inside the window. */
  const recurringBelow = (): Array<readonly [number, number]> => [
    ...[8, 9, 10].map((h) => belowHour(day1 + h * HOUR_S)).flat(),
    ...[9, 10, 11].map((h) => belowHour(day2 + h * HOUR_S)).flat(),
  ];
  /**
   * A 24-hour declining ramp ending 22 hours before NOW — free disk
   * falls 300→110 GB at ≈7.9 GB/h, so the last ~17 judged hours close
   * with under 24 hours of freeze runway, spanning two UTC days.
   */
  const recurringRunway = (): Array<readonly [number, number]> => ramp(22, 24, 300, 110);
  /**
   * Six below-freeze hours after the ramp ends — three on Nov 22
   * evening, three on Nov 23 morning — so each hour's closing sample
   * is its own below-freeze reading, not a later ramp sample.
   */
  const lateBelow = (): Array<readonly [number, number]> => {
    const d22 = Date.parse('2026-11-22T00:00:00.000Z') / 1000;
    const d23 = Date.parse('2026-11-23T00:00:00.000Z') / 1000;
    return [15, 16, 17].map((h) => belowHour(d22 + h * HOUR_S)).flat()
      .concat([8, 9, 10].map((h) => belowHour(d23 + h * HOUR_S)).flat());
  };

  async function runsDir(name: string, files?: Record<string, ReadonlyArray<readonly [number, number]>>): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    for (const [file, pairs] of Object.entries(files ?? {})) {
      const rows: HostDiskSample[] = pairs.map(([at, freeGb]) => ({ at, freeGb }));
      // Files are written in the on-disk {at, free_gb} shape.
      const body = rows.map((r) => ({ at: r.at, free_gb: r.freeGb }));
      await writeFile(join(dir, 'queue', file), JSON.stringify(body));
    }
    return dir;
  }
  const tickFile = (pairs: ReadonlyArray<readonly [number, number]>) => ({ [TICK.split('/').pop()!]: pairs });

  it('emits a below-freeze item for recurring under-line hours and validates it', async () => {
    const dir = await runsDir('runs-below', tickFile(recurringBelow()));
    const items = await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'disk-pressure' });
    expect(item!.id).toBe('disk-below-freeze-hours');
    expect(item!.title).toContain('below the lane-freeze line');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('6 distinct hour buckets');
    expect(item!.prompt).toContain('2 UTC days');
    expect(item!.prompt).toContain('host-disk-samples.json');
    expect(item!.prompt).toContain('phm host disk');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('60 GB');
  });

  it('emits a freeze-runway item for recurring disk_low hours', async () => {
    const dir = await runsDir('runs-runway', tickFile(recurringRunway()));
    const items = await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'disk-pressure' });
    expect(item!.id).toBe('disk-freeze-runway-hours');
    expect(item!.title).toContain('burning toward');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('disk_low');
    expect(item!.prompt).toContain('phm host disk');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits both items when both axes recur, capped at the item limit', async () => {
    const dir = await runsDir('runs-both', {
      'host-disk-samples.json': recurringRunway(),
      'disk-growth-history.json': lateBelow(),
    });
    const items = await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['disk-below-freeze-hours', 'disk-freeze-runway-hours']);
    expect(items).toHaveLength(2);
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 })).toHaveLength(1);
  });

  it('emits nothing below the recurring bar, on missing or invalid files, or for another repository', async () => {
    // Recurring below-freeze on a single UTC day only.
    const oneDay = await runsDir('runs-oneday', tickFile([8, 9, 10, 11, 12, 13].map((h) => belowHour(day2 + h * HOUR_S)).flat()));
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Steady high free disk: judged hours, no convictions.
    const steady = await runsDir('runs-steady', tickFile(ramp(4, 12, 300, 300)));
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: steady, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing sample files.
    const empty = await runsDir('runs-empty');
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // An invalid body is not evidence.
    const badDir = join(home, 'runs-bad');
    await mkdir(join(badDir, 'queue'), { recursive: true });
    await writeFile(join(badDir, 'queue', 'host-disk-samples.json'), '{"not":"an array"}');
    await writeFile(join(badDir, 'queue', 'disk-growth-history.json'), 'not json');
    expect(await diskBacklogItems({ repo: 'ashlrai/phantom', runsDir: badDir, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this host's evidence.
    const dir = await runsDir('runs-repo', tickFile(recurringBelow()));
    expect(await diskBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await diskBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', tickFile(recurringBelow()));
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await diskBacklogItems(opts);
    const second = await diskBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends disk items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'queue'), { recursive: true });
      const rows = recurringBelow().map(([at, freeGb]) => ({ at, free_gb: freeGb }));
      await writeFile(join(runs, 'queue', 'host-disk-samples.json'), JSON.stringify(rows));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const diskItems = first.items.filter((i) => i.id.startsWith('disk-'));
      expect(diskItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(diskItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('disk-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('disk-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
