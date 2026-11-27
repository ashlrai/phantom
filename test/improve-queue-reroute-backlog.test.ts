import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRerouteJournal,
  queueRerouteBacklogItems,
  REROUTE_BACKLOG_MAX_ITEMS,
  REROUTE_JOB_MIN_DAYS,
  REROUTE_JOB_MIN_ROWS,
  REROUTE_NOTHELD_MIN_DAYS,
  REROUTE_NOTHELD_MIN_JOBS,
  REROUTE_WINDOW_HOURS,
  rerouteChurnCells,
  rerouteNotHeldCells,
} from '../src/core/improve/queue-reroute-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; journal timestamps are epoch seconds like the writer's tickAt/1000. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
/** Epoch seconds `msAgo` milliseconds before NOW_MS. */
const sec = (msAgo: number): number => Math.floor((NOW_MS - msAgo) / 1000);

/** One work-market.v1 queue_reroute row in the producer's exact shape; spec keys override fields. */
function rerouteRow(tsSec: number, spec: Record<string, unknown> = {}): string {
  return J({
    schema: 'work-market.v1',
    event: 'queue_reroute',
    job: 'RQ-TEST-1',
    preferred_lane: 'codex',
    target_lane: 'claude',
    deadline_at: '2026-11-30T00:00:00.000Z',
    running: 0,
    target: 2,
    reason_codes: ['resource_plan_under_target', 'expiring_included_quota'],
    ts: tsSec,
    ...spec,
  });
}

/** n reroute rows for `job` alternating targets, spread across `days` distinct UTC days ending today. */
function rerouteSeries(job: string, days: number, perDay: number, spec: Record<string, unknown> = {}): string[] {
  const rows: string[] = [];
  const targets = ['claude', 'codex', 'gemini'];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(rerouteRow(sec(d * DAY + i * HOUR), {
        job,
        preferred_lane: (d + i) % 2 === 0 ? 'codex' : null,
        target_lane: targets[(d + i) % targets.length]!,
        ...spec,
      }));
    }
  }
  return rows;
}

/** One reward-signal.v1 row in the producer's exact shape. */
function rewardRow(spec: { jobId: string; merged?: boolean; recordedAtMs: number }): string {
  const merged = spec.merged ?? false;
  const dispatchedAtMs = spec.recordedAtMs - 2 * HOUR;
  const mergedAtMs = merged ? spec.recordedAtMs - HOUR : null;
  return J({
    v: 1,
    jobId: spec.jobId,
    pool: 'claude',
    repo: 'ashlrai/phantom',
    merged,
    dispatchedAt: new Date(dispatchedAtMs).toISOString(),
    mergedAt: mergedAtMs === null ? null : new Date(mergedAtMs).toISOString(),
    timeToMergeMs: mergedAtMs === null ? null : mergedAtMs - dispatchedAtMs,
    ciWallMs: null,
    cost: { pool: null, pctUsedStart: null, pctUsedEnd: null, pctUsedDelta: null, costUsd: null },
    recordedAt: new Date(spec.recordedAtMs).toISOString(),
  });
}

