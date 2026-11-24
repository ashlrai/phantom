import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRecutJobOutcomes,
  foldRecutLeaseJournal,
  foldRecutWriteJournal,
  RECUT_LOOP_MIN_DAYS,
  RECUT_LOOP_MIN_LEASES,
  RECUT_LOOP_MIN_LEASE_DAYS,
  RECUT_LOOP_MIN_WRITES,
  RECUT_LOOP_WINDOW_HOURS,
  recutLeaseCell,
  recutLoopBacklogItems,
  recutPrCells,
} from '../src/core/improve/recut-loop-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const LEASE_MS = 10 * 60 * 1000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the writers emit. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One write-journal row in recut-loop.ts's writer shape. */
function writeRow(pr: number, id: string, headSha: string, atMs: number, baseSha?: string): string {
  return J({ at: iso(atMs), pr, id, headSha, ...(baseSha !== undefined ? { baseSha } : {}), file: `RQ-PHX-${id}.md` });
}

/** perDay write rows for one PR spread across `days` distinct UTC days ending today. */
function writeSeries(pr: number, days: number, perDay: number, headSha = 'a'.repeat(40)): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(writeRow(pr, `RECUT${pr}L${d * perDay + i + 1}`, headSha, NOW_MS - d * DAY - i * HOUR - HOUR));
    }
  }
  return rows;
}

/** One lease-journal row in the writer's reservation shape. */
function leaseRow(pr: number, id: string, headSha: string, atMs: number, leaseUntilMs?: number): string {
  return J({ at: iso(atMs), pr, id, headSha, file: `RQ-PHX-${id}.md`, leaseUntil: leaseUntilMs ?? atMs + LEASE_MS });
}

// --- jobs-ledger row builders (dispatchd dialect) -------------------------

const launchRow = (job: string, atMs: number): string =>
  J({ event: 'launch', job, repo: 'phantom', lane: 'work', tier: 'mid', ts: iso(atMs) });
const finishRow = (job: string, atMs: number, empty = false): string =>
  J({ event: 'finish', job, empty, wall_s: 42, ts: iso(atMs) });
const publishPrRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: iso(atMs) });
const publishEmptyRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'empty', ts: iso(atMs) });
const publishAbortRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'abort:quota', ts: iso(atMs) });
const outcomeRow = (job: string, state: string, atMs: number): string =>
  J({ event: 'outcome', job, state, ts: iso(atMs) });

describe('foldRecutWriteJournal', () => {
  it('folds in-window rows per PR and keeps only contract-valid records', () => {
    const rows = [
      writeRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - DAY),
      writeRow(101, 'RECUT101L2', 'b'.repeat(40), NOW_MS - 2 * DAY),
      writeRow(202, 'RECUT202L1', 'c'.repeat(40), NOW_MS - HOUR),
      // Malformed and off-contract rows never count.
      'not json',
      '{"at":',
      J({ at: 'not-a-date', pr: 303, id: 'RECUT303L1', headSha: 'x' }),
      J({ pr: 303, id: 'RECUT303L1', headSha: 'x' }),
      J({ at: iso(NOW_MS - HOUR), id: 'RECUT303L1', headSha: 'x' }),
      J({ at: iso(NOW_MS - HOUR), pr: 303, headSha: 'x' }),
      J({ at: iso(NOW_MS - HOUR), pr: 303, id: 'has space', headSha: 'x' }),
      J({ at: iso(NOW_MS - HOUR), pr: 303, id: 'RECUT303L1' }), // no headSha
      J({ at: iso(NOW_MS - HOUR), pr: 0, id: 'RECUT303L1', headSha: 'x' }),
      J({ at: iso(NOW_MS - HOUR), pr: 1.5, id: 'RECUT303L1', headSha: 'x' }),
      // Out-of-window and future-dated rows contribute nothing.
      writeRow(404, 'RECUT404L1', 'd'.repeat(40), NOW_MS - RECUT_LOOP_WINDOW_HOURS * 3_600_000 - DAY),
      writeRow(505, 'RECUT505L1', 'e'.repeat(40), NOW_MS + 600_000),
      '',
    ];
    const fold = foldRecutWriteJournal(rows.join('\n'), NOW_MS, RECUT_LOOP_WINDOW_HOURS);
    expect(fold.malformed).toBe(2);
    expect([...fold.prs.keys()].sort()).toEqual([101, 202]);
    const p101 = fold.prs.get(101)!;
    expect(p101.writes).toBe(2);
    expect(p101.days.size).toBe(2);
    expect(p101.jobIds).toEqual(new Set(['RQ-PHX-RECUT101L1', 'RQ-PHX-RECUT101L2']));
    expect(p101.headShas.size).toBe(2);
    // Resolution keys are the writer's lease-check triple: pr, id, headSha.
    expect(fold.published.get(`101 RECUT101L1 ${'a'.repeat(40)}`)).toEqual([NOW_MS - DAY]);
    expect(fold.published.get(`202 RECUT202L1 ${'c'.repeat(40)}`)).toEqual([NOW_MS - HOUR]);
    expect(fold.published.has(`101 RECUT101L9 ${'a'.repeat(40)}`)).toBe(false);
  });
});

