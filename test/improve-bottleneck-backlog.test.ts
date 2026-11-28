import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOTTLENECK_MIN_CHECK_BLOCKED,
  BOTTLENECK_MIN_CHECK_ROWS,
  BOTTLENECK_MIN_EO_STALE_ROWS,
  BOTTLENECK_MIN_ERROR_ROWS,
  BOTTLENECK_MIN_PENDING,
  BOTTLENECK_MIN_PENDING_ROWS,
  BOTTLENECK_MIN_STALL_ROWS,
  bottleneckBacklogItems,
  bottleneckCells,
  foldBottleneckRows,
  parseBottleneckJournal,
  parseBottleneckJournalEntry,
} from '../src/core/improve/bottleneck-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const SCHEMA = 'ashlr.bottleneck-hourly/v1';

/**
 * One writer-shaped hourly row with HEALTHY defaults — every evidence
 * block present but below every cell bar, so tests inject the signal
 * they mean to measure instead of inheriting the fixture's own.
 * Overrides merge shallowly over the top level.
 */
const mkRow = (ts: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ts,
  schema: SCHEMA,
  per_repo: null,
  window: { stages: 'trailing 7d by mergedAt', gate: 'trailing 24h' },
  metrics: {
    stages: {
      open_to_merged: { n: 100, p50: 2.5, p95: 15 },
      gate_first_green_24h: { n: 50, p50: 1.1, p95: 2.4 },
      merged_to_released: { n: 2000, p50: 366, p95: 2665, n_pending: 30, pending_age_p50: 120, pending_age_p95: 800 },
      released_to_installed: { n: 201, p50: 36.7, p95: 169, n_pending: 25, pending_age_p50: 200, pending_age_p95: 600, scope: 'phantom only' },
    },
    per_repo: {},
    merges_last_hour_total: 7,
    merges_per_hour_24h_total: 17.7,
    cost_per_merged_pr: {},
  },
  bottleneck: { stage: 'released_to_installed', p50_min: 36.7, lower_bound: false, owner: 'Core', since: ts },
  rq_filed: null,
  merge_drop_attribution: {
    window: { this_hour: [ts, ts], prev_hour: [ts, ts] },
    repos: { phantom: { merged_this_h: 7, merged_prev_h: 9, opened_this_h: 30, opened_prev_h: 28, open_automerge: 350, conflicts: 12, blocked_required_checks: 3, required_check_states: {}, unknown_after_retry: 4, behind: 30, red_master_commits_this_h: 0, red_master_minutes: null, red_master_minutes_reason: 'x', master_commits_this_h: 40, merge_queue: [], est_supply_merges_lost: 0.2 } },
    checks: [{ repo: 'phantom', check: 'Merge Gate', failing: 2, pending: 5, missing: 1 }],
    lane_supply: {
      source: 'queue/status.json, metrics/load-curve.jsonl (1/min), metrics/jobs.jsonl',
      lanes: {
        'devin-flash': { queued_now: 0, target: 1, held: false, off: false, running_mean_this_h: 0.7, running_mean_prev_h: 0.8, zero_running_minutes_this_h: 4, minutes_sampled_this_h: 62, launches_this_h: 2, launches_prev_h: 2, launches_24h: 30, merge_rate_24h: 1.1, stalled: false, est_merges_lost: 0 },
        claude: { queued_now: 0, target: 1, held: false, off: false, running_mean_this_h: 0.8, running_mean_prev_h: 0.9, zero_running_minutes_this_h: 5, minutes_sampled_this_h: 62, launches_this_h: 2, launches_prev_h: 2, launches_24h: 40, merge_rate_24h: 2.0, stalled: false, est_merges_lost: 0 },
      },
    },
    phantom_secrets_freeze: { disabled_workflows: [], blocked_prs: null, evidence: 'x', reason: 'x' },
    ranked: [],
    est_is_inference: true,
    totals: { merged_this_h: 7, merged_prev_h: 9, opened_this_h: 30, opened_prev_h: 28 },
    incident: null,
  },
  errors: {},
  graphql_calls: 91,
  eo_ping: { warranted: false, unsent_pending: null, stale: false },
  burn_pace: { source: 'x', lanes: {} },
  reaper: { status: 'ok', window: 'last 1 h', sources: [], passes: 1, found: 3, reaped: 3, by_class: {} },
  ...over,
});

