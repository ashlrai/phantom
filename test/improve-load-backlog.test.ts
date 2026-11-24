import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOAD_DOMINANT_MIN_SHARE,
  LOAD_MIN_DAYS,
  LOAD_RECURRING_HOURS,
  LOAD_WINDOW_HOURS,
  foldLoadEvidence,
  loadBacklogItems,
} from '../src/core/improve/load-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { LoadSnapshotRow } from '../src/core/fleet/load-history.js';

const HOUR_MS = 3_600_000;
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const JOURNAL = 'queue/host-load-history.jsonl';

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-load-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const row = (at: number, contributors: LoadSnapshotRow['contributors'], extra: Partial<LoadSnapshotRow> = {}): LoadSnapshotRow => ({
  at, load1: 91.5, hostMax: 36, contributors, ...extra,
});
const fleet = (share = 80): LoadSnapshotRow['contributors'] => [
  { name: 'fleet jobs', sharePercent: share },
  { name: 'system', sharePercent: 100 - share },
];
const app = (name: string, share = 70): LoadSnapshotRow['contributors'] => [
  { name, sharePercent: share },
  { name: 'other apps', sharePercent: 100 - share },
];

/** Six snapshots, one per hour bucket, three on each of two UTC days — each covers ~10 blocked minutes. */
const recurringRows = (contributors: LoadSnapshotRow['contributors']): LoadSnapshotRow[] => {
  const hours = [
    Date.parse('2026-11-21T10:00:00.000Z'), Date.parse('2026-11-21T11:00:00.000Z'), Date.parse('2026-11-21T12:00:00.000Z'),
    Date.parse('2026-11-22T10:00:00.000Z'), Date.parse('2026-11-22T11:00:00.000Z'), Date.parse('2026-11-22T12:00:00.000Z'),
  ];
  return hours.map((at) => row(at, contributors));
};

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};
const jsonl = (rows: readonly unknown[]): string[] => rows.map((r) => JSON.stringify(r));

describe('foldLoadEvidence', () => {
  it('reports unknown on empty input and counts invalid and out-of-window rows honestly', () => {
    expect(foldLoadEvidence([], { nowMs: NOW_MS })).toMatchObject({ state: 'unknown', snapshots: 0, blockedHours: { hours: 0, days: 0 } });
    const ev = foldLoadEvidence([
      null, 'junk', {}, row(NOW_MS - HOUR_MS, fleet()),
      row(NOW_MS - (LOAD_WINDOW_HOURS + 1) * HOUR_MS, fleet()),
      row(NOW_MS + HOUR_MS, fleet()),
      { at: 'not-a-number', load1: null, hostMax: null, contributors: [] },
      { at: NOW_MS - 2 * HOUR_MS, load1: null, hostMax: null, contributors: [{ name: 7, sharePercent: 1 }] },
      { at: NOW_MS - 3 * HOUR_MS, load1: undefined, hostMax: null, contributors: [] },
    ], { nowMs: NOW_MS });
    expect(ev.invalidRows).toBe(6);
    expect(ev.snapshots).toBe(1);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.state).toBe('known');
  });

  it('folds blocked hour buckets and window contributor shares through the production summarizeLoadHistory', () => {
    const ev = foldLoadEvidence(recurringRows(fleet(80)), { nowMs: NOW_MS });
    expect(ev.state).toBe('known');
    expect(ev.snapshots).toBe(6);
    expect(ev.judgedHours).toBe(6);
    // One snapshot per hour, each ~10 minutes of coverage: every bucket meets the bar.
    expect(ev.blockedHours).toEqual({ hours: LOAD_RECURRING_HOURS, days: LOAD_MIN_DAYS });
    expect(ev.blockedMinutes).not.toBeNull();
    expect(ev.top[0]).toMatchObject({ name: 'fleet jobs' });
    expect(ev.top[0]!.sharePercent).toBeGreaterThanOrEqual(LOAD_DOMINANT_MIN_SHARE);
    expect(ev.dominant?.name).toBe('fleet jobs');
    // 'fleet jobs' ranked first in all six recurring blocked hours.
    expect(ev.dominant!.topHours).toBe(LOAD_RECURRING_HOURS);
  });

  it('keeps the dominant refinement null for owner-side or split contributors', () => {
    const appRows = recurringRows(app('Cursor', 70));
    const ev = foldLoadEvidence(appRows, { nowMs: NOW_MS });
    expect(ev.blockedHours.hours).toBe(LOAD_RECURRING_HOURS);
    expect(ev.top[0]!.name).toBe('Cursor');
    expect(ev.dominant).toBeNull();
    // A fleet contributor below the majority share never mints the item either.
    const split = foldLoadEvidence(recurringRows([
      { name: 'fleet jobs', sharePercent: 40 }, { name: 'system', sharePercent: 35 }, { name: 'other apps', sharePercent: 25 },
    ]), { nowMs: NOW_MS });
    expect(split.top[0]!.name).toBe('fleet jobs');
    expect(split.top[0]!.sharePercent).toBeLessThan(LOAD_DOMINANT_MIN_SHARE);
    expect(split.dominant).toBeNull();
  });

  it('does not count sparse hours below the blocked-minutes bar', () => {
    // Six snapshots all inside ONE hour: the bucket's blocked minutes are bounded by the hour's own span coverage.
    const sameHour = [0, 1, 2, 3, 4, 5].map((i) => row(Date.parse('2026-11-22T10:00:00.000Z') + i * 5 * 60_000, fleet()));
    const ev = foldLoadEvidence(sameHour, { nowMs: NOW_MS });
    expect(ev.judgedHours).toBe(1);
    expect(ev.blockedHours.hours).toBeLessThan(LOAD_RECURRING_HOURS);
  });
});

