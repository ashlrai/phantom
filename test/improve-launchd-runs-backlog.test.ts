import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LAUNCHD_RUNS_BACKLOG_MAX_ITEMS,
  foldLaunchdRunCells,
  launchdRunsBacklogItems,
  parseLaunchdRunEntry,
  parseLaunchdRunJournal,
} from '../src/core/improve/launchd-runs-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { CRASH_THRESHOLD, HOUR_MS } from '../src/core/autofix/types.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-launchd-runs-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const sampleRow = (atMs: number, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    label: 'ai.ashlr.local-runtime',
    atMs,
    runs: 10,
    lastExitCode: 0,
    pid: null,
    ...over,
  });

const D1 = Date.parse('2026-11-28T08:00:00.000Z');
const D2 = Date.parse('2026-11-29T08:00:00.000Z');
const D3 = Date.parse('2026-11-30T08:00:00.000Z');

/** `n` nonzero-exit samples for one label spread across n distinct UTC days — past the row and day bars. */
const flakyExits = (label = 'ai.ashlr.flaky', code = 1): string[] =>
  [D1, D2, D3].map((atMs, i) => sampleRow(atMs + i * 3_600_000, { label, runs: 10 + i, lastExitCode: code }));

/**
 * One churn episode per day: a baseline sample then a second ~30min later
 * whose runs count jumped by more than CRASH_THRESHOLD — three episodes
 * across three UTC days, past the row and day bars.
 */
const churnSeries = (label = 'ai.ashlr.churn'): string[] => {
  const rows: string[] = [];
  let runs = 0;
  for (const day of [D1, D2, D3]) {
    runs += 1;
    rows.push(sampleRow(day, { label, runs, lastExitCode: 0 }));
    runs += CRASH_THRESHOLD + 5;
    rows.push(sampleRow(day + 1_800_000, { label, runs, lastExitCode: 0 }));
  }
  return rows;
};

/** A runs dir holding the sample journal under ledger/, matching the writer's own path. */
const runsDirWith = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'ledger'), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, 'ledger', file), text);
  return dir;
};