/** Distinct hourly timestamps alternating two UTC days — identical lines dedupe, so fixtures must not reuse ts. */
const spreadTs = (i: number, day1: string, day2: string): string =>
  new Date(Date.parse(i % 2 === 0 ? day1 : day2) + Math.floor(i / 2) * HOUR).toISOString();

const errRow = (ts: string, key = 'merge_drop', message = 'RuntimeError: graphql rc=1 gh: HTTP 504'): string =>
  J(mkRow(ts, { merge_drop_attribution: { error: message }, errors: { [key]: message } }));

/** A stalled devin-flash lane_supply block — the only evidence the row carries. */
const stallMda = (lane = 'devin-flash', over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lane_supply: {
    lanes: {
      [lane]: {
        queued_now: 4, target: 1, held: false, off: false,
        running_mean_this_h: 0, running_mean_prev_h: 0.1,
        zero_running_minutes_this_h: 62, minutes_sampled_this_h: 62,
        launches_this_h: 0, launches_prev_h: 1, launches_24h: 30,
        merge_rate_24h: 1.1, stalled: true, est_merges_lost: 1.1,
        ...over,
      },
    },
  },
});

const stallRow = (ts: string, lane = 'devin-flash'): string =>
  J(mkRow(ts, { merge_drop_attribution: stallMda(lane) }));

const checkRow = (ts: string, failing: number, missing: number, pending = 0, repo = 'phantom', check = 'Merge Gate'): string =>
  J(mkRow(ts, { merge_drop_attribution: { checks: [{ repo, check, failing, pending, missing }] } }));

const pendingRow = (ts: string, stage: string, nPending: number, p95: number): string =>
  J(mkRow(ts, { metrics: { stages: { [stage]: { n: 2000, p50: 300, p95: 2000, n_pending: nPending, pending_age_p50: 3000, pending_age_p95: p95 } } } }));

const staleEoRow = (ts: string): string =>
  J(mkRow(ts, {
    eo_ping: {
      warranted: true, stale: true,
      unsent_pending: { ts: '2026-11-20T01:00:00-05:00', age_h: 80, stale: true, reasons: ['merged_to_released p50 249 -> 337 min (+35%)'] },
    },
  }));

