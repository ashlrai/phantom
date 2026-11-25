import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EFFICIENCY_MIN_ROWS,
  EFFICIENCY_WINDOW_HOURS,
  efficiencyBacklogItems,
  foldEfficiencyEvidence,
} from '../src/core/improve/efficiency-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR_MS = 3_600_000;
const NOW_MS = Date.parse('2026-11-25T12:00:00.000Z');
const JOURNAL = join('ledger', 'efficiency-hourly.jsonl');
const SCHEMA = 'ashlr.efficiency-hourly/v1';

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-efficiency-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

interface RankedEntry {
  key: string;
  item: string;
  unit?: string;
  rank?: number;
  cost_per_day?: number | null;
  disk_gb?: number | null;
  ram_gb?: number | null;
  lower_bound?: boolean;
  detail?: Record<string, unknown>;
  source?: string;
  note?: string;
  [k: string]: unknown;
}

const ranked = (key: string, item: string, extra: Partial<RankedEntry> = {}): RankedEntry => ({
  key, item, unit: 'session wall-hours/day', rank: 4, cost_per_day: 0.5, detail: {}, source: 'test', ...extra,
});

const row = (atMs: number, rankedEntries: readonly RankedEntry[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts: new Date(atMs).toISOString(), schema: SCHEMA, ranked: rankedEntries, errors: null, ...extra,
});

const TEST_FULL = ranked('test_full', 'local test runs beyond affected-only (full-suite invocations in agent sessions)', {
  unit: 'session wall-hours/day', rank: 10, cost_per_day: 0.0,
  detail: { full_commands_rank_window: 41, full_wall_min_rank_window: 0.6, targeted_commands_rank_window: 982, targeted_wall_min_rank_window: 77.6, full_p_mean_s: 0.9, targeted_mean_s: 4.7 },
});
const CI_MINUTES = ranked('ci_minutes', 'CI run wall time on hosted runners (all workflows, CI window)', {
  unit: 'runner wall-hours/day', rank: 1, cost_per_day: 19.03, lower_bound: true,
  detail: { phantom: { runs_total: 2500, runs_sampled: 100, wall_min_sampled: 113.3, per_merged_pr_sampled: 0.6 } },
});
const HARNESS = ranked('harness', 'harness size per session', {
  unit: 'bytes/session', rank: 12, cost_per_day: null,
  detail: { window_h: 24, prompt_files: 597, prompt_bytes_p50: 6408, prompt_bytes_p95: 9092, prompt_bytes_total: 3662241, mcp_procs_per_running_session_p50: 22.8, mcp_samples: 58 },
});
const WORKTREES = ranked('worktrees', 'worktree footprint (linked worktrees, not full clones)', {
  unit: 'GB disk', rank: 11, cost_per_day: null, disk_gb: 125.6,
  detail: { registered_worktrees_all_repos: 887, runs_dir_flat_entries: 164948, dispatchd: { kept_worktrees: 54, reaping: 437 } },
});
const BUILD = ranked('build', 'per-agent builds and typechecks (no shared content-addressed build cache)', {
  unit: 'session wall-hours/day', rank: 4, cost_per_day: 0.7,
  detail: { commands_rank_window: 696, wall_min_rank_window: 295.8, sessions_traced_rank_window: 1662, per_session: 0.42, wall_min_per_merged_pr_traced_lanes: 0.37, wall_min_short_window: 76.3 },
});
const INSTALL_PROC = ranked('install', 'local install processes on the Mac', {
  unit: 'core-hours/day', rank: 9, cost_per_day: 0.0,
});
const DISPATCH_PAUSED = ranked('dispatch_paused', 'dispatch admission paused by the memory guard (swap backstop and related)', {
  unit: 'paused hours/day', rank: 3, cost_per_day: 23.7,
});
const FS_INDEXER = ranked('fs_indexer', 'file-system indexing and FS event load (machine wide)', {
  unit: 'core-hours/day', rank: 2, cost_per_day: 13.45,
});

/** Hourly rows on two UTC days — enough sightings for the recurrence bars. */
const recurringRows = (entries: readonly RankedEntry[]): Record<string, unknown>[] => {
  const times = [
    Date.parse('2026-11-23T10:00:00.000Z'), Date.parse('2026-11-23T11:00:00.000Z'), Date.parse('2026-11-23T12:00:00.000Z'),
    Date.parse('2026-11-24T10:00:00.000Z'), Date.parse('2026-11-24T11:00:00.000Z'), Date.parse('2026-11-24T12:00:00.000Z'),
  ];
  return times.map((at) => row(at, entries));
};

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'ledger'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};
const jsonl = (rows: readonly unknown[]): string[] => rows.map((r) => JSON.stringify(r));

