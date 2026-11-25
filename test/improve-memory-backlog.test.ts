import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldMemoryEvidence,
  MEMORY_HOUR_MIN_SAMPLES,
  MEMORY_RECURRING_HOURS,
  MEMORY_WINDOW_HOURS,
  memoryBacklogItems,
} from '../src/core/improve/memory-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { MEMORY_GUARD } from '../src/core/resources/lane-autopilot.js';

const HOUR = 3_600_000;
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface Fields { free?: number | null; swap?: number | null; outs?: number | null }
const row = (atMs: number, f: Fields = {}): Record<string, unknown> => ({
  schema: 'fleet.swapout-sample.v1',
  sampled_at: iso(atMs),
  free_pct: f.free ?? null,
  swap_gb: f.swap ?? null,
  swapouts_per_min: f.outs ?? null,
});
/**
 * Six judged samples inside one hour bucket, all recording swapout
 * activity — a severe line for the pressure axis — while staying clear
 * of every blocked condition so the two axes stay separable.
 */
const pressureHour = (hourMs: number, n = MEMORY_HOUR_MIN_SAMPLES): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => row(hourMs + i * 60_000, { free: 45, swap: 10, outs: 5 }));
/** Six complete readings inside one hour bucket, all refused by memoryAllowsRaise but none severe. */
const blockedHour = (hourMs: number, n = MEMORY_HOUR_MIN_SAMPLES): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => row(hourMs + i * 60_000, { free: 27, swap: 10, outs: 0 }));
/** Six complete readings inside one hour bucket the guard allows. */
const clearHour = (hourMs: number, n = MEMORY_HOUR_MIN_SAMPLES): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => row(hourMs + i * 60_000, { free: 45, swap: 10, outs: 0 }));

/** `hours` consecutive hour buckets starting at `startHourMs`. */
const hourStarts = (startHourMs: number, hours: number): number[] =>
  Array.from({ length: hours }, (_, i) => startHourMs + i * HOUR);