describe('foldRerouteJournal', () => {
  it('keeps only in-window work-market.v1 queue_reroute rows of the producer contract', () => {
    const rows = [
      rerouteRow(NOW_S),
      rerouteRow(NOW_S - HOUR / 1000, { job: 'RQ-TEST-2', preferred_lane: null, reason_codes: ['resource_plan_under_target', 'expiring_reset_bank'] }),
      // Wrong schema, wrong event name, bad ts, non-JSON.
      J({ schema: 'other.v9', event: 'queue_reroute', job: 'RQ-TEST-3', preferred_lane: null, target_lane: 'claude', deadline_at: 'x', running: 0, target: 1, reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-TEST-3', preferred_lane: null, target_lane: 'claude', deadline_at: 'x', running: 0, target: 1, reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'queue_reroute', job: 'RQ-TEST-3', preferred_lane: null, target_lane: 'claude', deadline_at: 'x', running: 0, target: 1, reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], ts: 'soon' }),
      J({ schema: 'work-market.v1', event: 'queue_reroute', job: 'RQ-TEST-3', preferred_lane: null, target_lane: 'claude', deadline_at: 'x', running: 0, target: 1, reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], ts: -5 }),
      'not json {"event":"queue_reroute"',
      '',
      // Out-of-window and beyond the +300 s skew: skipped as non-evidence, not invalid.
      rerouteRow(NOW_S - REROUTE_WINDOW_HOURS * 3600 - 10),
      rerouteRow(NOW_S + 600),
      // Other events never reach the parse: no '"event":"queue_reroute"' substring.
      J({ schema: 'work-market.v1', event: 'posture', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'unfed_capacity', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'repo_share', repo: 'ashlrai/locus', ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'route_decision', job: 'RQ-TEST-9', chosen_lane: 'claude', ts: NOW_S }),
    ].join('\n');
    const fold = foldRerouteJournal(rows, NOW_MS, REROUTE_WINDOW_HOURS);
    // Two contract-valid in-window rows.
    expect(fold.records).toBe(2);
    // bad-schema row, string-ts, negative-ts and the non-JSON line all count
    // as invalid; the other-event rows are skipped before parsing (no
    // '"event":"queue_reroute"' substring).
    expect(fold.invalidRows).toBe(4);
    expect(fold.jobs.get('RQ-TEST-1')?.rows).toBe(1);
    expect(fold.jobs.get('RQ-TEST-2')?.rows).toBe(1);
  });

  it('rejects rows outside the producer contract field by field', () => {
    const bad = [
      rerouteRow(NOW_S, { job: '' }),                            // empty job id
      rerouteRow(NOW_S, { job: 'x'.repeat(201) }),               // over the bounded id length
      rerouteRow(NOW_S, { preferred_lane: 'Not A Lane' }),       // hint must be null or a lane id
      rerouteRow(NOW_S, { preferred_lane: 7 }),                  // hint is null-or-lane, never a number
      rerouteRow(NOW_S, { target_lane: 'bad lane!' }),           // target must be a lane id
      rerouteRow(NOW_S, { deadline_at: 'not-a-date' }),          // deadline must parse
      rerouteRow(NOW_S, { deadline_at: null }),                  // the writer always records a deadline
      rerouteRow(NOW_S, { running: -1 }),
      rerouteRow(NOW_S, { running: 1.5 }),
      rerouteRow(NOW_S, { target: 'two' }),
      rerouteRow(NOW_S, { reason_codes: 'resource_plan_under_target' }),
      rerouteRow(NOW_S, { reason_codes: null }),
      // Marker or expiring code missing — not the writer's vocabulary.
      rerouteRow(NOW_S, { reason_codes: ['expiring_included_quota'] }),
      rerouteRow(NOW_S, { reason_codes: ['resource_plan_under_target'] }),
      rerouteRow(NOW_S, { reason_codes: ['resource_plan_under_target', 'saturated'] }),
      // The preferred_lane key itself absent — the writer always emits it.
      J({ schema: 'work-market.v1', event: 'queue_reroute', job: 'RQ-TEST-1', target_lane: 'claude', deadline_at: '2026-11-30T00:00:00.000Z', running: 0, target: 2, reason_codes: ['resource_plan_under_target', 'expiring_included_quota'], ts: NOW_S }),
    ];
    const fold = foldRerouteJournal(bad.join('\n'), NOW_MS, REROUTE_WINDOW_HOURS);
    expect(fold.records).toBe(0);
    expect(fold.invalidRows).toBe(bad.length);
    expect(fold.jobs.size).toBe(0);
  });

  it('aggregates per job: rows, days, targets, arrival hints, expiring codes, last target', () => {
    const rows = [
      // Day -3: hinted codex, moved to claude.
      rerouteRow(sec(3 * DAY), { job: 'RQ-AGG', preferred_lane: 'codex', target_lane: 'claude', reason_codes: ['resource_plan_under_target', 'expiring_included_quota'] }),
      // Day -2: arrived with the claude hint the last rewrite set, moved to gemini on a reset bank.
      rerouteRow(sec(2 * DAY), { job: 'RQ-AGG', preferred_lane: 'claude', target_lane: 'gemini', reason_codes: ['resource_plan_under_target', 'expiring_reset_bank'] }),
      // Day -1: open-hint row moved back to claude.
      rerouteRow(sec(DAY), { job: 'RQ-AGG', preferred_lane: null, target_lane: 'claude', reason_codes: ['resource_plan_under_target', 'expiring_included_quota'] }),
      // A different job on the same days — separate fold.
      rerouteRow(sec(2 * DAY), { job: 'RQ-OTHER', preferred_lane: null, target_lane: 'claude' }),
    ].join('\n');
    const fold = foldRerouteJournal(rows, NOW_MS, REROUTE_WINDOW_HOURS);
    expect(fold.records).toBe(4);
    const job = fold.jobs.get('RQ-AGG')!;
    expect(job.rows).toBe(3);
    expect(job.days.size).toBe(3);
    expect([...job.targets].sort()).toEqual(['claude', 'gemini']);
    expect([...job.hints].sort()).toEqual(['(open hint)', 'claude', 'codex']);
    expect([...job.expiring].sort()).toEqual(['expiring_included_quota', 'expiring_reset_bank']);
    // Journal order is append order — the newest receipt's target wins.
    expect(job.lastTarget).toBe('claude');
    expect(job.firstMs).toBe(sec(3 * DAY) * 1000);
    expect(job.lastMs).toBe(sec(DAY) * 1000);
    expect(fold.jobs.get('RQ-OTHER')?.lastTarget).toBe('claude');
  });
});

describe('rerouteChurnCells', () => {
  it('emits only at the row and day bars, sorted deterministically', () => {
    // Below the row bar: two re-hints across two days never reach REROUTE_JOB_MIN_ROWS.
    const few = foldRerouteJournal([
      rerouteRow(sec(2 * DAY), { job: 'RQ-FEW' }),
      rerouteRow(sec(DAY), { job: 'RQ-FEW' }),
    ].join('\n'), NOW_MS, REROUTE_WINDOW_HOURS);
    expect(few.jobs.get('RQ-FEW')!.rows).toBeLessThan(REROUTE_JOB_MIN_ROWS);
    expect(few.jobs.get('RQ-FEW')!.days.size).toBeGreaterThanOrEqual(REROUTE_JOB_MIN_DAYS);
    expect(rerouteChurnCells(few)).toEqual([]);

    // One day only — a burst of re-hints, not a pattern.
    const oneDay = foldRerouteJournal(rerouteSeries('RQ-ONE', 1, REROUTE_JOB_MIN_ROWS + 2).join('\n'), NOW_MS, REROUTE_WINDOW_HOURS);
    expect(oneDay.jobs.get('RQ-ONE')!.days.size).toBe(1);
    expect(rerouteChurnCells(oneDay)).toEqual([]);

    // Recurring: three receipts across three distinct UTC days.
    const fold = foldRerouteJournal(rerouteSeries('RQ-CHURN', 3, 1).join('\n'), NOW_MS, REROUTE_WINDOW_HOURS);
    const cells = rerouteChurnCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ job: 'RQ-CHURN', rows: 3, lastTarget: 'gemini' });
    expect(cells[0]!.days).toHaveLength(3);
    expect(cells[0]!.firstSeen).not.toBeNull();
    expect(cells[0]!.lastSeen).not.toBeNull();
  });
});