describe('parseBottleneckJournalEntry', () => {
  it('accepts a writer-shaped row and extracts every folded block', () => {
    // Enrich the healthy default into the fully-loaded row the writer
    // emits on a bad hour: stalled lane, deep check block, pending
    // backlog, stale EO ping.
    const row = parseBottleneckJournalEntry(mkRow('2026-11-23T10:00:00-05:00', {
      metrics: {
        stages: {
          merged_to_released: { n: 2000, p50: 366, p95: 2665, n_pending: 704, pending_age_p50: 4000, pending_age_p95: 9728 },
          released_to_installed: { n: 201, p50: 36.7, p95: 169, n_pending: 1798, pending_age_p50: 4100, pending_age_p95: 9724, scope: 'phantom only' },
        },
      },
      merge_drop_attribution: {
        repos: { phantom: { merged_this_h: 7 } },
        checks: [{ repo: 'phantom', check: 'Merge Gate', failing: 330, pending: 0, missing: 16 }],
        ...stallMda(),
      },
      eo_ping: { warranted: true, stale: true, unsent_pending: { ts: 'x', age_h: 81.2, stale: true, reasons: ['r'] } },
    }));
    expect(row).not.toBeNull();
    expect(row!.utcDay).toBe('2026-11-23');
    expect(row!.stages.get('merged_to_released')).toMatchObject({ n: 2000, nPending: 704, pendingAgeP95: 9728 });
    expect(row!.stages.get('released_to_installed')!.scope).toBe('phantom only');
    expect(row!.mdaCovered).toBe(true);
    expect(row!.laneStalls).toHaveLength(1);
    expect(row!.laneStalls[0]).toMatchObject({ lane: 'devin-flash', queuedNow: 4, zeroRunningMinThisH: 62, estMergesLost: 1.1 });
    expect(row!.checkBlocks).toEqual([{ repo: 'phantom', check: 'Merge Gate', failing: 330, pending: 0, missing: 16 }]);
    expect(row!.eoWarranted).toBe(true);
    expect(row!.eoStale).toMatchObject({ ageHours: 81.2, reasons: ['r'] });
    // Healthy default row: present blocks, nothing at any bar.
    const quiet = parseBottleneckJournalEntry(mkRow('2026-11-23T11:00:00Z'));
    expect(quiet!.laneStalls).toEqual([]);
    expect(quiet!.checkBlocks).toEqual([{ repo: 'phantom', check: 'Merge Gate', failing: 2, pending: 5, missing: 1 }]);
    expect(quiet!.eoStale).toBeNull();
  });

  it('rejects rows failing the schema-plus-timestamp frame', () => {
    const bad: unknown[] = [
      null, 'x', [],
      mkRow('2026-11-23T10:00:00Z', { schema: 'ashlr.bottleneck-hourly/v2' }),
      mkRow('2026-11-23T10:00:00Z', { schema: undefined }),
      mkRow('not a date'),
      mkRow('2026-11-23T10:00:00Z', { ts: 1730000000 }),
    ];
    for (const value of bad) expect(parseBottleneckJournalEntry(value)).toBeNull();
  });

  it('treats absent and evolved blocks as unrecorded evidence, never zeros', () => {
    // Early-schema row: eo_ping was a boolean; per_repo/burn_pace/reaper
    // did not exist yet.
    const early = mkRow('2026-11-16T14:55:03-05:00', { eo_ping: false });
    delete early['burn_pace'];
    delete early['reaper'];
    delete early['per_repo'];
    const row = parseBottleneckJournalEntry(early);
    expect(row).not.toBeNull();
    expect(row!.eoWarranted).toBe(false);
    expect(row!.eoStale).toBeNull();
    expect(row!.laneStalls).toEqual([]);
    // merge_drop_attribution as {error} dict: no repos object → not covered, no stalls/checks.
    const errored = parseBottleneckJournalEntry(mkRow('2026-11-23T10:00:00Z', {
      merge_drop_attribution: { error: 'RuntimeError: graphql rc=1 gh: HTTP 504' },
      errors: { merge_drop: 'RuntimeError: graphql rc=1 gh: HTTP 504' },
    }));
    expect(errored!.mdaCovered).toBe(false);
    expect(errored!.errors.map((e) => e.key)).toEqual(['merge_drop']);
    expect(errored!.checkBlocks).toEqual([]);
    // A stage object with no measured field carries no evidence.
    const emptyStage = parseBottleneckJournalEntry(mkRow('2026-11-23T10:00:00Z', {
      metrics: { stages: { merged_to_released: { n: null, p50: null, p95: null } } },
    }));
    expect(emptyStage!.stages.has('merged_to_released')).toBe(false);
  });
});