describe('foldMemoryEvidence', () => {
  it('counts invalid lines, out-of-window rows and unjudged samples honestly', () => {
    const inWindow = NOW_MS - 2 * HOUR;
    const ev = foldMemoryEvidence([
      row(inWindow, { free: 45, swap: 10, outs: 0 }),
      { schema: 'fleet.swapout-sample.v1', sampled_at: iso(inWindow), free_pct: 'high' },
      'not json at all',
      row(NOW_MS - (MEMORY_WINDOW_HOURS + 1) * HOUR, { free: 10 }),
      row(inWindow + 2 * 60_000),                    // valid row, no stat fields: never judged
      row(inWindow + 3 * 60_000, { free: null, swap: null, outs: null }),
    ], { nowMs: NOW_MS });
    expect(ev.samples).toBe(3);
    expect(ev.invalidRows).toBe(2);
    expect(ev.outsideWindow).toBe(1);
    expect(ev.judged).toBe(1);
    expect(ev.pressure).toBe(0);
    expect(ev.complete).toBe(1);
    expect(ev.blocked).toBe(0);
    expect(ev.freePctKnown).toBe(1);
    expect(ev.swapoutsKnown).toBe(1);
    expect(ev.swapGbKnown).toBe(1);
    expect(ev.pressureHours).toEqual({ hours: 0, days: 0 });
    expect(ev.blockedHours).toEqual({ hours: 0, days: 0 });
    expect(ev.oldestAt).toBe(iso(inWindow));
    expect(ev.newestAt).toBe(iso(inWindow + 3 * 60_000));
  });

  it('classifies pressure on any severe line and blocked on the complete-reading guard rule', () => {
    const t = NOW_MS - 2 * HOUR;
    const ev = foldMemoryEvidence([
      row(t, { free: 20, swap: 10, outs: 0 }),        // low free: pressure + blocked
      row(t + 60_000, { free: 45, swap: 10, outs: 5 }), // swapout activity: pressure only (raise allowed)
      row(t + 120_000, { free: 45, swap: 50, outs: 0 }), // swap backstop: pressure + blocked
      row(t + 180_000, { free: 27, swap: 10, outs: 0 }), // hysteresis band: blocked only
      row(t + 240_000, { free: 45, swap: 10, outs: 0 }), // clear
      row(t + 300_000, { free: 45, swap: 10 }),         // partial: judged, never complete
      row(t + 360_000, { free: 45, swap: 10, outs: 150 }), // growing swapouts: pressure + blocked
    ], { nowMs: NOW_MS });
    expect(ev.judged).toBe(7);
    expect(ev.pressure).toBe(4);
    expect(ev.complete).toBe(6);
    expect(ev.blocked).toBe(4);
    expect(ev.freeBelowLow).toBe(1);
    expect(ev.freeAboveRaise).toBe(5);
    expect(ev.swapoutsPositive).toBe(2);
    expect(ev.swapoutsGrowing).toBe(1);
    expect(ev.swapAboveBackstop).toBe(1);
  });

  it('requires the recurring bar: enough hours, each mostly hits, spanning enough days', () => {
    // Five pressure hours on two days: under MEMORY_RECURRING_HOURS.
    const day1 = Date.parse('2026-11-21T00:00:00.000Z');
    const day2 = Date.parse('2026-11-22T00:00:00.000Z');
    const few = [
      ...hourStarts(day1 + 10 * HOUR, 3).flatMap((h) => pressureHour(h)),
      ...hourStarts(day2 + 10 * HOUR, 2).flatMap((h) => pressureHour(h)),
    ];
    const evFew = foldMemoryEvidence(few, { nowMs: NOW_MS });
    expect(evFew.pressureHours.hours).toBe(5);
    expect(evFew.pressureHours.days).toBe(2);

    // Six pressure hours but all on one UTC day: recurrence needs two days.
    const oneDay = hourStarts(day2 + 2 * HOUR, MEMORY_RECURRING_HOURS).flatMap((h) => pressureHour(h));
    const evOne = foldMemoryEvidence(oneDay, { nowMs: NOW_MS });
    expect(evOne.pressureHours.hours).toBe(MEMORY_RECURRING_HOURS);
    expect(evOne.pressureHours.days).toBe(1);

    // Six pressure hours across two days: recurring.
    const across = [
      ...hourStarts(day1 + 8 * HOUR, 3).flatMap((h) => pressureHour(h)),
      ...hourStarts(day2 + 9 * HOUR, 3).flatMap((h) => pressureHour(h)),
    ];
    const evAcross = foldMemoryEvidence(across, { nowMs: NOW_MS });
    expect(evAcross.pressureHours).toEqual({ hours: 6, days: 2 });
  });

  it('an hour below the sample floor or under half hits never counts', () => {
    const day1 = Date.parse('2026-11-21T00:00:00.000Z');
    const day2 = Date.parse('2026-11-22T00:00:00.000Z');
    const starts = [...hourStarts(day1 + 8 * HOUR, 3), ...hourStarts(day2 + 9 * HOUR, 3)];
    // Severe rows (free below the low line) hit both axes at once.
    const severe = (h: number, n: number): Record<string, unknown>[] =>
      Array.from({ length: n }, (_, i) => row(h + i * 60_000, { free: 20, swap: 10, outs: 0 }));
    const values = starts.flatMap((h, i) => {
      // First three hours: only 3 judged samples (under the floor). Last three: 3 hits of 8 judged (under half).
      if (i < 3) return severe(h, 3);
      return [...severe(h, 3), ...clearHour(h, 5)];
    });
    const ev = foldMemoryEvidence(values, { nowMs: NOW_MS });
    expect(ev.pressureHours.hours).toBe(0);
    // Same rows on the blocked axis: 3 complete blocked readings of 8 complete, under half.
    expect(ev.blocked).toBe(18);
    expect(ev.blockedHours.hours).toBe(0);
  });

  it('keeps the two axes independent: hysteresis-band blocks never count as pressure', () => {
    const day1 = Date.parse('2026-11-21T00:00:00.000Z');
    const day2 = Date.parse('2026-11-22T00:00:00.000Z');
    const values = [
      ...hourStarts(day1 + 8 * HOUR, 3).flatMap((h) => blockedHour(h)),
      ...hourStarts(day2 + 9 * HOUR, 3).flatMap((h) => blockedHour(h)),
    ];
    const ev = foldMemoryEvidence(values, { nowMs: NOW_MS });
    expect(ev.pressure).toBe(0);
    expect(ev.pressureHours.hours).toBe(0);
    expect(ev.blockedHours).toEqual({ hours: 6, days: 2 });
    expect(MEMORY_GUARD.lowFreePct).toBe(25);
    expect(MEMORY_GUARD.raiseFreePct).toBe(30);
  });
});