describe('foldEfficiencyEvidence', () => {
  it('reports unknown on empty input and counts invalid and out-of-window rows honestly', () => {
    expect(foldEfficiencyEvidence([], { nowMs: NOW_MS })).toMatchObject({ state: 'unknown', rows: 0, cells: [] });
    const ev = foldEfficiencyEvidence([
      null, 'junk', {}, row(NOW_MS - HOUR_MS, [TEST_FULL]),
      { ts: 'not-a-date', schema: SCHEMA, ranked: [] },
      { ts: new Date(NOW_MS - HOUR_MS).toISOString(), schema: 'other.schema/v9', ranked: [] },
      { ts: new Date(NOW_MS - HOUR_MS).toISOString(), schema: SCHEMA },
      row(NOW_MS - (EFFICIENCY_WINDOW_HOURS + 1) * HOUR_MS, [TEST_FULL]),
      row(NOW_MS + 2 * HOUR_MS, [TEST_FULL]),
      row(NOW_MS - 2 * HOUR_MS, [TEST_FULL], { errors: { ci: 'RuntimeError: gh quota' } }),
      row(NOW_MS - 3 * HOUR_MS, [TEST_FULL], { errors: ['section failed'] }),
      row(NOW_MS - 4 * HOUR_MS, [
        { key: 'test_full' },
        { item: 'no key' },
        'not-an-object',
        TEST_FULL,
      ]),
    ], { nowMs: NOW_MS });
    expect(ev.invalidRows).toBe(6);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.degradedRows).toBe(2);
    expect(ev.rows).toBe(2);
    expect(ev.state).toBe('known');
    // Only the two clean in-window rows feed cells; the malformed entries in the last row are disclosed.
    expect(ev.malformedRanked).toBe(3);
    const cell = ev.cells.find((c) => c.spec.slug === 'test-full');
    expect(cell?.rows).toBe(2);
    expect(cell?.days).toEqual(['2026-11-25']);
  });

  it('folds recurring actionable cells and ignores non-actionable keys and wrong units', () => {
    const ev = foldEfficiencyEvidence(recurringRows([TEST_FULL, CI_MINUTES, HARNESS, WORKTREES, BUILD, INSTALL_PROC, DISPATCH_PAUSED, FS_INDEXER]), { nowMs: NOW_MS });
    const slugs = ev.cells.map((c) => c.spec.slug).sort();
    expect(slugs).toEqual(['agent-builds', 'ci-minutes', 'harness-size', 'test-full', 'worktrees']);
    for (const cell of ev.cells) {
      expect(cell.rows).toBe(EFFICIENCY_MIN_ROWS * 2);
      expect(cell.days).toEqual(['2026-11-23', '2026-11-24']);
      expect(cell.latest).not.toBeNull();
    }
    const testFull = ev.cells.find((c) => c.spec.slug === 'test-full')!;
    expect(testFull.latest?.costPerDay).toBe(0);
    expect(testFull.latest?.rank).toBe(10);
    const ci = ev.cells.find((c) => c.spec.slug === 'ci-minutes')!;
    expect(ci.latest?.lowerBound).toBe(true);
    expect(ci.latest?.costPerDay).toBe(19.03);
    // The process-class install variant (core-hours/day) and the excluded keys never fold.
    expect(ev.cells.some((c) => c.id.includes('install'))).toBe(false);
    expect(ev.cells.some((c) => c.spec.slug === 'agent-installs')).toBe(false);
  });

  it('keeps the newest sighting as latest and records first/last bounds', () => {
    const rows = recurringRows([TEST_FULL]);
    const ev = foldEfficiencyEvidence(rows, { nowMs: NOW_MS });
    const cell = ev.cells[0]!;
    expect(cell.firstSeen).toBe('2026-11-23T10:00:00.000Z');
    expect(cell.lastSeen).toBe('2026-11-24T12:00:00.000Z');
    expect(cell.latest?.atMs).toBe(Date.parse('2026-11-24T12:00:00.000Z'));
  });
});