describe('parseBottleneckJournal', () => {
  it('counts malformed and off-frame lines, dedupes exact replays', () => {
    const a = J(mkRow('2026-11-23T10:00:00Z'));
    const b = J(mkRow('2026-11-23T11:00:00Z', { errors: { merge_drop: 'x' } }));
    const text = [a, a, b, 'not json', J({ schema: 'other/v9' }), '', '   '].join('\n');
    const parsed = parseBottleneckJournal(text);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.replayedRows).toBe(1);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldBottleneckRows + bottleneckCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const DAY1 = '2026-11-21T00:00:00Z';
  const DAY2 = '2026-11-22T00:00:00Z';
  const OLD = '2026-11-01T10:00:00Z'; // outside the 7-day window

  /** n error rows for one key spread over two UTC days at distinct hours. */
  const errorRows = (key: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => errRow(spreadTs(i, DAY1, DAY2), key));

  it('emits an analyzer-errors cell per key at the row/day bars', () => {
    const cells = bottleneckCells(foldBottleneckRows(errorRows('merge_drop', BOTTLENECK_MIN_ERROR_ROWS).join('\n'), { nowMs: NOW }));
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('analyzer-errors');
    if (cell.kind !== 'analyzer-errors') return;
    expect(cell.key).toBe('merge_drop');
    expect(cell.rows).toBe(BOTTLENECK_MIN_ERROR_ROWS);
    expect(cell.days).toEqual(['2026-11-21', '2026-11-22']);
    expect(cell.lastMessage).toContain('HTTP 504');

    // Below the row bar and single-day recurrence both stay silent.
    expect(bottleneckCells(foldBottleneckRows(errorRows('merge_drop', BOTTLENECK_MIN_ERROR_ROWS - 1).join('\n'), { nowMs: NOW }))).toEqual([]);
    const oneDay = Array.from({ length: BOTTLENECK_MIN_ERROR_ROWS }, (_, i) =>
      errRow(new Date(Date.parse(DAY1) + i * HOUR).toISOString(), 'merge_drop')).join('\n');
    expect(bottleneckCells(foldBottleneckRows(oneDay, { nowMs: NOW }))).toEqual([]);
    // Two keys each below the bar do not merge into one cell.
    const split = [...errorRows('merge_drop', 3), ...errorRows('phantom:prs', 3)].join('\n');
    expect(bottleneckCells(foldBottleneckRows(split, { nowMs: NOW }))).toEqual([]);
  });

  it('emits a lane-stall cell per lane at the stalled-row/day bars', () => {
    const rows = Array.from({ length: BOTTLENECK_MIN_STALL_ROWS }, (_, i) => stallRow(spreadTs(i, DAY1, DAY2)));
    // A healthy lane on the same rows must not join the tally — and the
    // healthy row's own blocks stay below every other bar.
    rows.push(J(mkRow(spreadTs(99, DAY1, DAY2))));
    const cells = bottleneckCells(foldBottleneckRows(rows.join('\n'), { nowMs: NOW }));
    const stall = cells.find((c) => c.kind === 'lane-stall');
    expect(stall).toBeDefined();
    if (stall!.kind !== 'lane-stall') return;
    expect(stall!.lane).toBe('devin-flash');
    expect(stall!.rows).toBe(BOTTLENECK_MIN_STALL_ROWS);
    expect(stall!.latest.queuedNow).toBe(4);
    expect(stall!.latest.estMergesLost).toBe(1.1);

    // stalled:false never counts; below the row bar stays silent.
    const notStalled = J(mkRow(spreadTs(BOTTLENECK_MIN_STALL_ROWS, DAY1, DAY2), {
      merge_drop_attribution: stallMda('devin-flash', { stalled: false }),
    }));
    const under = [...Array.from({ length: BOTTLENECK_MIN_STALL_ROWS - 1 }, (_, i) => stallRow(spreadTs(i, DAY1, DAY2))), notStalled];
    expect(bottleneckCells(foldBottleneckRows(under.join('\n'), { nowMs: NOW }))
      .filter((c) => c.kind === 'lane-stall')).toEqual([]);
    // Single-day recurrence stays silent even with enough rows.
    const oneDay = Array.from({ length: BOTTLENECK_MIN_STALL_ROWS }, (_, i) =>
      stallRow(new Date(Date.parse(DAY1) + i * HOUR).toISOString())).join('\n');
    expect(bottleneckCells(foldBottleneckRows(oneDay, { nowMs: NOW }))).toEqual([]);
  });

  it('emits a check-block cell per (repo, check) on hard-blocked bars only', () => {
    const rows = Array.from({ length: BOTTLENECK_MIN_CHECK_ROWS }, (_, i) => checkRow(spreadTs(i, DAY1, DAY2), 330, 16));
    const cells = bottleneckCells(foldBottleneckRows(rows.join('\n'), { nowMs: NOW }));
    const cell = cells.find((c) => c.kind === 'check-block');
    expect(cell).toBeDefined();
    if (cell === undefined || cell.kind !== 'check-block') return;
    expect(cell.repo).toBe('phantom');
    expect(cell.check).toBe('Merge Gate');
    expect(cell.maxBlocked).toBe(346);
    expect(cell.latest.pending).toBe(0);

    // Below the hard-blocked bar: pending-heavy but green-able rows do not count.
    const soft = Array.from({ length: 8 }, (_, i) => checkRow(spreadTs(i, DAY1, DAY2), 5, 2, 40)).join('\n');
    expect(bottleneckCells(foldBottleneckRows(soft, { nowMs: NOW }))).toEqual([]);
    // Exactly at the bar counts.
    const atBar = Array.from({ length: BOTTLENECK_MIN_CHECK_ROWS }, (_, i) =>
      checkRow(spreadTs(i, DAY1, DAY2), BOTTLENECK_MIN_CHECK_BLOCKED - 10, 10)).join('\n');
    expect(bottleneckCells(foldBottleneckRows(atBar, { nowMs: NOW })).map((c) => c.kind)).toContain('check-block');
    // A check entry missing 'failing' cannot compute the hard block and is skipped.
    const partial = J(mkRow(spreadTs(90, DAY1, DAY2), {
      merge_drop_attribution: { checks: [{ repo: 'phantom', check: 'Merge Gate', missing: 50 }] },
    }));
    expect(bottleneckCells(foldBottleneckRows(partial, { nowMs: NOW }))).toEqual([]);
  });

  it('emits a release-pending cell per stage over the pending bars', () => {
    const rows = Array.from({ length: BOTTLENECK_MIN_PENDING_ROWS }, (_, i) => pendingRow(spreadTs(i, DAY1, DAY2), 'merged_to_released', BOTTLENECK_MIN_PENDING, 9728));
    const cells = bottleneckCells(foldBottleneckRows(rows.join('\n'), { nowMs: NOW }));
    const cell = cells.find((c) => c.kind === 'release-pending');
    expect(cell).toBeDefined();
    if (cell === undefined || cell.kind !== 'release-pending') return;
    expect(cell.stage).toBe('merged_to_released');
    expect(cell.pendingRows).toBe(BOTTLENECK_MIN_PENDING_ROWS);

    // Small pending counts and young pending ages stay silent.
    const quiet = Array.from({ length: 8 }, (_, i) => pendingRow(spreadTs(i, DAY1, DAY2), 'merged_to_released', 50, 900)).join('\n');
    expect(bottleneckCells(foldBottleneckRows(quiet, { nowMs: NOW }))).toEqual([]);
    // A stage with no pending fields at all never qualifies.
    const noPending = J(mkRow(spreadTs(90, DAY1, DAY2), { metrics: { stages: { open_to_merged: { n: 100, p50: 2.5, p95: 15 } } } }));
    expect(bottleneckCells(foldBottleneckRows(noPending, { nowMs: NOW }))).toEqual([]);
  });

  it('emits the eo-ping-stale cell at the stale-row/day bars', () => {
    const rows = Array.from({ length: BOTTLENECK_MIN_EO_STALE_ROWS }, (_, i) => staleEoRow(spreadTs(i, DAY1, DAY2)));
    const cells = bottleneckCells(foldBottleneckRows(rows.join('\n'), { nowMs: NOW }));
    const cell = cells.find((c) => c.kind === 'eo-ping-stale');
    expect(cell).toBeDefined();
    if (cell === undefined || cell.kind !== 'eo-ping-stale') return;
    expect(cell.staleRows).toBe(BOTTLENECK_MIN_EO_STALE_ROWS);
    expect(cell.warrantedRows).toBe(BOTTLENECK_MIN_EO_STALE_ROWS);
    expect(cell.ageHours).toBe(80);
    expect(cell.reasons[0]).toContain('merged_to_released');

    // Fresh (non-stale) pending pings and sub-bar stale counts stay silent.
    const fresh = J(mkRow(spreadTs(90, DAY1, DAY2), {
      eo_ping: { warranted: true, stale: false, unsent_pending: { ts: DAY1, age_h: 0.5, stale: false, reasons: [] } },
    }));
    expect(bottleneckCells(foldBottleneckRows(fresh, { nowMs: NOW }))).toEqual([]);
    const few = Array.from({ length: BOTTLENECK_MIN_EO_STALE_ROWS - 1 }, (_, i) => staleEoRow(spreadTs(i, DAY1, DAY2))).join('\n');
    expect(bottleneckCells(foldBottleneckRows(few, { nowMs: NOW }))).toEqual([]);
  });

  it('emits corrupt-lines at the contract-failure bar and windows on ts', () => {
    const corrupt = ['not json at all', J({ schema: 'wrong/v1' }), J(mkRow('bad ts'))];
    const fold = foldBottleneckRows(corrupt.join('\n'), { nowMs: NOW });
    expect(fold.invalidRows).toBe(3);
    const cells = bottleneckCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'corrupt-lines', invalidRows: 3 });

    // Out-of-window rows are context; future-skew rows still count.
    const windowed = [
      J(mkRow(OLD, { errors: { merge_drop: 'x' } })),
      J(mkRow(new Date(NOW + 30_000).toISOString(), { errors: { merge_drop: 'x' } })),
      J(mkRow(new Date(NOW + 10 * MIN).toISOString(), { errors: { merge_drop: 'x' } })), // past skew
    ].join('\n');
    const wf = foldBottleneckRows(windowed, { nowMs: NOW });
    expect(wf.outsideWindow).toBe(2);
    expect(wf.rows).toBe(1);
    expect(wf.errors.get('merge_drop')!.rows).toBe(1);
  });
});

