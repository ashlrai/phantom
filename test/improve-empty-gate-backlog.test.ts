import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_GATE_MIN_DAYS,
  EMPTY_GATE_MIN_JOBS,
  EMPTY_GATE_MIN_ROWS,
  EMPTY_GATE_WINDOW_HOURS,
  emptyGateBacklogItems,
  emptyGateCells,
  foldEmptyGateJournal,
} from '../src/core/improve/empty-gate-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like restock's writer emits. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One empty-gate skipped_empty row in the writers' shape (dispatchd/restock). */
function gateRow(spec: {
  job: string;
  atMs?: number;
  ts?: string;
  reason?: string | null;
  code?: number | string | null;
  precheckCode?: number | null;
  applied?: boolean;
  lane?: string | null;
  repo?: string | null;
  event?: string;
  extra?: Record<string, unknown>;
}): string {
  const row: Record<string, unknown> = {
    event: spec.event ?? 'skipped_empty',
    job: spec.job,
    repo: spec.repo === undefined ? 'ashlrai/phantom' : spec.repo,
    lane: spec.lane === undefined ? 'claude' : spec.lane,
    reason: spec.reason === undefined ? 'task_empty_repeat_24h' : spec.reason,
    ts: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    ...spec.extra,
  };
  if (spec.code !== undefined) row['code'] = spec.code;
  if (spec.precheckCode !== undefined) row['precheck_code'] = spec.precheckCode;
  if (spec.applied !== undefined) row['applied'] = spec.applied;
  for (const key of ['repo', 'lane', 'reason', 'code', 'precheck_code'] as const) {
    if (row[key] === null) delete row[key];
  }
  return J(row);
}

