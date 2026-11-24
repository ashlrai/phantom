import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldQueueVisitJournal,
  QUEUE_VISIT_BACKLOG_MAX_ITEMS,
  QUEUE_VISIT_MIN_ADVERSE_DAYS,
  QUEUE_VISIT_MIN_ARRIVALS,
  QUEUE_VISIT_MIN_DAYS,
  QUEUE_VISIT_MIN_STUCK,
  QUEUE_VISIT_STUCK_AGE_MS,
  QUEUE_VISIT_WINDOW_MS,
  queueVisitBacklogItems,
  queueVisitCells,
  queueVisitWindowDays,
} from '../src/core/improve/queue-visit-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { QueueVisit } from '../src/core/queue/stats.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** A visit snapshot the way visit-sync's makeVisit writes it. */
const visit = (id: string, station: string, pool: string, arrivedAt: number, startedAt?: number, completedAt?: number): string =>
  J({ id, station, pool, arrivedAt, ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }) });

const NOW = Date.parse('2026-11-24T15:00:00.000Z');
const WINDOW = QUEUE_VISIT_WINDOW_MS;

/** UTC midnight `daysAgo` days before NOW's date. */
const dayStart = (daysAgo: number): number => {
  const d = new Date(NOW);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysAgo);
};

describe('foldQueueVisitJournal', () => {
  it('keeps the latest snapshot per (station, pool, id) and skips malformed lines', () => {
    const text = [
      visit('RQ-A1:a1', 'READY', 'claude', 1000),
      visit('RQ-A1:a1', 'READY', 'claude', 1000, 2000), // progressed snapshot wins
      visit('RQ-A1:a1', 'claimed', 'claude', 1000, 2000, 3000), // station differs: a different key
      'not json',
      J({ id: 'x' }), // fails isQueueVisit
      '',
    ].join('\n');
    const fold = foldQueueVisitJournal(text);
    expect(fold.rows).toBe(3);
    expect(fold.invalidRows).toBe(2);
    expect(fold.visits).toHaveLength(2);
    const ready = fold.visits.find((v) => v.station === 'READY')!;
    expect(ready.startedAt).toBe(2000);
    expect(ready.completedAt).toBeUndefined();
  });

  it('folds an empty or missing tail to no visits', () => {
    expect(foldQueueVisitJournal('').visits).toEqual([]);
    expect(foldQueueVisitJournal('\n\n').invalidRows).toBe(0);
  });
});

describe('queueVisitWindowDays', () => {
  it('partitions the window into UTC dates, first clipped and last partial', () => {
    const days = queueVisitWindowDays(NOW, WINDOW);
    expect(days.length).toBeGreaterThanOrEqual(7);
    expect(days[0]!.since).toBe(NOW - WINDOW);
    expect(days.at(-1)!.until).toBe(NOW);
    // Contiguous: each day's until is the next day's since.
    for (let i = 1; i < days.length; i++) expect(days[i]!.since).toBe(days[i - 1]!.until);
    expect(new Set(days.map((d) => d.date)).size).toBe(days.length);
  });
});

