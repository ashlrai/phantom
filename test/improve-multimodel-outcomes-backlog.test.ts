import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldMultimodelOutcomes,
  MULTIMODEL_OUTCOMES_MIN_DAYS,
  MULTIMODEL_OUTCOMES_MIN_OVERRIDES,
  MULTIMODEL_OUTCOMES_WINDOW_HOURS,
  multimodelOutcomeCells,
  multimodelOutcomesBacklogItems,
} from '../src/core/improve/multimodel-outcomes-backlog.js';
import { LEARNING_MIN_SIGNALS } from '../src/core/verse/multimodel/learning.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are canonical ISO-8601 UTC like the journal writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One SeatOutcome row in the store's journaled shape. */
function outcomeRow(spec: {
  seatId?: string;
  engine?: string;
  kind?: string;
  signal?: string;
  atMs?: number;
  sessionId?: string;
  model?: string;
  extra?: Record<string, unknown>;
  omit?: string[];
}): string {
  const row: Record<string, unknown> = {
    at: iso(spec.atMs ?? NOW_MS),
    seatId: spec.seatId ?? 'seat-a',
    engine: spec.engine ?? 'claude',
    kind: spec.kind ?? 'debug',
    signal: spec.signal ?? 'down',
    ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...spec.extra,
  };
  for (const key of spec.omit ?? []) delete row[key];
  return J(row);
}

/** `count` adverse rows for one (kind, seat, engine) spread across `days` UTC days. */
function adverseSeries(opts: { seatId?: string; engine?: string; kind?: string; signal?: string; count: number; days: number }): string[] {
  const rows: string[] = [];
  if (opts.days <= 1) {
    // Single-day series: hourly spacing keeps every row inside one UTC day.
    for (let i = 0; i < opts.count; i++) {
      rows.push(outcomeRow({ seatId: opts.seatId, engine: opts.engine, kind: opts.kind, signal: opts.signal ?? 'down', atMs: NOW_MS - (i + 1) * HOUR }));
    }
    return rows;
  }
  const span = opts.days * DAY;
  for (let i = 0; i < opts.count; i++) {
    const atMs = NOW_MS - Math.floor((i * span) / Math.max(1, opts.count - 1)) - HOUR;
    rows.push(outcomeRow({ seatId: opts.seatId, engine: opts.engine, kind: opts.kind, signal: opts.signal ?? 'down', atMs }));
  }
  return rows;
}