describe('bottleneckBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const DAY1 = new Date(NOW - 2 * DAY).toISOString();
  const DAY2 = new Date(NOW - DAY).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'bottleneck-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir with ledger/bottleneck-hourly.jsonl written when rows are provided. */
  async function runsDir(name: string, rows?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'ledger'), { recursive: true });
    if (rows !== undefined) {
      await writeFile(join(dir, 'ledger', 'bottleneck-hourly.jsonl'), rows.join('\n') + '\n');
    }
    return dir;
  }

  const errRows = (key: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => errRow(spreadTs(i, DAY1, DAY2), key));
  const stallRows = (lane: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => stallRow(spreadTs(i, DAY1, DAY2), lane));

  it('emits recurring-evidence items that pass the backlog contract', async () => {
    const dir = await runsDir('runs-cells', [
      ...errRows('merge_drop', BOTTLENECK_MIN_ERROR_ROWS),
      ...stallRows('devin-flash', BOTTLENECK_MIN_STALL_ROWS),
      ...Array.from({ length: BOTTLENECK_MIN_CHECK_ROWS }, (_, i) => checkRow(spreadTs(i, DAY1, DAY2), 330, 16)),
      ...Array.from({ length: BOTTLENECK_MIN_PENDING_ROWS }, (_, i) => pendingRow(spreadTs(i, DAY1, DAY2), 'merged_to_released', BOTTLENECK_MIN_PENDING, 9700)),
    ]);
    const items = await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (const item of items) {
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'bottleneck-hourly' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('bottleneck-hourly.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    const kinds = items.map((i) => i.id.split('-').slice(0, 2).join('-'));
    expect(kinds).toContain('bottleneck-errors');
    expect(kinds).toContain('bottleneck-lane');
    expect(kinds).toContain('bottleneck-check');
    expect(kinds).toContain('bottleneck-pending');
    const errors = items.find((i) => i.id.includes('bottleneck-errors'))!;
    expect(errors.prompt).toContain('merge_drop');
    expect(errors.prompt).toContain('HTTP 504');
    const stall = items.find((i) => i.id.includes('bottleneck-lane-stall'))!;
    expect(stall.prompt).toContain('devin-flash');
    expect(stall.prompt).toContain('labelled inference');
    const check = items.find((i) => i.id.includes('bottleneck-check'))!;
    expect(check.prompt).toContain('Merge Gate');
    expect(check.prompt).toContain('failing + missing');
    const pending = items.find((i) => i.id.includes('bottleneck-pending'))!;
    expect(pending.prompt).toContain('merged_to_released');
    expect(pending.prompt).toContain('n_pending');
    // Stable ids: a refresh re-derives the same identities.
    const again = await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits the eo-ping-stale and corrupt-lines items at their bars', async () => {
    const staleRows = Array.from({ length: BOTTLENECK_MIN_EO_STALE_ROWS }, (_, i) => staleEoRow(spreadTs(i, DAY1, DAY2)));
    const dir = await runsDir('runs-eo', staleRows);
    const items = await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toContain('bottleneck-eo-stale');
    expect(items[0]!.prompt).toContain('unrelayed');
    expect(items[0]!.prompt).toContain('merged_to_released p50');

    const corruptDir = await runsDir('runs-corrupt', ['torn line', J({ schema: 'nope/v0' }), J(mkRow('bad ts'))]);
    const corruptItems = await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: corruptDir, now: NOW });
    expect(corruptItems).toHaveLength(1);
    expect(corruptItems[0]!.id).toContain('bottleneck-corrupt');
    expect(corruptItems[0]!.prompt).toContain('contract');
  });

  it('emits nothing for absent journals, foreign repos or sub-bar evidence', async () => {
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const bare = await runsDir('runs-bare'); // ledger dir, no journal
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: bare, now: NOW })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);
    // Foreign repository never inherits this install's fleet evidence.
    const gap = await runsDir('runs-repo', errRows('merge_drop', BOTTLENECK_MIN_ERROR_ROWS));
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/other', runsDir: gap, now: NOW })).toEqual([]);
    expect(await bottleneckBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: gap, now: NOW })).toHaveLength(1);
    // Sub-bar: a handful of error rows never reaches the recurrence bars.
    const few = await runsDir('runs-few', errRows('merge_drop', 3));
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: NOW })).toEqual([]);
    // Healthy rows only: no cells.
    const healthy = await runsDir('runs-healthy', [J(mkRow(DAY1)), J(mkRow(DAY2))]);
    expect(await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: NOW })).toEqual([]);
    // Honours the item limit across multiple cells.
    const two = await runsDir('runs-two', [...errRows('merge_drop', BOTTLENECK_MIN_ERROR_ROWS), ...stallRows('devin-flash', BOTTLENECK_MIN_STALL_ROWS)]);
    const limited = await bottleneckBacklogItems({ repo: 'ashlrai/phantom', runsDir: two, now: NOW, limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describe('discoverBacklog integration', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const DAY1 = new Date(NOW - 2 * DAY).toISOString();
  const DAY2 = new Date(NOW - DAY).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'bottleneck-discover-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it('appends bottleneck items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'ledger'), { recursive: true });
    const rows = Array.from({ length: BOTTLENECK_MIN_ERROR_ROWS }, (_, i) =>
      errRow(spreadTs(i, DAY1, DAY2), 'merge_drop'));
    await writeFile(join(runs, 'ledger', 'bottleneck-hourly.jsonl'), rows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const bottleneckItems = first.items.filter((i) => i.id.includes('bottleneck-'));
    expect(bottleneckItems.length).toBeGreaterThan(0);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(bottleneckItems)).toBe(bottleneckItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.includes('bottleneck-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.includes('bottleneck-'))).toHaveLength(bottleneckItems.length);
  });
});