describe('queueVisitCells', () => {
  const foldOf = (visits: QueueVisit[]) => ({ visits, rows: visits.length, invalidRows: 0 });

  /** claimed visits heavy enough to rate rho >= 0.9 on the given UTC days:
   * arrivals early in the day, 8h service each, all boundaries inside one UTC date. */
  const saturatedDay = (daysAgo: number): QueueVisit[] => {
    const start = dayStart(daysAgo) + HOUR;
    const out: QueueVisit[] = [];
    for (let i = 0; i < 4; i++) {
      const arrivedAt = start + i * 30 * MIN;
      out.push({ id: `RQ-S${daysAgo}-${i}:a1`, station: 'claimed', pool: 'claude', arrivedAt, startedAt: arrivedAt, completedAt: arrivedAt + 8 * HOUR });
    }
    return out;
  };

  it('emits a saturated cell only at the recurring bars', () => {
    // One adverse day only.
    expect(queueVisitCells(foldOf(saturatedDay(1)), NOW, WINDOW)).toEqual([]);
    // Two red days but under the arrivals bar: one slow visit per day,
    // 22h service each — rho ~0.92 but only two in-window arrivals total.
    const thin: QueueVisit[] = [];
    for (const d of [1, 2]) {
      const arrivedAt = dayStart(d) + 30 * MIN;
      thin.push({ id: `RQ-T${d}:a1`, station: 'claimed', pool: 'thin', arrivedAt, startedAt: arrivedAt, completedAt: arrivedAt + 22 * HOUR });
    }
    expect(QUEUE_VISIT_MIN_ADVERSE_DAYS).toBe(2);
    expect(QUEUE_VISIT_MIN_ARRIVALS).toBe(3);
    expect(queueVisitCells(foldOf(thin), NOW, WINDOW)).toEqual([]);
  });

  it('emits one saturated cell per (scope, name) at the bars with day tallies', () => {
    const visits = [...saturatedDay(1), ...saturatedDay(3), ...saturatedDay(5)];
    const cells = queueVisitCells(foldOf(visits), NOW, WINDOW);
    const saturated = cells.filter((c) => c.kind === 'saturated');
    // station 'claimed' and pool 'claude' both saturate.
    const station = saturated.find((c) => c.scope === 'station' && c.name === 'claimed');
    const pool = saturated.find((c) => c.scope === 'pool' && c.name === 'claude');
    expect(station).toBeDefined();
    expect(pool).toBeDefined();
    expect(station!.days.length).toBeGreaterThanOrEqual(QUEUE_VISIT_MIN_ADVERSE_DAYS);
    expect(station!.arrivals).toBe(12);
    expect(station!.maxRho).toBeGreaterThanOrEqual(0.9);
    expect(station!.latest.date).toBeTruthy();
    expect(station!.lowerBound).toBe(false);
  });

  it('does not saturate stations whose service is structurally instantaneous', () => {
    // READY visits: startedAt === completedAt === launch stamp — zero service,
    // mu stays null, rho never measures — the wait is queue dwell, not saturation.
    const visits: QueueVisit[] = [];
    for (const d of [1, 2, 3]) {
      const arrivedAt = dayStart(d) + 8 * HOUR;
      visits.push({ id: `RQ-R${d}:a1`, station: 'READY', pool: 'claude', arrivedAt, startedAt: arrivedAt, completedAt: arrivedAt });
    }
    const cells = queueVisitCells(foldOf(visits), NOW, WINDOW);
    expect(cells.filter((c) => c.kind === 'saturated' && c.scope === 'station' && c.name === 'READY')).toEqual([]);
  });

  it('emits a stuck cell only at the recurring bars', () => {
    const open = (id: string, station: string, pool: string, ageMs: number): QueueVisit => ({
      id, station, pool, arrivedAt: NOW - ageMs,
    });
    // One parked visit never emits.
    expect(queueVisitCells(foldOf([open('RQ-P1:a1', 'publish', 'claude', 3 * DAY)]), NOW, WINDOW)).toEqual([]);
    // Two parked visits but both arrived today (under the age bar): impossible —
    // age bar is 24h so use two visits on the same old day: days union is still >= 2
    // because each visit was open across multiple window days.
    const two = [open('RQ-P1:a1', 'publish', 'claude', 3 * DAY), open('RQ-P2:a1', 'publish', 'claude', 2 * DAY)];
    const cells = queueVisitCells(foldOf(two), NOW, WINDOW);
    const stuck = cells.filter((c) => c.kind === 'stuck');
    expect(stuck.length).toBeGreaterThan(0);
    const stationCell = stuck.find((c) => c.scope === 'station' && c.name === 'publish')!;
    expect(stationCell.visits).toBe(2);
    expect(stationCell.days.length).toBeGreaterThanOrEqual(QUEUE_VISIT_MIN_DAYS);
    expect(QUEUE_VISIT_MIN_STUCK).toBe(2);
    expect(QUEUE_VISIT_STUCK_AGE_MS).toBe(DAY);
  });

  it('a visit completed inside the window is never stuck, and young opens are not parked', () => {
    const visits: QueueVisit[] = [
      { id: 'RQ-D1:a1', station: 'publish', pool: 'claude', arrivedAt: NOW - 3 * DAY, startedAt: NOW - 3 * DAY + HOUR, completedAt: NOW - 2 * DAY },
      { id: 'RQ-D2:a1', station: 'publish', pool: 'claude', arrivedAt: NOW - 2 * HOUR }, // open but young
    ];
    expect(queueVisitCells(foldOf(visits), NOW, WINDOW).filter((c) => c.kind === 'stuck')).toEqual([]);
  });

  it('keeps only fleet-shaped job ids as examples while counts stay honest', () => {
    const visits: QueueVisit[] = [
      { id: 'bad id!:a1', station: 'pr-ci', pool: 'codex', arrivedAt: NOW - 3 * DAY },
      { id: 'RQ-CI-1:a2', station: 'pr-ci', pool: 'codex', arrivedAt: NOW - 2 * DAY },
      { id: 'also bad:a1', station: 'pr-ci', pool: 'codex', arrivedAt: NOW - DAY - HOUR },
    ];
    const cells = queueVisitCells(foldOf(visits), NOW, WINDOW);
    const stuck = cells.find((c) => c.kind === 'stuck' && c.scope === 'station' && c.name === 'pr-ci')!;
    expect(stuck.visits).toBe(3);
    expect(stuck.examples.map((e) => e.job)).toEqual(['RQ-CI-1']);
  });

  it('marks cells lower-bound when the tail truncated', () => {
    const visits = [...saturatedDay(1), ...saturatedDay(3)];
    const cells = queueVisitCells(foldOf(visits), NOW, WINDOW, true);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.lowerBound)).toBe(true);
  });
});