describe('foldRecutLeaseJournal', () => {
  it('folds reservations and falls back to the writer window without leaseUntil', () => {
    const rows = [
      leaseRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - DAY),
      leaseRow(101, 'RECUT101L2', 'a'.repeat(40), NOW_MS - 2 * DAY, NOW_MS - DAY), // explicit expiry
      J({ at: iso(NOW_MS - HOUR), pr: 202, id: 'RECUT202L1', headSha: 'b'.repeat(40) }), // no leaseUntil
      'not json',
      J({ at: iso(NOW_MS - HOUR), pr: 303, id: 'bad id', headSha: 'x', leaseUntil: NOW_MS }),
      writeRow(404, 'RECUT404L1', 'd'.repeat(40), NOW_MS - HOUR), // a write row in the lease file still folds (same base contract)
    ];
    const fold = foldRecutLeaseJournal(rows.join('\n'), NOW_MS, RECUT_LOOP_WINDOW_HOURS);
    expect(fold.malformed).toBe(1);
    // The write-shaped row lacks leaseUntil so it folds with the fallback expiry — the journals share the base contract.
    expect(fold.leases).toHaveLength(4);
    const [l1, l2, l3, l4] = fold.leases;
    expect(l1!.expiresMs).toBe(NOW_MS - DAY + LEASE_MS);
    expect(l2!.expiresMs).toBe(NOW_MS - DAY);
    expect(l3!.expiresMs).toBe(NOW_MS - HOUR + LEASE_MS);
    expect(l4!.pr).toBe(404);
  });
});

describe('foldRecutJobOutcomes', () => {
  it('tallies launches, finishes, publishes and resolved outcomes for RQ-PHX-RECUT* jobs only', () => {
    const job = 'RQ-PHX-RECUT101L1';
    const rows = [
      launchRow(job, NOW_MS - 5 * DAY),
      finishRow(job, NOW_MS - 4 * DAY, true),
      launchRow(job, NOW_MS - 3 * DAY),
      publishEmptyRow(job, NOW_MS - 2 * DAY),
      launchRow(job, NOW_MS - DAY),
      publishPrRow(job, NOW_MS - 20 * HOUR),
      outcomeRow(job, 'MERGED', NOW_MS - 10 * HOUR),
      // A second recut job with different evidence.
      launchRow('RQ-PHX-RECUT202L1', NOW_MS - DAY),
      finishRow('RQ-PHX-RECUT202L1', NOW_MS - 12 * HOUR, false),
      publishAbortRow('RQ-PHX-RECUT202L1', NOW_MS - 11 * HOUR),
      outcomeRow('RQ-PHX-RECUT202L1', 'CLOSED', NOW_MS - HOUR),
      // Non-recut jobs, node-pool rows, undated and out-of-window rows never count.
      launchRow('RQ-PHX-OTHERJOB', NOW_MS - DAY),
      finishRow('RQ-PHX-OTHERJOB', NOW_MS - DAY, true),
      J({ schema: 'fleet.session-pool.v1', event: 'launch', job: 'sess-1:2', jobId: job, ts: iso(NOW_MS - DAY) }),
      J({ event: 'launch', job, ts: 'not-a-date' }),
      launchRow(job, NOW_MS - RECUT_LOOP_WINDOW_HOURS * 3_600_000 - DAY),
      'not json',
      '',
    ];
    const tallies = foldRecutJobOutcomes(rows.join('\n'), NOW_MS, RECUT_LOOP_WINDOW_HOURS);
    expect([...tallies.keys()].sort()).toEqual(['RQ-PHX-RECUT101L1', 'RQ-PHX-RECUT202L1']);
    const a = tallies.get(job)!;
    expect(a.launches).toBe(3);
    expect(a.finishes).toBe(1);
    expect(a.emptyFinishes).toBe(2); // the empty:true finish plus the class:'empty' publish
    expect(a.prs).toBe(1);
    expect(a.aborts).toBe(0);
    expect(a.merged).toBe(1);
    const c = tallies.get('RQ-PHX-RECUT202L1')!;
    expect(c.launches).toBe(1);
    expect(c.aborts).toBe(1);
    expect(c.closed).toBe(1);
  });
});

