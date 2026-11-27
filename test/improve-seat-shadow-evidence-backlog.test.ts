import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldSeatShadowEvidence,
  SEAT_SHADOW_EVIDENCE_MIN_DAYS,
  SEAT_SHADOW_EVIDENCE_MIN_ROWS,
  SEAT_SHADOW_EVIDENCE_WINDOW_HOURS,
  seatShadowEvidenceBacklogItems,
  seatShadowEvidenceCells,
} from '../src/core/improve/seat-shadow-evidence-backlog.js';
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

/** A SeatDecision in the scrubDecision shape the writer journals. */
function decision(spec: {
  seatId?: string | null;
  candidates?: string[];
  exclusions?: Record<string, unknown>[];
  why?: string;
} = {}): Record<string, unknown> {
  const seatId = spec.seatId === undefined ? null : spec.seatId;
  return {
    seatId,
    candidates: spec.candidates ?? (seatId === null ? [] : [seatId]),
    exclusions: spec.exclusions ?? [],
    why: spec.why ?? 'No seat the grant lets produce can take this work right now.',
    summary: 'No seat can take this work right now.',
    mode: 'balanced',
  };
}

/**
 * One ShadowDecisionRecord in the writer's shape. `source` defaults to
 * 'gateway' (an included path); `actual` defaults to null. Pass
 * `decision: null` to omit the field entirely for malformed cases.
 */
function shadowRow(spec: {
  atMs?: number;
  ts?: string;
  source?: string;
  task?: string;
  difficulty?: string;
  autonomous?: boolean;
  decision?: Record<string, unknown> | null;
  actual?: unknown;
  extra?: Record<string, unknown>;
}): string {
  return J({
    v: 1,
    at: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    source: spec.source ?? 'gateway',
    request: {
      task: spec.task ?? 'code',
      difficulty: spec.difficulty ?? 'medium',
      autonomous: spec.autonomous ?? false,
    },
    ...(spec.decision === null ? {} : { decision: spec.decision ?? decision() }),
    actual: spec.actual === undefined ? null : spec.actual,
    ...spec.extra,
  });
}

/** The beside-dispatch signature: source 'daemon', actual {engine, seatId: null}. */
const BESIDE_ACTUAL = { engine: 'claude', seatId: null };

/** Recurring adverse-exclusion rows: `count` evaluations across `days` UTC days. */
function exclusionSeries(
  seatId: string,
  kind: string,
  days: number,
  perDay: number,
  opts: { source?: string; task?: string; autonomous?: boolean; actual?: unknown; seat?: string | null } = {},
): string[] {
  const rows: string[] = [];
  const chosen = opts.seat === undefined ? 'seat-chosen' : opts.seat;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(shadowRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source: opts.source,
        task: opts.task,
        autonomous: opts.autonomous,
        actual: opts.actual,
        decision: decision({
          seatId: chosen,
          candidates: chosen === null ? [] : [chosen],
          exclusions: [exclusion(seatId, [kind]), exclusion('seat-cap', ['headroom'])],
        }),
      }));
    }
  }
  return rows;
}

/** Recurring empty-decision rows (seatId null). */
function emptySeries(
  subKind: 'all-excluded' | 'no-seats',
  days: number,
  perDay: number,
  opts: { source?: string; task?: string; autonomous?: boolean; actual?: unknown } = {},
): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(shadowRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source: opts.source,
        task: opts.task,
        autonomous: opts.autonomous,
        actual: opts.actual,
        decision: decision({
          seatId: null,
          candidates: [],
          exclusions: subKind === 'all-excluded'
            ? [exclusion('seat-a', ['reserve']), exclusion('seat-b', ['headroom', 'unreachable'])]
            : [],
          why: subKind === 'all-excluded'
            ? 'No seat the grant lets produce can take this work right now.'
            : 'No seat capacity is published for this request.',
        }),
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (current tail; predecessor folds identically). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldSeatShadowEvidence([rows.join('\n')], nowMs, SEAT_SHADOW_EVIDENCE_WINDOW_HOURS);
}