describe('queueVisitBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'queue-visit-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under a scratch Ashlr home. */
  async function journal(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name, 'queue');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'visits.jsonl');
    if (lines !== undefined) await writeFile(path, lines.join('\n') + '\n');
    return path;
  }

  const saturatedRows = (tag: string, daysAgo: number[]): string[] =>
    daysAgo.flatMap((d) => {
      const start = dayStart(d) + HOUR;
      return [0, 1, 2, 3].map((i) => {
        const arrivedAt = start + i * 30 * MIN;
        return visit(`${tag}-${d}-${i}:a1`, 'claimed', 'claude', arrivedAt, arrivedAt, arrivedAt + 8 * HOUR);
      });
    });

  it('emits validated items for recurring saturation and parked visits', async () => {
    const path = await journal('hit', [
      ...saturatedRows('RQ-S', [1, 3, 5]),
      visit('RQ-P1:a1', 'publish', 'claude', NOW - 3 * DAY),
      visit('RQ-P2:a1', 'publish', 'claude', NOW - 2 * DAY),
    ]);
    const items = await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const item of items) {
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('visits.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    const saturated = items.find((i) => i.area === 'queue-saturated' && i.title.includes('claimed'))!;
    expect(saturated).toBeDefined();
    expect(saturated.id).toMatch(/^queue-visit-[0-9a-f]{16}$/);
    const stuck = items.find((i) => i.area === 'queue-stuck' && i.title.includes('publish'))!;
    expect(stuck).toBeDefined();
    expect(stuck.prompt).toContain('RQ-P1');
  });

  it('emits nothing for missing journals, empty evidence, another repository, or sub-bar evidence', async () => {
    expect(await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'no-such', 'visits.jsonl'), now: NOW })).toEqual([]);
    expect(await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: await journal('empty'), now: NOW })).toEqual([]);

    // One saturated day only — below the adverse-days bar.
    const thin = await journal('thin', saturatedRows('RQ-T', [1]));
    expect(await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: thin, now: NOW })).toEqual([]);

    const dir = await journal('repo', [...saturatedRows('RQ-R', [1, 3])]);
    expect(await queueVisitBacklogItems({ repo: 'ashlrai/other', journalPath: dir, now: NOW })).toEqual([]);
    expect(await queueVisitBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: dir, now: NOW })).not.toEqual([]);
  });

  it('a malformed journal still folds the valid rows', async () => {
    const path = await journal('mixed', [...saturatedRows('RQ-M', [1, 3]), 'garbage line']);
    const items = await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.some((i) => i.area === 'queue-saturated')).toBe(true);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('trunc', [
      ...saturatedRows('RQ-X', [1, 3]),
      visit('RQ-P1:a1', 'publish', 'claude', NOW - 3 * DAY),
      visit('RQ-P2:a1', 'publish', 'claude', NOW - 2 * DAY),
    ]);
    const pad = 'x'.repeat(8 * 1024 * 1024 + 1024);
    await writeFile(path, pad + '\n' + [
      ...saturatedRows('RQ-X', [1, 3]),
      visit('RQ-P1:a1', 'publish', 'claude', NOW - 3 * DAY),
      visit('RQ-P2:a1', 'publish', 'claude', NOW - 2 * DAY),
    ].join('\n') + '\n');
    const items = await queueVisitBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const path = await journal('stable', [
      ...saturatedRows('RQ-Y', [1, 3, 5]),
      visit('RQ-P1:a1', 'publish', 'claude', NOW - 3 * DAY),
      visit('RQ-P2:a1', 'publish', 'claude', NOW - 2 * DAY),
    ]);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await queueVisitBacklogItems(opts);
    const second = await queueVisitBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(QUEUE_VISIT_BACKLOG_MAX_ITEMS);
  });

  it('appends queue-visit items through discovery and dedupes on refresh', async () => {
    const ashlr = join(home, '.ashlr');
    await mkdir(join(ashlr, 'queue'), { recursive: true });
    process.env.ASHLR_HOME = ashlr;
    await writeFile(join(ashlr, 'queue', 'visits.jsonl'), [
      ...saturatedRows('RQ-D', [1, 3]),
      visit('RQ-P1:a1', 'publish', 'claude', NOW - 3 * DAY),
      visit('RQ-P2:a1', 'publish', 'claude', NOW - 2 * DAY),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const visitItems = first.items.filter((i) => i.id.startsWith('queue-visit-'));
    expect(visitItems.length).toBeGreaterThanOrEqual(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(visitItems)).toBe(visitItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('queue-visit-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('queue-visit-'))).toHaveLength(visitItems.length);
  });
});
