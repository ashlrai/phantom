import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldGrowthClock,
  foldGrowthSeries,
  GROWTH_DARK_MIN_MERGES,
  GROWTH_DARK_MIN_OPENS,
  GROWTH_ELEVATED_MIN_READINGS,
  GROWTH_ELEVATED_RATIO,
  growthBacklogItems,
  growthCells,
} from '../src/core/improve/growth-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('foldGrowthSeries', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = WEEK;
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it('folds cost readings, skipping null usd, unplaceable stamps and out-of-window rows', () => {
    const cost = [
      J({ t: ago(HOUR), costPerMergedPrUsd: 1.5 }),
      J({ ts: ago(2 * HOUR), costPerMergedPrUsd: 2.5 }),
      J({ at: ago(3 * HOUR), costPerMergedPrUsd: null }),       // priced nothing: not a reading
      J({ t: ago(8 * DAY), costPerMergedPrUsd: 9 }),            // outside the window
      J({ t: 'not a stamp', costPerMergedPrUsd: 4 }),           // unplaceable
      'garbage line',
      '',
    ];
    const fold = foldGrowthSeries(cost, null, null, NOW, WINDOW);
    expect(fold.costRead).toBe(true);
    expect(fold.pullsRead).toBe(false);
    expect(fold.releasesRead).toBe(false);
    expect(fold.cost).toHaveLength(2);
    expect(fold.cost.map((r) => r.usd)).toEqual([1.5, 2.5]);
    expect(fold.costRows).toBe(4); // timestamped rows only; null-usd still counts as a row
    expect(fold.invalidRows).toBe(2);
  });

  it('folds both pulls shapes and lets pull facts win over count rows', () => {
    const counts = [
      J({ t: ago(HOUR), opened: 3, merged: 1 }),
      J({ hour: ago(2 * HOUR), opened: 0, merged: 2 }),
      J({ t: ago(8 * DAY), opened: 9, merged: 9 }),
    ];
    const countFold = foldGrowthSeries(null, counts, null, NOW, WINDOW);
    expect(countFold.pulls).toHaveLength(2);
    expect(countFold.pulls.every((r) => r.shape === 'count')).toBe(true);
    expect(countFold.pullsRows).toBe(3);

    const mixed = [
      J({ repo: 'ashlrai/phantom', createdAt: ago(HOUR), number: 101 }),
      J({ repo: 'ashlrai/phantom', createdAt: ago(2 * HOUR), number: 102 }),
      J({ t: ago(HOUR), opened: 5, merged: 5 }), // stray count row beside facts
    ];
    const factFold = foldGrowthSeries(null, mixed, null, NOW, WINDOW);
    expect(factFold.pulls).toHaveLength(2);
    expect(factFold.pulls.every((r) => r.shape === 'pull')).toBe(true);
    expect(factFold.pullsRows).toBe(2); // pullFacts win the row count too
  });

  it('folds release publishedAt rows inside the window only', () => {
    const releases = [
      J({ publishedAt: ago(DAY) }),
      J({ publishedAt: ago(10 * DAY) }),
      J({ publishedAt: 'garbage' }),
    ];
    const fold = foldGrowthSeries(null, null, releases, NOW, WINDOW);
    expect(fold.releasesRead).toBe(true);
    expect(fold.releases).toHaveLength(1);
    expect(fold.releaseRows).toBe(2); // the garbage stamp is invalid, not a row
    expect(fold.invalidRows).toBe(1);
  });

  it('treats a null series as absent rather than empty', () => {
    const fold = foldGrowthSeries(null, null, null, NOW, WINDOW);
    expect(fold.costRead).toBe(false);
    expect(fold.pullsRead).toBe(false);
    expect(fold.releasesRead).toBe(false);
    expect(fold.cost).toEqual([]);
    expect(fold.pulls).toEqual([]);
    expect(fold.releases).toEqual([]);
  });
});

