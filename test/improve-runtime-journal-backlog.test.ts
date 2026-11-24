import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRuntimeJournal,
  RUNTIME_JOURNAL_MIN_DAYS,
  RUNTIME_JOURNAL_MIN_ITEMS,
  RUNTIME_JOURNAL_WINDOW_HOURS,
  runtimeJournalBacklogItems,
  runtimeJournalCells,
} from '../src/core/improve/runtime-journal-backlog.js';
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

/** A SeatDecision carrying the given exclusions (the shape scrubDecision journals). */
function seatDecision(exclusions: Record<string, unknown>[]): Record<string, unknown> {
  return {
    seatId: null,
    candidates: [],
    exclusions,
    why: 'No seat the grant lets produce can take this work right now.',
    summary: 'No seat can take this work right now.',
    mode: 'autonomous',
  };
}

/** One fleet.runtime dispatch row in the writer's shape; every field the fold reads is explicit. */
function dispatchRow(spec: {
  itemId: string;
  atMs?: number;
  ts?: string;
  repo?: string | null;
  source?: string;
  dispatched?: boolean;
  backend?: string | null;
  skipReason?: string | null;
  hold?: { kind: 'park' | 'split'; reason?: string; nextEligibleAt?: string | null } | null;
  seat?: Record<string, unknown>[] | null;
  extra?: Record<string, unknown>;
}): string {
  const repo = spec.repo === undefined ? 'ashlrai/phantom' : spec.repo;
  return J({
    v: 1,
    type: 'dispatch',
    at: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    itemId: spec.itemId,
    taskId: null,
    runId: null,
    ...(repo === null ? {} : { repo }),
    title: 'fixture item',
    source: spec.source ?? 'improve-loop',
    backend: spec.backend === undefined ? 'claude' : spec.backend,
    model: null,
    lane: 'claude',
    seatId: null,
    dispatched: spec.dispatched ?? false,
    skipReason: spec.skipReason ?? null,
    proposalId: null,
    spentUsd: 0,
    seatDecision: spec.seat === undefined || spec.seat === null ? null : seatDecision(spec.seat),
    hold: spec.hold ?? null,
    ...spec.extra,
  });
}

/** A landing row — the journal's other record kind; never dispatch evidence. */
function landingRow(atMs: number): string {
  return J({ v: 1, type: 'landing', at: iso(atMs), landingId: 'land-1', kind: 'merge', repo: 'ashlrai/phantom', prNumber: 42, proposalId: null });
}

/** Recurring adverse-exclusion rows: `count` distinct items across `days` UTC days. */
function exclusionSeries(
  seatId: string,
  kind: string,
  days: number,
  perDay: number,
  opts: { prefix?: string; repo?: string; dispatched?: boolean } = {},
): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(dispatchRow({
        itemId: `${opts.prefix ?? 'RQ-E'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        repo: opts.repo,
        dispatched: opts.dispatched ?? true,
        backend: 'claude',
        seat: [exclusion(seatId, [kind]), exclusion('other-seat', ['headroom'])],
      }));
    }
  }
  return rows;
}

/** Recurring seat-evaluated park rows on one repo (seatDecision present). */
function parkSeries(
  repo: string,
  days: number,
  perDay: number,
  opts: { prefix?: string; kinds?: string[]; nextEligibleAt?: string | null; seat?: boolean } = {},
): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(dispatchRow({
        itemId: `${opts.prefix ?? 'RQ-P'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        repo,
        dispatched: false,
        hold: { kind: 'park', reason: 'No seat can take it.', nextEligibleAt: opts.nextEligibleAt ?? null },
        seat: opts.seat === false ? null : [exclusion('seat-a', opts.kinds ?? ['headroom', 'reserve'])],
      }));
    }
  }
  return rows;
}

