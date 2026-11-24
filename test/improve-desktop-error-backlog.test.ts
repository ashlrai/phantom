import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_ERROR_MAX_ITEMS,
  DESKTOP_ERROR_MIN_DAYS,
  DESKTOP_ERROR_MIN_RECORDS,
  desktopErrorBacklogItems,
  foldDesktopErrorCells,
  parseDesktopErrorRows,
  type DesktopErrorRecord,
} from '../src/core/improve/desktop-error-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const FP = '0123456789abcdef';
const FP2 = 'fedcba9876543210';
const record = (fingerprint: string, atMs: number, over: Record<string, unknown> = {}): DesktopErrorRecord => ({
  fingerprint,
  surface: 'route:verse.fleet',
  message: 'Cannot read properties of undefined',
  appVersion: '3.30.72',
  atMs,
  ...over,
} as DesktopErrorRecord);

describe('parseDesktopErrorRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 7 * DAY;

  it('keeps only rows whose own fields validate inside the window', () => {
    const rows = [
      J({ at: '2026-11-23T10:00:00.000Z', fingerprint: FP, surface: 'route:verse.fleet', message: 'boom', appVersion: '3.30.72' }),
      J({ at: '2026-11-22T10:00:00.000Z', fingerprint: FP2, surface: 'pane:fleet', message: 'bang' }),
      J({ at: '2026-11-23T10:00:00.000Z', fingerprint: 'not-hex!', surface: 'route:x', message: 'm' }),
      J({ at: '2026-11-23T10:00:00.000Z', fingerprint: FP, surface: 'BAD SURFACE!', message: 'm' }),
      J({ at: '2026-11-23T10:00:00.000Z', fingerprint: FP, surface: 'route:x', message: '' }),
      J({ at: '2026-11-23T10:00:00.000Z', fingerprint: FP, surface: 'route:x', message: 'm', appVersion: 42 }),
      J({ at: '2026-11-10T10:00:00.000Z', fingerprint: FP, surface: 'route:x', message: 'm' }), // outside window
      J({ at: '2026-11-24T10:00:00.000Z', fingerprint: FP, surface: 'route:x', message: 'm' }), // future
      J({ fingerprint: FP, surface: 'route:x', message: 'm' }), // no timestamp
      J({ at: 'not a date', fingerprint: FP, surface: 'route:x', message: 'm' }),
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseDesktopErrorRows(rows, CUTOFF, NOW);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ fingerprint: FP, surface: 'route:verse.fleet', appVersion: '3.30.72' });
    expect(parsed[1]).toMatchObject({ fingerprint: FP2, surface: 'pane:fleet', appVersion: null });
    expect(parsed[0]!.atMs).toBe(Date.parse('2026-11-23T10:00:00.000Z'));
  });
});

