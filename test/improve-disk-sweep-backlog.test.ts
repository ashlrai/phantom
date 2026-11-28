import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DISK_SWEEP_MIN_DAYS,
  DISK_SWEEP_MIN_ROWS,
  DISK_SWEEP_WINDOW_MS,
  DISK_SWEEP_ZERO_YIELD_GB,
  diskSweepBacklogItems,
  foldDiskSweepEvidence,
  parseDiskSweepEntry,
  parseDiskSweepJournal,
  type DiskSweepRow,
} from '../src/core/improve/disk-sweep-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const FREEZE_GB = 60;

/** The on-disk row shape fleet-disk-sweep.ts's --log appendFile writes. */
const journalRow = (generatedAt: string, over: Record<string, unknown> = {}): string => JSON.stringify({
  generatedAt,
  apply: true,
  freeGb: 40,
  swept: true,
  freedGb: 0,
  steps: [
    { name: 'wt-cache', ran: true, code: 0, freedGb: 0 },
    { name: 'worktree-stale', ran: true, code: 0, freedGb: 0 },
  ],
  ...over,
});

/** A validated row for the pure fold, same defaults as journalRow. */
const sweepRow = (atMs: number, over: Partial<DiskSweepRow> = {}): DiskSweepRow => ({
  atMs,
  utcDay: new Date(atMs).toISOString().slice(0, 10),
  apply: true,
  swept: true,
  freeGb: 40,
  freedGb: 0,
  steps: [
    { name: 'wt-cache', ran: true, code: 0, freedGb: 0 },
    { name: 'worktree-stale', ran: true, code: 0, freedGb: 0 },
  ],
  ...over,
});

/** `n` failing sweep rows spread across `days` distinct UTC days ending near NOW. */
const failingRows = (count: number, days: number, step: 'wt-cache' | 'worktree-stale' = 'wt-cache'): DiskSweepRow[] => {
  const rows: DiskSweepRow[] = [];
  const perDay = Math.ceil(count / days);
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay && rows.length < count; i += 1) {
      const atMs = NOW_MS - (days - 1 - d) * DAY_MS - i * 3_600_000;
      rows.push(sweepRow(atMs, {
        // The passing step still reclaimed GBs, so a failing sweep is
        // step-failure evidence only — never a zero-yield row.
        freedGb: 2.5,
        steps: [
          { name: step, ran: true, code: 1, freedGb: 0 },
          { name: step === 'wt-cache' ? 'worktree-stale' : 'wt-cache', ran: true, code: 0, freedGb: 2.5 },
        ],
      }));
    }
  }
  return rows;
};

/** `count` applied pressured sweeps freeing nothing, spread across `days` UTC days. */
const zeroYieldRows = (count: number, days: number): DiskSweepRow[] => {
  const rows: DiskSweepRow[] = [];
  const perDay = Math.ceil(count / days);
  for (let d = 0; d < days; d += 1) {
    for (let i = 0; i < perDay && rows.length < count; i += 1) {
      const atMs = NOW_MS - (days - 1 - d) * DAY_MS - i * 3_600_000;
      rows.push(sweepRow(atMs));
    }
  }
  return rows;
};

describe('parseDiskSweepJournal', () => {
  it('parses on-contract rows and counts malformed and off-contract lines', () => {
    const text = [
      journalRow('2026-11-23T10:00:00.000Z'),
      'not json',
      journalRow('2026-11-23T11:00:00.000Z', { swept: false, steps: [
        { name: 'wt-cache', ran: false, code: null, freedGb: 0 },
        { name: 'worktree-stale', ran: false, code: null, freedGb: 0 },
      ] }),
      journalRow('not-a-date'),
      journalRow('2026-11-23T11:30:00.000Z', { freeGb: -1 }),
      journalRow('2026-11-23T11:45:00.000Z', { steps: [{ name: 'bogus-step', ran: true, code: 0, freedGb: 0 }] }),
      journalRow('2026-11-23T11:50:00.000Z', { steps: [{ name: 'wt-cache', ran: true, code: null, freedGb: 0 }] }),
      journalRow('2026-11-23T11:55:00.000Z', { steps: [] }),
      '',
    ].join('\n');
    const { rows, invalidRows } = parseDiskSweepJournal(text);
    expect(rows).toHaveLength(2);
    expect(invalidRows).toBe(6);
    expect(rows[0]).toMatchObject({ apply: true, swept: true, freeGb: 40, freedGb: 0 });
    expect(rows[1]).toMatchObject({ swept: false });
    expect(rows[1]!.steps.every((s) => s.ran === false && s.code === null)).toBe(true);
  });

  it('rejects rows violating the writer contract', () => {
    const base = JSON.parse(journalRow('2026-11-23T10:00:00.000Z')) as Record<string, unknown>;
    const cases: Record<string, unknown>[] = [
      { ...base, generatedAt: 1729 },
      { ...base, apply: 'yes' },
      { ...base, swept: 1 },
      { ...base, freeGb: '40' },
      { ...base, freedGb: -0.5 },
      { ...base, steps: 'none' },
      { ...base, steps: [{ name: 'wt-cache', ran: true, code: 0 }] },
      { ...base, steps: [{ name: 'wt-cache', ran: false, code: 0, freedGb: 0 }] },
      { ...base, steps: [{ name: 'wt-cache', ran: true, code: 0, freedGb: -1 }] },
    ];
    for (const value of cases) expect(parseDiskSweepEntry(value)).toBeNull();
    expect(parseDiskSweepEntry(null)).toBeNull();
    expect(parseDiskSweepEntry([base])).toBeNull();
  });
});