/** Recurring split rows on one repo. */
function splitSeries(repo: string, days: number, perDay: number, opts: { prefix?: string } = {}): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(dispatchRow({
        itemId: `${opts.prefix ?? 'RQ-S'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        repo,
        dispatched: false,
        hold: { kind: 'split', reason: 'Too much context.', nextEligibleAt: null },
        seat: [exclusion('seat-a', ['context'])],
      }));
    }
  }
  return rows;
}

/** Recurring skip rows declining on one code. */
function skipSeries(code: string, days: number, perDay: number, opts: { prefix?: string; backend?: string | null } = {}): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(dispatchRow({
        itemId: `${opts.prefix ?? 'RQ-K'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        dispatched: false,
        skipReason: code,
        backend: opts.backend === undefined ? 'claude' : opts.backend,
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (current tail; predecessor folds identically). */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldRuntimeJournal([rows.join('\n')], nowMs, RUNTIME_JOURNAL_WINDOW_HOURS);
}

describe('foldRuntimeJournal', () => {
  it('counts in-window dispatch rows and skips foreign shapes without guessing', () => {
    const rows = [
      dispatchRow({ itemId: 'RQ-OK', atMs: NOW_MS - HOUR, dispatched: true, backend: 'claude' }),
      landingRow(NOW_MS - HOUR),
      landingRow(NOW_MS - 2 * HOUR),
      // Outside the window — too old and too far in the future.
      dispatchRow({ itemId: 'RQ-OLD', atMs: NOW_MS - RUNTIME_JOURNAL_WINDOW_HOURS * 3_600_000 - DAY, dispatched: true }),
      dispatchRow({ itemId: 'RQ-FUT', atMs: NOW_MS + 600_000, dispatched: true }),
      // Writer-contract failures: not dispatch rows at all.
      J({ v: 1, type: 'dispatch', at: iso(NOW_MS - HOUR) }),                                  // no itemId
      J({ v: 1, type: 'dispatch', at: iso(NOW_MS - HOUR), itemId: 'RQ-NODISP' }),              // no dispatched
      J({ v: 1, type: 'dispatch', at: 'not-a-date', itemId: 'RQ-BADAT', dispatched: true }),   // bad at
      J({ v: 2, type: 'dispatch', at: iso(NOW_MS - HOUR), itemId: 'RQ-V2', dispatched: true }),// wrong v
      J({ hello: 'world' }),
      'not json at all',
      '{"dispatch":',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(1);
    // Two landings skip silently; seven non-dispatch/malformed lines count.
    expect(fold.malformed).toBe(7);
    expect(fold.exclusions.size).toBe(0);
    expect(fold.holds.size).toBe(0);
    expect(fold.skips.size).toBe(0);
  });

  it('folds adverse seat exclusions per (seatId, kind); capacity and policy kinds never pair', () => {
    const rows = [
      // Dispatched rows still carry the full exclusion list — the evaluation happened.
      dispatchRow({
        itemId: 'RQ-D1', atMs: NOW_MS - DAY, dispatched: true, backend: 'claude', repo: 'ashlrai/phantom', source: 'improve-loop',
        seat: [
          exclusion('seat-broken', ['unknown-usage']),
          exclusion('seat-cap', ['headroom', 'spent', 'reserve', 'session-ceiling', 'model-window', 'context']),
          exclusion('seat-policy', ['grant', 'lane', 'switched-off', 'demoted', 'task-arm']),
        ],
      }),
      dispatchRow({
        itemId: 'RQ-D2', atMs: NOW_MS - 2 * DAY, dispatched: true, backend: 'devin', repo: 'ashlrai/lexicon', source: 'nightly',
        seat: [exclusion('seat-broken', ['unknown-usage', 'unreachable']), exclusion('seat-cap', ['headroom'])],
      }),
      // A held row's seatDecision contributes the same way; no repo label degrades to unattributed.
      dispatchRow({
        itemId: 'RQ-H1', atMs: NOW_MS - 3 * DAY, dispatched: false, repo: null,
        hold: { kind: 'park', reason: 'held', nextEligibleAt: null },
        seat: [exclusion('seat-broken', ['unknown-usage'])],
      }),
      // Exclusions without details (older scrubbed rows) contribute nothing adverse.
      dispatchRow({
        itemId: 'RQ-ND', atMs: NOW_MS - HOUR, dispatched: true,
        seat: [{ seatId: 'seat-legacy', reasons: ['Some sentence.'], nextEligibleAt: null }],
      }),
      // Unsafe seat ids never reach a cell.
      dispatchRow({
        itemId: 'RQ-BAD', atMs: NOW_MS - HOUR, dispatched: true,
        seat: [{ seatId: 'has space', reasons: [], nextEligibleAt: null, details: [{ kind: 'unknown-usage', text: 'x.' }] }],
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(5);
    expect([...fold.exclusions.keys()].sort()).toEqual([
      'seat-brokenunknown-usage',
      'seat-brokenunreachable',
    ]);
    const cell = fold.exclusions.get('seat-brokenunknown-usage')!;
    expect(cell.seatId).toBe('seat-broken');
    expect(cell.kind).toBe('unknown-usage');
    expect(cell.items.size).toBe(3);
    expect(cell.rows).toBe(3);
    expect(cell.days.size).toBe(3);
    expect(cell.repos.get('ashlrai/phantom')).toBe(1);
    expect(cell.repos.get('ashlrai/lexicon')).toBe(1);
    expect(cell.repos.get('unattributed')).toBe(1);
    expect(cell.sources.get('improve-loop')).toBe(2);
    expect(cell.sources.get('nightly')).toBe(1);
    // The same (seat, kind) listed twice in one row counts once.
    const dupe = foldRows([
      dispatchRow({
        itemId: 'RQ-DUP', atMs: NOW_MS - HOUR, dispatched: true,
        seat: [{ seatId: 'seat-x', reasons: [], nextEligibleAt: null, details: [
          { kind: 'signed-out', text: 'a.' }, { kind: 'signed-out', text: 'b.' },
        ] }],
      }),
    ]);
    expect(dupe.exclusions.get('seat-xsigned-out')!.rows).toBe(1);
  });

  it('folds seat-evaluated parks by (kind, repo) and splits, skipping policy parks', () => {
    const rows = [
      // Seat-evaluated park: seatDecision aboard.
      ...parkSeries('ashlrai/phantom', 1, 2, { prefix: 'RQ-PA', kinds: ['headroom', 'reserve'] }),
      // Policy parks: no seatDecision — intended backpressure, never a cell.
      dispatchRow({ itemId: 'RQ-PP1', atMs: NOW_MS - DAY, dispatched: false, repo: 'ashlrai/phantom', hold: { kind: 'park', reason: 'not in rollout stage' } }),
      dispatchRow({ itemId: 'RQ-PP2', atMs: NOW_MS - 2 * DAY, dispatched: false, repo: 'ashlrai/phantom', hold: { kind: 'park', reason: 'land-first' } }),
      dispatchRow({ itemId: 'RQ-PP3', atMs: NOW_MS - 3 * DAY, dispatched: false, repo: 'ashlrai/phantom', hold: { kind: 'park', reason: 'no repo identity' } }),
      // Split holds on another repo.
      ...splitSeries('ashlrai/lexicon', 1, 2, { prefix: 'RQ-SP' }),
      // A park on yet another repo — separate cell.
      ...parkSeries('ashlrai/lexicon', 1, 1, { prefix: 'RQ-PB' }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(8);
    const keys = [...fold.holds.keys()].sort();
    expect(keys).toEqual(['parkashlrai/lexicon', 'parkashlrai/phantom', 'splitashlrai/lexicon']);
    const phantom = fold.holds.get('parkashlrai/phantom')!;
    expect(phantom.holdKind).toBe('park');
    expect(phantom.repo).toBe('ashlrai/phantom');
    expect(phantom.items.size).toBe(2);
    expect(phantom.kinds.get('headroom')).toBe(2);
    expect(phantom.kinds.get('reserve')).toBe(2);
    expect(phantom.noReopen).toBe(2);
    // Policy parks contributed rows but no cell and no kind tallies.
    const lexiconPark = fold.holds.get('parkashlrai/lexicon')!;
    expect(lexiconPark.items.size).toBe(1);
    const split = [...fold.holds.values()].find((c) => c.holdKind === 'split')!;
    expect(split.repo).toBe('ashlrai/lexicon');
    expect(split.items.size).toBe(2);
    // The fold counts noReopen rows only for parks; split rows never increment it.
    expect(split.noReopen).toBe(0);
    expect(split.kinds.get('context')).toBe(2);
  });

  it('counts noReopen only for park rows whose hold named no reopening', () => {
    const reopening = iso(NOW_MS + DAY);
    const rows = [
      ...parkSeries('ashlrai/phantom', 1, 2, { prefix: 'RQ-PR', nextEligibleAt: reopening }),
      ...parkSeries('ashlrai/lexicon', 1, 2, { prefix: 'RQ-PS' }),
    ];
    const fold = foldRows(rows);
    const phantom = fold.holds.get('parkashlrai/phantom')!;
    const lexicon = fold.holds.get('parkashlrai/lexicon')!;
    expect(phantom.noReopen).toBe(0);
    expect(lexicon.noReopen).toBe(2);
  });

  it('folds code-shaped skip reasons only, and a hold always explains the row first', () => {
    const rows = [
      ...skipSeries('repair-authority-unavailable', 1, 3, { prefix: 'RQ-K1', backend: 'claude' }),
      ...skipSeries('lane-capped', 1, 2, { prefix: 'RQ-K2', backend: null }),
      // Sentence reasons never become cells.
      dispatchRow({ itemId: 'RQ-S1', atMs: NOW_MS - DAY, dispatched: false, skipReason: 'Skipped because the repo is paused.' }),
      dispatchRow({ itemId: 'RQ-S2', atMs: NOW_MS - 2 * DAY, dispatched: false, skipReason: 'UPPER CASE CODE' }),
      dispatchRow({ itemId: 'RQ-S3', atMs: NOW_MS - 3 * DAY, dispatched: false, skipReason: '' }),
      // A held row's skipReason never becomes a skip cell — the hold explains it.
      dispatchRow({
        itemId: 'RQ-S4', atMs: NOW_MS - DAY, dispatched: false, skipReason: 'repair-authority-unavailable',
        hold: { kind: 'park', reason: 'held', nextEligibleAt: null },
        seat: [exclusion('seat-a', ['headroom'])],
      }),
      // Dispatched rows ignore skipReason entirely.
      dispatchRow({ itemId: 'RQ-S5', atMs: NOW_MS - DAY, dispatched: true, skipReason: 'repair-authority-unavailable' }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(10);
    expect([...fold.skips.keys()].sort()).toEqual(['lane-capped', 'repair-authority-unavailable']);
    const cell = fold.skips.get('repair-authority-unavailable')!;
    expect(cell.items.size).toBe(3);
    expect(cell.backends.get('claude')).toBe(3);
    const capped = fold.skips.get('lane-capped')!;
    expect(capped.backends.get('unknown')).toBe(2);
    // The held row joined the park cell, not the skip cell.
    const park = [...fold.holds.values()][0]!;
    expect(park.items.has('RQ-S4')).toBe(true);
    expect(cell.items.has('RQ-S4')).toBe(false);
  });

  it('folds the rotated predecessor and current tails as one journal', () => {
    const previous = exclusionSeries('seat-old', 'signed-out', 1, 2, { prefix: 'RQ-OLD' });
    const current = exclusionSeries('seat-old', 'signed-out', 1, 2, { prefix: 'RQ-NEW' });
    const fold = foldRuntimeJournal([previous.join('\n'), current.join('\n')], NOW_MS, RUNTIME_JOURNAL_WINDOW_HOURS);
    const cell = fold.exclusions.get('seat-oldsigned-out')!;
    expect(cell.items.size).toBe(4);
    expect(cell.rows).toBe(4);
    // Order does not matter — sets and maps fold identically.
    const reversed = foldRuntimeJournal([current.join('\n'), previous.join('\n')], NOW_MS, RUNTIME_JOURNAL_WINDOW_HOURS);
    expect(reversed.exclusions.get('seat-oldsigned-out')!.items.size).toBe(4);
  });
});

describe('runtimeJournalCells', () => {
  it('emits a cell only at the distinct-item and distinct-day bars', () => {
    // Below the item bar: two items across two days.
    const few = foldRows(exclusionSeries('seat-x', 'unreachable', RUNTIME_JOURNAL_MIN_DAYS, 1, { prefix: 'RQ-F' }));
    expect(few.exclusions.get('seat-xunreachable')!.items.size).toBe(RUNTIME_JOURNAL_MIN_ITEMS - 1);
    expect(runtimeJournalCells(few)).toEqual([]);

    // Below the day bar: enough items but all on one UTC day.
    const oneDay = foldRows(exclusionSeries('seat-x', 'unreachable', 1, RUNTIME_JOURNAL_MIN_ITEMS + 2, { prefix: 'RQ-O' }));
    expect(oneDay.exclusions.get('seat-xunreachable')!.days.size).toBe(1);
    expect(runtimeJournalCells(oneDay)).toEqual([]);

    // At the bars.
    const recurring = foldRows(exclusionSeries('seat-x', 'unreachable', RUNTIME_JOURNAL_MIN_DAYS, 2, { prefix: 'RQ-R' }));
    const cells = runtimeJournalCells(recurring);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('seat-exclusion');
    if (cell.kind !== 'seat-exclusion') throw new Error('unreachable');
    expect(cell.seatId).toBe('seat-x');
    expect(cell.reasonKind).toBe('unreachable');
    expect(cell.items).toBe(4);
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.examples).toHaveLength(3);
    expect(cell.dispatchRows).toBe(4);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(runtimeJournalCells(recurring, true)[0]!.lowerBound).toBe(true);
    expect(cell.repos.length).toBeGreaterThan(0);
    expect(cell.sources.length).toBeGreaterThan(0);
  });

  it('emits hold and skip cells with their own evidence fields', () => {
    const rows = [
      ...parkSeries('ashlrai/phantom', 2, 2, { prefix: 'RQ-P' }),
      ...skipSeries('killed-by-operator', 2, 2, { prefix: 'RQ-K' }),
    ];
    const cells = runtimeJournalCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual(['park-hold', 'skip-code']);
    const park = cells[0]!;
    if (park.kind !== 'park-hold') throw new Error('unreachable');
    expect(park.holdKind).toBe('park');
    expect(park.repo).toBe('ashlrai/phantom');
    expect(park.items).toBe(4);
    expect(park.noReopen).toBe(4);
    expect(park.reasonKinds.length).toBeGreaterThan(0);
    const skip = cells[1]!;
    if (skip.kind !== 'skip-code') throw new Error('unreachable');
    expect(skip.code).toBe('killed-by-operator');
    expect(skip.items).toBe(4);
    expect(skip.backends).toEqual([{ text: 'claude', count: 4 }]);
  });

  it('orders seat-exclusions first, then park, split and skip cells', () => {
    const rows = [
      ...skipSeries('zzz-skip', 2, 2, { prefix: 'RQ-K' }),
      ...splitSeries('ashlrai/phantom', 2, 2, { prefix: 'RQ-S' }),
      ...parkSeries('ashlrai/phantom', 2, 2, { prefix: 'RQ-P' }),
      ...exclusionSeries('seat-z', 'other', 2, 2, { prefix: 'RQ-E' }),
    ];
    const cells = runtimeJournalCells(foldRows(rows));
    expect(cells.map((c) => c.kind)).toEqual(['seat-exclusion', 'park-hold', 'split-hold', 'skip-code']);
  });
});

describe('runtimeJournalBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'runtime-journal-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[], previous: string[] = []): Promise<string> {
    const dir = join(home, 'fleet', 'runtime');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    if (previous.length > 0) await writeFile(path.replace(/\.jsonl$/, '.1.jsonl'), previous.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell kind with grounded prompts', async () => {
    const rows = [
      ...exclusionSeries('seat-broken', 'unknown-usage', 3, 1, { prefix: 'RQ-E' }),
      ...parkSeries('ashlrai/phantom', 2, 2, { prefix: 'RQ-P' }),
      ...skipSeries('repair-authority-unavailable', 2, 2, { prefix: 'RQ-K' }),
    ];
    const path = await journal('runs', rows);
    const items = await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.area)).toEqual(['runtime-seat-exclusion', 'runtime-park-hold', 'runtime-skip-code']);
    for (const item of items) {
      expect(item.id).toMatch(/^runtime-journal-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('runs.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const [seat, park, skip] = items;
    expect(seat!.title).toContain('seat-broken');
    expect(seat!.title).toContain('unknown-usage');
    expect(seat!.prompt).toContain('unknown-usage');
    expect(seat!.prompt).toContain('capacity.json');
    expect(park!.title).toContain('parking');
    expect(park!.prompt).toContain('ashlrai/phantom');
    expect(park!.prompt).toContain('seatDecision');
    expect(skip!.title).toContain('repair-authority-unavailable');
    expect(skip!.prompt).toContain('skipReason');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'runs.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'fleet', 'runtime', 'runs.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's fleet journal.
    const thin = exclusionSeries('seat-x', 'unreachable', 1, RUNTIME_JOURNAL_MIN_ITEMS + 2, { prefix: 'RQ-T' });
    const thinPath = await journal('runs-thin', thin);
    expect(await runtimeJournalBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await runtimeJournalBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).toEqual([]);

    // A journal with only healthy dispatches emits nothing.
    const healthy = [
      dispatchRow({ itemId: 'RQ-H1', atMs: NOW_MS - DAY, dispatched: true, seat: [exclusion('seat-a', ['headroom'])] }),
      dispatchRow({ itemId: 'RQ-H2', atMs: NOW_MS - 2 * DAY, dispatched: true, seat: [exclusion('seat-a', ['spent'])] }),
      landingRow(NOW_MS - DAY),
    ];
    const healthyPath = await journal('runs-healthy', healthy);
    expect(await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);
  });

  it('reads rows across the rotation boundary via the .1 predecessor', async () => {
    // Older half in the predecessor, newer half in the current file —
    // neither half alone reaches the day bar.
    const older = exclusionSeries('seat-rot', 'signed-out', 1, 2, { prefix: 'RQ-OLD' });
    const newer = exclusionSeries('seat-rot', 'signed-out', 1, 2, { prefix: 'RQ-NEW' });
    // Push `older` a day back so the two halves span two UTC days.
    const aged = older.map((line) => {
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = iso(NOW_MS - 2 * DAY);
      return J(row);
    });
    const path = await journal('runs-rot', newer, aged);
    const items = await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('seat-rot');
    expect(items[0]!.prompt).toContain('signed-out');
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = exclusionSeries('seat-trunc', 'other', 3, 1, { prefix: 'RQ-TR' });
    // Pad past the writer's 2 MB rotation bound so the tail read reports truncated.
    const pad = 'x'.repeat(3 * 1024 * 1024);
    const path = await journal('runs-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await runtimeJournalBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...exclusionSeries('seat-a', 'unreachable', 2, 2, { prefix: 'RQ-S1' }),
      ...parkSeries('ashlrai/phantom', 2, 2, { prefix: 'RQ-S2' }),
      ...skipSeries('some-code', 2, 2, { prefix: 'RQ-S3' }),
    ];
    const path = await journal('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await runtimeJournalBacklogItems(opts);
    const second = await runtimeJournalBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await runtimeJournalBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends runtime-journal items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is homedir()/.ashlr/fleet/runtime — the
    // relocated HOME is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'fleet', 'runtime');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'runs.jsonl'), [
      dispatchRow({ itemId: 'RQ-J1', ts: iso(at(0)), dispatched: true, backend: 'claude', seat: [exclusion('seat-live', ['unknown-usage'])] }),
      dispatchRow({ itemId: 'RQ-J2', ts: iso(at(1)), dispatched: true, backend: 'claude', seat: [exclusion('seat-live', ['unknown-usage'])] }),
      dispatchRow({ itemId: 'RQ-J3', ts: iso(at(2)), dispatched: true, backend: 'claude', seat: [exclusion('seat-live', ['unknown-usage'])] }),
      dispatchRow({ itemId: 'RQ-J4', ts: iso(at(0, 1)), dispatched: true, backend: 'claude', seat: [exclusion('seat-live', ['unknown-usage'])] }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('runtime-journal-'));
    expect(journalItems).toHaveLength(1);
    expect(journalItems[0]!.area).toBe('runtime-seat-exclusion');
    expect(journalItems[0]!.title).toContain('seat-live');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('runtime-journal-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('runtime-journal-'))).toHaveLength(1);
  });
});