/** n decline rows for distinct jobs spread across `days` distinct UTC days ending today. */
function gateSeries(
  reason: string,
  days: number,
  perDay: number,
  opts: { lane?: string; repo?: string; prefix?: string } = {},
): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(gateRow({
        job: `${opts.prefix ?? 'RQ-G'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR,
        reason, lane: opts.lane, repo: opts.repo,
      }));
    }
  }
  return rows;
}

/** Repeated decline rows for one job spread across `days` distinct UTC days. */
function jobSeries(
  job: string,
  days: number,
  perDay: number,
  opts: { reason?: string; lane?: string } = {},
): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(gateRow({
        job,
        atMs: NOW_MS - d * DAY - i * HOUR,
        reason: opts.reason ?? 'prompt_empty_same_base_24h',
        lane: opts.lane,
      }));
    }
  }
  return rows;
}

/** The production fold over joined rows. */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldEmptyGateJournal(rows.join('\n'), nowMs, EMPTY_GATE_WINDOW_HOURS);
}

describe('foldEmptyGateJournal', () => {
  it('keeps only reason-decline skipped_empty rows with safe job ids inside the window', () => {
    const rows = [
      gateRow({ job: 'RQ-OK', atMs: NOW_MS - HOUR }),
      // Stale: predates the window.
      gateRow({ job: 'RQ-OLD', atMs: NOW_MS - EMPTY_GATE_WINDOW_HOURS * 3_600_000 - DAY }),
      // Future-dated beyond skew — untrustworthy, contributes nothing.
      gateRow({ job: 'RQ-FUT', atMs: NOW_MS + 600_000 }),
      // Undated row — unknown stays unknown.
      gateRow({ job: 'RQ-NODATE', ts: 'not-a-date' }),
      // Precheck declines carry a numeric code — the sibling feed's evidence.
      gateRow({ job: 'RQ-CODE', atMs: NOW_MS - HOUR, code: 10 }),
      gateRow({ job: 'RQ-PCODE', atMs: NOW_MS - HOUR, precheckCode: 12 }),
      // A coded row stays excluded even when it also carries a reason.
      gateRow({ job: 'RQ-BOTH', atMs: NOW_MS - HOUR, code: 11, reason: 'task_empty_repeat_24h' }),
      // Dry-run rows record the job still launched.
      gateRow({ job: 'RQ-DRY', atMs: NOW_MS - HOUR, applied: false }),
      // Other events never count even when they carry decline-shaped fields.
      gateRow({ job: 'RQ-LAUNCH', event: 'launch', atMs: NOW_MS - HOUR, extra: { note: 'skipped_empty mention' } }),
      gateRow({ job: 'RQ-PARK', event: 'precheck_parked', atMs: NOW_MS - HOUR, extra: { note: 'skipped_empty mention' } }),
      // Node-pool producer schemas are never dispatch attempts.
      J({ schema: 'fleet.session-pool.v1', event: 'skipped_empty', job: 'sess-1:2', ts: iso(NOW_MS - HOUR), reason: 'task_empty_repeat_24h' }),
      J({ schema: 'phm-node-runner.v1', event: 'skipped_empty', job: 'job-1:tok', ts: iso(NOW_MS - HOUR), reason: 'task_empty_repeat_24h' }),
      // Unsafe job ids never reach the fold.
      gateRow({ job: '../escape', atMs: NOW_MS - HOUR }),
      gateRow({ job: 'has space', atMs: NOW_MS - HOUR }),
      'not json skipped_empty',
      '{"skipped_empty":',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toHaveLength(1);
    expect(fold.rows[0]!.job).toBe('RQ-OK');
    expect(fold.malformed).toBe(2);
  });

  it('records the reason label, lane and repo tallies verbatim-sanitized', () => {
    const rows = [
      gateRow({ job: 'RQ-A', atMs: NOW_MS - 2 * DAY, reason: 'upkeep_empty_same_base', lane: 'devin', repo: 'ashlrai/phantom' }),
      gateRow({ job: 'RQ-B', atMs: NOW_MS - DAY, reason: 'upkeep_empty_same_base', lane: 'claude', repo: 'ashlrai/other' }),
      // Missing fields degrade to recorded fallbacks, never zero.
      gateRow({ job: 'RQ-C', atMs: NOW_MS - HOUR, reason: null, lane: null, repo: null }),
      // Alternate reason spellings fold in the router's precedence.
      gateRow({ job: 'RQ-D', atMs: NOW_MS - HOUR, reason: null, extra: { empty_reason: 'rebase_claim_in_flight_wait_for_finish' } }),
      // A malformed first spelling decides — no fallthrough to a weaker key.
      gateRow({ job: 'RQ-E', atMs: NOW_MS - HOUR, reason: 'Not A Label!', extra: { empty_reason: 'task_empty_repeat_24h' } }),
      // A string code is the sibling readers' label spelling.
      gateRow({ job: 'RQ-F', atMs: NOW_MS - HOUR, reason: null, code: 'custom_gate_label' }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toHaveLength(6);
    const byJob = new Map(fold.rows.map((r) => [r.job, r]));
    expect(byJob.get('RQ-A')).toMatchObject({ reason: 'upkeep_empty_same_base', lane: 'devin', repo: 'ashlrai/phantom' });
    expect(byJob.get('RQ-B')!.repo).toBe('ashlrai/other');
    expect(byJob.get('RQ-C')).toMatchObject({ reason: 'unrecorded reason', lane: 'unknown', repo: 'unattributed' });
    expect(byJob.get('RQ-D')!.reason).toBe('rebase_claim_in_flight_wait_for_finish');
    expect(byJob.get('RQ-E')!.reason).toBe('unrecorded reason');
    expect(byJob.get('RQ-F')!.reason).toBe('custom_gate_label');
  });

  it('parses dispatchd local-offset timestamps like the sibling folds', () => {
    // dispatchd writes %Y-%m-%dT%H:%M:%S%z — offset without a colon.
    const ts = '2026-11-23T07:00:00-0500'; // = 12:00Z = NOW_MS
    const fold = foldRows([gateRow({ job: 'RQ-TZ', ts })]);
    expect(fold.rows).toHaveLength(1);
    expect(fold.rows[0]!.atMs).toBe(NOW_MS);
  });
});

describe('emptyGateCells', () => {
  it('emits a reason cell only at the job and day bars', () => {
    // Below the job bar: two distinct jobs across two days.
    const few = foldRows(gateSeries('task_empty_repeat_24h', EMPTY_GATE_MIN_DAYS, 1, { prefix: 'RQ-F' }));
    expect(few.rows).toHaveLength(EMPTY_GATE_MIN_JOBS - 1);
    expect(emptyGateCells(few.rows)).toEqual([]);

    // Below the day bar: enough jobs but all on one UTC day.
    const oneDay = foldRows(gateSeries('task_empty_repeat_24h', 1, EMPTY_GATE_MIN_JOBS + 2, { prefix: 'RQ-O' }));
    expect(emptyGateCells(oneDay.rows)).toEqual([]);

    // At the bars: enough distinct jobs across two days.
    const recurring = foldRows(gateSeries('task_empty_repeat_24h', EMPTY_GATE_MIN_DAYS, 2, { prefix: 'RQ-R', lane: 'claude' }));
    const cells = emptyGateCells(recurring.rows);
    // 4 decline rows fold into one reason cell AND one job cell per job —
    // each job declined twice on one day never reaches the job bar.
    const reasonCells = cells.filter((c) => c.kind === 'reason');
    expect(reasonCells).toHaveLength(1);
    const cell = reasonCells[0]!;
    expect(cell.reason).toBe('task_empty_repeat_24h');
    expect(cell.count).toBe(4);
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.lanes).toEqual([{ text: 'claude', count: 4 }]);
    expect(cell.repos).toEqual([{ text: 'ashlrai/phantom', count: 4 }]);
    expect(cell.jobs).toHaveLength(3);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(emptyGateCells(recurring.rows, true)[0]!.lowerBound).toBe(true);
  });

  it('emits a job cell only at the row and day bars', () => {
    // One job declined twice on one day — below the row bar.
    const thin = foldRows(jobSeries('RQ-STICK', 1, EMPTY_GATE_MIN_ROWS - 1));
    expect(emptyGateCells(thin.rows)).toEqual([]);

    // Enough rows but all on one UTC day.
    const oneDay = foldRows(jobSeries('RQ-STICK', 1, EMPTY_GATE_MIN_ROWS + 2));
    expect(emptyGateCells(oneDay.rows)).toEqual([]);

    // At the bars: repeated declines across two days.
    const recurring = foldRows(jobSeries('RQ-STICK', EMPTY_GATE_MIN_DAYS, 2));
    const jobCells = emptyGateCells(recurring.rows).filter((c) => c.kind === 'job');
    expect(jobCells).toHaveLength(1);
    const cell = jobCells[0]!;
    expect(cell.job).toBe('RQ-STICK');
    expect(cell.count).toBe(4);
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.reasons).toEqual([{ text: 'prompt_empty_same_base_24h', count: 4 }]);
  });

  it('sorts cells worst-first and never emits one-off or healthy evidence', () => {
    const rows = [
      // A reason cell at the bars (4 jobs × 2 days = 4 distinct jobs).
      ...gateSeries('rebase_retry_exhausted_3x_inspect_claims_change_head_or_task', 2, 2, { prefix: 'RQ-I' }),
      // A job cell at the bars (1 job × 6 rows × 3 days) — the worst cell.
      ...jobSeries('RQ-STUCK', 3, 2, { reason: 'upkeep_empty_same_base' }),
      // One-off declines: a single job once, a reason on one day.
      gateRow({ job: 'RQ-ONCE', atMs: NOW_MS - HOUR }),
      ...gateSeries('prompt_empty_same_base_24h', 1, EMPTY_GATE_MIN_JOBS + 1, { prefix: 'RQ-U' }),
    ];
    const cells = emptyGateCells(foldRows(rows).rows);
    const kinds = cells.map((c) => `${c.kind}:${c.kind === 'reason' ? c.reason : c.job}`);
    // Job cell count is its 6 recorded rows; the reason cell counts its
    // 4 distinct jobs — the job cell sorts first on count.
    expect(kinds[0]).toBe('job:RQ-STUCK');
    expect(kinds).toContain('reason:rebase_retry_exhausted_3x_inspect_claims_change_head_or_task');
    expect(kinds).not.toContain('reason:prompt_empty_same_base_24h');
    expect(cells.find((c) => c.kind === 'reason')!.count).toBe(4);
  });
});

describe('emptyGateBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'empty-gate-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/jobs.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), rows.join('\n') + '\n');
    return dir;
  }

  it('emits an empty-gate item for a recurring decline reason', async () => {
    const rows = gateSeries('task_empty_repeat_24h', 3, 1, { prefix: 'RQ-A', lane: 'claude' });
    const dir = await runsDir('runs-gate', rows);
    const items = await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const reasonItems = items.filter((i) => i.prompt.includes('reason \'task_empty_repeat_24h\''));
    expect(reasonItems).toHaveLength(1);
    const [item] = reasonItems;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'empty-gates' });
    expect(item!.id).toMatch(/^fleet-empty-gate-[0-9a-f]{16}$/);
    expect(item!.title).toContain('task_empty_repeat_24h');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('skipped_empty');
    expect(item!.prompt).toContain('jobs.jsonl');
    expect(item!.prompt).toContain('claude');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits a job item for a repeatedly declined job and names the re-add path', async () => {
    const rows = jobSeries('RQ-STUCK', 3, 2, { reason: 'rebase_claim_in_flight_wait_for_finish' });
    const dir = await runsDir('runs-stuck', rows);
    const items = await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const jobItems = items.filter((i) => i.title.includes('RQ-STUCK'));
    expect(jobItems).toHaveLength(1);
    const [item] = jobItems;
    expect(item!.prompt).toContain('RQ-STUCK');
    expect(item!.prompt).toContain('router-queue');
    expect(item!.prompt).toContain('rebase_claim_in_flight_wait_for_finish');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const empty = await runsDir('runs-empty', []);
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'jobs.jsonl'), { recursive: true });
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW })).toEqual([]);

    // Below the day bar: one burst day of declines.
    const thin = await runsDir('runs-thin', gateSeries('task_empty_repeat_24h', 1, EMPTY_GATE_MIN_JOBS + 2, { prefix: 'RQ-T' }));
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/lexicon', runsDir: thin, now: NOW })).toEqual([]);
    expect(await emptyGateBacklogItems({ repo: '', runsDir: thin, now: NOW })).toEqual([]);

    // A healthy ledger: launches, finishes and coded precheck declines emit nothing.
    const healthy = await runsDir('runs-healthy', [
      J({ event: 'launch', job: 'RQ-H0', lane: 'claude', ts: iso(NOW_MS - DAY) }),
      J({ event: 'finish', job: 'RQ-H0', lane: 'claude', ts: iso(NOW_MS - HOUR) }),
      gateRow({ job: 'RQ-H1', atMs: NOW_MS - HOUR, code: 10 }),
      gateRow({ job: 'RQ-H2', atMs: NOW_MS - 2 * HOUR, code: 12 }),
      gateRow({ job: 'RQ-H3', atMs: NOW_MS - 3 * HOUR, code: 10 }),
    ]);
    expect(await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = gateSeries('task_empty_repeat_24h', 3, 1, { prefix: 'RQ-TR' });
    // Pad the ledger past the 16 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(17 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await emptyGateBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...gateSeries('task_empty_repeat_24h', 2, 2, { prefix: 'RQ-S1' }),
      ...gateSeries('upkeep_empty_same_base', 3, 1, { prefix: 'RQ-S2' }),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await emptyGateBacklogItems(opts);
    const second = await emptyGateBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(2);
    const limited = await emptyGateBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends empty-gate items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      gateRow({ job: 'RQ-D0', atMs: at(0), reason: 'task_empty_repeat_24h' }),
      gateRow({ job: 'RQ-D1', atMs: at(1), reason: 'task_empty_repeat_24h' }),
      gateRow({ job: 'RQ-D2', atMs: at(2), reason: 'task_empty_repeat_24h' }),
      gateRow({ job: 'RQ-D3', atMs: at(0, 1), reason: 'task_empty_repeat_24h' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const gateItems = first.items.filter((i) => i.id.startsWith('fleet-empty-gate-'));
    expect(gateItems.length).toBeGreaterThan(0);
    expect(gateItems.every((i) => i.area === 'empty-gates')).toBe(true);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gateItems)).toBe(gateItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-empty-gate-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-empty-gate-'))).toHaveLength(gateItems.length);
  });
});
