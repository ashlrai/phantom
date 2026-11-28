import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldPrecheckParkJournal,
  PRECHECK_PARK_MIN_DAYS,
  PRECHECK_PARK_MIN_JOBS,
  PRECHECK_PARK_MIN_ROWS,
  PRECHECK_PARK_WINDOW_HOURS,
  precheckParkBacklogItems,
  precheckParkCells,
} from '../src/core/improve/precheck-park-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like dispatchd's metric() writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One dispatchd precheck_parked row in the writer's shape. */
function parkRow(spec: {
  job: string;
  atMs?: number;
  ts?: string;
  reason?: string | null;
  code?: number | string | null;
  attempt?: number | null;
  lane?: string | null;
  repo?: string | null;
  event?: string;
  extra?: Record<string, unknown>;
}): string {
  const row: Record<string, unknown> = {
    event: spec.event ?? 'precheck_parked',
    job: spec.job,
    repo: spec.repo === undefined ? 'ashlrai/phantom' : spec.repo,
    lane: spec.lane === undefined ? 'claude' : spec.lane,
    code: spec.code === undefined ? 13 : spec.code,
    reason: spec.reason === undefined ? 'files_and_tests_exist' : spec.reason,
    retry_at: Math.floor((spec.atMs ?? NOW_MS) / 1000) + 3600,
    attempt: spec.attempt === undefined ? 3 : spec.attempt,
    ts: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    ...spec.extra,
  };
  for (const key of ['repo', 'lane', 'reason', 'code', 'attempt'] as const) {
    if (row[key] === null) delete row[key];
  }
  return J(row);
}

/** n park rows for distinct jobs spread across `days` distinct UTC days ending today. */
function parkSeries(
  reason: string,
  days: number,
  perDay: number,
  opts: { lane?: string; repo?: string; prefix?: string; attempt?: number } = {},
): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(parkRow({
        job: `${opts.prefix ?? 'RQ-P'}${n++}`,
        atMs: NOW_MS - d * DAY - i * HOUR,
        reason, lane: opts.lane, repo: opts.repo, attempt: opts.attempt,
      }));
    }
  }
  return rows;
}

/** Repeated park rows for one job spread across `days` distinct UTC days. */
function jobSeries(
  job: string,
  days: number,
  perDay: number,
  opts: { reason?: string; lane?: string; attempt?: number } = {},
): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(parkRow({
        job,
        atMs: NOW_MS - d * DAY - i * HOUR,
        reason: opts.reason ?? 'unproven_completion',
        lane: opts.lane,
        attempt: opts.attempt === undefined ? d * perDay + i + 1 : opts.attempt,
      }));
    }
  }
  return rows;
}

/** The production fold over joined rows. */
function foldRows(rows: string[], nowMs = NOW_MS) {
  return foldPrecheckParkJournal(rows.join('\n'), nowMs, PRECHECK_PARK_WINDOW_HOURS);
}

