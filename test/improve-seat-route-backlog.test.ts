import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldSeatRouteJournal,
  SEAT_ROUTE_BACKLOG_MAX_ITEMS,
  SEAT_ROUTE_MIN_DAYS,
  SEAT_ROUTE_MIN_ROWS,
  SEAT_ROUTE_WINDOW_MS,
  seatRouteBacklogItems,
  seatRouteCells,
  type SeatRouteFold,
} from '../src/core/improve/seat-route-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's `at`. */
const NOW = Date.parse('2026-11-24T15:00:00.000Z');
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

/** One decisions.jsonl row in the recordShadowDecision writer's shape. */
function routeRow(spec: {
  atMs?: number;
  source?: string;
  task?: string;
  autonomous?: boolean;
  seatId?: string | null;
  candidates?: string[];
  exclusions?: Record<string, unknown>[];
  mode?: string;
  actual?: { engine: string; seatId: string | null } | null;
  why?: string;
}): string {
  return J({
    v: 1,
    at: iso(spec.atMs ?? NOW),
    source: spec.source ?? 'gateway',
    request: {
      task: spec.task ?? 'code',
      difficulty: 'medium',
      contextTokens: 8_000,
      autonomous: spec.autonomous ?? true,
    },
    decision: {
      seatId: spec.seatId === undefined ? null : spec.seatId,
      candidates: spec.candidates ?? [],
      exclusions: spec.exclusions ?? [],
      why: spec.why ?? 'No seat the grant lets produce can take this work right now.',
      mode: spec.mode ?? 'balanced',
    },
    actual: spec.actual === undefined ? null : spec.actual,
  });
}

/** A no-eligible-seat decision row: seatId null, the starvation evidence shape. */
const noSeat = (spec: Parameters<typeof routeRow>[0] = {}): string => routeRow({ seatId: null, ...spec });
/** A seated decision row: counts toward the cell total, never its rows. */
const seated = (spec: Parameters<typeof routeRow>[0] = {}): string =>
  routeRow({ seatId: 'claude-max', candidates: ['claude-max'], ...spec });

const fold = (lines: string[], nowMs = NOW): SeatRouteFold =>
  foldSeatRouteJournal(lines.join('\n'), nowMs, SEAT_ROUTE_WINDOW_MS);