describe('foldDiskSweepEvidence', () => {
  it('counts context tallies and bounds the window honestly', () => {
    const inside = NOW_MS - 2 * 3_600_000;
    const rows = [
      sweepRow(inside),                                                        // applied, swept, pressured, zero yield
      sweepRow(inside + 60_000, { apply: false, freedGb: 12.5 }),             // dry run
      sweepRow(inside + 120_000, { swept: false, freeGb: 200, freedGb: 0, steps: [
        { name: 'wt-cache', ran: false, code: null, freedGb: 0 },
        { name: 'worktree-stale', ran: false, code: null, freedGb: 0 },
      ] }),                                                                  // never swept, disk fine
      sweepRow(inside + 180_000, { freeGb: null }),                           // blind sweep
      sweepRow(inside + 240_000, { freeGb: 200, freedGb: 3 }),                // swept (forced), not pressured
      sweepRow(NOW_MS + 120_000),                                             // beyond skew: outside
      sweepRow(NOW_MS - DISK_SWEEP_WINDOW_MS - DAY_MS),                       // older than window: outside
    ];
    const ev = foldDiskSweepEvidence(rows, { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(ev.rows).toBe(5);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.appliedRows).toBe(4);
    expect(ev.dryRunRows).toBe(1);
    expect(ev.unsweptRows).toBe(1);
    expect(ev.unmeasuredSweeps).toBe(1);
    expect(ev.pressuredRows).toBe(2);   // freeGb 40 rows only (null and 200 excluded)
    expect(ev.pressuredAppliedSweeps).toBe(1); // only the first row: applied+swept+pressured
    expect(ev.zeroYield.rows).toBe(1);
    expect(ev.stepFailures.rows).toBe(0);
    expect(ev.freezeBelowGb).toBe(FREEZE_GB);
    expect(ev.oldestAt).toBe(new Date(inside).toISOString());
    expect(ev.newestAt).toBe(new Date(inside + 240_000).toISOString());
  });

  it('folds step failures per step name across days', () => {
    const rows = [
      ...failingRows(2, 2, 'wt-cache'),
      ...failingRows(1, 1, 'worktree-stale'),
      // A swept row whose steps all exited 0 is not a failure.
      sweepRow(NOW_MS - 3_600_000),
      // An unswept row cannot fail: its steps did not run.
      sweepRow(NOW_MS - 7_200_000, { swept: false, freeGb: 200, steps: [
        { name: 'wt-cache', ran: false, code: null, freedGb: 0 },
        { name: 'worktree-stale', ran: false, code: null, freedGb: 0 },
      ] }),
    ];
    const ev = foldDiskSweepEvidence(rows, { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(ev.stepFailures.rows).toBe(3);
    expect(ev.stepFailures.days.size).toBe(2);
    expect(ev.failingSteps).toEqual([
      { name: 'wt-cache', count: 2 },
      { name: 'worktree-stale', count: 1 },
    ]);
    expect(ev.stepFailures.firstSeen).not.toBeNull();
    expect(ev.stepFailures.lastSeen).not.toBeNull();
  });

  it('admits only applied pressured zero-yield rows to the yield axis', () => {
    const rows = [
      ...zeroYieldRows(2, 2),
      // Dry run under pressure freeing nothing recorded: never yield evidence.
      sweepRow(NOW_MS - 5 * 3_600_000, { apply: false, freedGb: 0 }),
      // Blind sweep (freeGb null): pressure unproven.
      sweepRow(NOW_MS - 6 * 3_600_000, { freeGb: null, freedGb: 0 }),
      // Applied pressured sweep that freed something: denominator only.
      sweepRow(NOW_MS - 8 * 3_600_000, { freedGb: 4.2 }),
      // Applied sweep above the freeze line: not pressured even at zero yield.
      sweepRow(NOW_MS - 9 * 3_600_000, { freeGb: 200, freedGb: 0 }),
      // Pressured but a step never ran: the swept-row invariant fails.
      sweepRow(NOW_MS - 10 * 3_600_000, {
        freedGb: 0,
        steps: [
          { name: 'wt-cache', ran: true, code: 0, freedGb: 0 },
          { name: 'worktree-stale', ran: false, code: null, freedGb: 0 },
        ],
      }),
      // Pressured, applied, all steps ran — but the recorded yield is
      // one rounding step above the zero line: denominator only.
      sweepRow(NOW_MS - 11 * 3_600_000, { freedGb: DISK_SWEEP_ZERO_YIELD_GB + 0.1 }),
    ];
    const ev = foldDiskSweepEvidence(rows, { nowMs: NOW_MS, freezeBelowGb: FREEZE_GB });
    expect(ev.zeroYield.rows).toBe(2);
    expect(ev.zeroYield.days.size).toBe(2);
    // Denominator: the two zero-yield rows + the 4.2 GB row + the
    // inconsistent unrun-step row + the sub-tenth yield row.
    expect(ev.pressuredAppliedSweeps).toBe(5);
  });
});

describe('diskSweepBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'disk-sweep-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  async function runsDir(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    if (lines !== undefined) await writeFile(join(dir, 'queue', 'disk-sweep.jsonl'), lines.join('\n') + '\n');
    return dir;
  }
  const iso = (atMs: number): string => new Date(atMs).toISOString();
  /** Journal lines for `count` failing sweeps across `days` UTC days. */
  const failingLines = (count: number, days: number): string[] =>
    failingRows(count, days).map((r) => journalRow(iso(r.atMs), {
      freedGb: r.freedGb,
      steps: r.steps.map((s) => ({ name: s.name, ran: s.ran, code: s.code, freedGb: s.freedGb })),
    }));
  const yieldLines = (count: number, days: number): string[] =>
    zeroYieldRows(count, days).map((r) => journalRow(iso(r.atMs)));

  it('emits a step-failure item at the recurring bar and validates it', async () => {
    const dir = await runsDir('runs-fail', failingLines(DISK_SWEEP_MIN_ROWS, DISK_SWEEP_MIN_DAYS));
    const items = await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'disk-pressure' });
    expect(item!.id).toBe('disk-sweep-step-failures');
    expect(item!.title).toContain('disk sweep');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('non-zero');
    expect(item!.prompt).toContain('wt-cache');
    expect(item!.prompt).toContain('disk-sweep.jsonl');
    expect(item!.prompt).toContain('phm fleet disk-sweep --history');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits a zero-yield item for recurring empty applied sweeps', async () => {
    const dir = await runsDir('runs-yield', yieldLines(DISK_SWEEP_MIN_ROWS + 1, DISK_SWEEP_MIN_DAYS));
    const items = await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.id).toBe('disk-sweep-zero-yield');
    expect(item!.title).toContain('reclaiming nothing');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('freedGb of 0');
    expect(item!.prompt).toContain('60 GB');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits both items when both axes recur, capped at the item limit', async () => {
    const dir = await runsDir('runs-both', [...failingLines(3, 2), ...yieldLines(3, 2)]);
    const items = await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['disk-sweep-step-failures', 'disk-sweep-zero-yield']);
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 })).toHaveLength(1);
  });

  it('emits nothing below the bars, on missing or invalid journals, or for another repository', async () => {
    // Failing rows all on one UTC day: under DISK_SWEEP_MIN_DAYS.
    const oneDay = await runsDir('runs-oneday', failingLines(4, 1));
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Too few adverse rows even across two days.
    const few = await runsDir('runs-few', failingLines(DISK_SWEEP_MIN_ROWS - 1, 2));
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Healthy sweeps only: applied rows that freed GBs, plus dry runs.
    const healthy = await runsDir('runs-healthy', [
      journalRow(iso(NOW_MS - DAY_MS), { freedGb: 12.4, steps: [
        { name: 'wt-cache', ran: true, code: 0, freedGb: 8.1 },
        { name: 'worktree-stale', ran: true, code: 0, freedGb: 4.3 },
      ] }),
      journalRow(iso(NOW_MS - 2 * DAY_MS), { apply: false, swept: false, freeGb: 200, steps: [
        { name: 'wt-cache', ran: false, code: null, freedGb: 0 },
        { name: 'worktree-stale', ran: false, code: null, freedGb: 0 },
      ] }),
    ]);
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty');
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A journal of only malformed lines yields no rows, hence no items.
    const bad = await runsDir('runs-bad', ['{oops', '42', '"text"']);
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/phantom', runsDir: bad, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this host's evidence.
    const dir = await runsDir('runs-repo', failingLines(3, 2));
    expect(await diskSweepBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await diskSweepBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('honors ASHLR_RUNS_DIR when no runsDir is passed', async () => {
    const dir = await runsDir('runs-env', failingLines(3, 2));
    process.env.ASHLR_RUNS_DIR = dir;
    const items = await diskSweepBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['disk-sweep-step-failures']);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...failingLines(3, 2), ...yieldLines(3, 2)]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await diskSweepBacklogItems(opts);
    const second = await diskSweepBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends sweep items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'queue'), { recursive: true });
      await writeFile(join(runs, 'queue', 'disk-sweep.jsonl'), [...failingLines(3, 2), ...yieldLines(3, 2)].join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const sweepItems = first.items.filter((i) => i.id.startsWith('disk-sweep-'));
      expect(sweepItems.map((i) => i.id)).toEqual(['disk-sweep-step-failures', 'disk-sweep-zero-yield']);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(sweepItems)).toBe(2);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('disk-sweep-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('disk-sweep-'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