describe('memoryBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'memory-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  const day1 = Date.parse('2026-11-21T00:00:00.000Z');
  const day2 = Date.parse('2026-11-22T00:00:00.000Z');
  const recurringPressure = (): Record<string, unknown>[] => [
    ...hourStarts(day1 + 8 * HOUR, 3).flatMap((h) => pressureHour(h)),
    ...hourStarts(day2 + 9 * HOUR, 3).flatMap((h) => pressureHour(h)),
  ];
  const recurringBlocked = (): Record<string, unknown>[] => [
    ...hourStarts(day1 + 8 * HOUR, 3).flatMap((h) => blockedHour(h)),
    ...hourStarts(day2 + 9 * HOUR, 3).flatMap((h) => blockedHour(h)),
  ];

  async function runsDir(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (lines !== undefined) {
      await writeFile(join(dir, 'metrics', 'swapout-rate.jsonl'), lines.join('\n') + '\n');
    }
    return dir;
  }
  const ledger = (rows: readonly Record<string, unknown>[]): string[] => rows.map((r) => JSON.stringify(r));

  it('emits a recorded-pressure item for recurring severe-line hours and validates it', async () => {
    const dir = await runsDir('runs-pressure', ledger(recurringPressure()));
    const items = await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'memory-pressure' });
    expect(item!.id).toBe('memory-pressure-hours');
    expect(item!.title).toContain('recorded pressure');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('6 distinct hour buckets');
    expect(item!.prompt).toContain('2 UTC days');
    expect(item!.prompt).toContain('swapout-rate.jsonl');
    expect(item!.prompt).toContain('fleet vitals');
    expect(item!.prompt).toContain('lane-memory-pressure');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain(String(MEMORY_GUARD.lowFreePct));
  });

  it('emits a withheld-raise item for recurring hysteresis-band blocks', async () => {
    const dir = await runsDir('runs-blocked', ledger(recurringBlocked()));
    const items = await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.id).toBe('memory-guard-blocked-hours');
    expect(item!.title).toContain('withholding');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('memoryAllowsRaise');
    expect(item!.prompt).toContain('raise-headroom');
    expect(item!.prompt).toContain('UNMEASURED');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits both items when both axes recur, capped at the item limit', async () => {
    const dir = await runsDir('runs-both', ledger([...recurringPressure(), ...recurringBlocked()]));
    const items = await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['memory-pressure-hours', 'memory-guard-blocked-hours']);
    expect(items).toHaveLength(2);
    expect(await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 })).toHaveLength(1);
  });

  it('emits nothing below the recurring bar, on a missing ledger, or for another repository', async () => {
    // Recurring pressure on a single UTC day only.
    const oneDay = await runsDir('runs-oneday', ledger(hourStarts(day2 + 2 * HOUR, MEMORY_RECURRING_HOURS).flatMap((h) => pressureHour(h))));
    expect(await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Healthy samples only.
    const healthy = await runsDir('runs-healthy', ledger(hourStarts(day1 + 8 * HOUR, 7).flatMap((h) => clearHour(h))));
    expect(await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: new Date(NOW_MS) })).toEqual([]);

    // Missing ledger and missing runs dir.
    const empty = await runsDir('runs-empty');
    expect(await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await memoryBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this host's evidence.
    const dir = await runsDir('runs-repo', ledger(recurringPressure()));
    expect(await memoryBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await memoryBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', ledger(recurringPressure()));
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await memoryBacklogItems(opts);
    const second = await memoryBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends memory items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'metrics', 'swapout-rate.jsonl'), ledger(recurringPressure()).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const memoryItems = first.items.filter((i) => i.id.startsWith('memory-'));
      expect(memoryItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(memoryItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('memory-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('memory-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