/** The production fold: one journal text (the single append-only file). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldMultimodelOutcomes([rows.join('\n')], nowMs, MULTIMODEL_OUTCOMES_WINDOW_HOURS);
}

describe('foldMultimodelOutcomes', () => {
  it('counts contract rows and skips malformed or foreign lines', () => {
    const rows = [
      outcomeRow({ seatId: 'seat-a', atMs: NOW_MS - HOUR, sessionId: 'sess-1', model: 'claude-opus-4' }),
      outcomeRow({ seatId: 'seat-b', engine: 'codex', kind: 'review', signal: 'up', atMs: NOW_MS - 2 * HOUR }),
      // Outside the window — too old and too far in the future.
      outcomeRow({ seatId: 'seat-c', atMs: NOW_MS - MULTIMODEL_OUTCOMES_WINDOW_HOURS * 3_600_000 - DAY }),
      outcomeRow({ seatId: 'seat-c', atMs: NOW_MS + 600_000 }),
      // Malformed: unparsable, non-object, and contract violations.
      'not json at all',
      '[1,2,3]',
      'null',
      J({ seatId: 'seat-a' }),                                                                    // missing keys
      outcomeRow({ seatId: '', atMs: NOW_MS - 3 * HOUR }),                                        // empty seatId
      outcomeRow({ seatId: 'seat\nb', atMs: NOW_MS - 4 * HOUR }),                                // control byte in seatId
      outcomeRow({ seatId: 'x'.repeat(257), atMs: NOW_MS - 5 * HOUR }),                          // seatId over writer bound
      outcomeRow({ engine: '  ', atMs: NOW_MS - 6 * HOUR }),                                      // blank engine
      outcomeRow({ kind: 'bogus-kind', atMs: NOW_MS - 7 * HOUR }),                                // kind outside vocabulary
      outcomeRow({ signal: 'bogus-signal', atMs: NOW_MS - 8 * HOUR }),                            // signal outside vocabulary
      outcomeRow({ atMs: NOW_MS - 9 * HOUR, omit: ['at'] }),                                      // missing timestamp
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(2);
    expect(fold.malformed).toBe(11);
    expect(fold.outsideWindow).toBe(2);
    // sessionId/model are contract fields that pass validation but never fold.
    expect(fold.learned['debug|seat:seat-a']).toBeDefined();
    expect(JSON.stringify(fold)).not.toContain('sess-1');
    expect(JSON.stringify(fold)).not.toContain('claude-opus-4');
  });

  it('runs the same aggregateOutcomes math the advisor reads', () => {
    const rows = [
      ...adverseSeries({ seatId: 'seat-a', engine: 'claude', kind: 'debug', count: 4, days: 2 }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: NOW_MS - 25 * HOUR }),
    ];
    const fold = foldRows(rows);
    const seatStat = fold.learned['debug|seat:seat-a']!;
    const engineStat = fold.learned['debug|engine:claude']!;
    expect(seatStat.n).toBeGreaterThanOrEqual(LEARNING_MIN_SIGNALS);
    expect(seatStat.score).toBeLessThan(0);
    expect(seatStat.down).toBe(4);
    // The engine stat pools every claude debug row: seat-a's four downs plus seat-b's two ups.
    expect(engineStat.down).toBe(4);
    expect(engineStat.up).toBe(2);
    expect(engineStat.score).toBeGreaterThan(seatStat.score);
    expect(fold.seatMeta.get('debug seat-a')!.rows).toBe(4);
    expect(fold.engineMeta.get('debug claude')!.seatIds).toEqual(new Set(['seat-a', 'seat-b']));
  });
});

describe('multimodelOutcomeCells', () => {
  it('emits nothing below the recurring bars or for positive evidence', () => {
    // Adverse rows on a single day: the day bar fails.
    const oneDay = foldRows(adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 5, days: 1 }));
    expect(multimodelOutcomeCells(oneDay)).toEqual([]);

    // Two adverse rows across two days: the decayed-signal bar fails.
    const thin = foldRows([
      outcomeRow({ seatId: 'seat-a', kind: 'debug', signal: 'down', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-a', kind: 'debug', signal: 'down', atMs: NOW_MS - 25 * HOUR }),
    ]);
    expect(multimodelOutcomeCells(thin)).toEqual([]);

    // Many positive outcomes: the adverse-tilt gate fails.
    const positive = foldRows([
      ...adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 3, days: 2 }).map((line) => line.replace('"signal":"down"', '"signal":"up"')),
      ...adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 3, days: 2 }).map((line) => line.replace('"signal":"down"', '"signal":"compare-won"')),
    ]);
    expect(multimodelOutcomeCells(positive)).toEqual([]);

    // Advisor cells below their bars: too few overrides, one day, or a followed majority.
    const fewOverrides = foldRows([
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
    ]);
    expect(multimodelOutcomeCells(fewOverrides)).toEqual([]);

    const followedMajority = foldRows([
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 49 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-followed', atMs: NOW_MS - 2 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-followed', atMs: NOW_MS - 26 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-followed', atMs: NOW_MS - 50 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-followed', atMs: NOW_MS - 74 * HOUR }),
      // Plain thumbs-up keep the learned stat positive so only the advisor
      // axis is under test here.
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'up', atMs: NOW_MS - 3 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'up', atMs: NOW_MS - 27 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'up', atMs: NOW_MS - 51 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'up', atMs: NOW_MS - 75 * HOUR }),
    ]);
    expect(multimodelOutcomeCells(followedMajority)).toEqual([]);
  });

  it('emits seat, engine and advisor cells at the bars, advisor first', () => {
    const rows = [
      // Advisor cell: 3 overrides on (review, seat-x), no follows — below the
      // preference bars on purpose (decayed n stays under LEARNING_MIN_SIGNALS).
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 49 * HOUR }),
      // Seat cell without an engine cell: seat-a's four debug downs vs seat-b's
      // six debug ups keep the claude engine stat positive.
      ...adverseSeries({ seatId: 'seat-a', engine: 'claude', kind: 'debug', count: 4, days: 2 }),
      ...adverseSeries({ seatId: 'seat-b', engine: 'claude', kind: 'debug', count: 6, days: 2 }).map((line) => line.replace('"signal":"down"', '"signal":"up"')),
      // Engine cell without seat cells: two codex seats split the review losses.
      outcomeRow({ seatId: 'seat-c', engine: 'codex', kind: 'plan', signal: 'down', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-c', engine: 'codex', kind: 'plan', signal: 'compare-lost', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-d', engine: 'codex', kind: 'plan', signal: 'switch-away', atMs: NOW_MS - 2 * HOUR }),
      outcomeRow({ seatId: 'seat-d', engine: 'codex', kind: 'plan', signal: 'escalated', atMs: NOW_MS - 26 * HOUR }),
    ];
    const fold = foldRows(rows);
    const cells = multimodelOutcomeCells(fold);
    expect(cells.map((c) => `${c.axis}|${c.promptKind}|${c.subject}`)).toEqual([
      'advisor|review|seat-x',
      'seat|debug|seat-a',
      'engine|plan|codex',
    ]);
    const [advisor, seat, engine] = cells;
    expect(advisor).toMatchObject({ axis: 'advisor', promptKind: 'review', subject: 'seat-x', rows: MULTIMODEL_OUTCOMES_MIN_OVERRIDES, followed: 0 });
    expect(advisor!.days.length).toBeGreaterThanOrEqual(MULTIMODEL_OUTCOMES_MIN_DAYS);
    expect(seat).toMatchObject({ axis: 'seat', promptKind: 'debug', subject: 'seat-a', rows: 4 });
    expect(seat!.down).toBe(4);
    expect(seat!.up).toBe(0);
    expect(seat!.tilt).toBeGreaterThan(0);
    expect(engine).toMatchObject({ axis: 'engine', promptKind: 'plan', subject: 'codex', rows: 4 });
    expect(engine!.seats.sort()).toEqual(['seat-c', 'seat-d']);
    expect(engine!.down).toBe(4);
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldMultimodelOutcomes(
      [adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 4, days: 2 }).join('\n')],
      NOW_MS,
      MULTIMODEL_OUTCOMES_WINDOW_HOURS,
    );
    const cells = multimodelOutcomeCells(fold, true);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.lowerBound)).toBe(true);
    expect(multimodelOutcomeCells(fold, false).every((c) => !c.lowerBound)).toBe(true);
  });
});

describe('multimodelOutcomesBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'multimodel-outcomes-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'verse', 'multimodel');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR, sessionId: 'sess-9' }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 49 * HOUR }),
      ...adverseSeries({ seatId: 'seat-a', engine: 'claude', kind: 'debug', count: 4, days: 2 }),
      ...adverseSeries({ seatId: 'seat-b', engine: 'claude', kind: 'debug', count: 6, days: 2 }).map((line) => line.replace('"signal":"down"', '"signal":"up"')),
      'a torn append {"at":',
    ];
    const path = await journal('outcomes', rows);
    const items = await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.map((i) => i.area)).toEqual([
      'multimodel-advisor-override',
      'multimodel-seat-preference',
    ]);
    for (const item of items) {
      expect(item.id).toMatch(/^multimodel-outcomes-[0-9a-f]{16}$/);
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('outcomes.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('sess-9');
    }
    const [advisor, seat] = items;
    expect(advisor).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
    expect(advisor!.title).toContain('overridden');
    expect(advisor!.prompt).toContain('auto-overridden');
    expect(seat).toMatchObject({ priority: 3 });
    expect(seat!.title).toContain('seat-a');
    expect(seat!.prompt).toContain('passed over');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'outcomes.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'verse', 'multimodel', 'outcomes.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's outcome journal.
    const good = [
      ...adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 4, days: 3 }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 49 * HOUR }),
    ];
    const goodPath = await journal('outcomes-good', good);
    expect(await multimodelOutcomesBacklogItems({ repo: 'ashlrai/lexicon', journalPath: goodPath, now: NOW })).toEqual([]);
    expect(await multimodelOutcomesBacklogItems({ repo: '', journalPath: goodPath, now: NOW })).toEqual([]);
    expect(await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: goodPath, now: NOW })).not.toEqual([]);

    // Rows below the recurring bars emit nothing — and clean rows emit nothing at all.
    const sparse = [
      outcomeRow({ seatId: 'seat-a', kind: 'debug', signal: 'down', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-a', kind: 'debug', signal: 'down', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-b', engine: 'codex', kind: 'plan', signal: 'up', atMs: NOW_MS - 2 * HOUR }),
    ];
    const sparsePath = await journal('outcomes-sparse', sparse);
    expect(await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: sparsePath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 4, days: 3 });
    // Pad past the 1 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(1100 * 1024);
    const path = await journal('outcomes-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await multimodelOutcomesBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...adverseSeries({ seatId: 'seat-a', kind: 'debug', count: 4, days: 3 }),
      ...adverseSeries({ seatId: 'seat-c', engine: 'codex', kind: 'plan', count: 4, days: 3 }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 25 * HOUR }),
      outcomeRow({ seatId: 'seat-x', kind: 'review', signal: 'auto-overridden', atMs: NOW_MS - 49 * HOUR }),
    ];
    const path = await journal('outcomes-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await multimodelOutcomesBacklogItems(opts);
    const second = await multimodelOutcomesBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(3);
    const limited = await multimodelOutcomesBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends multimodel-outcomes items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's default path is ~/.ashlr/verse/multimodel under the
    // relocated HOME.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'verse', 'multimodel');
    await mkdir(dir, { recursive: true });
    const liveRows = [
      // Advisor cell: 3 overrides across 3 days.
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: at(0) }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: at(1) }),
      outcomeRow({ seatId: 'seat-x', engine: 'grok', kind: 'review', signal: 'auto-overridden', atMs: at(2) }),
      // Seat cell: 4 downs across 3 days, offset from seat-b's ups on the
      // same engine+kind so the engine stat stays positive.
      outcomeRow({ seatId: 'seat-a', engine: 'claude', kind: 'debug', signal: 'down', atMs: at(0, 1) }),
      outcomeRow({ seatId: 'seat-a', engine: 'claude', kind: 'debug', signal: 'down', atMs: at(1, 1) }),
      outcomeRow({ seatId: 'seat-a', engine: 'claude', kind: 'debug', signal: 'retry', atMs: at(2, 1) }),
      outcomeRow({ seatId: 'seat-a', engine: 'claude', kind: 'debug', signal: 'switch-away', atMs: at(0, 2) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(0, 3) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(1, 3) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(2, 3) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(3, 3) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(4, 3) }),
      outcomeRow({ seatId: 'seat-b', engine: 'claude', kind: 'debug', signal: 'up', atMs: at(5, 3) }),
      // Sparse evidence that stays below the bars.
      outcomeRow({ seatId: 'seat-c', engine: 'codex', kind: 'plan', signal: 'down', atMs: at(0, 4) }),
      outcomeRow({ seatId: 'seat-c', engine: 'codex', kind: 'plan', signal: 'down', atMs: at(1, 4) }),
    ];
    await writeFile(join(dir, 'outcomes.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('multimodel-outcomes-'));
    expect(journalItems.map((i) => i.area)).toEqual(['multimodel-advisor-override', 'multimodel-seat-preference']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('multimodel-outcomes-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('multimodel-outcomes-'))).toHaveLength(2);
  });
});