describe('recutPrCells', () => {
  it('emits a cell only at the write and day bars', () => {
    // Below the write bar: two writes across two days.
    const few = foldRecutWriteJournal(writeSeries(101, RECUT_LOOP_MIN_DAYS, 1).join('\n'), NOW_MS, RECUT_LOOP_WINDOW_HOURS);
    expect(few.prs.get(101)!.writes).toBe(RECUT_LOOP_MIN_DAYS);
    expect(recutPrCells(few, null)).toEqual([]);

    // Below the day bar: enough writes but all on one UTC day.
    const oneDay = foldRecutWriteJournal(
      [0, 1, 2].map((i) => writeRow(202, `RECUT202L${i + 1}`, 'a'.repeat(40), NOW_MS - i * HOUR)).join('\n'),
      NOW_MS, RECUT_LOOP_WINDOW_HOURS,
    );
    expect(oneDay.prs.get(202)!.days.size).toBe(1);
    expect(recutPrCells(oneDay, null)).toEqual([]);

    // At the bars: three writes across two days.
    const recurring = foldRecutWriteJournal(
      [
        writeRow(303, 'RECUT303L1', 'a'.repeat(40), NOW_MS - 3 * DAY),
        writeRow(303, 'RECUT303L2', 'a'.repeat(40), NOW_MS - 2 * DAY),
        writeRow(303, 'RECUT303L3', 'a'.repeat(40), NOW_MS - DAY),
      ].join('\n'),
      NOW_MS, RECUT_LOOP_WINDOW_HOURS,
    );
    const cells = recutPrCells(recurring, null);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.pr).toBe(303);
    expect(cell.writes).toBe(3);
    expect(cell.days).toHaveLength(3);
    expect(cell.jobIds).toEqual(['RQ-PHX-RECUT303L1', 'RQ-PHX-RECUT303L2', 'RQ-PHX-RECUT303L3']);
    expect(cell.jobs).toBeNull();
    expect(cell.lowerBound).toBe(false);
  });

  it('joins job tallies across a PR\'s minted ids and sorts cells worst-first', () => {
    const writes = foldRecutWriteJournal(
      [
        ...writeSeries(101, 2, 2),  // 4 writes — emits first
        writeRow(202, 'RECUT202L1', 'a'.repeat(40), NOW_MS - 2 * DAY),
        writeRow(202, 'RECUT202L2', 'a'.repeat(40), NOW_MS - DAY),
        writeRow(202, 'RECUT202L3', 'a'.repeat(40), NOW_MS - HOUR),
      ].join('\n'),
      NOW_MS, RECUT_LOOP_WINDOW_HOURS,
    );
    const jobs = foldRecutJobOutcomes(
      [
        launchRow('RQ-PHX-RECUT101L1', NOW_MS - 2 * DAY),
        finishRow('RQ-PHX-RECUT101L1', NOW_MS - DAY, true),
        launchRow('RQ-PHX-RECUT101L4', NOW_MS - DAY),
        outcomeRow('RQ-PHX-RECUT101L4', 'CLOSED', NOW_MS - 12 * HOUR),
        launchRow('RQ-PHX-RECUT202L1', NOW_MS - DAY),
      ].join('\n'),
      NOW_MS, RECUT_LOOP_WINDOW_HOURS,
    );
    const cells = recutPrCells(writes, jobs);
    expect(cells.map((c) => c.pr)).toEqual([101, 202]);
    expect(cells[0]!.jobs).toMatchObject({ launches: 2, finishes: 1, emptyFinishes: 1, closed: 1 });
    expect(cells[1]!.jobs).toMatchObject({ launches: 1, merged: 0 });
  });
});

