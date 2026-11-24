import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRateLimitEvents,
  RATE_LIMIT_MIN_DAYS,
  RATE_LIMIT_MIN_ROWS,
  RATE_LIMIT_MIN_WINDOWS,
  RATE_LIMIT_NEAR_UTILIZATION,
  RATE_LIMIT_WINDOW_HOURS,
  rateLimitBacklogItems,
  rateLimitCells,
} from '../src/core/improve/rate-limit-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's capturedAt. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One sanitized rate_limit_event record in the writer's journaled shape. */
function eventRow(spec: {
  atMs?: number;
  status?: string;
  rateLimitType?: string;
  utilization?: number;
  /** Epoch seconds; defaults to ~6h after the event's own timestamp. */
  resetsAt?: number;
  /** Pass null to omit capturedAt entirely (an undated foreign row). */
  capturedAt?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const atMs = spec.atMs ?? NOW_MS;
  const capturedAt = spec.capturedAt === undefined ? iso(atMs) : spec.capturedAt;
  return J({
    type: 'rate_limit_event',
    status: spec.status ?? 'rejected',
    rateLimitType: spec.rateLimitType ?? 'seven_day',
    utilization: spec.utilization ?? 1,
    resetsAt: spec.resetsAt ?? Math.floor(atMs / DAY) * 86_400 + 6 * 3_600,
    ...(capturedAt === null ? {} : { capturedAt }),
    ...spec.extra,
  });
}

/**
 * Recurring adverse rows on one (rateLimitType, tier) cell. resetsAt is
 * quantized to 06:00 UTC of each event's day by default, so a d-day
 * series spans d distinct provider windows; pass fixedResetsAt to pin a
 * single window.
 */
function adverseSeries(opts: {
  rateLimitType?: string;
  utilization?: number;
  days: number;
  perDay: number;
  statuses?: string[];
  fixedResetsAt?: number;
}): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < opts.days; d++) {
    for (let i = 0; i < opts.perDay; i++) {
      const atMs = NOW_MS - d * DAY - i * HOUR - HOUR;
      const resetsAt = opts.fixedResetsAt ?? Math.floor(atMs / DAY) * 86_400 + 6 * 3_600;
      rows.push(eventRow({
        atMs,
        status: opts.statuses?.[n % opts.statuses.length] ?? 'rejected',
        rateLimitType: opts.rateLimitType,
        utilization: opts.utilization,
        resetsAt,
      }));
      n += 1;
    }
  }
  return rows;
}

