import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldShadowDecisions,
  SHADOW_DECISIONS_MIN_DAYS,
  SHADOW_DECISIONS_MIN_ROWS,
  SHADOW_DECISIONS_WINDOW_HOURS,
  shadowDecisionCells,
  shadowDecisionsBacklogItems,
} from '../src/core/improve/shadow-decisions-backlog.js';
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

/** A SeatDecision carrying the given fields (the shape scrubDecision journals). */
function seatDecision(spec: {
  seatId?: string | null;
  candidates?: string[];
  exclusions?: Record<string, unknown>[];
}): Record<string, unknown> {
  const exclusions = spec.exclusions ?? [];
  return {
    seatId: spec.seatId === undefined ? null : spec.seatId,
    candidates: spec.candidates ?? [],
    exclusions,
    why: exclusions.length > 0
      ? 'No seat the grant lets produce can take this work right now.'
      : 'No seats are published.',
    summary: 'No seat can take this work right now.',
    mode: 'balanced',
  };
}

/** One shadow-decision record in the writer's shape; every field the fold reads is explicit. */
function decisionRow(spec: {
  atMs?: number;
  ts?: string;
  source?: string;
  task?: string;
  seatId?: string | null;
  candidates?: string[];
  exclusions?: Record<string, unknown>[];
  decision?: Record<string, unknown> | null;
  extra?: Record<string, unknown>;
}): string {
  const exclusions = spec.exclusions ?? [];
  return J({
    v: 1,
    at: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    source: spec.source ?? 'daemon',
    request: { task: spec.task ?? 'code', difficulty: 'medium', contextTokens: 4000, autonomous: true },
    decision: spec.decision === undefined
      ? seatDecision({ seatId: spec.seatId, candidates: spec.candidates, exclusions })
      : spec.decision,
    actual: { engine: 'claude', seatId: null },
    ...spec.extra,
  });
}

/** A chosen-seat decision: seatId set, candidates ranked, exclusions may ride along. */
function chosenRow(spec: {
  atMs?: number;
  seatId?: string;
  exclusions?: Record<string, unknown>[];
  source?: string;
  task?: string;
}): string {
  return decisionRow({
    atMs: spec.atMs,
    source: spec.source,
    task: spec.task,
    seatId: spec.seatId ?? 'seat-picked',
    candidates: [spec.seatId ?? 'seat-picked'],
    exclusions: spec.exclusions,
  });
}

/** Recurring adverse-exclusion decisions across `days` UTC days. */
function exclusionSeries(
  seatId: string,
  kind: string,
  days: number,
  perDay: number,
  opts: { prefix?: string; source?: string; task?: string } = {},
): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(chosenRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        seatId: 'seat-picked',
        source: opts.source,
        task: opts.task,
        exclusions: [exclusion(seatId, [kind]), exclusion('other-seat', ['headroom'])],
      }));
    }
  }
  return rows;
}

/** Recurring no-seat decisions (seatId null, exclusions aboard) for one source/task. */
function noSeatSeries(
  source: string,
  task: string,
  days: number,
  perDay: number,
  opts: { kinds?: string[] } = {},
): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(decisionRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source,
        task,
        exclusions: [
          exclusion('seat-a', opts.kinds ?? ['unknown-usage']),
          exclusion('seat-b', ['headroom', 'spent']),
        ],
      }));
    }
  }
  return rows;
}

/** Recurring empty-evaluation decisions (seatId null, no candidates, no exclusions) for one source. */
function emptySeries(source: string, days: number, perDay: number): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(decisionRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        source,
        task: 'review',
        seatId: null,
        candidates: [],
        exclusions: [],
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (current tail; predecessor folds identically). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldShadowDecisions([rows.join('\n')], nowMs, SHADOW_DECISIONS_WINDOW_HOURS);
}