describe('foldDesktopErrorCells', () => {
  const T0 = Date.parse('2026-11-23T08:00:00.000Z');

  it('groups by fingerprint, counts records and distinct UTC days, quotes the newest record', () => {
    const cells = foldDesktopErrorCells([
      record(FP, T0),
      record(FP, T0 + MIN),
      record(FP, T0 + 2 * DAY, { surface: 'route:verse.fleet', message: 'newer message', appVersion: '3.30.73' }),
      record(FP2, T0 + 3 * MIN, { surface: 'dock-helper:x', message: 'other' }),
    ]);
    expect(cells).toHaveLength(2);
    const [a, b] = cells;
    expect(a).toMatchObject({
      fingerprint: FP,
      count: 3,
      days: 2,
      surface: 'route:verse.fleet',
      message: 'newer message',
      appVersion: '3.30.73',
      firstSeen: '2026-11-23T08:00:00.000Z',
      lastSeen: '2026-11-25T08:00:00.000Z',
      lowerBound: false,
    });
    expect(b).toMatchObject({ fingerprint: FP2, count: 1, days: 1, surface: 'dock-helper:x', appVersion: '3.30.72' });
  });

  it('marks every cell a lower bound when a tail was truncated', () => {
    const cells = foldDesktopErrorCells([record(FP, T0)], true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('desktopErrorBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const iso = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();
  const isoDay = (daysAgo: number, minAgo = 0): string => new Date(NOW - daysAgo * DAY - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'desktop-error-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: the live ledger plus an optional rotated generation. */
  async function runsDir(name: string, files: { live?: string[]; rotated?: string[] }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'desktop'), { recursive: true });
    if (files.live !== undefined) await writeFile(join(dir, 'desktop', 'errors.jsonl'), files.live.join('\n') + '\n');
    if (files.rotated !== undefined) await writeFile(join(dir, 'desktop', 'errors.1.jsonl'), files.rotated.join('\n') + '\n');
    return dir;
  }
  const crash = (fp: string, at: string, over: Record<string, unknown> = {}): string =>
    J({ at, fingerprint: fp, surface: 'route:verse.fleet', message: 'Cannot read properties of undefined', appVersion: '3.30.72', ...over });

  it('emits an item for a fingerprint recurring across distinct days and validates it', async () => {
    const dir = await runsDir('runs-hit', {
      live: [
        crash(FP, isoDay(0, 60)),
        crash(FP, isoDay(1, 30)),
        crash(FP, isoDay(1, 90)),
        crash(FP2, isoDay(0, 10)), // one stray crash: under the bars
      ],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'desktop-errors' });
    expect(item!.id).toMatch(/^fleet-desktop-errors-[0-9a-f]{16}$/);
    expect(item!.title).toContain('route:verse.fleet');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain(FP);
    expect(item!.prompt).toContain('Cannot read properties of undefined');
    expect(item!.prompt).toContain('errors.jsonl');
    expect(item!.prompt).toContain('desktop-errors');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain(FP2);
  });

  it('emits nothing for a one-day burst, thin counts or a stale ledger', async () => {
    // Three records but all on one UTC day — an incident, not a recurrence.
    const burst = await runsDir('runs-burst', {
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(0, 120)), crash(FP, isoDay(0, 180))],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: burst, now: new Date(NOW) })).toEqual([]);
    // Two records across two days — under the record bar.
    const thin = await runsDir('runs-thin', {
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(2, 60))],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW) })).toEqual([]);
    // Records all outside the window.
    const stale = await runsDir('runs-stale', {
      live: [crash(FP, iso(10 * DAY / MIN)), crash(FP, iso(11 * DAY / MIN)), crash(FP, iso(12 * DAY / MIN))],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: stale, now: new Date(NOW) })).toEqual([]);
    expect(DESKTOP_ERROR_MIN_RECORDS).toBe(3);
    expect(DESKTOP_ERROR_MIN_DAYS).toBe(2);
  });

  it('folds the rotated generation into the same fingerprint cell', async () => {
    const dir = await runsDir('runs-rot', {
      rotated: [crash(FP, isoDay(5, 60))],
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60))],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 recorded render crash');
    expect(items[0]!.prompt).toContain(isoDay(5, 60).slice(0, 10));
  });

  it('emits nothing for missing ledgers, another repository, or empty evidence', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60)), crash(FP, isoDay(2, 60))],
    });
    expect(await desktopErrorBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await desktopErrorBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('a corrupt generation never poisons the fold and truncation is a stated lower bound', async () => {
    const dir = await runsDir('runs-mixed', {
      rotated: ['garbage{{{', 'not json'],
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60)), crash(FP, isoDay(2, 60))],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    // Pad the live ledger past the 3 MiB tail so the read reports truncated.
    const pad = 'x'.repeat(4 * 1024 * 1024);
    await writeFile(join(dir, 'desktop', 'errors.jsonl'), pad + '\n' + [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60)), crash(FP, isoDay(2, 60))].join('\n') + '\n');
    const truncated = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(truncated).toHaveLength(1);
    expect(truncated[0]!.prompt).toContain('lower bound');
  });

  it('scrubs and flattens the recorded message before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const dir = await runsDir('runs-scrub', {
      live: [
        crash(FP, isoDay(2, 60), { message: `fetch failed with ${token}` }),
        crash(FP, isoDay(1, 60), { message: `fetch failed with ${token}` }),
        crash(FP, isoDay(0, 60), { message: `fetch failed with ${token}\nsecond line` }),
      ],
    });
    const items = await desktopErrorBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).not.toContain('\nsecond line');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      live: [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60)), crash(FP, isoDay(2, 60))],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await desktopErrorBacklogItems(opts);
    const second = await desktopErrorBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(DESKTOP_ERROR_MAX_ITEMS);
  });

  it('appends desktop-error items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'desktop'), { recursive: true });
    await writeFile(join(runs, 'desktop', 'errors.jsonl'),
      [crash(FP, isoDay(0, 60)), crash(FP, isoDay(1, 60)), crash(FP, isoDay(2, 60))].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const crashItems = first.items.filter((i) => i.id.startsWith('fleet-desktop-errors-'));
    expect(crashItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(crashItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-desktop-errors-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-desktop-errors-'))).toHaveLength(1);
  });
});