/** The production fold: one journal text (the single self-compacting file). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldRateLimitEvents([rows.join('\n')], nowMs, RATE_LIMIT_WINDOW_HOURS);
}

describe('foldRateLimitEvents', () => {
  it('counts in-window events and skips foreign shapes without guessing', () => {
    const rows = [
      eventRow({ atMs: NOW_MS - HOUR, utilization: 1 }),
      eventRow({ atMs: NOW_MS - 2 * HOUR, utilization: 0.5, status: 'allowed' }),
      // Outside the window — too old and too far in the future.
      eventRow({ atMs: NOW_MS - RATE_LIMIT_WINDOW_HOURS * 3_600_000 - DAY }),
      eventRow({ atMs: NOW_MS + 600_000 }),
      // Undated: capturedAt omitted folds as the epoch, outside every window.
      eventRow({ atMs: NOW_MS - HOUR, capturedAt: null }),
      // Malformed and foreign shapes — the writer's parser rejects them all.
      'not json at all',
      J({ type: 'assistant', text: 'hello' }),
      J({ type: 'rate_limit_event', status: 'x', rateLimitType: 'y' }),                    // no utilization/resetsAt
      J({ type: 'rate_limit_event', status: 'x', rateLimitType: 'y', utilization: 'high', resetsAt: 1, capturedAt: iso(NOW_MS) }),
      J({ type: 'rate_limit_event', status: 'x', rateLimitType: 'y', utilization: 1, resetsAt: -5, capturedAt: iso(NOW_MS) }),
      '{"type":"rate_limit_event",',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.events).toBe(2);
    expect(fold.malformed).toBe(6);
    expect(fold.outsideWindow).toBe(3);
    // Only the utilization-1 row is adverse; the 0.5 row is healthy headroom.
    expect([...fold.cells.keys()]).toEqual(['seven_day|exhausted']);
    expect(fold.cells.get('seven_day|exhausted')!.rows).toBe(1);
  });

  it('folds adverse tiers per (rateLimitType, tier) and tallies context', () => {
    const rows = [
      // Exhausted seven_day rows across two days and two reset windows.
      ...adverseSeries({ rateLimitType: 'seven_day', utilization: 1, days: 2, perDay: 2, statuses: ['rejected', 'allowed_warning'] }),
      // Near-limit five_hour rows — a different cell.
      ...adverseSeries({ rateLimitType: 'five_hour', utilization: 0.8, days: 1, perDay: 2, statuses: ['allowed_warning'] }),
      // Healthy headroom: events, never cells.
      eventRow({ atMs: NOW_MS - HOUR, utilization: 0.4, status: 'allowed', rateLimitType: 'seven_day' }),
      eventRow({ atMs: NOW_MS - 2 * HOUR, utilization: RATE_LIMIT_NEAR_UTILIZATION - 0.01, rateLimitType: 'five_hour' }),
      // Vocabulary growth never blinds the feed: an unrecognized window label still folds.
      eventRow({ atMs: NOW_MS - 3 * HOUR, utilization: 1.2, rateLimitType: 'monthly', status: 'rejected' }),
    ];
    const fold = foldRows(rows);
    expect(fold.events).toBe(9);
    const keys = [...fold.cells.keys()].sort();
    expect(keys).toEqual(['five_hour|near-limit', 'monthly|exhausted', 'seven_day|exhausted']);
    const seven = fold.cells.get('seven_day|exhausted')!;
    expect(seven.rows).toBe(4);
    expect(seven.windows.size).toBe(2);
    expect(seven.days.size).toBe(2);
    expect(seven.statuses.get('rejected')).toBe(2);
    expect(seven.statuses.get('allowed_warning')).toBe(2);
    expect(seven.maxUtilization).toBe(1);
    const near = fold.cells.get('five_hour|near-limit')!;
    expect(near.rows).toBe(2);
    expect(near.maxUtilization).toBe(0.8);
    const monthly = fold.cells.get('monthly|exhausted')!;
    expect(monthly.maxUtilization).toBe(1.2);
  });
});

describe('rateLimitCells', () => {
  it('emits cells only at the row/day/window bars', () => {
    // Below bars: rows span days but all point at one provider window.
    const oneWindow = foldRows(adverseSeries({ days: 3, perDay: 2, fixedResetsAt: 1_800_000_000 }));
    expect(oneWindow.cells.get('seven_day|exhausted')!.rows).toBe(6);
    expect(oneWindow.cells.get('seven_day|exhausted')!.windows.size).toBe(1);
    expect(rateLimitCells(oneWindow)).toEqual([]);

    // Below bars: rows on a single UTC day even with two windows —
    // five_hour windows reset several times inside one day.
    const twoWindowDay = [
      eventRow({ atMs: NOW_MS - HOUR, utilization: 1, resetsAt: 1_800_000_000 }),
      eventRow({ atMs: NOW_MS - 2 * HOUR, utilization: 1, resetsAt: 1_800_100_000 }),
      eventRow({ atMs: NOW_MS - 3 * HOUR, utilization: 1, resetsAt: 1_800_000_000 }),
      eventRow({ atMs: NOW_MS - 4 * HOUR, utilization: 1, resetsAt: 1_800_100_000 }),
    ];
    const thin = foldRows(twoWindowDay);
    expect(thin.cells.get('seven_day|exhausted')!.days.size).toBe(1);
    expect(thin.cells.get('seven_day|exhausted')!.windows.size).toBe(2);
    expect(rateLimitCells(thin)).toEqual([]);

    // Below bars: too few rows across enough days and windows.
    const twoRows = [
      eventRow({ atMs: NOW_MS - DAY, utilization: 1, resetsAt: 1_800_000_000 }),
      eventRow({ atMs: NOW_MS - 2 * DAY, utilization: 1, resetsAt: 1_800_086_400 }),
    ];
    expect(rateLimitCells(foldRows(twoRows))).toEqual([]);

    // At the bars: rows + days + windows → emits, exhausted before near-limit.
    const good = foldRows([
      ...adverseSeries({ rateLimitType: 'seven_day', utilization: 1, days: RATE_LIMIT_MIN_DAYS, perDay: RATE_LIMIT_MIN_ROWS, statuses: ['rejected', 'allowed_warning'] }),
      ...adverseSeries({ rateLimitType: 'five_hour', utilization: RATE_LIMIT_NEAR_UTILIZATION, days: RATE_LIMIT_MIN_DAYS, perDay: RATE_LIMIT_MIN_ROWS, statuses: ['allowed_warning'] }),
    ]);
    const cells = rateLimitCells(good);
    expect(cells.map((c) => `${c.rateLimitType}|${c.tier}`)).toEqual(['seven_day|exhausted', 'five_hour|near-limit']);
    const [exhausted, near] = cells;
    expect(exhausted).toMatchObject({ kind: 'rate-limit-window', rateLimitType: 'seven_day', tier: 'exhausted' });
    expect(exhausted!.rows).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_ROWS);
    expect(exhausted!.days.length).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_DAYS);
    expect(exhausted!.windows).toBeGreaterThanOrEqual(RATE_LIMIT_MIN_WINDOWS);
    expect(exhausted!.statuses.map((s) => s.text).sort()).toEqual(['allowed_warning', 'rejected']);
    expect(near).toMatchObject({ rateLimitType: 'five_hour', tier: 'near-limit' });
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldRateLimitEvents(
      [adverseSeries({ days: 3, perDay: 2 }).join('\n')],
      NOW_MS,
      RATE_LIMIT_WINDOW_HOURS,
    );
    const cells = rateLimitCells(fold, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(rateLimitCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('rateLimitBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'rate-limit-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'fabric');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...adverseSeries({ rateLimitType: 'seven_day', utilization: 1, days: 2, perDay: 2, statuses: ['rejected', 'allowed_warning'] }),
      ...adverseSeries({ rateLimitType: 'five_hour', utilization: 0.8, days: 2, perDay: 2, statuses: ['allowed_warning'] }),
    ];
    const path = await journal('claude-rate-limit-events', rows);
    const items = await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.area)).toEqual(['rate-limit-exhausted', 'rate-limit-near']);
    for (const item of items) {
      expect(item.id).toMatch(/^rate-limit-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('claude-rate-limit-events.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const [exhausted, near] = items;
    expect(exhausted!.title).toContain('seven_day');
    expect(exhausted!.title).toContain('exhausting');
    expect(exhausted!.prompt).toContain('utilization >= 1');
    expect(exhausted!.prompt).toContain('capacity.json');
    expect(exhausted!.prompt).toContain('owner-only');
    expect(near!.title).toContain('five_hour');
    expect(near!.title).toContain('near the cap');
    expect(near!.prompt).toContain('near-limit');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'claude-rate-limit-events.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'fabric', 'claude-rate-limit-events.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's fabric journal.
    const thin = adverseSeries({ days: 3, perDay: 3 });
    const thinPath = await journal('events-thin', thin);
    expect(await rateLimitBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await rateLimitBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // A journal with only healthy headroom emits nothing.
    const healthy = [
      eventRow({ atMs: NOW_MS - DAY, utilization: 0.3, status: 'allowed' }),
      eventRow({ atMs: NOW_MS - 2 * DAY, utilization: 0.6, status: 'allowed' }),
      eventRow({ atMs: NOW_MS - 3 * DAY, utilization: RATE_LIMIT_NEAR_UTILIZATION - 0.01, status: 'allowed_warning' }),
      'not json at all',
    ];
    const healthyPath = await journal('events-healthy', healthy);
    expect(await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = adverseSeries({ days: 3, perDay: 2 });
    // Pad past the writer's 256 KiB compaction bound so the tail read reports truncated.
    const pad = 'x'.repeat(300 * 1024);
    const path = await journal('events-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await rateLimitBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...adverseSeries({ rateLimitType: 'seven_day', utilization: 1, days: 2, perDay: 2 }),
      ...adverseSeries({ rateLimitType: 'five_hour', utilization: 1, days: 3, perDay: 2 }),
      ...adverseSeries({ rateLimitType: 'five_hour', utilization: 0.8, days: 2, perDay: 3 }),
    ];
    const path = await journal('events-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await rateLimitBacklogItems(opts);
    const second = await rateLimitBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await rateLimitBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends rate-limit items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is homedir()/.ashlr/fabric — the
    // relocated HOME is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'fabric');
    await mkdir(dir, { recursive: true });
    const liveRows = [
      eventRow({ atMs: at(0), utilization: 1, rateLimitType: 'seven_day', status: 'rejected' }),
      eventRow({ atMs: at(1), utilization: 1, rateLimitType: 'seven_day', status: 'rejected' }),
      eventRow({ atMs: at(2), utilization: 1, rateLimitType: 'seven_day', status: 'allowed_warning' }),
      eventRow({ atMs: at(0, 1), utilization: 1, rateLimitType: 'seven_day', status: 'rejected' }),
      eventRow({ atMs: at(0), utilization: 0.8, rateLimitType: 'five_hour', status: 'allowed_warning' }),
      eventRow({ atMs: at(1), utilization: 0.85, rateLimitType: 'five_hour', status: 'allowed_warning' }),
      eventRow({ atMs: at(2), utilization: 0.9, rateLimitType: 'five_hour', status: 'allowed_warning' }),
      eventRow({ atMs: at(0, 2), utilization: 0.8, rateLimitType: 'five_hour', status: 'allowed_warning' }),
    ];
    await writeFile(join(dir, 'claude-rate-limit-events.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('rate-limit-'));
    expect(journalItems).toHaveLength(2);
    expect(journalItems.map((i) => i.area)).toEqual(['rate-limit-exhausted', 'rate-limit-near']);
    expect(journalItems[0]!.title).toContain('seven_day');
    expect(journalItems[1]!.title).toContain('five_hour');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('rate-limit-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('rate-limit-'))).toHaveLength(2);
  });
});