describe('foldShadowDecisions', () => {
  it('counts in-window decision rows and skips foreign shapes without guessing', () => {
    const rows = [
      chosenRow({ atMs: NOW_MS - HOUR, seatId: 'seat-ok' }),
      // Outside the window — too old and too far in the future.
      chosenRow({ atMs: NOW_MS - SHADOW_DECISIONS_WINDOW_HOURS * 3_600_000 - DAY, seatId: 'seat-old' }),
      chosenRow({ atMs: NOW_MS + 600_000, seatId: 'seat-fut' }),
      // Writer-contract failures: not decision records at all.
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'daemon' }),                                            // no request/decision
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'daemon', request: {}, decision: { seatId: 'seat-x', why: 'x', candidates: ['seat-x'], exclusions: [] } }), // valid: request {} → task 'unknown'
      J({ v: 1, at: 'not-a-date', source: 'daemon', request: {}, decision: { why: 'x', candidates: [], exclusions: [] } }),
      J({ v: 2, at: iso(NOW_MS - HOUR), source: 'daemon', request: {}, decision: { why: 'x', candidates: [], exclusions: [] } }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'mystery', request: {}, decision: { why: 'x', candidates: [], exclusions: [] } }),
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'daemon', request: {}, decision: { candidates: [], exclusions: [] } }), // no why
      J({ v: 1, at: iso(NOW_MS - HOUR), source: 'daemon', request: {}, decision: { why: 'x', exclusions: [] } }),        // no candidates
      J({ hello: 'world' }),
      'not json at all',
      '{"decision":',
      '',
    ];
    const fold = foldRows(rows);
    // The second record IS valid (request {} → task 'unknown', chosen seat).
    expect(fold.rows).toBe(2);
    // Nine non-record/malformed lines count; the two out-of-window rows parse but are window-skipped.
    expect(fold.malformed).toBe(9);
    expect(fold.exclusions.size).toBe(0);
    expect(fold.noSeat.size).toBe(0);
    expect(fold.emptyEval.size).toBe(0);
  });

  it('folds adverse seat exclusions per (seatId, kind); capacity and policy kinds never pair', () => {
    const rows = [
      // Chosen-seat rows still carry the full exclusion list — the evaluation happened.
      chosenRow({
        atMs: NOW_MS - DAY, seatId: 'seat-picked', source: 'daemon', task: 'code',
        exclusions: [
          exclusion('seat-broken', ['unknown-usage']),
          exclusion('seat-cap', ['headroom', 'spent', 'reserve', 'session-ceiling', 'model-window', 'context']),
          exclusion('seat-policy', ['grant', 'lane', 'switched-off', 'demoted', 'task-arm']),
        ],
      }),
      chosenRow({
        atMs: NOW_MS - 2 * DAY, seatId: 'seat-picked', source: 'leader', task: 'review',
        exclusions: [exclusion('seat-broken', ['unknown-usage', 'unreachable']), exclusion('seat-cap', ['headroom'])],
      }),
      // Exclusions without details (older scrubbed rows) contribute nothing adverse.
      chosenRow({
        atMs: NOW_MS - 3 * DAY, seatId: 'seat-picked',
        exclusions: [{ seatId: 'seat-legacy', reasons: ['Some sentence.'], nextEligibleAt: null }],
      }),
      // Unsafe seat ids never reach a cell.
      chosenRow({
        atMs: NOW_MS - HOUR, seatId: 'seat-picked',
        exclusions: [{ seatId: 'has space', reasons: [], nextEligibleAt: null, details: [{ kind: 'unknown-usage', text: 'x.' }] }],
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(4);
    expect([...fold.exclusions.keys()].sort()).toEqual([
      'seat-brokenunknown-usage',
      'seat-brokenunreachable',
    ]);
    const cell = fold.exclusions.get('seat-brokenunknown-usage')!;
    expect(cell.seatId).toBe('seat-broken');
    expect(cell.kind).toBe('unknown-usage');
    expect(cell.rows).toBe(2);
    expect(cell.days.size).toBe(2);
    expect(cell.sources.get('daemon')).toBe(1);
    expect(cell.sources.get('leader')).toBe(1);
    expect(cell.tasks.get('code')).toBe(1);
    expect(cell.tasks.get('review')).toBe(1);
    // The same (seat, kind) listed twice in one row counts once.
    const dupe = foldRows([
      chosenRow({
        atMs: NOW_MS - HOUR, seatId: 'seat-picked',
        exclusions: [{ seatId: 'seat-x', reasons: [], nextEligibleAt: null, details: [
          { kind: 'signed-out', text: 'a.' }, { kind: 'signed-out', text: 'b.' },
        ] }],
      }),
    ]);
    expect(dupe.exclusions.get('seat-xsigned-out')!.rows).toBe(1);
  });

  it('folds no-seat declines only when an evidence-broken kind rode along', () => {
    const rows = [
      // Adverse aboard: unknown-usage + capacity mix — emits.
      ...noSeatSeries('daemon', 'code', 1, 3),
      // Pure capacity/policy decline: designed backpressure, never a cell.
      ...[0, 1, 2].map((i) => decisionRow({
        atMs: NOW_MS - i * HOUR - HOUR,
        source: 'daemon',
        task: 'bulk',
        exclusions: [exclusion('seat-cap', ['headroom', 'spent']), exclusion('seat-policy', ['grant'])],
      })),
      // Adverse aboard on another source/task — separate cell.
      ...noSeatSeries('leader', 'plan', 1, 2, { kinds: ['unreachable', 'headroom'] }),
      // A CHOSEN decision with adverse exclusions is not a no-seat row.
      chosenRow({ atMs: NOW_MS - HOUR, seatId: 'seat-picked', exclusions: [exclusion('seat-x', ['signed-out'])] }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(9);
    expect([...fold.noSeat.keys()].sort()).toEqual(['daemoncode', 'leaderplan']);
    const daemon = fold.noSeat.get('daemoncode')!;
    expect(daemon.rows).toBe(3);
    expect(daemon.days.size).toBe(1);
    expect(daemon.kinds.get('unknown-usage')).toBe(3);
    expect(daemon.kinds.get('headroom')).toBe(3);
    expect(daemon.kinds.get('spent')).toBe(3);
    const leader = fold.noSeat.get('leaderplan')!;
    expect(leader.kinds.get('unreachable')).toBe(2);
  });

  it('folds empty seat-table evaluations per source', () => {
    const rows = [
      ...emptySeries('gateway', 1, 3),
      // A no-seat decline is NOT an empty evaluation.
      ...noSeatSeries('gateway', 'code', 1, 2),
      // A chosen decision is not either.
      chosenRow({ atMs: NOW_MS - HOUR, seatId: 'seat-picked' }),
      // Candidates aboard but nothing chosen and nothing excluded: not empty, not no-seat.
      decisionRow({ atMs: NOW_MS - 2 * HOUR, source: 'verse', seatId: null, candidates: ['seat-a'], exclusions: [] }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(7);
    expect([...fold.emptyEval.keys()]).toEqual(['gateway']);
    expect(fold.emptyEval.get('gateway')!.rows).toBe(3);
    expect(fold.emptyEval.get('gateway')!.tasks.get('review')).toBe(3);
  });

  it('folds the rotated predecessor and current tails as one journal', () => {
    const previous = exclusionSeries('seat-old', 'signed-out', 1, 2);
    const current = exclusionSeries('seat-old', 'signed-out', 1, 2);
    const fold = foldShadowDecisions([previous.join('\n'), current.join('\n')], NOW_MS, SHADOW_DECISIONS_WINDOW_HOURS);
    const cell = fold.exclusions.get('seat-oldsigned-out')!;
    expect(cell.rows).toBe(4);
    // Order does not matter — sets and maps fold identically.
    const reversed = foldShadowDecisions([current.join('\n'), previous.join('\n')], NOW_MS, SHADOW_DECISIONS_WINDOW_HOURS);
    expect(reversed.exclusions.get('seat-oldsigned-out')!.rows).toBe(4);
  });
});

describe('shadowDecisionCells', () => {
  it('emits a cell only at the contributing-row and distinct-day bars', () => {
    // Below the row bar: two rows across two days.
    const few = foldRows(exclusionSeries('seat-x', 'unreachable', SHADOW_DECISIONS_MIN_DAYS, 1));
    expect(few.exclusions.get('seat-xunreachable')!.rows).toBe(SHADOW_DECISIONS_MIN_ROWS - 1);
    expect(shadowDecisionCells(few)).toEqual([]);

    // Below the day bar: enough rows but all on one UTC day.
    const oneDay = foldRows(exclusionSeries('seat-x', 'unreachable', 1, SHADOW_DECISIONS_MIN_ROWS + 2));
    expect(oneDay.exclusions.get('seat-xunreachable')!.days.size).toBe(1);
    expect(shadowDecisionCells(oneDay)).toEqual([]);

    // At the bars.
    const recurring = foldRows(exclusionSeries('seat-x', 'unreachable', SHADOW_DECISIONS_MIN_DAYS, 2));
    const cells = shadowDecisionCells(recurring);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('seat-exclusion');
    if (cell.kind !== 'seat-exclusion') throw new Error('unreachable');
    expect(cell.seatId).toBe('seat-x');
    expect(cell.reasonKind).toBe('unreachable');
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.decisionRows).toBe(4);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(shadowDecisionCells(recurring, true)[0]!.lowerBound).toBe(true);
    expect(cell.sources.length).toBeGreaterThan(0);
    expect(cell.tasks.length).toBeGreaterThan(0);
  });

  it('emits no-seat and empty-eval cells with their own evidence fields', () => {
    const rows = [
      ...noSeatSeries('daemon', 'code', SHADOW_DECISIONS_MIN_DAYS, 2),
      ...emptySeries('leader', SHADOW_DECISIONS_MIN_DAYS, 2),
    ];
    const cells = shadowDecisionCells(foldRows(rows));
    // The no-seat rows' adverse exclusion mints a seat-exclusion cell too.
    expect(cells.map((c) => c.kind)).toEqual(['seat-exclusion', 'no-seat', 'empty-eval']);
    const noSeat = cells[1]!;
    if (noSeat.kind !== 'no-seat') throw new Error('unreachable');
    expect(noSeat.source).toBe('daemon');
    expect(noSeat.task).toBe('code');
    expect(noSeat.rows).toBe(4);
    expect(noSeat.reasonKinds.length).toBeGreaterThan(0);
    const empty = cells[2]!;
    if (empty.kind !== 'empty-eval') throw new Error('unreachable');
    expect(empty.source).toBe('leader');
    expect(empty.rows).toBe(4);
    expect(empty.tasks).toEqual([{ text: 'review', count: 4 }]);
  });

  it('orders seat-exclusions first, then no-seat and empty-eval cells', () => {
    const rows = [
      ...emptySeries('verse', SHADOW_DECISIONS_MIN_DAYS, 2),
      ...noSeatSeries('best-of-n', 'bulk', SHADOW_DECISIONS_MIN_DAYS, 2),
      ...exclusionSeries('seat-z', 'other', SHADOW_DECISIONS_MIN_DAYS, 2),
    ];
    const cells = shadowDecisionCells(foldRows(rows));
    // Two seat-exclusion cells (seat-z/other plus seat-a/unknown-usage
    // aboard the no-seat rows), then no-seat, then empty-eval.
    expect(cells.map((c) => c.kind)).toEqual(['seat-exclusion', 'seat-exclusion', 'no-seat', 'empty-eval']);
  });
});

describe('shadowDecisionsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'shadow-decisions-backlog-'));
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
      ...exclusionSeries('seat-broken', 'unknown-usage', 3, 1),
      ...noSeatSeries('daemon', 'code', 2, 2),
      ...emptySeries('leader', 2, 2),
    ];
    const path = await journal('decisions', rows);
    const items = await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    // The no-seat rows' adverse exclusion also mints its own seat-exclusion
    // cell — two lenses on the same evidence, both honest.
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.area)).toEqual([
      'shadow-seat-exclusion', 'shadow-seat-exclusion', 'shadow-no-seat', 'shadow-empty-eval',
    ]);
    for (const item of items) {
      expect(item.id).toMatch(/^shadow-decisions-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('decisions.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const seat = items.find((i) => i.title.includes('seat-broken'))!;
    expect(seat.title).toContain('unknown-usage');
    expect(seat.prompt).toContain('capacity.json');
    const noSeat = items.find((i) => i.area === 'shadow-no-seat')!;
    expect(noSeat.title).toContain('code');
    expect(noSeat.prompt).toContain('seatId null');
    const empty = items.find((i) => i.area === 'shadow-empty-eval')!;
    expect(empty.title).toContain('leader');
    expect(empty.prompt).toContain('EMPTY seat table');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'decisions.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'routing', 'decisions.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's routing journal.
    const thin = exclusionSeries('seat-x', 'unreachable', 1, SHADOW_DECISIONS_MIN_ROWS + 2);
    const thinPath = await journal('decisions-thin', thin);
    expect(await shadowDecisionsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await shadowDecisionsBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).toEqual([]);

    // A journal with only healthy decisions emits nothing.
    const healthy = [
      chosenRow({ atMs: NOW_MS - DAY, seatId: 'seat-a', exclusions: [exclusion('seat-b', ['headroom'])] }),
      chosenRow({ atMs: NOW_MS - 2 * DAY, seatId: 'seat-a', exclusions: [exclusion('seat-b', ['spent'])] }),
      // Designed declines: capacity/policy only — never cells.
      decisionRow({ atMs: NOW_MS - DAY, source: 'daemon', task: 'bulk', exclusions: [exclusion('seat-c', ['headroom', 'reserve'])] }),
      decisionRow({ atMs: NOW_MS - 2 * DAY, source: 'daemon', task: 'bulk', exclusions: [exclusion('seat-c', ['grant'])] }),
      decisionRow({ atMs: NOW_MS - 3 * DAY, source: 'daemon', task: 'bulk', exclusions: [exclusion('seat-c', ['lane'])] }),
    ];
    const healthyPath = await journal('decisions-healthy', healthy);
    expect(await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);
  });

  it('reads rows across the rotation boundary via the .1 predecessor', async () => {
    // Older half in the predecessor, newer half in the current file —
    // neither half alone reaches the day bar.
    const older = exclusionSeries('seat-rot', 'signed-out', 1, 2);
    const newer = exclusionSeries('seat-rot', 'signed-out', 1, 2);
    // Push `older` a day back so the two halves span two UTC days.
    const aged = older.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = iso(NOW_MS - 2 * DAY);
      return J(row);
    });
    const path = await journal('decisions-rot', newer, aged);
    const items = await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('seat-rot');
    expect(items[0]!.prompt).toContain('signed-out');
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = exclusionSeries('seat-trunc', 'other', 3, 1);
    // Pad past the writer's 2 MB rotation bound so the tail read reports truncated.
    const pad = 'x'.repeat(3 * 1024 * 1024);
    const path = await journal('decisions-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await shadowDecisionsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...exclusionSeries('seat-b', 'unreachable', 2, 2),
      ...noSeatSeries('daemon', 'code', 2, 2),
      ...emptySeries('leader', 2, 2),
    ];
    const path = await journal('decisions-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await shadowDecisionsBacklogItems(opts);
    const second = await shadowDecisionsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Two seat-exclusion cells (seat-b/unreachable, seat-a/unknown-usage
    // aboard the no-seat rows), the no-seat cell and the empty-eval cell.
    expect(first).toHaveLength(4);
    const limited = await shadowDecisionsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends shadow-decisions items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is ~/.ashlr/routing — the relocated HOME
    // is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'routing');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'decisions.jsonl'), [
      chosenRow({ atMs: at(0), seatId: 'seat-picked', exclusions: [exclusion('seat-live', ['unknown-usage'])] }),
      chosenRow({ atMs: at(1), seatId: 'seat-picked', exclusions: [exclusion('seat-live', ['unknown-usage'])] }),
      chosenRow({ atMs: at(2), seatId: 'seat-picked', exclusions: [exclusion('seat-live', ['unknown-usage'])] }),
      chosenRow({ atMs: at(0, 1), seatId: 'seat-picked', exclusions: [exclusion('seat-live', ['unknown-usage'])] }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('shadow-decisions-'));
    expect(journalItems).toHaveLength(1);
    expect(journalItems[0]!.area).toBe('shadow-seat-exclusion');
    expect(journalItems[0]!.title).toContain('seat-live');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('shadow-decisions-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('shadow-decisions-'))).toHaveLength(1);
  });
});
