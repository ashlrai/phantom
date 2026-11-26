import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRewardJournal,
  REWARD_BACKLOG_WINDOW_MS,
  REWARD_MIN_DAYS,
  REWARD_MIN_NOT_HELD,
  REWARD_MIN_ROWS,
  rewardBacklogItems,
  rewardCells,
} from '../src/core/improve/reward-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch ms like the ledger's canonical ISO rows. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
/** Canonical ISO-8601 UTC millis — the only timestamp shape isRewardSignalV1 accepts. */
const iso = (ms: number): string => new Date(ms).toISOString();

const COST_NULL = { pool: null, pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null, costUsd: null };

/** One reward-signal.v1 row in the producer's exact shape; merged rows carry a consistent derived ttm. */
function rewardRow(spec: {
  jobId: string;
  pool?: string | null;
  repo?: string | null;
  merged?: boolean;
  recordedAtMs: number;
  dispatchedAtMs?: number;
  ciWallMs?: number | null;
}): string {
  const merged = spec.merged ?? false;
  const dispatchedAtMs = spec.dispatchedAtMs ?? spec.recordedAtMs - 2 * HOUR;
  const mergedAtMs = merged ? spec.recordedAtMs - HOUR : null;
  return J({
    v: 1,
    jobId: spec.jobId,
    pool: spec.pool === undefined ? 'claude' : spec.pool,
    repo: spec.repo === undefined ? 'ashlrai/phantom' : spec.repo,
    merged,
    dispatchedAt: iso(dispatchedAtMs),
    mergedAt: mergedAtMs === null ? null : iso(mergedAtMs),
    timeToMergeMs: mergedAtMs === null ? null : mergedAtMs - dispatchedAtMs,
    ciWallMs: spec.ciWallMs ?? null,
    cost: COST_NULL,
    recordedAt: iso(spec.recordedAtMs),
  });
}

const held = (jobId: string, recordedAtMs: number, pool = 'claude'): string =>
  rewardRow({ jobId, pool, merged: true, recordedAtMs });
const notHeld = (jobId: string, recordedAtMs: number, pool = 'claude'): string =>
  rewardRow({ jobId, pool, merged: false, recordedAtMs });

/** n rows for one pool spread across `days` distinct UTC days ending today. */
function poolSeries(pool: string, days: number, perDay: number, make: (d: number, i: number) => string): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) rows.push(make(d, i));
  }
  return rows;
}