describe('rerouteNotHeldCells', () => {
  it('groups resolved-not-held jobs by last target lane at the bars', () => {
    // Three jobs last pointed at 'claude' across three days, all resolved not held.
    const rows = [
      rerouteRow(sec(2 * DAY), { job: 'RQ-NH-1', target_lane: 'claude' }),
      rerouteRow(sec(DAY), { job: 'RQ-NH-2', target_lane: 'claude' }),
      rerouteRow(sec(HOUR), { job: 'RQ-NH-3', target_lane: 'claude' }),
      // A held job on the same lane never counts toward the bar.
      rerouteRow(sec(DAY), { job: 'RQ-HELD', target_lane: 'claude' }),
      // Two not-held jobs on another lane — below the job bar.
      rerouteRow(sec(2 * DAY), { job: 'RQ-FEW-1', target_lane: 'gemini' }),
      rerouteRow(sec(DAY), { job: 'RQ-FEW-2', target_lane: 'gemini' }),
      // An unresolved job (no reward row) never counts.
      rerouteRow(sec(DAY), { job: 'RQ-UNRES', target_lane: 'claude' }),
    ].join('\n');
    const fold = foldRerouteJournal(rows, NOW_MS, REROUTE_WINDOW_HOURS);
    const rewards = new Map<string, { merged: boolean }>([
      ['RQ-NH-1', { merged: false }], ['RQ-NH-2', { merged: false }], ['RQ-NH-3', { merged: false }],
      ['RQ-HELD', { merged: true }],
      ['RQ-FEW-1', { merged: false }], ['RQ-FEW-2', { merged: false }],
    ]);
    const outcome = rerouteNotHeldCells(fold, rewards);
    expect(outcome.cells).toHaveLength(1);
    expect(outcome.cells[0]).toMatchObject({ lane: 'claude', jobs: 3 });
    expect(outcome.cells[0]!.examples).toEqual(['RQ-NH-1', 'RQ-NH-2', 'RQ-NH-3']);
    // The three member jobs' receipts span three distinct UTC days.
    expect(outcome.cells[0]!.days).toHaveLength(3);
    // Coverage keeps held, not-held and unresolved separate: six of the
    // seven rerouted jobs resolved — one held, five not held — one never resolved.
    expect(outcome).toMatchObject({ resolved: 6, held: 1, notHeld: 5, unresolved: 1 });
  });

  it('requires the day bar even when enough distinct jobs resolved not held', () => {
    // Three not-held jobs but every reroute receipt landed on one UTC day.
    const rows = [
      rerouteRow(sec(3 * HOUR), { job: 'RQ-D1' }),
      rerouteRow(sec(2 * HOUR), { job: 'RQ-D2' }),
      rerouteRow(sec(HOUR), { job: 'RQ-D3' }),
    ].join('\n');
    const fold = foldRerouteJournal(rows, NOW_MS, REROUTE_WINDOW_HOURS);
    const rewards = new Map<string, { merged: boolean }>([
      ['RQ-D1', { merged: false }], ['RQ-D2', { merged: false }], ['RQ-D3', { merged: false }],
    ]);
    const outcome = rerouteNotHeldCells(fold, rewards);
    expect(outcome.cells).toEqual([]);
    expect(outcome.notHeld).toBe(3);
  });
});