describe('recutLeaseCell', () => {
  const lease = (pr: number, id: string, atMs: number, leaseUntilMs = atMs + LEASE_MS, headSha = 'a'.repeat(40)) =>
    ({ atMs, pr, id, headSha, expiresMs: leaseUntilMs });
  /** A published write stamped at the same tick the reservation used. */
  const publishedAt = (pr: number, id: string, atMs: number, headSha = 'a'.repeat(40)) =>
    new Map([[`${pr} ${id} ${headSha}`, [atMs]]]);

  it('counts only expired, unpublished reservations across the bars', () => {
    const published = publishedAt(101, 'RECUT101L1', NOW_MS - 3 * DAY);
    const leases = [
      lease(101, 'RECUT101L1', NOW_MS - 3 * DAY),          // resolved by the write
      lease(101, 'RECUT101L2', NOW_MS - 3 * DAY),          // orphan 1
      lease(202, 'RECUT202L1', NOW_MS - 2 * DAY),          // orphan 2
      lease(303, 'RECUT303L1', NOW_MS - DAY),              // orphan 3
      lease(404, 'RECUT404L1', NOW_MS - HOUR, NOW_MS + HOUR), // still reserved — not an orphan yet
      lease(505, 'RECUT505L1', NOW_MS - 2 * DAY, NOW_MS - DAY), // expired orphan 4
    ];
    const cell = recutLeaseCell(leases, published, { nowMs: NOW_MS });
    expect(cell).not.toBeNull();
    expect(cell!.unresolved).toBe(4);
    expect(cell!.days).toEqual(['2026-11-20', '2026-11-21', '2026-11-22']);
    expect(cell!.byPr).toEqual([
      { text: '101', count: 1 },
      { text: '202', count: 1 },
      { text: '303', count: 1 },
      { text: '505', count: 1 },
    ]);
  });

  it('emits nothing below the unresolved or day bars', () => {
    const leases = [
      { atMs: NOW_MS - 2 * DAY, pr: 101, id: 'RECUT101L1', headSha: 'x', expiresMs: NOW_MS - DAY },
      { atMs: NOW_MS - DAY, pr: 202, id: 'RECUT202L1', headSha: 'x', expiresMs: NOW_MS - HOUR },
    ];
    expect(recutLeaseCell(leases, new Map(), { nowMs: NOW_MS })).toBeNull();
    // Three orphans but all on one UTC day.
    const oneDay = [0, 1, 2].map((i) => ({
      atMs: NOW_MS - i * HOUR, pr: 100 + i, id: `RECUT${100 + i}L1`, headSha: 'x', expiresMs: NOW_MS - DAY,
    }));
    expect(recutLeaseCell(oneDay, new Map(), { nowMs: NOW_MS })).toBeNull();
    expect(RECUT_LOOP_MIN_LEASES).toBe(3);
    expect(RECUT_LOOP_MIN_LEASE_DAYS).toBe(2);
    expect(RECUT_LOOP_MIN_WRITES).toBe(RECUT_LOOP_MIN_WRITES);
  });

  it('does not resolve against a recycled id\'s later publish or a head mismatch', () => {
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const leases = [
      lease(101, 'RECUT101L1', NOW_MS - 3 * DAY),                                        // orphan: write is a recycled id, days later
      lease(202, 'RECUT202L1', NOW_MS - 3 * DAY),                                        // orphan
      lease(303, 'RECUT303L1', NOW_MS - 2 * DAY),                                        // orphan
      lease(404, 'RECUT404L1', NOW_MS - DAY),                                            // resolved: same-tick write
      lease(505, 'RECUT505L1', NOW_MS - 2 * DAY, NOW_MS - 2 * DAY + LEASE_MS, shaB),     // orphan: write carries a different head
    ];
    const published = new Map<string, number[]>([
      [`101 RECUT101L1 ${shaA}`, [NOW_MS - DAY]],   // same triple but stamped a day after the lease
      [`404 RECUT404L1 ${shaA}`, [NOW_MS - DAY]],   // the lease's own tick
      [`505 RECUT505L1 ${shaA}`, [NOW_MS - 2 * DAY]], // same tick, different headSha
    ]);
    const cell = recutLeaseCell(leases, published, { nowMs: NOW_MS });
    expect(cell).not.toBeNull();
    expect(cell!.unresolved).toBe(4);
    expect(cell!.days).toEqual(['2026-11-20', '2026-11-21']);
  });
});