describe('foldRewardJournal', () => {
  it('keeps only in-window rows under the writer contract', () => {
    const rows = [
      held('job-1', NOW_MS),
      notHeld('job-2', NOW_MS - HOUR),
      // Wrong schema version.
      J({ ...JSON.parse(held('job-3', NOW_MS)), v: 2 }),
      // Missing a required key.
      (() => { const r = JSON.parse(notHeld('job-4', NOW_MS)) as Record<string, unknown>; delete r['ciWallMs']; return J(r); })(),
      // Extra key outside the closed set.
      J({ ...JSON.parse(held('job-5', NOW_MS)), extra: 1 }),
      // merged:true without mergedAt.
      J({ ...JSON.parse(held('job-6', NOW_MS)), mergedAt: null, timeToMergeMs: null }),
      // timeToMergeMs inconsistent with the timestamps.
      J({ ...JSON.parse(held('job-7', NOW_MS)), timeToMergeMs: 1 }),
      // Non-canonical timestamp (no millis).
      J({ ...JSON.parse(held('job-8', NOW_MS)), recordedAt: '2026-11-23T11:00:00Z' }),
      // Pool outside the producer pattern.
      rewardRow({ jobId: 'job-9', pool: 'Bad Pool!', recordedAtMs: NOW_MS }),
      // Repo outside the producer pattern.
      rewardRow({ jobId: 'job-10', repo: 'not a repo', recordedAtMs: NOW_MS }),
      // Cost shape drift.
      J({ ...JSON.parse(held('job-11', NOW_MS)), cost: { pool: null } }),
      // Outside the window and beyond the skew allowance.
      held('job-12', NOW_MS - REWARD_BACKLOG_WINDOW_MS - 10),
      held('job-13', NOW_MS + 120_000),
      'not json',
      '',
    ].join('\n');
    const fold = foldRewardJournal(rows, NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(fold.records).toBe(2);
    expect(fold.invalidRows).toBe(10);
    const claude = fold.pools.get('claude')!;
    expect(claude.rows).toBe(2);
    expect(claude.held).toBe(1);
    expect(claude.notHeld).toBe(1);
    expect(claude.days.size).toBe(1);
    expect(claude.repos.get('ashlrai/phantom')).toBe(2);
  });

  it('counts a replayed job once even when later rows span days or change pool', () => {
    const original = notHeld('replayed', NOW_MS - DAY);
    const rows = [
      original, original, original, original, original, original,
      notHeld('replayed', NOW_MS),
      held('replayed', NOW_MS, 'codex'),
    ];
    const fold = foldRewardJournal(rows.join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(fold.records).toBe(1);
    expect(fold.pools.size).toBe(1);
    expect(fold.pools.get('claude')).toMatchObject({ rows: 1, notHeld: 1, days: new Set(['2026-11-22']) });
    expect(rewardCells(fold)).toEqual([]);
  });

  it('uses the first valid retained row before applying the time window', () => {
    const rows = [
      held('old', NOW_MS - REWARD_BACKLOG_WINDOW_MS - DAY),
      notHeld('old', NOW_MS),
      J({ jobId: 'new' }),
      held('new', NOW_MS),
    ];
    const fold = foldRewardJournal(rows.join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(fold.records).toBe(1);
    expect(fold.invalidRows).toBe(1);
    expect(fold.pools.get('claude')).toMatchObject({ rows: 1, held: 1, notHeld: 0 });
  });

  it('groups rows per pool and tallies unattributed rows separately', () => {
    const rows = [
      held('job-1', NOW_MS, 'claude'),
      notHeld('job-2', NOW_MS - HOUR, 'claude'),
      held('job-3', NOW_MS - DAY, 'codex'),
      rewardRow({ jobId: 'job-4', pool: null, merged: false, recordedAtMs: NOW_MS }),
      rewardRow({ jobId: 'job-5', pool: null, merged: false, recordedAtMs: NOW_MS - HOUR, repo: null }),
    ].join('\n');
    const fold = foldRewardJournal(rows, NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(fold.records).toBe(5);
    expect(fold.invalidRows).toBe(0);
    expect(fold.pools.get('claude')).toMatchObject({ pool: 'claude', rows: 2, held: 1, notHeld: 1 });
    expect(fold.pools.get('codex')).toMatchObject({ pool: 'codex', rows: 1, held: 1, notHeld: 0 });
    const unattributed = fold.pools.get('')!;
    expect(unattributed.pool).toBeNull();
    expect(unattributed.rows).toBe(2);
    expect(unattributed.repos.get('unattributed')).toBe(1);
    expect(unattributed.repos.get('ashlrai/phantom')).toBe(1);
  });
});

describe('rewardCells', () => {
  it('emits a pool cell only at the row, day, not-held and majority bars', () => {
    // Below the row bar.
    const few = foldRewardJournal(
      poolSeries('claude', REWARD_MIN_DAYS + 1, 1, (d) => notHeld(`j${d}`, NOW_MS - d * DAY)).join('\n'),
      NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(few.pools.get('claude')!.rows).toBeLessThan(REWARD_MIN_ROWS);
    expect(rewardCells(few)).toEqual([]);

    // One day only — a burst, not a pattern.
    const oneDay = foldRewardJournal(
      poolSeries('claude', 1, REWARD_MIN_ROWS + 2, (d, i) => notHeld(`j${i}`, NOW_MS - i * HOUR)).join('\n'),
      NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(oneDay.pools.get('claude')!.days.size).toBe(1);
    expect(rewardCells(oneDay)).toEqual([]);

    const burstWithHeldMerges = [
      ...poolSeries('claude', 1, 4, (_d, i) => notHeld(`burst-${i}`, NOW_MS - i * HOUR)),
      held('held-1', NOW_MS - DAY),
      held('held-2', NOW_MS - 2 * DAY),
    ];
    const burst = foldRewardJournal(burstWithHeldMerges.join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    expect(burst.pools.get('claude')).toMatchObject({ rows: 6, notHeld: 4 });
    expect(rewardCells(burst)).toEqual([]);

    // Enough rows and days but not-held below the floor: 3 not-held of 6.
    const thin = foldRewardJournal(
      [
        ...poolSeries('claude', 3, 1, (d) => notHeld(`n${d}`, NOW_MS - d * DAY)),
        ...poolSeries('claude', 3, 1, (d) => held(`h${d}`, NOW_MS - d * DAY - HOUR)),
      ].join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    const thinTally = thin.pools.get('claude')!;
    expect(thinTally.rows).toBeGreaterThanOrEqual(REWARD_MIN_ROWS);
    expect(thinTally.notHeld).toBeLessThan(REWARD_MIN_NOT_HELD);
    expect(rewardCells(thin)).toEqual([]);

    // Strict majority required: exactly half not-held never emits.
    const half = foldRewardJournal(
      [
        ...poolSeries('claude', 3, 2, (d, i) => notHeld(`n${d}-${i}`, NOW_MS - d * DAY)),
        ...poolSeries('claude', 3, 2, (d, i) => held(`h${d}-${i}`, NOW_MS - d * DAY)),
      ].join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    const halfTally = half.pools.get('claude')!;
    expect(halfTally.rows).toBe(12);
    expect(halfTally.notHeld).toBe(6);
    expect(halfTally.notHeld * 2).toBe(halfTally.rows);
    expect(rewardCells(half)).toEqual([]);

    // Recurring: 5 of 7 resolved rows not held across 3 days.
    const recurring = foldRewardJournal(
      [
        notHeld('n0', NOW_MS), notHeld('n0b', NOW_MS - HOUR),
        notHeld('n1', NOW_MS - DAY), notHeld('n1b', NOW_MS - DAY - HOUR),
        notHeld('n2', NOW_MS - 2 * DAY),
        held('h1', NOW_MS - DAY), held('h2', NOW_MS - 2 * DAY),
      ].join('\n'), NOW_MS, REWARD_BACKLOG_WINDOW_MS);
    const cells = rewardCells(recurring);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ pool: 'claude', rows: 7, held: 2, notHeld: 5 });
    expect(cells[0]!.share).toBeCloseTo(5 / 7, 5);
    expect(cells[0]!.days).toHaveLength(3);
    expect(cells[0]!.repos[0]).toEqual(['ashlrai/phantom', 7]);
  });

  it('emits an unattributed cell for null-pool collapse and sorts worst-first', () => {
    const rows = [
      // unattributed: 8 of 8 not held across 4 days — the worst cell.
      ...poolSeries('u', 4, 2, (d, i) => rewardRow({ jobId: `u${d}-${i}`, pool: null, merged: false, recordedAtMs: NOW_MS - d * DAY - i * HOUR })),
      // claude: 6 of 9 not held across 3 days.
      ...poolSeries('claude', 3, 2, (d, i) => notHeld(`cn${d}-${i}`, NOW_MS - d * DAY)),
      ...poolSeries('claude', 3, 1, (d) => held(`ch${d}`, NOW_MS - d * DAY - HOUR)),
    ].join('\n');
    const cells = rewardCells(foldRewardJournal(rows, NOW_MS, REWARD_BACKLOG_WINDOW_MS));
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ pool: null, notHeld: 8, rows: 8 });
    expect(cells[1]).toMatchObject({ pool: 'claude', notHeld: 6, rows: 9 });
  });
});

describe('rewardBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'reward-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A ledger file carrying the given rows under <home>/metrics/. */
  async function ledger(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'reward-signals.jsonl');
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits pool-collapse items for recurring ledger evidence', async () => {
    const rows = [
      ...poolSeries('claude', 3, 2, (d, i) => notHeld(`n${d}-${i}`, NOW_MS - d * DAY)),
      ...poolSeries('claude', 3, 1, (d) => notHeld(`n-extra-${d}`, NOW_MS - d * DAY - HOUR)),
      held('h1', NOW_MS),
      held('h2', NOW_MS - DAY),
    ];
    const path = await ledger('led-collapse', rows);
    const items = await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'reward' });
    expect(item.id).toMatch(/^reward-[0-9a-f]{16}$/);
    expect(item.title).toContain('claude');
    expect(item.title).toContain('does not hold');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('reward-signals.jsonl');
    expect(item.prompt).toContain('router-calibration');
    expect(item.prompt).toContain('merged:false');
    expect(item.prompt).toContain('9 of 11');
    expect(item.prompt).toContain('not held across 3 UTC day(s)');
    expect(item.prompt).toContain('no-change');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: join(home, 'nope.jsonl'), now: NOW_MS })).toEqual([]);

    const empty = await ledger('led-empty', []);
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: empty, now: NOW_MS })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'led-notfile');
    await mkdir(join(notFile, 'reward-signals.jsonl'), { recursive: true });
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: join(notFile, 'reward-signals.jsonl'), now: NOW_MS })).toEqual([]);

    // Below the day bar: one burst day of not-held rows.
    const thin = await ledger('led-thin', poolSeries('claude', 1, REWARD_MIN_ROWS + 4, (d, i) => notHeld(`j${i}`, NOW_MS - i * HOUR)));
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: thin, now: NOW_MS })).toEqual([]);
    expect(await rewardBacklogItems({ repo: 'ashlrai/lexicon', ledgerPath: thin, now: NOW_MS })).toEqual([]);
    expect(await rewardBacklogItems({ repo: '', ledgerPath: thin, now: NOW_MS })).toEqual([]);

    // A healthy pool: mostly held merges emits nothing.
    const healthy = await ledger('led-healthy', [
      ...poolSeries('claude', 3, 3, (d, i) => held(`h${d}-${i}`, NOW_MS - d * DAY)),
      ...poolSeries('claude', 3, 1, (d) => notHeld(`n${d}`, NOW_MS - d * DAY - HOUR)),
    ]);
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: healthy, now: NOW_MS })).toEqual([]);
  });

  it('withholds collapse items when the clipped prefix can overturn the majority', async () => {
    const notHeldRows = poolSeries('claude', 3, 2, (d, i) => notHeld(`n${d}-${i}`, NOW_MS - d * DAY));
    const heldRows = poolSeries('claude', 3, 2, (d, i) => held(`h${d}-${i}`, NOW_MS - d * DAY));
    const path = await ledger('led-trunc', [heldRows.join('\n'), ' '.repeat(17 * 1024 * 1024), ...notHeldRows]);
    expect(await rewardBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: NOW_MS })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      // claude collapse
      ...poolSeries('claude', 3, 2, (d, i) => notHeld(`cn${d}-${i}`, NOW_MS - d * DAY)),
      ...poolSeries('claude', 3, 1, (d) => notHeld(`cn-extra-${d}`, NOW_MS - d * DAY - HOUR)),
      held('ch1', NOW_MS),
      // codex collapse
      ...poolSeries('codex', 3, 2, (d, i) => notHeld(`xn${d}-${i}`, NOW_MS - d * DAY, 'codex')),
      ...poolSeries('codex', 3, 1, (d) => notHeld(`xn-extra-${d}`, NOW_MS - d * DAY - HOUR, 'codex')),
      held('xh1', NOW_MS - DAY, 'codex'),
    ];
    const path = await ledger('led-stable', rows);
    const opts = { repo: 'ashlrai/phantom', ledgerPath: path, now: NOW_MS };
    const first = await rewardBacklogItems(opts);
    const second = await rewardBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await rewardBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends reward items through discovery and dedupes on refresh', async () => {
    const ash = join(home, '.ashlr');
    await mkdir(join(ash, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const live = (jobId: string, merged: boolean, recordedAtMs: number): string =>
      rewardRow({ jobId, merged, recordedAtMs });
    await writeFile(join(ash, 'metrics', 'reward-signals.jsonl'),
      [
        live('n0', false, at(0)), live('n0b', false, at(0, 1)),
        live('n1', false, at(1)), live('n1b', false, at(1, 1)),
        live('n2', false, at(2)), live('n2b', false, at(2, 1)),
        live('n3', false, at(0, 2)), live('n3b', false, at(1, 2)),
        live('h1', true, at(2, 3)),
      ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const rewardItems = first.items.filter((i) => i.id.startsWith('reward-'));
    expect(rewardItems).toHaveLength(1);
    expect(rewardItems[0]!.area).toBe('reward');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(rewardItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('reward-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('reward-'))).toHaveLength(1);
  });
});