describe('queueRerouteBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'queue-reroute-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/work-market.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), rows.length ? rows.join('\n') + '\n' : '');
    return dir;
  }

  /** A reward ledger path carrying the given rows under an isolated metrics dir. */
  async function rewardDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    const path = join(dir, 'metrics', 'reward-signals.jsonl');
    await writeFile(path, rows.length ? rows.join('\n') + '\n' : '');
    return path;
  }

  it('emits churn and not-held items only for the fleet repository', async () => {
    const churnRows = rerouteSeries('RQ-CHURN', 3, 1);
    const dir = await runsDir('runs-cells', churnRows);
    // Outside the fleet repo the receipts describe nothing this checkout owns.
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/locus', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await queueRerouteBacklogItems({ repo: 'not a repo', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);

    const items = await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'queue-reroute' });
    expect(item.id).toMatch(/^queue-reroute-churn-[0-9a-f]{16}$/);
    expect(item.title).toContain('RQ-CHURN');
    expect(item.prompt).toContain('queue_reroute');
    expect(item.prompt).toContain('work-market.jsonl');
    expect(item.prompt).toContain('reward-signals.jsonl');
    expect(item.prompt).toContain('routeExpiringCapacity');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).not.toContain('lower bound');
    // The hint chain is quoted: the series alternates codex/open hints.
    expect(item.prompt).toContain('preferred_lane');
  });

  it('emits not-held lane items joined to the reward ledger', async () => {
    const rows = [
      rerouteRow(sec(2 * DAY), { job: 'RQ-NH-1', target_lane: 'claude' }),
      rerouteRow(sec(DAY), { job: 'RQ-NH-2', target_lane: 'claude' }),
      rerouteRow(sec(HOUR), { job: 'RQ-NH-3', target_lane: 'claude' }),
      rerouteRow(sec(DAY), { job: 'RQ-HELD', target_lane: 'claude' }),
    ];
    const dir = await runsDir('runs-outcome', rows);
    const rewardPath = await rewardDir('rewards', [
      rewardRow({ jobId: 'RQ-NH-1', merged: false, recordedAtMs: NOW_MS - DAY }),
      rewardRow({ jobId: 'RQ-NH-2', merged: false, recordedAtMs: NOW_MS - HOUR }),
      rewardRow({ jobId: 'RQ-NH-3', merged: false, recordedAtMs: NOW_MS }),
      rewardRow({ jobId: 'RQ-HELD', merged: true, recordedAtMs: NOW_MS }),
    ]);
    const items = await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, rewardPath, now: new Date(NOW_MS) });
    // One churn item? No — each job has a single receipt, below the churn bar.
    // Only the not-held lane cell emits.
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'reroute-outcomes' });
    expect(item.id).toMatch(/^queue-reroute-notheld-[0-9a-f]{16}$/);
    expect(item.title).toContain('claude');
    expect(item.prompt).toContain('merged:false');
    expect(item.prompt).toContain('RQ-NH-1');
    expect(item.prompt).toContain('3 distinct job(s)');
    expect(item.prompt).toContain('held merges');
    expect(item.prompt).toContain('never resolved');
    expect(item.prompt).toContain('association, not proof');
    expect(item.prompt).not.toContain('lower bound');
  });

  it('emits nothing for missing evidence, below-bar cells, or unresolved-only outcomes', async () => {
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);

    // A journal directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'work-market.jsonl'), { recursive: true });
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: new Date(NOW_MS) })).toEqual([]);

    // Below the churn bars: one burst day of re-hints for one job.
    const thin = await runsDir('runs-thin', rerouteSeries('RQ-THIN', 1, REROUTE_JOB_MIN_ROWS + 4));
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);

    // Sparse re-hints across days but below the row bar.
    const sparse = await runsDir('runs-sparse', [
      rerouteRow(sec(2 * DAY), { job: 'RQ-SPARSE' }),
      rerouteRow(sec(DAY), { job: 'RQ-SPARSE' }),
    ]);
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: sparse, now: new Date(NOW_MS) })).toEqual([]);

    // Enough rerouted jobs at the bars but the reward ledger is absent —
    // churn emits, not-held never does (no resolved verdicts exist).
    const churnOnly = await runsDir('runs-churn-only', rerouteSeries('RQ-CHURN-ONLY', 3, 1));
    const items = await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: churnOnly, rewardPath: join(home, 'no-rewards.jsonl'), now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^queue-reroute-churn-/);

    // Three not-held jobs on one lane but every receipt on a single day —
    // below the day bar even with the reward join.
    const oneDayRows = [
      rerouteRow(sec(3 * HOUR), { job: 'RQ-D1', target_lane: 'claude' }),
      rerouteRow(sec(2 * HOUR), { job: 'RQ-D2', target_lane: 'claude' }),
      rerouteRow(sec(HOUR), { job: 'RQ-D3', target_lane: 'claude' }),
    ];
    const oneDayDir = await runsDir('runs-oneday', oneDayRows);
    const oneDayRewards = await rewardDir('rewards-oneday', [
      rewardRow({ jobId: 'RQ-D1', merged: false, recordedAtMs: NOW_MS }),
      rewardRow({ jobId: 'RQ-D2', merged: false, recordedAtMs: NOW_MS }),
      rewardRow({ jobId: 'RQ-D3', merged: false, recordedAtMs: NOW_MS }),
    ]);
    expect(await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDayDir, rewardPath: oneDayRewards, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = [
      ...rerouteSeries('RQ-CHURN', 3, 1),
      rerouteRow(sec(2 * DAY), { job: 'RQ-NH-1', target_lane: 'claude' }),
      rerouteRow(sec(DAY), { job: 'RQ-NH-2', target_lane: 'claude' }),
      rerouteRow(sec(HOUR), { job: 'RQ-NH-3', target_lane: 'claude' }),
    ];
    const dir = await runsDir('runs-trunc', []);
    // Pad the journal past the 32 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(33 * 1024 * 1024);
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const rewardPath = await rewardDir('rewards-trunc', [
      rewardRow({ jobId: 'RQ-NH-1', merged: false, recordedAtMs: NOW_MS - DAY }),
      rewardRow({ jobId: 'RQ-NH-2', merged: false, recordedAtMs: NOW_MS - HOUR }),
      rewardRow({ jobId: 'RQ-NH-3', merged: false, recordedAtMs: NOW_MS }),
    ]);
    const items = await queueRerouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, rewardPath, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...rerouteSeries('RQ-CHURN-A', 3, 1),
      ...rerouteSeries('RQ-CHURN-B', 3, 1, { target_lane: 'gemini' }),
      rerouteRow(sec(2 * DAY), { job: 'RQ-NH-1', target_lane: 'claude' }),
      rerouteRow(sec(DAY), { job: 'RQ-NH-2', target_lane: 'claude' }),
      rerouteRow(sec(HOUR), { job: 'RQ-NH-3', target_lane: 'claude' }),
    ];
    const dir = await runsDir('runs-stable', rows);
    const rewardPath = await rewardDir('rewards-stable', [
      rewardRow({ jobId: 'RQ-NH-1', merged: false, recordedAtMs: NOW_MS - DAY }),
      rewardRow({ jobId: 'RQ-NH-2', merged: false, recordedAtMs: NOW_MS - HOUR }),
      rewardRow({ jobId: 'RQ-NH-3', merged: false, recordedAtMs: NOW_MS }),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, rewardPath, now: new Date(NOW_MS) };
    const first = await queueRerouteBacklogItems(opts);
    const second = await queueRerouteBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBe(3);
    expect(first.length).toBeLessThanOrEqual(REROUTE_BACKLOG_MAX_ITEMS);
    const limited = await queueRerouteBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends reroute items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'metrics', 'work-market.jsonl'),
        rerouteSeries('RQ-CHURN', 3, 1).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const rerouteItems = first.items.filter((i) => i.id.startsWith('queue-reroute-'));
      expect(rerouteItems).toHaveLength(1);
      expect(rerouteItems[0]!.area).toBe('queue-reroute');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(rerouteItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('queue-reroute-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('queue-reroute-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closed vocabularies', () => {
  it('keeps the recurring bars at the documented values', () => {
    expect(REROUTE_JOB_MIN_ROWS).toBe(3);
    expect(REROUTE_JOB_MIN_DAYS).toBe(2);
    expect(REROUTE_NOTHELD_MIN_JOBS).toBe(3);
    expect(REROUTE_NOTHELD_MIN_DAYS).toBe(2);
    expect(REROUTE_WINDOW_HOURS).toBe(168);
  });
});