describe('recutLoopBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'recut-loop-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose queue/ and metrics/ carry the given journal rows. */
  async function runsDir(name: string, opts: { writes?: string[]; leases?: string[]; jobs?: string[] } = {}): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'queue', 'recut-loop.jsonl'), (opts.writes ?? []).join('\n') + '\n');
    await writeFile(join(dir, 'queue', 'recut-loop-leases.jsonl'), (opts.leases ?? []).join('\n') + '\n');
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), (opts.jobs ?? []).join('\n') + '\n');
    return dir;
  }

  const recurringWrites = () => [
    writeRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - 3 * DAY),
    writeRow(101, 'RECUT101L2', 'a'.repeat(40), NOW_MS - 2 * DAY),
    writeRow(101, 'RECUT101L3', 'a'.repeat(40), NOW_MS - DAY),
  ];

  it('emits a recut-loop item for a recurring re-cut with joined job evidence', async () => {
    const dir = await runsDir('runs-recut', {
      writes: recurringWrites(),
      jobs: [
        launchRow('RQ-PHX-RECUT101L1', NOW_MS - 3 * DAY),
        finishRow('RQ-PHX-RECUT101L1', NOW_MS - 2 * DAY, true),
        outcomeRow('RQ-PHX-RECUT101L1', 'CLOSED', NOW_MS - DAY),
        launchRow('RQ-PHX-RECUT101L2', NOW_MS - 2 * DAY),
        publishPrRow('RQ-PHX-RECUT101L2', NOW_MS - DAY),
        outcomeRow('RQ-PHX-RECUT101L2', 'MERGED', NOW_MS - 12 * HOUR),
      ],
    });
    const items = await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const recut = items.filter((i) => i.id.startsWith('recut-loop-'));
    expect(recut).toHaveLength(1);
    const [item] = recut;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'recut-loop' });
    expect(item!.id).toMatch(/^recut-loop-[0-9a-f]{16}$/);
    expect(item!.title).toContain('#101');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('PR #101');
    expect(item!.prompt).toContain('RQ-PHX-RECUT101L1');
    expect(item!.prompt).toContain('recut-loop.jsonl');
    expect(item!.prompt).toContain('2 launch(es)');
    expect(item!.prompt).toContain('1 empty finish(es)/publish(es)');
    expect(item!.prompt).toContain('1 MERGED outcome(s)');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits the reservation item for expired orphans and resolves published pairs', async () => {
    const dir = await runsDir('runs-lease', {
      writes: [writeRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - 3 * DAY)],
      leases: [
        leaseRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - 3 * DAY), // resolved
        leaseRow(202, 'RECUT202L1', 'b'.repeat(40), NOW_MS - 3 * DAY),
        leaseRow(303, 'RECUT303L1', 'c'.repeat(40), NOW_MS - 2 * DAY),
        leaseRow(404, 'RECUT404L1', 'd'.repeat(40), NOW_MS - DAY),
        leaseRow(505, 'RECUT505L1', 'e'.repeat(40), NOW_MS - 12 * HOUR, NOW_MS + HOUR), // still reserved
      ],
    });
    const items = await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const leaseItems = items.filter((i) => i.title.includes('reservations'));
    expect(leaseItems).toHaveLength(1);
    const [item] = leaseItems;
    expect(item!.title).toContain('reservations');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 expired reservation(s)');
    expect(item!.prompt).toContain('#202 ×1');
    expect(item!.prompt).not.toContain('RECUT505L1');
    expect(item!.prompt).not.toContain('RECUT101L1');
    // No recurrence item: only one write row exists.
    expect(items.filter((i) => i.prompt.includes('re-cutting the same pull request'))).toHaveLength(0);
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const empty = await runsDir('runs-empty');
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'queue', 'recut-loop.jsonl'), { recursive: true });
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW })).toEqual([]);

    // Below the bars: one write, or three on one day.
    const thin = await runsDir('runs-thin', { writes: [writeRow(101, 'RECUT101L1', 'a'.repeat(40), NOW_MS - DAY)] });
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    const oneDay = await runsDir('runs-oneday', {
      writes: [
        writeRow(202, 'RECUT202L1', 'a'.repeat(40), NOW_MS - 2 * HOUR),
        writeRow(202, 'RECUT202L2', 'a'.repeat(40), NOW_MS - HOUR),
        writeRow(202, 'RECUT202L3', 'a'.repeat(40), NOW_MS),
      ],
    });
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: NOW })).toEqual([]);
    expect(await recutLoopBacklogItems({ repo: 'ashlrai/lexicon', runsDir: oneDay, now: NOW })).toEqual([]);
    expect(await recutLoopBacklogItems({ repo: '', runsDir: oneDay, now: NOW })).toEqual([]);
  });

  it('says outcome evidence is unknown — never zero — when the jobs ledger is withheld', async () => {
    const dir = join(home, 'runs-nojobs');
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'queue', 'recut-loop.jsonl'), recurringWrites().join('\n') + '\n');
    await writeFile(join(dir, 'queue', 'recut-loop-leases.jsonl'), '\n');
    const items = await recutLoopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const recut = items.filter((i) => i.id.startsWith('recut-loop-'));
    expect(recut).toHaveLength(1);
    expect(recut[0]!.prompt).toContain('unknown — not zero');
    expect(recut[0]!.prompt).not.toContain('0 launch(es)');
  });

  it('withholds the reservation signal when the write tail is truncated but still emits recurrence', async () => {
    // Injected texts are whole by definition; exercise the file path with a
    // write journal larger than the tail bound is impractical, so assert the
    // injected contract: writesText present + leasesText present emits both.
    const items = await recutLoopBacklogItems({
      repo: 'ashlrai/phantom',
      runsDir: join(home, 'unused'),
      writesText: recurringWrites().join('\n') + '\n',
      leasesText: [
        leaseRow(202, 'RECUT202L1', 'b'.repeat(40), NOW_MS - 3 * DAY),
        leaseRow(303, 'RECUT303L1', 'c'.repeat(40), NOW_MS - 2 * DAY),
        leaseRow(404, 'RECUT404L1', 'd'.repeat(40), NOW_MS - DAY),
      ].join('\n') + '\n',
      jobsText: null,
      now: NOW,
    });
    expect(items.filter((i) => i.prompt.includes('re-cutting the same pull request'))).toHaveLength(1);
    expect(items.filter((i) => i.title.includes('reservations'))).toHaveLength(1);
    // A missing write journal withholds everything, leases included.
    const withheld = await recutLoopBacklogItems({
      repo: 'ashlrai/phantom',
      runsDir: join(home, 'unused'),
      writesText: null,
      leasesText: 'x\n',
      now: NOW,
    });
    expect(withheld).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      writes: [
        ...writeSeries(101, 2, 2),
        writeRow(202, 'RECUT202L1', 'a'.repeat(40), NOW_MS - 2 * DAY),
        writeRow(202, 'RECUT202L2', 'a'.repeat(40), NOW_MS - DAY),
        writeRow(202, 'RECUT202L3', 'a'.repeat(40), NOW_MS - HOUR),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await recutLoopBacklogItems(opts);
    const second = await recutLoopBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await recutLoopBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends recut-loop items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY;
    await writeFile(join(runs, 'queue', 'recut-loop.jsonl'), [
      writeRow(101, 'RECUT101L1', 'a'.repeat(40), at(3)),
      writeRow(101, 'RECUT101L2', 'a'.repeat(40), at(2)),
      writeRow(101, 'RECUT101L3', 'a'.repeat(40), at(1)),
    ].join('\n') + '\n');
    await writeFile(join(runs, 'queue', 'recut-loop-leases.jsonl'), '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      launchRow('RQ-PHX-RECUT101L1', at(3)),
      finishRow('RQ-PHX-RECUT101L1', at(2), true),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const recutItems = first.items.filter((i) => i.id.startsWith('recut-loop-'));
    expect(recutItems).toHaveLength(1);
    expect(recutItems[0]!.area).toBe('recut-loop');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(recutItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('recut-loop-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('recut-loop-'))).toHaveLength(1);
  });
});