describe('loadBacklogItems', () => {
  it('emits the blocked-hours and fleet-dominant items at the recurring bars', async () => {
    const dir = await runsDir('runs-fleet', jsonl(recurringRows(fleet(80))));
    const items = await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['host-load-blocked-hours', 'host-load-dominant-fleet-jobs']);
    expect(items.every((i) => i.priority === 3 && i.area === 'host-load')).toBe(true);
    expect(items[0]!.prompt).toContain('queue/host-load-history.jsonl');
    expect(items[0]!.prompt).toContain('over_host');
    expect(items[0]!.prompt).toContain('fleet jobs');
    expect(items[1]!.prompt).toContain('worker parallelism');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 })).toHaveLength(1);
  });

  it('emits only the blocked-hours item when an owner-side app dominates', async () => {
    const dir = await runsDir('runs-app', jsonl(recurringRows(app('Cursor', 70))));
    const items = await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['host-load-blocked-hours']);
    expect(items[0]!.prompt).toContain('Cursor');
  });

  it('emits the model-server variant of the dominance item', async () => {
    const dir = await runsDir('runs-model', jsonl(recurringRows(app('local model server', 75))));
    const items = await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['host-load-blocked-hours', 'host-load-dominant-local-model-server']);
    expect(items[1]!.prompt).toContain('local-inference');
  });

  it('emits nothing below the recurring bars, on missing or unreadable journals, or for another repository', async () => {
    // Recurring blocked hours on a single UTC day only.
    const oneDayHours = [10, 11, 12, 13, 14, 15].map((h) => Date.parse(`2026-11-22T${String(h).padStart(2, '0')}:00:00.000Z`));
    const oneDay = await runsDir('runs-oneday', jsonl(oneDayHours.map((at) => row(at, fleet()))));
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Fewer than the recurring hour bar.
    const few = await runsDir('runs-few', jsonl(recurringRows(fleet()).slice(0, 5)));
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'queue', 'host-load-history.jsonl'), { recursive: true });
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"at":"x"}', '']);
    expect(await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this host's evidence.
    const dir = await runsDir('runs-repo', jsonl(recurringRows(fleet())));
    expect(await loadBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await loadBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(2);
  });

  it('states truncated tails as lower bounds in the emitted prompts', async () => {
    // >1 MiB of retained rows: the tail read drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 11000; i += 1) {
      filler.push(JSON.stringify(row(NOW_MS - (200 - (i % 190)) * HOUR_MS, [{ name: 'fleet jobs', sharePercent: 90 }])));
    }
    const dir = await runsDir('runs-big', [...filler, ...jsonl(recurringRows(fleet(80)))]);
    const items = await loadBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', jsonl(recurringRows(fleet(80))));
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await loadBacklogItems(opts);
    const second = await loadBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends load items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, JOURNAL), jsonl(recurringRows(fleet(80))).join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const loadItems = first.items.filter((i) => i.id.startsWith('host-load-'));
    expect(loadItems.map((i) => i.id)).toEqual(['host-load-blocked-hours', 'host-load-dominant-fleet-jobs']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(loadItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('host-load-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('host-load-'))).toHaveLength(2);
  });
});
