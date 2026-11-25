import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldSeatDecisionJournal,
  SEAT_DECISION_MIN_DAYS,
  SEAT_DECISION_MIN_ROWS,
  SEAT_DECISION_WINDOW_HOURS,
  seatDecisionBacklogItems,
  seatDecisionCells,
} from '../src/core/improve/seat-decision-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One SeatExclusion in the journaled shape: reasons plus the structured details twin. */
function exclusion(seatId: string, kinds: string[], nextEligibleAt: string | null = null): Record<string, unknown> {
  return {
    seatId,
    reasons: kinds.map((k) => `${k} reason.`),
    nextEligibleAt,
    details: kinds.map((k) => ({ kind: k, text: `${k} reason.` })),
  };
}

/** A SeatDecision in the scrubDecision-journaled shape. */
function seatDecision(spec: {
  seatId?: string | null;
  candidates?: string[];
  exclusions?: Record<string, unknown>[];
} = {}): Record<string, unknown> {
  return {
    seatId: spec.seatId === undefined ? null : spec.seatId,
    candidates: spec.candidates ?? [],
    exclusions: spec.exclusions ?? [],
    why: 'No seat the grant lets produce can take this work right now.',
    summary: 'No seat can take this work right now.',
    mode: 'balanced',
  };
}

/** One ShadowDecisionRecord in the writer's shape; every field the fold reads is explicit. */
function decisionRow(spec: {
  atMs?: number;
  source?: string;
  task?: string;
  difficulty?: string;
  autonomous?: boolean;
  decision?: Record<string, unknown>;
  actual?: { engine: string; seatId: string | null } | null;
}): string {
  return J({
    v: 1,
    at: iso(spec.atMs ?? NOW_MS),
    source: spec.source ?? 'gateway',
    request: {
      task: spec.task ?? 'code',
      difficulty: spec.difficulty ?? 'medium',
      autonomous: spec.autonomous ?? true,
    },
    decision: spec.decision ?? seatDecision(),
    actual: spec.actual === undefined ? null : spec.actual,
  });
}

/** A beside-dispatch shadow comparison row: the legacy engine ran while the seat view decided. */
function comparisonRow(spec: {
  atMs?: number;
  engine?: string;
  decision?: Record<string, unknown>;
  autonomous?: boolean;
} = {}): string {
  return decisionRow({
    atMs: spec.atMs,
    source: 'daemon',
    autonomous: spec.autonomous,
    decision: spec.decision,
    actual: { engine: spec.engine ?? 'claude', seatId: null },
  });
}

/** A non-dispatch surface row (gateway API completion or leader seat choice). */
function surfaceRow(spec: {
  atMs?: number;
  source?: string;
  seatId?: string | null;
  exclusions?: Record<string, unknown>[];
  autonomous?: boolean;
} = {}): string {
  return decisionRow({
    atMs: spec.atMs,
    source: spec.source ?? 'gateway',
    autonomous: spec.autonomous,
    decision: seatDecision({
      seatId: spec.seatId === undefined ? null : spec.seatId,
      candidates: spec.seatId ? [spec.seatId] : [],
      exclusions: spec.exclusions ?? [],
    }),
    actual: null,
  });
}

/** Recurring blind comparison rows: `count` evaluations across `days` UTC days. */
function blindSeries(days: number, perDay: number, opts: { engine?: string; autonomous?: boolean; noSeats?: boolean } = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const noSeats = opts.noSeats ?? false;
      rows.push(comparisonRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        engine: opts.engine ?? 'claude',
        autonomous: opts.autonomous,
        decision: seatDecision({
          seatId: null,
          candidates: [],
          exclusions: noSeats ? [] : [exclusion('seat-a', ['unknown-usage']), exclusion('seat-b', ['headroom'])],
        }),
      }));
    }
  }
  return rows;
}