describe('foldSeatShadowEvidence', () => {
  it('counts in-window rows this feed covers and skips foreign shapes without guessing', () => {
    const rows = [
      shadowRow({ atMs: NOW_MS - HOUR, source: 'gateway' }),
      shadowRow({ atMs: NOW_MS - 2 * HOUR, source: 'leader' }),
      shadowRow({ atMs: NOW_MS - HOUR, source: 'daemon', actual: BESIDE_ACTUAL }),
      shadowRow({ atMs: NOW_MS - HOUR, source: 'best-of-n' }),
      shadowRow({ atMs: NOW_MS - HOUR, source: 'verse' }),
      // Outside the window — too old and too far in the future.
      shadowRow({ atMs: NOW_MS - SEAT_SHADOW_EVIDENCE_WINDOW_HOURS * 3_600_000 - DAY }),
      shadowRow({ atMs: NOW_MS + 600_000 }),
      // Contract-valid rows this feed deliberately does not cover.
      shadowRow({ atMs: NOW_MS - HOUR, source: 'test' }),                                     // test traffic
      shadowRow({ atMs: NOW_MS - HOUR, source: 'daemon', actual: null }),                     // standing tick, held
      shadowRow({ atMs: NOW_MS - HOUR, source: 'daemon', actual: { engine: 'claude', seatId: 'seat-x' } }), // standing tick, dispatched
      shadowRow({ atMs: NOW_MS - HOUR, source: 'daemon', actual: { engine: 'claude', seatId: null }, decision: decision({ seatId: 'seat-a' }) }), // beside — folded
      // Writer-contract failures.
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: false } }), // no decision
      J({ v: 2, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: false }, decision: decision(), actual: null }),
      J({ v: 1, at: 'not-a-date', source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: false }, decision: decision(), actual: null }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'bogus', request: { task: 'code', difficulty: 'medium', autonomous: false }, decision: decision(), actual: null }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'bogus', difficulty: 'medium', autonomous: false }, decision: decision(), actual: null }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'bogus', autonomous: false }, decision: decision(), actual: null }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium' }, decision: decision(), actual: null }), // no autonomous
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: false }, decision: { seatId: null, candidates: [], exclusions: [] }, actual: null }), // no why
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'gateway', request: { task: 'code', difficulty: 'medium', autonomous: false }, decision: decision(), actual: 'bogus' }),
      J({ hello: 'world' }),
      'not json at all',
      '{"v":1,',
      '',
    ];
    const fold = foldRows(rows);
    // 5 included sources + 1 beside = 6 folded rows.
    expect(fold.rows).toBe(6);
    // test + held tick + dispatched tick = 3 skipped; two out-of-window rows never reach the counters.
    expect(fold.skippedRows).toBe(3);
    // 9 malformed/off-contract lines (no-decision, v2, bad at, bad source, bad task, bad difficulty, no autonomous, no why, bad actual) + hello + not-json + truncated-json = 12.
    expect(fold.malformed).toBe(12);
    expect(fold.exclusions.size).toBe(0);
    // The five bare default decisions (seatId null, nothing excluded) each
    // form a 'no-seats' empty cell keyed by their source; the sixth folded
    // row chose a seat and contributes no cell.
    expect(fold.empties.size).toBe(5);
  });

  it('folds adverse seat exclusions per (seatId, kind); capacity and policy kinds never pair', () => {
    const rows = [
      // A chosen seat does not erase the evidence that other seats failed.
      shadowRow({
        atMs: NOW_MS - DAY, source: 'gateway', task: 'review', autonomous: true,
        decision: decision({
          seatId: 'seat-ok', candidates: ['seat-ok'],
          exclusions: [
            exclusion('seat-broken', ['unknown-usage']),
            exclusion('seat-cap', ['headroom', 'spent', 'reserve', 'session-ceiling', 'model-window', 'context', 'spend-cap']),
            exclusion('seat-policy', ['grant', 'lane', 'switched-off', 'demoted', 'task-arm']),
          ],
        }),
        actual: null,
      }),
      shadowRow({
        atMs: NOW_MS - 2 * DAY, source: 'leader', task: 'plan', autonomous: false,
        decision: decision({
          seatId: 'seat-ok',
          exclusions: [exclusion('seat-broken', ['unknown-usage', 'unreachable']), exclusion('seat-cap', ['headroom'])],
        }),
      }),
      // A beside-dispatch row contributes the same way, engine recorded.
      shadowRow({
        atMs: NOW_MS - 3 * DAY, source: 'daemon', task: 'bulk', autonomous: true, actual: BESIDE_ACTUAL,
        decision: decision({
          seatId: 'seat-ok',
          exclusions: [exclusion('seat-broken', ['unknown-usage'])],
        }),
      }),
      // Exclusions without details (older scrubbed rows) contribute nothing adverse.
      shadowRow({
        atMs: NOW_MS - HOUR,
        decision: decision({
          seatId: 'seat-legacy', candidates: ['seat-legacy'],
          exclusions: [{ seatId: 'seat-legacyx', reasons: ['Some sentence.'], nextEligibleAt: null }],
        }),
      }),
      // Unsafe seat ids never reach a cell.
      shadowRow({
        atMs: NOW_MS - HOUR,
        decision: decision({
          seatId: 'seat-ok',
          exclusions: [{ seatId: 'has space', reasons: [], nextEligibleAt: null, details: [{ kind: 'unknown-usage', text: 'x.' }] }],
        }),
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(5);
    expect([...fold.exclusions.keys()].sort()).toEqual([
      'seat-broken:unknown-usage',
      'seat-broken:unreachable',
    ]);
    const cell = fold.exclusions.get('seat-broken:unknown-usage')!;
    expect(cell.seatId).toBe('seat-broken');
    expect(cell.kind).toBe('unknown-usage');
    expect(cell.rows).toBe(3);
    expect(cell.days.size).toBe(3);
    expect(cell.sources.get('gateway')).toBe(1);
    expect(cell.sources.get('leader')).toBe(1);
    expect(cell.sources.get('daemon')).toBe(1);
    expect(cell.tasks.get('review')).toBe(1);
    expect(cell.tasks.get('plan')).toBe(1);
    expect(cell.tasks.get('bulk')).toBe(1);
    expect(cell.autonomy.get('autonomous')).toBe(2);
    expect(cell.autonomy.get('interactive')).toBe(1);
    expect(cell.engines.get('claude')).toBe(1);
    expect(cell.engines.get('unrecorded')).toBe(2);
    // The same (seat, kind) listed twice in one row counts once.
    const dupe = foldRows([
      shadowRow({
        atMs: NOW_MS - HOUR,
        decision: decision({
          seatId: 'seat-ok',
          exclusions: [{
            seatId: 'seat-x', reasons: [], nextEligibleAt: null,
            details: [{ kind: 'signed-out', text: 'a.' }, { kind: 'signed-out', text: 'b.' }],
          }],
        }),
      }),
    ]);
    expect(dupe.exclusions.get('seat-x:signed-out')!.rows).toBe(1);
  });

  it('splits empty decisions into all-excluded and no-seats keyed by source, task and autonomy', () => {
    const rows = [
      ...emptySeries('all-excluded', 1, 2, { source: 'gateway', task: 'code', autonomous: false }),
      ...emptySeries('no-seats', 1, 2, { source: 'gateway', task: 'code', autonomous: false }),
      ...emptySeries('all-excluded', 1, 1, { source: 'leader', task: 'leader', autonomous: true }),
      // Same shape on the beside path folds too.
      ...emptySeries('no-seats', 1, 1, { source: 'daemon', task: 'bulk', autonomous: true, actual: BESIDE_ACTUAL }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(6);
    const keys = [...fold.empties.keys()].sort();
    expect(keys).toEqual([
      'daemon:bulk:true:no-seats',
      'gateway:code:false:all-excluded',
      'gateway:code:false:no-seats',
      'leader:leader:true:all-excluded',
    ]);
    const allExcluded = fold.empties.get('gateway:code:false:all-excluded')!;
    expect(allExcluded.subKind).toBe('all-excluded');
    expect(allExcluded.rows).toBe(2);
    expect(allExcluded.kinds.get('reserve')).toBe(2);
    expect(allExcluded.kinds.get('headroom')).toBe(2);
    expect(allExcluded.kinds.get('unreachable')).toBe(2);
    expect(allExcluded.difficulties.get('medium')).toBe(2);
    expect(allExcluded.whys.get('No seat the grant lets produce can take this work right now.')).toBe(2);
    const noSeats = fold.empties.get('gateway:code:false:no-seats')!;
    expect(noSeats.subKind).toBe('no-seats');
    expect(noSeats.kinds.size).toBe(0);
    expect(noSeats.whys.get('No seat capacity is published for this request.')).toBe(2);
    const beside = fold.empties.get('daemon:bulk:true:no-seats')!;
    expect(beside.engines.get('claude')).toBe(1);
  });

  it('folds the rotated predecessor and current tails as one journal', () => {
    const previous = exclusionSeries('seat-old', 'signed-out', 1, 2, { source: 'gateway' });
    const current = exclusionSeries('seat-old', 'signed-out', 1, 2, { source: 'gateway' });
    const fold = foldSeatShadowEvidence([previous.join('\n'), current.join('\n')], NOW_MS, SEAT_SHADOW_EVIDENCE_WINDOW_HOURS);
    const cell = fold.exclusions.get('seat-old:signed-out')!;
    expect(cell.rows).toBe(4);
    // Order does not matter — sets and maps fold identically.
    const reversed = foldSeatShadowEvidence([current.join('\n'), previous.join('\n')], NOW_MS, SEAT_SHADOW_EVIDENCE_WINDOW_HOURS);
    expect(reversed.exclusions.get('seat-old:signed-out')!.rows).toBe(4);
  });
});

describe('seatShadowEvidenceCells', () => {
  it('emits a cell only at the row and distinct-day bars', () => {
    // Below the row bar: two rows across two days.
    const few = foldRows(emptySeries('no-seats', SEAT_SHADOW_EVIDENCE_MIN_DAYS, 1, { source: 'gateway' }));
    expect(few.empties.get('gateway:code:false:no-seats')!.rows).toBe(SEAT_SHADOW_EVIDENCE_MIN_ROWS - 1);
    expect(seatShadowEvidenceCells(few)).toEqual([]);

    // Below the day bar: enough rows but all on one UTC day.
    const oneDay = foldRows(emptySeries('no-seats', 1, SEAT_SHADOW_EVIDENCE_MIN_ROWS + 2, { source: 'gateway' }));
    expect(oneDay.empties.get('gateway:code:false:no-seats')!.days.size).toBe(1);
    expect(seatShadowEvidenceCells(oneDay)).toEqual([]);

    // At the bars.
    const recurring = foldRows(emptySeries('no-seats', SEAT_SHADOW_EVIDENCE_MIN_DAYS, 2, { source: 'gateway' }));
    const cells = seatShadowEvidenceCells(recurring);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('empty');
    if (cell.kind !== 'empty') throw new Error('unreachable');
    expect(cell.source).toBe('gateway');
    expect(cell.task).toBe('code');
    expect(cell.autonomous).toBe(false);
    expect(cell.subKind).toBe('no-seats');
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.evalRows).toBe(4);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(seatShadowEvidenceCells(recurring, true)[0]!.lowerBound).toBe(true);
    expect(cell.engines).toEqual([{ text: 'unrecorded', count: 4 }]);
    expect(cell.whys.length).toBeGreaterThan(0);
  });

  it('emits exclusion cells with their own evidence fields and orders them first', () => {
    const rows = [
      ...exclusionSeries('seat-a', 'unreachable', 2, 2, { source: 'gateway' }),
      ...emptySeries('all-excluded', 2, 2, { source: 'leader', task: 'leader', autonomous: true }),
    ];
    const cells = seatShadowEvidenceCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual(['exclusion', 'empty']);
    const excl = cells[0]!;
    if (excl.kind !== 'exclusion') throw new Error('unreachable');
    expect(excl.seatId).toBe('seat-a');
    expect(excl.reasonKind).toBe('unreachable');
    expect(excl.rows).toBe(4);
    expect(excl.sources).toEqual([{ text: 'gateway', count: 4 }]);
    expect(excl.tasks).toEqual([{ text: 'code', count: 4 }]);
    expect(excl.autonomy).toEqual([{ text: 'interactive', count: 4 }]);
    expect(excl.engines).toEqual([{ text: 'unrecorded', count: 4 }]);
    const empty = cells[1]!;
    if (empty.kind !== 'empty') throw new Error('unreachable');
    expect(empty.subKind).toBe('all-excluded');
    expect(empty.kinds.length).toBeGreaterThan(0);
  });
});

describe('seatShadowEvidenceBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'seat-shadow-evidence-backlog-'));
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

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...exclusionSeries('seat-broken', 'unknown-usage', 3, 1, { source: 'gateway' }),
      ...exclusionSeries('seat-broken', 'unknown-usage', 1, 1, { source: 'daemon', actual: BESIDE_ACTUAL, task: 'bulk', autonomous: true }),
      ...emptySeries('all-excluded', 2, 2, { source: 'leader', task: 'leader', autonomous: true }),
      ...emptySeries('no-seats', 2, 2, { source: 'daemon', task: 'bulk', autonomous: true, actual: BESIDE_ACTUAL }),
    ];
    const path = await journal('decisions', rows);
    const items = await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.area)).toEqual(['seat-shadow-evidence-exclusion', 'seat-shadow-evidence-empty', 'seat-shadow-evidence-empty']);
    for (const item of items) {
      expect(item.id).toMatch(/^seat-shadow-evidence-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('decisions.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const [seat, allExcluded, noSeats] = items;
    expect(seat!.title).toContain('seat-broken');
    expect(seat!.title).toContain('unknown-usage');
    expect(seat!.prompt).toContain('unknown-usage');
    expect(seat!.prompt).toContain('capacity.json');
    expect(seat!.prompt).toContain('gateway');
    expect(allExcluded!.title).toContain('every seat');
    expect(allExcluded!.prompt).toContain('leader');
    expect(allExcluded!.prompt).toContain('reserve');
    expect(noSeats!.title).toContain('empty seat view');
    expect(noSeats!.prompt).toContain('daemon');
    expect(noSeats!.prompt).toContain('bulk');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'decisions.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'routing', 'decisions.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's seat journal.
    const thin = emptySeries('no-seats', 1, SEAT_SHADOW_EVIDENCE_MIN_ROWS + 2, { source: 'gateway' });
    const thinPath = await journal('decisions-thin', thin);
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await seatShadowEvidenceBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).toEqual([]);

    // A journal with only healthy evaluations emits nothing.
    const healthy = [
      shadowRow({ atMs: NOW_MS - DAY, decision: decision({ seatId: 'seat-a', exclusions: [exclusion('seat-b', ['headroom'])] }) }),
      shadowRow({ atMs: NOW_MS - 2 * DAY, decision: decision({ seatId: 'seat-a', exclusions: [exclusion('seat-b', ['spent'])] }) }),
    ];
    const healthyPath = await journal('decisions-healthy', healthy);
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);

    // A journal with only the standing tick's own evaluations emits nothing —
    // runs.jsonl already carries that evidence.
    const standing = [
      shadowRow({ atMs: NOW_MS - DAY, source: 'daemon', actual: null, decision: decision({ seatId: 'seat-a', exclusions: [exclusion('seat-broken', ['unreachable'])] }) }),
      shadowRow({ atMs: NOW_MS - 2 * DAY, source: 'daemon', actual: { engine: 'claude', seatId: 'seat-a' }, decision: decision({ seatId: 'seat-a', exclusions: [exclusion('seat-broken', ['unreachable'])] }) }),
      shadowRow({ atMs: NOW_MS - 3 * DAY, source: 'daemon', actual: null, decision: decision({ seatId: null, exclusions: [exclusion('seat-a', ['reserve'])] }) }),
    ];
    const standingPath = await journal('decisions-standing', standing);
    expect(await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: standingPath, now: NOW })).toEqual([]);
  });

  it('reads rows across the rotation boundary via the .1 predecessor', async () => {
    // Older half in the predecessor, newer half in the current file —
    // neither half alone reaches the day bar.
    const older = exclusionSeries('seat-rot', 'signed-out', 1, 2, { source: 'gateway' });
    const newer = exclusionSeries('seat-rot', 'signed-out', 1, 2, { source: 'gateway' });
    // Push `older` a day back so the two halves span two UTC days.
    const aged = older.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = iso(NOW_MS - 2 * DAY);
      return J(row);
    });
    const path = await journal('decisions-rot', newer, aged);
    const items = await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('seat-rot');
    expect(items[0]!.prompt).toContain('signed-out');
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = exclusionSeries('seat-trunc', 'other', 3, 1, { source: 'gateway' });
    // Pad past the writer's 2 MB rotation bound so the tail read reports truncated.
    const pad = 'x'.repeat(3 * 1024 * 1024);
    const path = await journal('decisions-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await seatShadowEvidenceBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...exclusionSeries('seat-a', 'unreachable', 2, 2, { source: 'gateway' }),
      ...exclusionSeries('seat-b', 'signed-out', 2, 2, { source: 'leader' }),
      ...emptySeries('no-seats', 2, 2, { source: 'gateway' }),
    ];
    const path = await journal('decisions-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await seatShadowEvidenceBacklogItems(opts);
    const second = await seatShadowEvidenceBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await seatShadowEvidenceBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends seat-shadow items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is homedir()/.ashlr/routing — the
    // relocated HOME is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'routing');
    await mkdir(dir, { recursive: true });
    const rows = [0, 1, 2].map((d) => shadowRow({
      ts: iso(at(d)),
      source: 'gateway',
      decision: decision({
        seatId: 'seat-live',
        exclusions: [exclusion('seat-live-broken', ['unknown-usage']), exclusion('seat-cap', ['headroom'])],
      }),
    }));
    await writeFile(join(dir, 'decisions.jsonl'), rows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const shadowItems = first.items.filter((i) => i.id.startsWith('seat-shadow-evidence-'));
    expect(shadowItems).toHaveLength(1);
    expect(shadowItems[0]!.area).toBe('seat-shadow-evidence-exclusion');
    expect(shadowItems[0]!.title).toContain('seat-live-broken');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(shadowItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('seat-shadow-evidence-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('seat-shadow-evidence-'))).toHaveLength(1);
  });
});