describe('foldSeatRouteJournal', () => {
  it('groups no-seat decisions by (source, task, autonomous) with totals and tallies', () => {
    const f = fold([
      noSeat({ atMs: NOW - 2 * DAY, actual: { engine: 'claude', seatId: null }, mode: 'balanced' }),
      seated({ atMs: NOW - 2 * DAY + HOUR }),
      noSeat({ atMs: NOW - DAY, actual: null, mode: 'reserve' }),
      seated({ atMs: NOW - DAY + HOUR, seatId: 'codex-pro' }),
      noSeat({ atMs: NOW - DAY + 2 * HOUR, source: 'leader', task: 'plan', autonomous: false, mode: 'all-in' }),
    ]);
    expect(f.records).toBe(5);
    expect(f.testRows).toBe(0);
    expect(f.invalidRows).toBe(0);
    expect(f.noSeat.size).toBe(2);
    const gateway = [...f.noSeat.values()].find((c) => c.source === 'gateway')!;
    expect(gateway).toMatchObject({ task: 'code', autonomous: true, rows: 2, total: 4 });
    expect(gateway.days.size).toBe(2);
    expect(gateway.firstMs).toBe(NOW - 2 * DAY);
    // Only no-seat rows bound the cell's seen range — the seated rows do not.
    expect(gateway.lastMs).toBe(NOW - DAY);
    expect([...gateway.actualEngines.entries()]).toEqual([['claude', 1]]);
    expect([...gateway.modes.entries()].sort()).toEqual([['balanced', 1], ['reserve', 1]]);
    const leader = [...f.noSeat.values()].find((c) => c.source === 'leader')!;
    expect(leader).toMatchObject({ task: 'plan', autonomous: false, rows: 1, total: 1 });
  });

  it('counts test-source rows separately and never folds them', () => {
    const f = fold([
      noSeat({ atMs: NOW - 2 * DAY, source: 'test' }),
      noSeat({ atMs: NOW - DAY, source: 'test', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      noSeat({ atMs: NOW - DAY + HOUR, source: 'gateway' }),
      noSeat({ atMs: NOW - DAY + 2 * HOUR, source: 'gateway' }),
      noSeat({ atMs: NOW - DAY + 3 * HOUR, source: 'gateway' }),
    ]);
    expect(f.testRows).toBe(2);
    expect(f.records).toBe(3);
    // The gateway cell has only its own three rows — test probes contributed nothing.
    const cell = [...f.noSeat.values()].find((c) => c.source === 'gateway')!;
    expect(cell.rows).toBe(3);
    expect(cell.total).toBe(3);
    expect(f.exclusions.size).toBe(0);
  });

  it('forms exclusion cells only for the non-dispatch surface sources', () => {
    const rows = [
      // 'daemon' mirrors runs.jsonl evidence runtime-journal-backlog owns — never a cell here.
      routeRow({ atMs: NOW - 2 * DAY, source: 'daemon', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: NOW - DAY, source: 'daemon', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: NOW - 2 * DAY, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: NOW - DAY, source: 'leader', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unreachable'])] }),
      routeRow({ atMs: NOW - DAY + HOUR, source: 'best-of-n', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['signed-out'])] }),
    ];
    const f = fold(rows);
    expect(f.exclusions.size).toBe(3);
    for (const cell of f.exclusions.values()) {
      expect(cell.seatId).toBe('seat-a');
      expect(cell.rows).toBe(1);
      // Only the two surface rows naming seat-a count toward its total.
      expect(f.seatTotals.get('seat-a')).toBe(3);
    }
    const kinds = [...f.exclusions.values()].map((c) => c.kind).sort();
    expect(kinds).toEqual(['signed-out', 'unknown-usage', 'unreachable']);
    const unknownUsage = [...f.exclusions.values()].find((c) => c.kind === 'unknown-usage')!;
    expect([...unknownUsage.sources.entries()]).toEqual([['gateway', 1]]);
  });

  it('counts only evidence-broken kinds as adverse; capacity and policy kinds are context', () => {
    const f = fold([
      routeRow({ atMs: NOW - 2 * DAY, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage', 'spent', 'headroom'])] }),
      routeRow({ atMs: NOW - DAY, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: NOW - DAY + HOUR, source: 'verse', seatId: null, exclusions: [exclusion('seat-a', ['spent', 'reserve'])] }),
    ]);
    // Only the two 'unknown-usage' observations are adverse cells.
    expect(f.exclusions.size).toBe(1);
    const cell = [...f.exclusions.values()][0]!;
    expect(cell).toMatchObject({ seatId: 'seat-a', kind: 'unknown-usage', rows: 2 });
    // seatTotals counts every exclusion observation on the surfaces: all three rows named seat-a.
    expect(f.seatTotals.get('seat-a')).toBe(3);
  });

  it('treats exclusions without structured details as context, never adverse', () => {
    const legacy = {
      seatId: 'seat-a',
      reasons: ['usage unknown.'],
      nextEligibleAt: null,
      // no details twin — an older record shape
    };
    const f = fold([
      routeRow({ atMs: NOW - 2 * DAY, source: 'gateway', seatId: 'seat-b', exclusions: [legacy] }),
      routeRow({ atMs: NOW - DAY, source: 'gateway', seatId: 'seat-b', exclusions: [legacy] }),
      routeRow({ atMs: NOW - DAY + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [legacy] }),
    ]);
    expect(f.exclusions.size).toBe(0);
    expect(f.seatTotals.get('seat-a')).toBe(3);
  });

  it('dedupes (seatId, kind) pairs and seats within one row', () => {
    const f = fold([
      routeRow({
        atMs: NOW - 2 * DAY,
        source: 'gateway',
        seatId: 'seat-b',
        exclusions: [
          exclusion('seat-a', ['unknown-usage']),
          { seatId: 'seat-a', reasons: ['again.'], nextEligibleAt: null, details: [{ kind: 'unknown-usage', text: 'again.' }] },
        ],
      }),
      routeRow({ atMs: NOW - DAY, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: NOW - DAY + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
    ]);
    const cell = [...f.exclusions.values()][0]!;
    expect(cell.rows).toBe(3); // one adverse observation per row, not per detail entry
    expect(f.seatTotals.get('seat-a')).toBe(3); // one seat observation per row, not per exclusion entry
  });

  it('skips rows outside the window and counts malformed or off-contract lines', () => {
    const f = fold([
      noSeat({ atMs: NOW - SEAT_ROUTE_WINDOW_MS - HOUR }), // outside window
      noSeat({ atMs: NOW + HOUR }), // beyond skew? within +5min? no — 1h ahead is outside
      'garbage line',
      J({ v: 2, at: iso(NOW), source: 'gateway', request: {}, decision: {}, actual: null }),
      J({ v: 1, at: 'not-a-date', source: 'gateway', request: {}, decision: {}, actual: null }),
      routeRow({ atMs: NOW - MIN, source: 'not-a-source' }),
      routeRow({ atMs: NOW - MIN, task: 'not-a-task' }),
      routeRow({ atMs: NOW - MIN, seatId: 'bad seat!' }),
      routeRow({ atMs: NOW - MIN }),
    ]);
    expect(f.records).toBe(1);
    expect(f.invalidRows).toBe(6);
  });

  it('keeps forward-compatible extra fields without folding them', () => {
    const row = JSON.parse(routeRow({ atMs: NOW - MIN, actual: { engine: 'codex', seatId: 'seat-x' } }));
    row.request.contextTokens = 'not-a-number';
    row.decision.taskArm = { key: 'arm-1' };
    row.decision.summary = 'Picked seat-x for the job.';
    row.future = 'field';
    const f = foldSeatRouteJournal(`${J(row)}\n`, NOW, SEAT_ROUTE_WINDOW_MS);
    expect(f.invalidRows).toBe(0);
    expect(f.records).toBe(1);
    const cell = [...f.noSeat.values()][0]!;
    expect(cell.actualEngines.get('codex')).toBe(1);
  });
});

describe('seatRouteCells', () => {
  const T_OLD = NOW - 2 * DAY - 2 * HOUR; // 2026-11-22
  const T_NEW = NOW - DAY - 3 * HOUR; // 2026-11-23

  it('emits no-seat cells only at the recurring bars of rows and days', () => {
    const f = fold([
      noSeat({ atMs: T_OLD, source: 'gateway' }),
      noSeat({ atMs: T_OLD + HOUR, source: 'gateway' }),
      seated({ atMs: T_NEW, source: 'gateway' }),
      noSeat({ atMs: T_NEW + HOUR, source: 'gateway' }),
      // one day only — under the day bar despite three rows
      noSeat({ atMs: NOW - 2 * HOUR, source: 'leader', task: 'review' }),
      noSeat({ atMs: NOW - HOUR, source: 'leader', task: 'review' }),
      noSeat({ atMs: NOW - 30 * MIN, source: 'leader', task: 'review' }),
      // two days but only two rows — under the row bar
      noSeat({ atMs: NOW - 3 * DAY, source: 'verse', task: 'bulk' }),
      noSeat({ atMs: NOW - DAY, source: 'verse', task: 'bulk' }),
    ]);
    const cells = seatRouteCells(f);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'no-seat', source: 'gateway', task: 'code', rows: 3, total: 4 });
    expect(cells[0]!.days).toEqual(['2026-11-22', '2026-11-23']);
    expect(SEAT_ROUTE_MIN_ROWS).toBe(3);
    expect(SEAT_ROUTE_MIN_DAYS).toBe(2);
  });

  it('orders no-seat cells before exclusion cells, each by rows then identity', () => {
    const f = fold([
      routeRow({ atMs: T_OLD, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: T_OLD + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: T_NEW, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
      routeRow({ atMs: T_NEW + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-c', ['signed-out'])] }),
      routeRow({ atMs: NOW - 2 * HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-c', ['signed-out'])] }),
      routeRow({ atMs: NOW - HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-c', ['signed-out'])] }),
      noSeat({ atMs: T_OLD, source: 'leader' }),
      noSeat({ atMs: T_NEW, source: 'leader' }),
      noSeat({ atMs: NOW - HOUR, source: 'leader' }),
    ]);
    const cells = seatRouteCells(f);
    expect(cells.map((c) => c.kind)).toEqual(['no-seat', 'seat-exclusion', 'seat-exclusion']);
    // seat-a has 3 rows, seat-c has 3 rows — identity order breaks the tie.
    expect(cells[1]).toMatchObject({ kind: 'seat-exclusion', seatId: 'seat-a', reasonKind: 'unknown-usage', rows: 3, seatTotal: 3 });
    expect(cells[2]).toMatchObject({ kind: 'seat-exclusion', seatId: 'seat-c', reasonKind: 'signed-out', rows: 3 });
  });

  it('marks truncation as a lower bound on every emitted cell', () => {
    const f = fold([
      noSeat({ atMs: T_OLD, source: 'gateway' }),
      noSeat({ atMs: T_NEW, source: 'gateway' }),
      noSeat({ atMs: NOW - HOUR, source: 'gateway' }),
    ]);
    const cells = seatRouteCells(f, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('seatRouteBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    home = await mkdtemp(join(tmpdir(), 'seat-route-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A decisions journal: the live file plus an optional rotated decisions.1.jsonl generation. */
  async function journal(name: string, files: { live?: string[]; rotated?: string[] }): Promise<string> {
    const path = join(home, name, 'routing', 'decisions.jsonl');
    await mkdir(dirname(path), { recursive: true });
    if (files.live !== undefined) await writeFile(path, files.live.join('\n') + '\n');
    if (files.rotated !== undefined) await writeFile(path.replace(/\.jsonl$/, '.1.jsonl'), files.rotated.join('\n') + '\n');
    return path;
  }

  const T_OLD = NOW - 2 * DAY - 2 * HOUR; // 2026-11-22
  const T_NEW = NOW - DAY - 3 * HOUR; // 2026-11-23

  it('emits a backlog item for a recurring no-seat cell and validates it', async () => {
    const path = await journal('sr-a', {
      live: [
        noSeat({ atMs: T_OLD, actual: { engine: 'claude', seatId: null }, mode: 'balanced' }),
        noSeat({ atMs: T_OLD + HOUR, actual: null, mode: 'reserve' }),
        seated({ atMs: T_NEW }),
        noSeat({ atMs: T_NEW + HOUR, mode: 'all-in' }),
      ],
    });
    const items = await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'seat-route' });
    expect(item!.id).toMatch(/^seat-route-[0-9a-f]{16}$/);
    expect(item!.title).toContain('no eligible seat');
    expect(item!.title).toContain('gateway');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('decisions.jsonl');
    expect(item!.prompt).toContain('3 of 4 in-window decisions');
    expect(item!.prompt).toContain('claude×1');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits a backlog item for a recurring evidence-broken exclusion cell', async () => {
    const path = await journal('sr-b', {
      live: [
        routeRow({ atMs: T_OLD, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
        routeRow({ atMs: T_OLD + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage', 'spent'])] }),
        routeRow({ atMs: T_NEW, source: 'leader', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
        routeRow({ atMs: T_NEW + HOUR, source: 'gateway', seatId: 'seat-c', exclusions: [exclusion('seat-a', ['headroom'])] }),
      ],
    });
    const items = await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item!.title).toContain('seat-a');
    expect(item!.title).toContain('unknown-usage');
    expect(item!.prompt).toContain('3 adverse exclusion observations');
    // seat-a is named in all four rows' exclusions — the fourth only for the
    // non-adverse 'headroom' kind, which still counts toward the seat's total.
    expect(item!.prompt).toContain('4 total exclusion observations');
    expect(item!.prompt).toContain('75.0%');
    expect(item!.prompt).toContain('gateway×2, leader×1');
    expect(item!.prompt).toContain('runs.jsonl');
    expect(item!.prompt).toContain('no-change');
  });

  it('never emits exclusion items for daemon-source evidence', async () => {
    const path = await journal('sr-c', {
      live: [
        routeRow({ atMs: T_OLD, source: 'daemon', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
        routeRow({ atMs: T_OLD + HOUR, source: 'daemon', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
        routeRow({ atMs: T_NEW, source: 'daemon', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unknown-usage'])] }),
        // …but daemon no-seat decisions still count — starvation has no sibling fold.
        noSeat({ atMs: T_OLD, source: 'daemon', task: 'bulk' }),
        noSeat({ atMs: T_OLD + HOUR, source: 'daemon', task: 'bulk' }),
        noSeat({ atMs: T_NEW, source: 'daemon', task: 'bulk' }),
      ],
    });
    const items = await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('no eligible seat');
    expect(items[0]!.title).toContain('daemon');
    expect(items[0]!.prompt).not.toContain('seat-a');
  });

  it('emits nothing below the recurring bars of rows and days', async () => {
    const oneDay = await journal('sr-d', {
      live: [
        noSeat({ atMs: NOW - 2 * HOUR }),
        noSeat({ atMs: NOW - HOUR }),
        noSeat({ atMs: NOW - 30 * MIN }),
      ],
    });
    expect(await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: oneDay, now: new Date(NOW) })).toEqual([]);

    const twoRows = await journal('sr-e', {
      live: [noSeat({ atMs: NOW - 2 * DAY }), noSeat({ atMs: NOW - DAY })],
    });
    expect(await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: twoRows, now: new Date(NOW) })).toEqual([]);
    expect(SEAT_ROUTE_MIN_ROWS).toBe(3);
    expect(SEAT_ROUTE_MIN_DAYS).toBe(2);
  });

  it('reads both journal generations — the rotated decisions.1.jsonl counts', async () => {
    const path = await journal('sr-f', {
      rotated: [
        routeRow({ atMs: T_OLD, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unreachable'])] }),
        routeRow({ atMs: T_OLD + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unreachable'])] }),
      ],
      live: [routeRow({ atMs: T_NEW, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['unreachable'])] })],
    });
    const items = await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('unreachable');
    expect(items[0]!.prompt).toContain('3 adverse exclusion observations');
  });

  it('emits nothing for missing journals, another repository, or quiet evidence', async () => {
    expect(await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'no-such', 'decisions.jsonl'), now: new Date(NOW) })).toEqual([]);

    const path = await journal('sr-g', {
      live: [
        noSeat({ atMs: T_OLD }), noSeat({ atMs: T_OLD + HOUR }), noSeat({ atMs: T_NEW }),
      ],
    });
    expect(await seatRouteBacklogItems({ repo: 'ashlrai/other', journalPath: path, now: new Date(NOW) })).toEqual([]);
    // The bare name is not an owner/name backlog target.
    expect(await seatRouteBacklogItems({ repo: 'phantom', journalPath: path, now: new Date(NOW) })).toEqual([]);
    expect(await seatRouteBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: path, now: new Date(NOW) })).toHaveLength(1);
    expect(await seatRouteBacklogItems({ repo: '', journalPath: path, now: new Date(NOW) })).toEqual([]);

    const quiet = await journal('sr-h', { live: [seated({ atMs: T_OLD }), seated({ atMs: T_NEW })] });
    expect(await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: quiet, now: new Date(NOW) })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('sr-i', {
      live: [
        noSeat({ atMs: T_OLD }), noSeat({ atMs: T_OLD + HOUR }), noSeat({ atMs: T_NEW }),
      ],
    });
    // Pad the journal past the 4 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(5 * 1024 * 1024);
    await writeFile(path, pad + '\n' + [
      noSeat({ atMs: T_OLD }), noSeat({ atMs: T_OLD + HOUR }), noSeat({ atMs: T_NEW }),
    ].join('\n') + '\n');
    const items = await seatRouteBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = await journal('sr-j', {
      live: [
        routeRow({ atMs: T_OLD, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['signed-out'])] }),
        routeRow({ atMs: T_OLD + HOUR, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['signed-out'])] }),
        routeRow({ atMs: T_NEW, source: 'gateway', seatId: 'seat-b', exclusions: [exclusion('seat-a', ['signed-out'])] }),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: new Date(NOW) };
    const first = await seatRouteBacklogItems(opts);
    const second = await seatRouteBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(SEAT_ROUTE_BACKLOG_MAX_ITEMS);
    expect(SEAT_ROUTE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('appends seat-route items through discovery and dedupes on refresh', async () => {
    // The default journal path resolves under the relocated HOME:
    // ~/.ashlr/routing/decisions.jsonl (homedir-rooted; ASHLR_HOME is not consulted).
    // discoverBacklog anchors its window at the real clock, so these rows
    // are stamped relative to Date.now(), not the fixed NOW the unit tests
    // use. UTC noons two and one days back guarantee distinct UTC days at
    // any wall-clock time the suite runs.
    const d = new Date();
    const day2 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, 12);
    const day1 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 12);
    const dir = join(home, '.ashlr', 'routing');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'decisions.jsonl'), [
      noSeat({ atMs: day2, source: 'gateway' }),
      noSeat({ atMs: day2 + HOUR, source: 'gateway' }),
      noSeat({ atMs: day1, source: 'gateway' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const seatItems = first.items.filter((i) => i.id.startsWith('seat-route-'));
    expect(seatItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(seatItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('seat-route-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('seat-route-'))).toHaveLength(1);
  });
});