/** Recurring no-seat surface rows on one source. */
function noSeatSeries(source: string, days: number, perDay: number, opts: { kinds?: string[] } = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(surfaceRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source,
        seatId: null,
        autonomous: true,
        exclusions: (opts.kinds ?? ['unreachable']).map((k) => exclusion('seat-x', [k])),
      }));
    }
  }
  return rows;
}

/** Recurring surface rows excluding one seat for one adverse kind. */
function excludedSeries(source: string, seatId: string, kind: string, days: number, perDay: number, opts: { chosen?: string } = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(surfaceRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source,
        seatId: opts.chosen ?? 'seat-y',
        exclusions: [exclusion(seatId, [kind]), exclusion('seat-z', ['headroom'])],
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (current tail; predecessor folds identically). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldSeatDecisionJournal([rows.join('\n')], nowMs, SEAT_DECISION_WINDOW_HOURS);
}

describe('foldSeatDecisionJournal', () => {
  it('counts comparison and surface rows, skips dispatch-path and test rows, counts invalid lines', () => {
    const rows = [
      comparisonRow({ atMs: NOW_MS - HOUR }),
      surfaceRow({ atMs: NOW_MS - 2 * HOUR, source: 'leader' }),
      // Dispatch-path evidence: daemon rows that are not comparisons, and any
      // row whose `actual` names a seat, stay with runtime-journal-backlog.
      decisionRow({ atMs: NOW_MS - 3 * HOUR, source: 'daemon', actual: null }),
      decisionRow({ atMs: NOW_MS - 4 * HOUR, source: 'gateway', actual: { engine: 'claude', seatId: 'seat-r' } }),
      decisionRow({ atMs: NOW_MS - 5 * HOUR, source: 'test', actual: null }),
      decisionRow({ atMs: NOW_MS - 6 * HOUR, source: 'test', actual: { engine: 'claude', seatId: null } }),
      // Outside the window — too old and too far in the future (inside skew).
      comparisonRow({ atMs: NOW_MS - SEAT_DECISION_WINDOW_HOURS * 3_600_000 - DAY }),
      comparisonRow({ atMs: NOW_MS + 600_000 }),
      // Writer-contract failures.
      J({ v: 1, at: iso(NOW_MS - HOUR) }),                                                        // no source/request/decision
      J({ v: 2, at: iso(NOW_MS - HOUR), source: 'gateway', request: {}, decision: {} }),          // wrong v
      J({ v: 1, at: 'not-a-date', source: 'gateway', request: {}, decision: {} }),                // bad at
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'bogus', request: {}, decision: {} }),            // bad source
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code' }, decision: {} }), // thin request
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: true }, decision: { seatId: null } }), // thin decision
      'not json at all',
      '{"decision":',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(2);
    expect(fold.comparisons).toBe(1);
    expect(fold.surfaces.get('leader')!.rows).toBe(1);
    // Four skipped-class rows (daemon null-actual, gateway dispatched, two test) + eight malformed.
    expect(fold.skippedRows).toBe(4);
    expect(fold.invalidRows).toBe(8);
  });

  it('folds blind comparison rows with engine tallies, the no-seats split and autonomous share', () => {
    const rows = [
      // Blind: seat view found nothing while claude ran anyway.
      ...blindSeries(2, 2, { engine: 'claude' }),
      // Sighted comparisons: the view chose a seat — context, not blind.
      comparisonRow({ atMs: NOW_MS - HOUR, engine: 'devin', decision: seatDecision({ seatId: 'seat-a', candidates: ['seat-a'] }) }),
      comparisonRow({ atMs: NOW_MS - 2 * HOUR, engine: 'devin', decision: seatDecision({ seatId: 'seat-a', candidates: ['seat-a'] }) }),
      // noSeats variant on a third day.
      ...blindSeries(1, 2, { engine: 'codex', noSeats: true, autonomous: false }).map((line, i) => {
        const row = JSON.parse(line) as Record<string, unknown>;
        row['at'] = iso(NOW_MS - 3 * DAY - i * HOUR);
        return J(row);
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(8);
    expect(fold.comparisons).toBe(8);
    expect(fold.blind).toBe(6);
    expect(fold.blindNoSeats).toBe(2);
    expect(fold.blindAllExcluded).toBe(4);
    expect(fold.blindDays.size).toBe(3);
    expect(fold.blindEngines.get('claude')).toBe(4);
    expect(fold.blindEngines.get('codex')).toBe(2);
    expect(fold.blindKinds.get('unknown-usage')).toBe(4);
    expect(fold.blindKinds.get('headroom')).toBe(4);
    expect(fold.blindAutonomous.autonomous).toBe(4);
    expect(fold.blindAutonomous.interactive).toBe(2);
    expect(fold.firstBlindMs).not.toBeNull();
    expect(fold.lastBlindMs).not.toBeNull();
  });

  it('folds surface rows per source and adverse (seat, kind) pairs; capacity and policy kinds never pair', () => {
    const rows = [
      // gateway: two no-seat rows across two days, one seat excluded for unreachable.
      surfaceRow({ atMs: NOW_MS - DAY, source: 'gateway', seatId: null, exclusions: [exclusion('seat-x', ['unreachable', 'headroom'])] }),
      surfaceRow({ atMs: NOW_MS - 2 * DAY, source: 'gateway', seatId: null, exclusions: [exclusion('seat-x', ['unreachable'])] }),
      surfaceRow({ atMs: NOW_MS - DAY, source: 'gateway', seatId: 'seat-y', exclusions: [exclusion('seat-x', ['unreachable']), exclusion('seat-p', ['grant', 'lane', 'switched-off', 'demoted', 'task-arm', 'spent', 'reserve', 'session-ceiling', 'model-window', 'context'])] }),
      // leader: healthy picks — no adverse evidence.
      surfaceRow({ atMs: NOW_MS - DAY, source: 'leader', seatId: 'seat-y', exclusions: [exclusion('seat-x', ['headroom'])] }),
      // A row whose exclusion lacks details contributes kinds but no adverse pair.
      decisionRow({
        atMs: NOW_MS - 3 * DAY, source: 'verse',
        decision: { ...seatDecision({ seatId: 'seat-y' }), exclusions: [{ seatId: 'seat-x', reasons: ['Legacy sentence.'], nextEligibleAt: null }] },
        actual: null,
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(5);
    expect(fold.surfaces.get('gateway')!.rows).toBe(3);
    expect(fold.surfaces.get('gateway')!.noSeat).toBe(2);
    expect(fold.surfaces.get('leader')!.rows).toBe(1);
    expect(fold.surfaces.get('verse')!.rows).toBe(1);
    // (seat-x, unreachable) appears on all three gateway rows; policy/capacity kinds never pair.
    const cell = fold.exclusions.get('seat-x unreachable')!;
    expect(cell).toBeDefined();
    expect(cell.rows).toBe(3);
    expect(cell.days.size).toBe(2);
    expect(cell.sources.get('gateway')).toBe(3);
    expect([...fold.exclusions.keys()]).toEqual(['seat-x unreachable']);
    // The gateway surface's kind context tallies every bounded kind, adverse or not.
    expect(fold.surfaces.get('gateway')!.kinds.get('unreachable')).toBe(3);
    expect(fold.surfaces.get('gateway')!.kinds.get('headroom')).toBe(1);
    // The same (seat, kind) listed twice in one row counts once.
    const dupe = foldRows([
      surfaceRow({
        atMs: NOW_MS - HOUR, source: 'gateway', seatId: 'seat-y',
        exclusions: [{ seatId: 'seat-x', reasons: [], nextEligibleAt: null, details: [
          { kind: 'signed-out', text: 'a.' }, { kind: 'signed-out', text: 'b.' },
        ] }],
      }),
    ]);
    expect(dupe.exclusions.get('seat-x signed-out')!.rows).toBe(1);
  });

  it('folds the rotated predecessor and current tails as one journal', () => {
    const previous = blindSeries(1, 2, { engine: 'claude' }).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = iso(NOW_MS - 3 * DAY);
      return J(row);
    });
    const current = blindSeries(1, 2, { engine: 'claude' });
    const fold = foldSeatDecisionJournal([previous.join('\n'), current.join('\n')], NOW_MS, SEAT_DECISION_WINDOW_HOURS);
    expect(fold.blind).toBe(4);
    expect(fold.blindDays.size).toBe(2);
    // Order does not matter — sets and maps fold identically.
    const reversed = foldSeatDecisionJournal([current.join('\n'), previous.join('\n')], NOW_MS, SEAT_DECISION_WINDOW_HOURS);
    expect(reversed.blind).toBe(4);
  });
});

describe('seatDecisionCells', () => {
  it('emits shadow-blind only at the row and day bars', () => {
    // Below the row bar: two rows across two days.
    const few = foldRows(blindSeries(SEAT_DECISION_MIN_DAYS, 1));
    expect(few.blind).toBeLessThan(SEAT_DECISION_MIN_ROWS);
    expect(seatDecisionCells(few)).toEqual([]);

    // Below the day bar: enough rows but all on one UTC day.
    const oneDay = foldRows(blindSeries(1, SEAT_DECISION_MIN_ROWS + 1));
    expect(oneDay.blindDays.size).toBe(1);
    expect(seatDecisionCells(oneDay)).toEqual([]);

    // At the bars.
    const recurring = foldRows(blindSeries(SEAT_DECISION_MIN_DAYS, 2));
    const cells = seatDecisionCells(recurring);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('shadow-blind');
    expect(cell.rows).toBe(SEAT_DECISION_MIN_ROWS);
    expect(cell.total).toBe(SEAT_DECISION_MIN_ROWS);
    expect(cell.share).toBe(1);
    expect(cell.days).toHaveLength(SEAT_DECISION_MIN_DAYS);
    expect(cell.engines).toEqual([{ text: 'claude', count: SEAT_DECISION_MIN_ROWS }]);
    expect(cell.kinds.length).toBeGreaterThan(0);
    expect(cell.autonomous).toBe(SEAT_DECISION_MIN_ROWS);
    expect(cell.interactive).toBe(0);
    expect(cell.noSeatsKnown).toBe(0);
    expect(cell.allExcluded).toBe(SEAT_DECISION_MIN_ROWS);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(seatDecisionCells(recurring, true)[0]!.lowerBound).toBe(true);
  });

  it('emits no-seat per source and seat-excluded per (seat, kind) at the same bars', () => {
    const rows = [
      // gateway starves on two days; leader stays healthy.
      ...noSeatSeries('gateway', SEAT_DECISION_MIN_DAYS, 2, { kinds: ['unreachable'] }),
      ...surfaceRowSeriesHealthy('leader', 2),
      // seat-x unreachable on gateway across two days (same rows as no-seat above? no —
      // excludedSeries rows choose seat-y, so they are separate evaluations).
      ...excludedSeries('gateway', 'seat-x', 'unreachable', SEAT_DECISION_MIN_DAYS, 2),
      // A single-day burst never emits.
      ...excludedSeries('leader', 'seat-q', 'signed-out', 1, SEAT_DECISION_MIN_ROWS + 1),
      // Capacity-truth kinds never emit a seat-excluded cell.
      ...excludedSeries('verse', 'seat-cap', 'headroom', SEAT_DECISION_MIN_DAYS, 2),
    ];
    const cells = seatDecisionCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual(['no-seat', 'seat-excluded']);
    const noSeat = cells.filter((c) => c.kind === 'no-seat');
    const excluded = cells.filter((c) => c.kind === 'seat-excluded');
    expect(noSeat).toHaveLength(1);
    expect(noSeat[0]!.name).toBe('gateway');
    expect(noSeat[0]!.rows).toBe(SEAT_DECISION_MIN_ROWS);
    // gateway surface rows: 4 no-seat + 4 excludedSeries evaluations.
    expect(noSeat[0]!.total).toBe(SEAT_DECISION_MIN_ROWS * 2);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]!.name).toBe('seat-x');
    expect(excluded[0]!.reasonKind).toBe('unreachable');
    // The adverse pair rides all 8 gateway evaluations (4 no-seat + 4 excluded).
    expect(excluded[0]!.rows).toBe(SEAT_DECISION_MIN_ROWS * 2);
    expect(excluded[0]!.sources).toEqual([{ text: 'gateway', count: SEAT_DECISION_MIN_ROWS * 2 }]);
    // The single-day burst and the capacity-kind cell never emitted.
    expect(cells.some((c) => c.name === 'seat-q')).toBe(false);
    expect(cells.some((c) => c.name === 'seat-cap')).toBe(false);
  });

  it('orders shadow-blind first, then no-seat by rows, then seat-excluded by rows', () => {
    const rows = [
      ...blindSeries(2, 2),
      // Capacity-truth exclusion kinds keep the no-seat cells free of
      // seat-excluded evidence so the ordering assertion stays exact.
      ...noSeatSeries('leader', 2, 2, { kinds: ['headroom'] }),
      ...noSeatSeries('gateway', 2, 3, { kinds: ['headroom'] }),
      ...excludedSeries('verse', 'seat-b', 'other', 2, 2),
      ...excludedSeries('verse', 'seat-a', 'unknown-usage', 2, 3),
    ];
    const cells = seatDecisionCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual([
      'shadow-blind',
      'no-seat', 'no-seat',
      'seat-excluded', 'seat-excluded',
    ]);
    // no-seat sorted by rows desc: gateway (6) before leader (4).
    expect(cells[1]!.name).toBe('gateway');
    expect(cells[2]!.name).toBe('leader');
    // seat-excluded sorted by rows desc: seat-a (6) before seat-b (2).
    expect(cells[3]!.name).toBe('seat-a');
    expect(cells[4]!.name).toBe('seat-b');
  });
});