describe('foldPrecheckParkJournal', () => {
  it('keeps only precheck_parked rows with safe job ids inside the window', () => {
    const rows = [
      parkRow({ job: 'RQ-OK', atMs: NOW_MS - HOUR }),
      // Stale: predates the window.
      parkRow({ job: 'RQ-OLD', atMs: NOW_MS - PRECHECK_PARK_WINDOW_HOURS * 3_600_000 - DAY }),
      // Future-dated beyond skew — untrustworthy, contributes nothing.
      parkRow({ job: 'RQ-FUT', atMs: NOW_MS + 600_000 }),
      // Undated row — unknown stays unknown.
      parkRow({ job: 'RQ-NODATE', ts: 'not-a-date' }),
      // Other events never count even when they carry park-shaped fields
      // and mention the event name in another field (passes the prefilter).
      parkRow({ job: 'RQ-LAUNCH', event: 'launch', atMs: NOW_MS - HOUR, extra: { note: 'precheck_parked mention' } }),
      parkRow({ job: 'RQ-SKIP', event: 'precheck_skip', atMs: NOW_MS - HOUR, extra: { note: 'precheck_parked mention' } }),
      parkRow({ job: 'RQ-DECL', event: 'skipped_empty', atMs: NOW_MS - HOUR, extra: { code: 13, note: 'precheck_parked mention' } }),
      parkRow({ job: 'RQ-VARIANT', event: 'precheck_parked_retry', atMs: NOW_MS - HOUR }),
      // Node-pool producer schemas are never dispatch attempts.
      J({ schema: 'fleet.session-pool.v1', event: 'precheck_parked', job: 'sess-1:2', ts: iso(NOW_MS - HOUR), reason: 'files_and_tests_exist' }),
      J({ schema: 'phm-node-runner.v1', event: 'precheck_parked', job: 'job-1:tok', ts: iso(NOW_MS - HOUR), reason: 'files_and_tests_exist' }),
      // Unsafe job ids never reach the fold.
      parkRow({ job: '../escape', atMs: NOW_MS - HOUR }),
      parkRow({ job: 'has space', atMs: NOW_MS - HOUR }),
      'not json precheck_parked',
      '{"precheck_parked":',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toHaveLength(1);
    expect(fold.rows[0]!.job).toBe('RQ-OK');
    expect(fold.malformed).toBe(2);
  });

  it('records reason, code, attempt, lane and repo tallies verbatim-sanitized', () => {
    const rows = [
      parkRow({ job: 'RQ-A', atMs: NOW_MS - 2 * DAY, reason: 'invalid_or_unknown_receipt', attempt: 7, lane: 'devin', repo: 'ashlrai/phantom' }),
      parkRow({ job: 'RQ-B', atMs: NOW_MS - DAY, reason: 'invalid_or_unknown_receipt', attempt: 2, lane: 'claude', repo: 'ashlrai/other' }),
      // Missing fields degrade to recorded fallbacks, never zero.
      parkRow({ job: 'RQ-C', atMs: NOW_MS - HOUR, reason: null, code: null, attempt: null, lane: null, repo: null }),
      // A string attempt parses; junk does not.
      parkRow({ job: 'RQ-D', atMs: NOW_MS - HOUR, reason: 'symbols_defined', attempt: '5' as unknown as number }),
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toHaveLength(4);
    const byJob = new Map(fold.rows.map((r) => [r.job, r]));
    expect(byJob.get('RQ-A')).toMatchObject({ reason: 'invalid_or_unknown_receipt', code: '13', attempt: 7, lane: 'devin', repo: 'ashlrai/phantom' });
    expect(byJob.get('RQ-B')!.repo).toBe('ashlrai/other');
    expect(byJob.get('RQ-C')).toMatchObject({ reason: 'unrecorded reason', code: 'unrecorded code', attempt: null, lane: 'unknown', repo: 'unattributed' });
    expect(byJob.get('RQ-D')!.attempt).toBe(5);
  });

  it('parses dispatchd local-offset timestamps like the sibling folds', () => {
    // dispatchd writes %Y-%m-%dT%H:%M:%S%z — offset without a colon.
    const ts = '2026-11-23T07:00:00-0500'; // = 12:00Z = NOW_MS
    const fold = foldRows([parkRow({ job: 'RQ-TZ', ts })]);
    expect(fold.rows).toHaveLength(1);
    expect(fold.rows[0]!.atMs).toBe(NOW_MS);
  });
});

describe('precheckParkCells', () => {
  it('emits a reason cell only at the job and day bars', () => {
    // Below the job bar: two distinct jobs across two days.
    const few = foldRows(parkSeries('files_and_tests_exist', PRECHECK_PARK_MIN_DAYS, 1, { prefix: 'RQ-F' }));
    expect(few.rows).toHaveLength(PRECHECK_PARK_MIN_JOBS - 1);
    expect(precheckParkCells(few.rows)).toEqual([]);

    // Below the day bar: enough jobs but all on one UTC day.
    const oneDay = foldRows(parkSeries('files_and_tests_exist', 1, PRECHECK_PARK_MIN_JOBS + 2, { prefix: 'RQ-O' }));
    expect(precheckParkCells(oneDay.rows)).toEqual([]);

    // At the bars: enough distinct jobs across two days.
    const recurring = foldRows(parkSeries('files_and_tests_exist', PRECHECK_PARK_MIN_DAYS, 2, { prefix: 'RQ-R', lane: 'claude', attempt: 4 }));
    const cells = precheckParkCells(recurring.rows);
    // 4 reason rows fold into one reason cell AND one job cell per job —
    // each job parked twice on one day never reaches the job bar.
    const reasonCells = cells.filter((c) => c.kind === 'reason');
    expect(reasonCells).toHaveLength(1);
    const cell = reasonCells[0]!;
    expect(cell.reason).toBe('files_and_tests_exist');
    expect(cell.count).toBe(4);
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.maxAttempt).toBe(4);
    expect(cell.lanes).toEqual([{ text: 'claude', count: 4 }]);
    expect(cell.repos).toEqual([{ text: 'ashlrai/phantom', count: 4 }]);
    expect(cell.jobs).toHaveLength(3);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(precheckParkCells(recurring.rows, true)[0]!.lowerBound).toBe(true);
  });

  it('emits a job cell only at the row and day bars', () => {
    // One job parked twice on one day — below the row bar.
    const thin = foldRows(jobSeries('RQ-STICK', 1, PRECHECK_PARK_MIN_ROWS - 1));
    expect(precheckParkCells(thin.rows)).toEqual([]);

    // Enough rows but all on one UTC day.
    const oneDay = foldRows(jobSeries('RQ-STICK', 1, PRECHECK_PARK_MIN_ROWS + 2));
    expect(precheckParkCells(oneDay.rows)).toEqual([]);

    // At the bars: repeated parks across two days.
    const recurring = foldRows(jobSeries('RQ-STICK', PRECHECK_PARK_MIN_DAYS, 2, { attempt: undefined }));
    const jobCells = precheckParkCells(recurring.rows).filter((c) => c.kind === 'job');
    expect(jobCells).toHaveLength(1);
    const cell = jobCells[0]!;
    expect(cell.job).toBe('RQ-STICK');
    expect(cell.count).toBe(4);
    expect(cell.rows).toBe(4);
    expect(cell.days).toHaveLength(2);
    // jobSeries attempt = d*perDay+i+1 → deepest is 4.
    expect(cell.maxAttempt).toBe(4);
    expect(cell.reasons).toEqual([{ text: 'unproven_completion', count: 4 }]);
    expect(cell.codes).toEqual([{ text: '13', count: 4 }]);
  });

  it('sorts cells worst-first and never emits one-off or healthy evidence', () => {
    const rows = [
      // A reason cell at the bars (4 jobs × 2 days = 4 distinct jobs).
      ...parkSeries('invalid_or_unknown_receipt', 2, 2, { prefix: 'RQ-I' }),
      // A job cell at the bars (1 job × 6 rows × 3 days) — the worst cell.
      ...jobSeries('RQ-STUCK', 3, 2, { reason: 'symbols_defined' }),
      // One-off parks: a single job once, a reason on one day.
      parkRow({ job: 'RQ-ONCE', atMs: NOW_MS - HOUR, reason: 'unproven_completion' }),
      ...parkSeries('unproven_completion', 1, PRECHECK_PARK_MIN_JOBS + 1, { prefix: 'RQ-U' }),
    ];
    const cells = precheckParkCells(foldRows(rows).rows);
    const kinds = cells.map((c) => `${c.kind}:${c.kind === 'reason' ? c.reason : c.job}`);
    // Job cell count is its 6 recorded rows; the reason cell counts its
    // 4 distinct jobs — the job cell sorts first on count.
    expect(kinds[0]).toBe('job:RQ-STUCK');
    expect(kinds).toContain('reason:invalid_or_unknown_receipt');
    expect(kinds).not.toContain('reason:unproven_completion');
    expect(cells.find((c) => c.kind === 'reason')!.count).toBe(4);
  });
});

describe('precheckParkBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'precheck-park-backlog-'));
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

  it('emits a precheck-park item for a recurring park reason', async () => {
    const rows = parkSeries('files_and_tests_exist', 3, 1, { prefix: 'RQ-A', lane: 'claude' });
    const dir = await runsDir('runs-park', rows);
    const items = await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const reasonItems = items.filter((i) => i.prompt.includes('reason \'files_and_tests_exist\''));
    expect(reasonItems).toHaveLength(1);
    const [item] = reasonItems;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'precheck-parks' });
    expect(item!.id).toMatch(/^fleet-precheck-park-[0-9a-f]{16}$/);
    expect(item!.title).toContain('files_and_tests_exist');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('precheck_parked');
    expect(item!.prompt).toContain('jobs.jsonl');
    expect(item!.prompt).toContain('phm fleet parked');
    expect(item!.prompt).toContain('claude');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits a job item for a repeatedly parked job and names the backoff depth', async () => {
    const rows = jobSeries('RQ-STUCK', 3, 2, { attempt: 7 });
    const dir = await runsDir('runs-stuck', rows);
    const items = await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const jobItems = items.filter((i) => i.title.includes('RQ-STUCK'));
    expect(jobItems).toHaveLength(1);
    const [item] = jobItems;
    expect(item!.prompt).toContain('RQ-STUCK');
    expect(item!.prompt).toContain('attempt');
    expect(item!.prompt).toContain('hourly');
    expect(item!.prompt).toContain('unproven_completion');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const empty = await runsDir('runs-empty', []);
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'jobs.jsonl'), { recursive: true });
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW })).toEqual([]);

    // Below the day bar: one burst day of parks.
    const thin = await runsDir('runs-thin', parkSeries('files_and_tests_exist', 1, PRECHECK_PARK_MIN_JOBS + 2, { prefix: 'RQ-T' }));
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/lexicon', runsDir: thin, now: NOW })).toEqual([]);
    expect(await precheckParkBacklogItems({ repo: '', runsDir: thin, now: NOW })).toEqual([]);

    // A healthy ledger: launches and finishes with no park rows emit nothing.
    const healthy = await runsDir('runs-healthy', [
      J({ event: 'launch', job: 'RQ-H0', lane: 'claude', ts: iso(NOW_MS - DAY) }),
      J({ event: 'finish', job: 'RQ-H0', lane: 'claude', ts: iso(NOW_MS - HOUR) }),
    ]);
    expect(await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = parkSeries('files_and_tests_exist', 3, 1, { prefix: 'RQ-TR' });
    // Pad the ledger past the 16 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(17 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await precheckParkBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...parkSeries('files_and_tests_exist', 2, 2, { prefix: 'RQ-S1' }),
      ...parkSeries('invalid_or_unknown_receipt', 3, 1, { prefix: 'RQ-S2' }),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await precheckParkBacklogItems(opts);
    const second = await precheckParkBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(2);
    const limited = await precheckParkBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends precheck-park items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      parkRow({ job: 'RQ-D0', atMs: at(0), reason: 'files_and_tests_exist' }),
      parkRow({ job: 'RQ-D1', atMs: at(1), reason: 'files_and_tests_exist' }),
      parkRow({ job: 'RQ-D2', atMs: at(2), reason: 'files_and_tests_exist' }),
      parkRow({ job: 'RQ-D3', atMs: at(0, 1), reason: 'files_and_tests_exist' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const parkItems = first.items.filter((i) => i.id.startsWith('fleet-precheck-park-'));
    expect(parkItems.length).toBeGreaterThan(0);
    expect(parkItems.every((i) => i.area === 'precheck-parks')).toBe(true);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(parkItems)).toBe(parkItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-precheck-park-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-precheck-park-'))).toHaveLength(parkItems.length);
  });
});