describe('efficiencyBacklogItems', () => {
  it('emits one item per recurring actionable cell at the bars', async () => {
    const dir = await runsDir('runs-all', jsonl(recurringRows([TEST_FULL, CI_MINUTES, HARNESS, WORKTREES, BUILD])));
    const items = await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id).sort()).toEqual([
      'efficiency-agent-builds', 'efficiency-ci-minutes', 'efficiency-harness-size', 'efficiency-test-full', 'efficiency-worktrees',
    ]);
    expect(items.every((i) => i.priority === 3 && i.area === 'fleet-efficiency' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const testFull = items.find((i) => i.id === 'efficiency-test-full')!;
    expect(testFull.prompt).toContain('ledger/efficiency-hourly.jsonl');
    expect(testFull.prompt).toContain('verify-changed.mjs');
    expect(testFull.prompt).toContain('codex lanes only');
    const ci = items.find((i) => i.id === 'efficiency-ci-minutes')!;
    expect(ci.prompt).toContain('.github/scripts/');
    expect(ci.prompt).toContain('.github/workflows');
    expect(ci.prompt).toContain('lower bound');
    const harness = items.find((i) => i.id === 'efficiency-harness-size')!;
    expect(harness.prompt).toContain('6408');
    expect(harness.prompt).toContain('unpriced');
    const wt = items.find((i) => i.id === 'efficiency-worktrees')!;
    expect(wt.prompt).toContain('125.6');
    expect(wt.prompt).toContain('temp-worktree-reaper');
  });

  it('emits nothing below the recurrence bars, on degraded-only evidence, or for another repository', async () => {
    // Two days but only two sightings — under the row bar.
    const twoSightings = [row(Date.parse('2026-11-23T10:00:00.000Z'), [TEST_FULL]), row(Date.parse('2026-11-24T10:00:00.000Z'), [TEST_FULL])];
    const few = await runsDir('runs-few', jsonl(twoSightings));
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Three sightings all on one UTC day.
    const oneDay = [0, 1, 2].map((h) => row(Date.parse('2026-11-24T10:00:00.000Z') + h * HOUR_MS, [TEST_FULL]));
    const oneDayDir = await runsDir('runs-oneday', jsonl(oneDay));
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDayDir, now: new Date(NOW_MS) })).toEqual([]);

    // Every in-window row degraded: recurrence can never be proven.
    const degraded = recurringRows([TEST_FULL]).map((r) => ({ ...r, errors: { lanes: 'RuntimeError: x' } }));
    const degDir = await runsDir('runs-degraded', jsonl(degraded));
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: degDir, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir, missing journal, and a directory where the journal should be.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'ledger', 'efficiency-hourly.jsonl'), { recursive: true });
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"ts":"x"}', '']);
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDir('runs-repo', jsonl(recurringRows([TEST_FULL])));
    expect(await efficiencyBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await efficiencyBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('states truncated tails and degraded rows inside the emitted prompts', async () => {
    // >8 MiB of retained rows: pad each filler row past the tail bound so the
    // oldest bytes are dropped; the recurring rows at the end stay retained.
    const pad = 'x'.repeat(8192);
    const filler: string[] = [];
    for (let i = 0; i < 1200; i += 1) {
      filler.push(JSON.stringify({ ...row(NOW_MS - (190 - (i % 180)) * HOUR_MS, [TEST_FULL]), pad }));
    }
    const big = [...filler, ...jsonl(recurringRows([TEST_FULL, CI_MINUTES]))];
    // One degraded row inside the window is disclosed, not counted.
    big.push(JSON.stringify(row(NOW_MS - 5 * HOUR_MS, [TEST_FULL], { errors: { ci: 'RuntimeError: gh quota' } })));
    const dir = await runsDir('runs-big', big);
    const items = await efficiencyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    const testFull = items.find((i) => i.id === 'efficiency-test-full');
    expect(testFull).toBeDefined();
    expect(testFull!.prompt).toContain('lower bound');
    expect(testFull!.prompt).toContain('degraded rows');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', jsonl(recurringRows([TEST_FULL, CI_MINUTES])));
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await efficiencyBacklogItems(opts);
    const second = await efficiencyBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.map((i) => i.id).sort()).toEqual(['efficiency-ci-minutes', 'efficiency-test-full']);
  });

  it('appends efficiency items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'ledger'), { recursive: true });
      await writeFile(join(runs, JOURNAL), jsonl(recurringRows([TEST_FULL])).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const effItems = first.items.filter((i) => i.id.startsWith('efficiency-'));
      expect(effItems.map((i) => i.id)).toEqual(['efficiency-test-full']);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(effItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('efficiency-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('efficiency-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