describe('foldGrowthClock', () => {
  it('picks per-series ISO stamps with the top generatedAt fallback', () => {
    const clock = foldGrowthClock({
      generatedAt: '2026-11-23T11:00:00.000Z',
      cost: '2026-11-23T11:30:00.000Z',
      pulls: { generatedAt: '2026-11-23T11:15:00.000Z' },
      releases: { observedAt: '2026-11-23T10:45:00.000Z' },
    });
    expect(clock.cost).toBe('2026-11-23T11:30:00.000Z');
    expect(clock.pulls).toBe('2026-11-23T11:15:00.000Z');
    expect(clock.releases).toBe('2026-11-23T10:45:00.000Z');
    expect(foldGrowthClock(null)).toEqual({ pulls: null, releases: null, cost: null });
    expect(foldGrowthClock('nope')).toEqual({ pulls: null, releases: null, cost: null });
    // A series key the status does not name falls back to the top stamp.
    expect(foldGrowthClock({ generatedAt: '2026-11-23T11:00:00.000Z' }).cost).toBe('2026-11-23T11:00:00.000Z');
  });
});

describe('growthCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = WEEK;
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();
  const emptyFold = foldGrowthSeries(null, null, null, NOW, WINDOW);

  it('emits cost-dark only with a read file, zero readings and proven merges', () => {
    const costFile = foldGrowthSeries([J({ t: ago(HOUR), costPerMergedPrUsd: null })], null, null, NOW, WINDOW);
    expect(costFile.costRead).toBe(true);
    expect(costFile.cost).toHaveLength(0);
    expect(growthCells(costFile, { merges: GROWTH_DARK_MIN_MERGES, opens: 0 }, NOW)
      .map((c) => c.kind)).toEqual(['cost-dark']);
    // Below the merge bar there is nothing the metric was obliged to record.
    expect(growthCells(costFile, { merges: GROWTH_DARK_MIN_MERGES - 1, opens: 0 }, NOW)).toEqual([]);
    // An absent file is a clean empty source, never a dark series.
    expect(growthCells(emptyFold, { merges: 99, opens: 99 }, NOW)).toEqual([]);
    // A file with usable readings is not dark.
    const lit = foldGrowthSeries([J({ t: ago(HOUR), costPerMergedPrUsd: 2 })], null, null, NOW, WINDOW);
    expect(growthCells(lit, { merges: 99, opens: 0 }, NOW)).toEqual([]);
  });

  it('emits pulls-dark only with a read file, zero readings and proven opens', () => {
    // The file's only count row sits outside the window → zero usable in-window readings.
    const pullsFile = foldGrowthSeries(null, [J({ t: ago(8 * DAY), opened: 1, merged: 0 })], null, NOW, WINDOW);
    expect(pullsFile.pullsRead).toBe(true);
    expect(pullsFile.pulls).toHaveLength(0);
    expect(growthCells(pullsFile, { merges: 0, opens: GROWTH_DARK_MIN_OPENS }, NOW)
      .map((c) => c.kind)).toEqual(['pulls-dark']);
    expect(growthCells(pullsFile, { merges: 0, opens: GROWTH_DARK_MIN_OPENS - 1 }, NOW)).toEqual([]);
  });

  it('emits releases-quiet only with a non-empty history and no in-window release', () => {
    const rel = foldGrowthSeries(null, null, [J({ publishedAt: ago(10 * DAY) })], NOW, WINDOW);
    expect(rel.releaseRows).toBe(1);
    expect(rel.releases).toHaveLength(0);
    expect(growthCells(rel, { merges: 0, opens: 0 }, NOW).map((c) => c.kind)).toEqual(['releases-quiet']);
    // An empty releases file has no history to go quiet from.
    const emptyRel = foldGrowthSeries(null, null, [], NOW, WINDOW);
    expect(growthCells(emptyRel, { merges: 0, opens: 0 }, NOW)).toEqual([]);
    // A release inside the window is not quiet.
    const fresh = foldGrowthSeries(null, null, [J({ publishedAt: ago(DAY) })], NOW, WINDOW);
    expect(growthCells(fresh, { merges: 0, opens: 0 }, NOW)).toEqual([]);
  });

  it('emits cost-elevated only at the ratio bar with readings on both sides', () => {
    const mk = (recentUsd: number, baseUsd: number): string[] => [
      // 8 baseline readings across earlier days at baseUsd
      ...Array.from({ length: GROWTH_ELEVATED_MIN_READINGS }, (_, i) =>
        J({ t: ago(2 * DAY + i * HOUR), costPerMergedPrUsd: baseUsd })),
      // 8 recent readings inside the newest 24h at recentUsd
      ...Array.from({ length: GROWTH_ELEVATED_MIN_READINGS }, (_, i) =>
        J({ t: ago(i * HOUR), costPerMergedPrUsd: recentUsd })),
    ];
    const hot = foldGrowthSeries(mk(3.0, 1.0), null, null, NOW, WINDOW);
    const cells = growthCells(hot, { merges: 0, opens: 0 }, NOW);
    const elevated = cells.find((c) => c.kind === 'cost-elevated');
    expect(elevated).toBeDefined();
    expect(elevated!.kind === 'cost-elevated' && elevated!.ratio).toBeGreaterThanOrEqual(GROWTH_ELEVATED_RATIO);
    // Below the ratio bar nothing emits.
    const mild = foldGrowthSeries(mk(1.2, 1.0), null, null, NOW, WINDOW);
    expect(growthCells(mild, { merges: 0, opens: 0 }, NOW)).toEqual([]);
    // Too few readings on one side reports nothing rather than a fabricated trend.
    const sparse = foldGrowthSeries([
      J({ t: ago(2 * DAY), costPerMergedPrUsd: 1.0 }),
      ...Array.from({ length: GROWTH_ELEVATED_MIN_READINGS }, (_, i) => J({ t: ago(i * HOUR), costPerMergedPrUsd: 5.0 })),
    ], null, null, NOW, WINDOW);
    expect(growthCells(sparse, { merges: 0, opens: 0 }, NOW)).toEqual([]);
  });
});