describe('parseLaunchdRunEntry / parseLaunchdRunJournal', () => {
  it('accepts the writer contract and drops off-contract rows and entries honestly', () => {
    const parsed = parseLaunchdRunEntry(JSON.parse(sampleRow(D1, {
      label: 'com.ashlr.helper', runs: 42, lastExitCode: -9, pid: 1234,
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.label).toBe('com.ashlr.helper');
    expect(parsed!.runs).toBe(42);
    expect(parsed!.lastExitCode).toBe(-9);
    expect(parsed!.pid).toBe(1234);
    expect(parsed!.utcDay).toBe('2026-11-28');

    // lastExitCode/pid stay optional; a missing or null one reads as absent.
    expect(parseLaunchdRunEntry({ label: 'ai.ashlr.x', atMs: D1, runs: 0 })!.lastExitCode).toBeNull();
    expect(parseLaunchdRunEntry({ label: 'ai.ashlr.x', atMs: D1, runs: 0, lastExitCode: null })!.pid).toBeNull();

    // Whole-row contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      { label: 'ai.ashlr.x', atMs: 'not-a-number', runs: 1 },
      { label: 'ai.ashlr.x', atMs: D1, runs: 'many' },
      { label: 'ai.ashlr.x', atMs: D1, runs: -1 },
      { label: 'ai.ashlr.x', atMs: D1, runs: Number.NaN },
      { label: '', atMs: D1, runs: 1 },
      { label: 'bad label!', atMs: D1, runs: 1 },
      { label: 'x'.repeat(202), atMs: D1, runs: 1 },
      { label: 42, atMs: D1, runs: 1 },
    ]) {
      expect(parseLaunchdRunEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows, invalidRows } = parseLaunchdRunJournal([
      'not json',
      '{"label":"ai.ashlr.x"}',
      sampleRow(D1),
      '',
      sampleRow(D2, { runs: 'bogus' }),
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldLaunchdRunCells', () => {
  const rowsOf = (lines: readonly string[]) => parseLaunchdRunJournal(lines.join('\n')).rows;

  it('folds nonzero exits and runs churn per label and ignores healthy samples', () => {
    const folded = foldLaunchdRunCells(rowsOf([
      ...flakyExits('ai.ashlr.flaky', 1),
      ...churnSeries('ai.ashlr.churn'),
      // A healthy label: flat runs, exit 0 — never adverse.
      ...[D1, D2, D3].map((atMs) => sampleRow(atMs, { label: 'ai.ashlr.steady', runs: 7, lastExitCode: 0 })),
    ]), { nowMs: NOW_MS });
    const flaky = folded.find((c) => c.label === 'ai.ashlr.flaky')!;
    expect(flaky.exitRows).toBe(3);
    expect(flaky.exitDays.size).toBe(3);
    expect(flaky.churnRows).toBe(0);
    expect(flaky.exitCodes[0]).toEqual({ code: 1, count: 3 });
    const churnCell = folded.find((c) => c.label === 'ai.ashlr.churn')!;
    expect(churnCell.churnRows).toBe(3);
    expect(churnCell.churnDays.size).toBe(3);
    expect(churnCell.exitRows).toBe(0);
    const steady = folded.find((c) => c.label === 'ai.ashlr.steady')!;
    expect(steady.exitRows).toBe(0);
    expect(steady.churnRows).toBe(0);
  });

  it('keeps sub-bar cells visible to the fold while the items layer applies the recurring bars', () => {
    // Nonzero exits all on ONE UTC day: a real cell, but under the days bar.
    const oneDay = foldLaunchdRunCells(rowsOf([
      sampleRow(D3, { label: 'ai.ashlr.x', lastExitCode: 2 }),
      sampleRow(D3 + 3_600_000, { label: 'ai.ashlr.x', lastExitCode: 2 }),
      sampleRow(D3 + 7_200_000, { label: 'ai.ashlr.x', lastExitCode: 2 }),
    ]), { nowMs: NOW_MS });
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0]!.exitRows).toBe(3);
    expect(oneDay[0]!.exitDays.size).toBe(1);

    // Samples outside the 7-day window never count.
    const ancient = foldLaunchdRunCells(rowsOf([
      sampleRow(Date.parse('2026-11-01T08:00:00.000Z'), { label: 'ai.ashlr.old', lastExitCode: 1 }),
      sampleRow(Date.parse('2026-11-02T08:00:00.000Z'), { label: 'ai.ashlr.old', lastExitCode: 1 }),
      sampleRow(Date.parse('2026-11-03T08:00:00.000Z'), { label: 'ai.ashlr.old', lastExitCode: 1 }),
    ]), { nowMs: NOW_MS });
    expect(ancient).toEqual([]);
  });

  it('does not count churn across a gap wider than the hour or a runs reset', () => {
    // Two samples > HOUR_MS apart with a big runs jump: not an hourly surge.
    const sparse = foldLaunchdRunCells(rowsOf([
      sampleRow(D1, { label: 'ai.ashlr.sparse', runs: 0, lastExitCode: 0 }),
      sampleRow(D1 + 2 * HOUR_MS, { label: 'ai.ashlr.sparse', runs: CRASH_THRESHOLD * 4, lastExitCode: 0 }),
    ]), { nowMs: NOW_MS });
    expect(sparse[0]!.churnRows).toBe(0);

    // A runs reset (newest lower than baseline) is not positive churn.
    const reset = foldLaunchdRunCells(rowsOf([
      sampleRow(D1, { label: 'ai.ashlr.reset', runs: 500, lastExitCode: 0 }),
      sampleRow(D1 + 900_000, { label: 'ai.ashlr.reset', runs: 2, lastExitCode: 0 }),
      sampleRow(D1 + 1_800_000, { label: 'ai.ashlr.reset', runs: 3, lastExitCode: 0 }),
    ]), { nowMs: NOW_MS });
    expect(reset[0]!.churnRows).toBe(0);
  });
});

describe('launchdRunsBacklogItems', () => {
  it('emits one item per recurring label with stable ids, prompts and metadata', async () => {
    const dir = await runsDirWith('runs-all', {
      'launchd-runs.jsonl': [
        ...flakyExits('ai.ashlr.flaky', 1),
        ...churnSeries('ai.ashlr.churn'),
        // Healthy samples that must not emit.
        ...[D1, D2, D3].map((atMs) => sampleRow(atMs, { label: 'ai.ashlr.steady', runs: 7, lastExitCode: 0 })),
        // Below-bar label: exits on a single day only.
        ...[D3, D3 + 3_600_000, D3 + 7_200_000].map((atMs) =>
          sampleRow(atMs, { label: 'ai.ashlr.oneday', runs: 3, lastExitCode: 9 })),
      ].join('\n') + '\n',
    });
    const items = await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.length).toBeLessThanOrEqual(Math.min(LAUNCHD_RUNS_BACKLOG_MAX_ITEMS, 25));
    for (const item of items) {
      expect(item.id).toMatch(/^launchd-runs-[0-9a-f]{16}$/);
      expect(item.priority).toBe(3);
      expect(item.area).toBe('autofix');
      expect(item.repo).toBe('ashlrai/phantom');
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('launchd-runs.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    const flaky = items.find((i) => i.title.includes('ai.ashlr.flaky'))!;
    expect(flaky.prompt).toContain('nonzero last exit code');
    expect(flaky.prompt).toContain('1 ×3');
    const churnItem = items.find((i) => i.title.includes('ai.ashlr.churn'))!;
    expect(churnItem.prompt).toContain('trailing hour');
    // The single-day and healthy labels never emit.
    expect(items.some((i) => i.title.includes('ai.ashlr.oneday'))).toBe(false);
    expect(items.some((i) => i.title.includes('ai.ashlr.steady'))).toBe(false);
    const limited = await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the rows bar: two nonzero-exit samples.
    const few = await runsDirWith('runs-few', {
      'launchd-runs.jsonl': [
        sampleRow(D1, { label: 'ai.ashlr.x', lastExitCode: 1 }),
        sampleRow(D2, { label: 'ai.ashlr.x', lastExitCode: 1 }),
      ].join('\n') + '\n',
    });
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three nonzero exits on one UTC day.
    const oneDay = await runsDirWith('runs-oneday', {
      'launchd-runs.jsonl': [
        sampleRow(D3, { label: 'ai.ashlr.x', lastExitCode: 1 }),
        sampleRow(D3 + 3_600_000, { label: 'ai.ashlr.x', lastExitCode: 1 }),
        sampleRow(D3 + 7_200_000, { label: 'ai.ashlr.x', lastExitCode: 1 }),
      ].join('\n') + '\n',
    });
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir, missing ledger dir and missing file are the writer's normal states.
    const empty = await runsDirWith('runs-empty', {});
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'ledger', 'launchd-runs.jsonl'), { recursive: true });
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDirWith('runs-junk', { 'launchd-runs.jsonl': 'not json\n{"label":"ai.ashlr.x"}\n' });
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDirWith('runs-repo', { 'launchd-runs.jsonl': flakyExits().join('\n') + '\n' });
    expect(await launchdRunsBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await launchdRunsBacklogItems({ repo: 'not-a-repo', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncated tails as lower bounds and counts malformed lines in prompts', async () => {
    // >512 KiB of retained healthy rows: the bounded tail drops the oldest bytes.
    // Constant runs and exit 0 keep every pad label non-adverse, so only the
    // flaky fixture can emit — deterministically.
    const filler: string[] = [];
    for (let i = 0; i < 7000; i += 1) {
      filler.push(sampleRow(D1 + (i % 500) * 1000, {
        label: `ai.ashlr.pad-${i % 50}`, runs: 5, lastExitCode: 0, pid: null,
      }));
    }
    const dir = await runsDirWith('runs-big', {
      'launchd-runs.jsonl': [...filler, ...flakyExits()].join('\n') + '\nnot json\n',
    });
    const items = await launchdRunsBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
    expect(items.some((i) => i.prompt.includes('malformed or off-contract'))).toBe(true);
  }, 30_000);

  it('keeps a recorded label verbatim in the prompt and derives stable ids', async () => {
    const dir = await runsDirWith('runs-stable', {
      'launchd-runs.jsonl': flakyExits('ai.ashlr.secret-job').join('\n') + '\n',
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await launchdRunsBacklogItems(opts);
    const second = await launchdRunsBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first[0]!.prompt).toContain('ai.ashlr.secret-job');
    expect(first[0]!.prompt).not.toContain('123456789:AAAABBBB');
  });

  it('appends launchd items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so the
    // fixtures use days relative to real now — three distinct UTC days inside
    // the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): number => Date.now() - days * DAY_MS;
    const recentFlaky = (label: string): string[] =>
      [1, 2, 3].map((d, i) => sampleRow(dayAgo(d) - i * 3_600_000, { label, runs: 10 + i, lastExitCode: 1 }));
    const runsDir = join(home, '.ashlr-runs');
    await mkdir(join(runsDir, 'ledger'), { recursive: true });
    await writeFile(join(runsDir, 'ledger', 'launchd-runs.jsonl'), recentFlaky('ai.ashlr.live-flaky').join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const launchdItems = first.items.filter((i) => i.id.startsWith('launchd-runs-'));
    expect(launchdItems).toHaveLength(1);
    expect(launchdItems[0]!.title).toContain('ai.ashlr.live-flaky');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(launchdItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('launchd-runs-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('launchd-runs-'))).toHaveLength(1);
  });
});