/** Healthy surface picks for the no-seat fixture: rows that chose a seat. */
function surfaceRowSeriesHealthy(source: string, days: number): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < 2; i++) {
      rows.push(surfaceRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source,
        seatId: 'seat-y',
        exclusions: [exclusion('seat-x', ['headroom'])],
      }));
    }
  }
  return rows;
}

describe('seatDecisionBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'seat-decision-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[], previous: string[] = []): Promise<string> {
    const dir = join(home, 'routing');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    if (previous.length > 0) await writeFile(path.replace(/\.jsonl$/, '.1.jsonl'), previous.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell kind with grounded prompts', async () => {
    const rows = [
      ...blindSeries(SEAT_DECISION_MIN_DAYS, 2, { engine: 'claude' }),
      // The gateway starvation rows also carry seat-x 'unreachable'
      // exclusions, so they mint a seat-excluded cell alongside the
      // no-seat one — four items total.
      ...noSeatSeries('gateway', SEAT_DECISION_MIN_DAYS, 2, { kinds: ['unreachable'] }),
      ...excludedSeries('leader', 'seat-x', 'signed-out', SEAT_DECISION_MIN_DAYS, 2),
    ];
    const path = await journal('decisions', rows);
    const items = await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.area)).toEqual([
      'seat-decision-shadow-blind',
      'seat-decision-no-seat',
      'seat-decision-seat-excluded',
      'seat-decision-seat-excluded',
    ]);
    for (const item of items) {
      expect(item.id).toMatch(/^seat-decision-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('decisions.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const [blind, noSeat] = items;
    const gatewayExcluded = items.find((i) => i.title.includes('unreachable'))!;
    const leaderExcluded = items.find((i) => i.title.includes('signed-out'))!;
    expect(blind!.title).toContain('no eligible seat');
    expect(blind!.prompt).toContain('shadow');
    expect(blind!.prompt).toContain('claude');
    expect(blind!.prompt).toContain('capacity.json');
    expect(noSeat!.title).toContain('gateway');
    expect(noSeat!.prompt).toContain('unreachable');
    expect(gatewayExcluded.title).toContain('seat-x');
    expect(gatewayExcluded.prompt).toContain('gateway');
    expect(leaderExcluded.title).toContain('seat-x');
    expect(leaderExcluded.prompt).toContain('leader');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'decisions.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'routing', 'decisions.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's routing journal.
    const thin = blindSeries(SEAT_DECISION_MIN_DAYS, 2);
    const thinPath = await journal('decisions-thin', thin);
    expect(await seatDecisionBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await seatDecisionBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // A journal with only healthy evaluations emits nothing.
    const healthy = [
      surfaceRow({ atMs: NOW_MS - DAY, source: 'gateway', seatId: 'seat-y', exclusions: [exclusion('seat-x', ['headroom'])] }),
      surfaceRow({ atMs: NOW_MS - 2 * DAY, source: 'leader', seatId: 'seat-y', exclusions: [exclusion('seat-x', ['spent'])] }),
      comparisonRow({ atMs: NOW_MS - DAY, engine: 'claude', decision: seatDecision({ seatId: 'seat-a', candidates: ['seat-a'] }) }),
    ];
    const healthyPath = await journal('decisions-healthy', healthy);
    expect(await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);
  });

  it('reads rows across the rotation boundary via the .1 predecessor', async () => {
    // Older half in the predecessor, newer half in the current file —
    // neither half alone reaches the day bar.
    const older = blindSeries(1, 2).map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = iso(NOW_MS - 3 * DAY);
      return J(row);
    });
    const newer = blindSeries(1, 2);
    const path = await journal('decisions-rot', newer, older);
    const items = await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.area).toBe('seat-decision-shadow-blind');
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = blindSeries(SEAT_DECISION_MIN_DAYS, 2);
    // Pad past the writer's 2 MB rotation bound so the tail read reports truncated.
    const pad = 'x'.repeat(3 * 1024 * 1024);
    const path = await journal('decisions-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await seatDecisionBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...blindSeries(2, 2),
      ...noSeatSeries('gateway', 2, 2),
      ...excludedSeries('leader', 'seat-x', 'unreachable', 2, 2),
    ];
    const path = await journal('decisions-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await seatDecisionBacklogItems(opts);
    const second = await seatDecisionBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await seatDecisionBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends seat-decision items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is homedir()/.ashlr/routing — the
    // relocated HOME is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'routing');
    await mkdir(dir, { recursive: true });
    const blindDecision = (): Record<string, unknown> =>
      seatDecision({ seatId: null, candidates: [], exclusions: [exclusion('seat-a', ['unknown-usage'])] });
    await writeFile(join(dir, 'decisions.jsonl'), [
      comparisonRow({ atMs: at(0), engine: 'claude', decision: blindDecision() }),
      comparisonRow({ atMs: at(1), engine: 'claude', decision: blindDecision() }),
      comparisonRow({ atMs: at(2), engine: 'claude', decision: blindDecision() }),
      comparisonRow({ atMs: at(0, 1), engine: 'claude', decision: blindDecision() }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const decisionItems = first.items.filter((i) => i.id.startsWith('seat-decision-'));
    expect(decisionItems).toHaveLength(1);
    expect(decisionItems[0]!.area).toBe('seat-decision-shadow-blind');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(decisionItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('seat-decision-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('seat-decision-'))).toHaveLength(1);
  });
});