describe('growthBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'growth-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir with a metrics/ dir; files written only when provided. */
  async function runsDir(name: string, files: {
    cost?: string[]; pulls?: string[]; releases?: string[]; status?: Record<string, unknown>; jobs?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.cost !== undefined) await writeFile(join(dir, 'metrics', 'growth-cost-hourly.jsonl'), files.cost.join('\n') + '\n');
    if (files.pulls !== undefined) await writeFile(join(dir, 'metrics', 'growth-pulls-hourly.jsonl'), files.pulls.join('\n') + '\n');
    if (files.releases !== undefined) await writeFile(join(dir, 'metrics', 'growth-releases.jsonl'), files.releases.join('\n') + '\n');
    if (files.status !== undefined) await writeFile(join(dir, 'metrics', 'growth-exports-status.json'), JSON.stringify(files.status));
    if (files.jobs !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.jobs.join('\n') + '\n');
    return dir;
  }

  const mergeRow = (job: string, msAgo: number): string => J({ job, event: 'merged', ts: iso(msAgo) });
  const openRow = (job: string, n: number, msAgo: number): string =>
    J({ job, event: 'publish', url: `https://github.com/ashlrai/phantom/pull/${n}`, ts: iso(msAgo) });
  const threeMerges = (): string[] => [mergeRow('RQ-M1', HOUR), mergeRow('RQ-M2', 2 * HOUR), mergeRow('RQ-M3', 3 * HOUR)];
  const threeOpens = (): string[] => [openRow('RQ-P1', 1, HOUR), openRow('RQ-P2', 2, 2 * HOUR), openRow('RQ-P3', 3, 3 * HOUR)];

  it('emits cost-dark, pulls-dark and releases-quiet items from dark series with proven activity', async () => {
    const dir = await runsDir('runs-dark', {
      // Cost file present but every row unpriced → zero usable readings.
      cost: [J({ t: iso(HOUR), costPerMergedPrUsd: null }), J({ t: iso(2 * HOUR), costPerMergedPrUsd: null })],
      // Pulls file present but its only row is outside the window.
      pulls: [J({ t: iso(10 * DAY), opened: 4, merged: 2 })],
      // Releases file has history but nothing in-window.
      releases: [J({ publishedAt: iso(12 * DAY) })],
      status: { generatedAt: iso(MIN), cost: iso(MIN), pulls: iso(MIN), releases: iso(MIN) },
      jobs: [...threeMerges(), ...threeOpens()],
    });
    const items = await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(3);
    const kinds = items.map((i) => i.id);
    expect(kinds.some((id) => id.includes('cost-dark'))).toBe(true);
    expect(kinds.some((id) => id.includes('pulls-dark'))).toBe(true);
    expect(kinds.some((id) => id.includes('releases-quiet'))).toBe(true);
    for (const item of items) {
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'growth-metrics' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('growth-');
      expect(item.prompt).toContain('no-change');
    }
    const costItem = items.find((i) => i.id.includes('cost-dark'))!;
    expect(costItem.prompt).toContain('costPerMergedPrUsd');
    expect(costItem.prompt).toContain('fresh'); // the status clock claimed fresh
    const pullsItem = items.find((i) => i.id.includes('pulls-dark'))!;
    expect(pullsItem.prompt).toContain('opened');
  });

  it('emits cost-elevated when the newest readings run above the baseline', async () => {
    const cost = [
      ...Array.from({ length: GROWTH_ELEVATED_MIN_READINGS }, (_, i) => J({ t: iso(2 * DAY + i * HOUR), costPerMergedPrUsd: 1.0 })),
      ...Array.from({ length: GROWTH_ELEVATED_MIN_READINGS }, (_, i) => J({ t: iso(i * HOUR), costPerMergedPrUsd: 3.0 })),
    ];
    const dir = await runsDir('runs-hot', { cost, jobs: threeMerges() });
    const items = await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toContain('cost-elevated');
    expect(items[0]!.prompt).toContain('median');
    expect(items[0]!.prompt).toContain('baseline');
  });

  it('emits nothing when every series is absent, the repo is foreign, or evidence is sub-bar', async () => {
    expect(await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: NOW })).toEqual([]);
    // metrics dir exists but holds no growth files at all.
    const bare = await runsDir('runs-bare', {});
    expect(await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: bare, now: NOW })).toEqual([]);
    // Dark cost file but no proven merges → nothing to measure → no item.
    const noMerges = await runsDir('runs-nomerge', {
      cost: [J({ t: iso(HOUR), costPerMergedPrUsd: null })],
      jobs: threeOpens(),
    });
    expect(await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: noMerges, now: NOW })).toEqual([]);
    // A lit series is not dark.
    const lit = await runsDir('runs-lit', {
      cost: [J({ t: iso(HOUR), costPerMergedPrUsd: 2.0 })],
      jobs: threeMerges(),
    });
    expect(await growthBacklogItems({ repo: 'ashlrai/phantom', runsDir: lit, now: NOW })).toEqual([]);
    // Foreign repository never inherits this install's fleet evidence.
    const dark = await runsDir('runs-repo', {
      cost: [J({ t: iso(HOUR), costPerMergedPrUsd: null })],
      jobs: threeMerges(),
    });
    expect(await growthBacklogItems({ repo: 'ashlrai/other', runsDir: dark, now: NOW })).toEqual([]);
    expect(await growthBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dark, now: NOW })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      cost: [J({ t: iso(HOUR), costPerMergedPrUsd: null })],
      releases: [J({ publishedAt: iso(10 * DAY) })],
      jobs: threeMerges(),
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await growthBacklogItems(opts);
    const second = await growthBacklogItems(opts);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(await growthBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends growth items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'growth-cost-hourly.jsonl'),
      [J({ t: iso(HOUR), costPerMergedPrUsd: null })].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), threeMerges().join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const growthItems = first.items.filter((i) => i.id.includes('growth-'));
    expect(growthItems.length).toBeGreaterThan(0);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(growthItems)).toBe(growthItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.includes('growth-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.includes('growth-'))).toHaveLength(growthItems.length);
  });
});
