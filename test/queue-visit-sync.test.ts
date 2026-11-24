import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planVisitSync, queueReadyVisits, queueVisitsFromJobs, syncQueueVisits } from '../src/core/queue/visit-sync.js';
import { compactQueueVisits, readQueueVisits, VISIT_JOURNAL_MAX_BYTES } from '../src/core/queue/journal.js';
import { estimateQueueStats, queueVisitKey, type QueueVisit } from '../src/core/queue/stats.js';

const NOW = Date.parse('2026-11-05T15:00:00Z');
const T = (s: string) => `2026-11-05T${s}+00:00`;
const ms = (s: string) => Date.parse(T(s));

const row = (o: Record<string, unknown>) => JSON.stringify(o);
const ledger = (...rows: Record<string, unknown>[]) => rows.map(row).join('\n') + '\n';
const at = (visits: QueueVisit[], job: string, station: string, attempt = 1) =>
  visits.find(v => v.station === station && v.id === `${job}:a${attempt}`);

describe('queueVisitsFromJobs', () => {
  it('reads the jobs-ledger field dialect', () => {
    const { visits, jobs, invalid } = queueVisitsFromJobs(ledger(
      { type: 'enqueue', job_id: 'RQ-D', pool: 'dialect-lane', timestamp: T('14:00:00') },
      { type: 'launch', job_id: 'RQ-D', pool: 'dialect-lane', timestamp: T('14:00:30') },
      { kind: 'finish', jobId: 'RQ-D', lane: 'dialect-lane', at: T('14:02:00') },
      { type: 'publish', job: 'RQ-D', pr_url: 'https://github.com/x/y/pull/9', time: T('14:02:30') },
      { kind: 'outcome', result: 'MERGED', id: 'RQ-D', html_url: 'https://github.com/x/y/pull/9', mergedAt: '2026-11-05T14:06:00+00:00' },
    ), NOW);
    expect(invalid).toBe(0);
    expect(at(visits, 'RQ-D', 'merged')).toMatchObject({ pool: 'dialect-lane' });
    expect(jobs.get('RQ-D')?.lane).toBe('dialect-lane');
  });

  it('folds a full lifecycle into per-station visits', () => {
    const { visits, invalid } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-A', repo: 'phantom', lane: 'codex-personal', tier: 'work', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-A', repo: 'phantom', lane: 'codex-personal', tier: 'work', model: 'm', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-A', lane: 'codex-personal', wall_s: 120, ts: T('14:02:30') },
      { event: 'publish', job: 'RQ-A', url: 'https://github.com/ashlrai/phantom/pull/1', ts: T('14:03:00') },
      { event: 'ci_start', job: 'RQ-A', ts: T('14:03:30') },
      { event: 'ci_complete', job: 'RQ-A', ts: T('14:05:00') },
      { event: 'outcome', job: 'RQ-A', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/1', ts: T('14:06:00') },
    ), NOW);
    expect(invalid).toBe(0);
    expect(at(visits, 'RQ-A', 'READY')).toEqual({ id: 'RQ-A:a1', station: 'READY', pool: 'codex-personal', arrivedAt: ms('14:00:00'), startedAt: ms('14:00:30'), completedAt: ms('14:00:30') });
    expect(at(visits, 'RQ-A', 'claimed')).toEqual({ id: 'RQ-A:a1', station: 'claimed', pool: 'codex-personal', arrivedAt: ms('14:00:30'), startedAt: ms('14:00:30'), completedAt: ms('14:02:30') });
    expect(at(visits, 'RQ-A', 'publish')).toEqual({ id: 'RQ-A:a1', station: 'publish', pool: 'codex-personal', arrivedAt: ms('14:02:30'), startedAt: ms('14:03:00'), completedAt: ms('14:03:00') });
    expect(at(visits, 'RQ-A', 'pr-ci')).toEqual({ id: 'RQ-A:a1', station: 'pr-ci', pool: 'codex-personal', arrivedAt: ms('14:03:00'), startedAt: ms('14:03:30'), completedAt: ms('14:05:00') });
    expect(at(visits, 'RQ-A', 'merge-queue')).toEqual({ id: 'RQ-A:a1', station: 'merge-queue', pool: 'codex-personal', arrivedAt: ms('14:05:00'), startedAt: ms('14:06:00'), completedAt: ms('14:06:00') });
    expect(at(visits, 'RQ-A', 'merged')).toEqual({ id: 'RQ-A:a1', station: 'merged', pool: 'codex-personal', arrivedAt: ms('14:06:00'), startedAt: ms('14:06:00'), completedAt: ms('14:06:00') });
  });

  it('keeps missing boundaries open or absent instead of fabricating them', () => {
    const { visits } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-B', lane: 'devin', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-B', lane: 'devin', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-B', lane: 'devin', ts: T('14:02:00') },
      { event: 'publish', job: 'RQ-B', url: 'https://github.com/x/y/pull/2', ts: T('14:02:30') },
      { event: 'outcome', job: 'RQ-B', state: 'MERGED', url: 'https://github.com/x/y/pull/2', mergedAt: '2026-11-05T14:10:00+00:00', ts: T('14:09:00') },
    ), NOW);
    expect(at(visits, 'RQ-B', 'claimed')?.completedAt).toBe(ms('14:02:00'));
    // pr-ci exits at mergedAt (preferred over ts); merge-queue needs ci_complete and stays absent.
    expect(at(visits, 'RQ-B', 'pr-ci')).toMatchObject({ arrivedAt: ms('14:02:30'), startedAt: ms('14:10:00'), completedAt: ms('14:10:00') });
    expect(at(visits, 'RQ-B', 'merge-queue')).toBeUndefined();
    expect(at(visits, 'RQ-B', 'merged')?.arrivedAt).toBe(ms('14:10:00'));
  });

  it('leaves in-flight stations open as WIP', () => {
    const { visits } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-C', lane: 'omlx', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-C', lane: 'omlx', ts: T('14:00:30') },
    ), NOW);
    expect(at(visits, 'RQ-C', 'claimed')).toEqual({ id: 'RQ-C:a1', station: 'claimed', pool: 'omlx', arrivedAt: ms('14:00:30'), startedAt: ms('14:00:30') });
    expect(at(visits, 'RQ-C', 'publish')).toBeUndefined();
    expect(at(visits, 'RQ-C', 'READY')?.completedAt).toBe(ms('14:00:30'));
  });

  it('bounds attempt-2 READY arrival by launch_failed retry receipts only', () => {
    const withRetry = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-D', lane: 'codex', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-D', lane: 'codex', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-D', lane: 'codex', ts: T('14:02:00') },
      { event: 'launch_failed', job: 'RQ-D', lane: 'codex', reason: 'paused', action: 'retry', attempt: 1, ts: T('14:03:00') },
      { event: 'launch_failed', job: 'RQ-D', lane: 'codex', reason: 'held', action: 'give_up', attempt: 2, ts: T('14:03:30') },
      { event: 'launch', job: 'RQ-D', lane: 'devin', ts: T('14:05:00') },
      { event: 'finish', job: 'RQ-D', lane: 'devin', ts: T('14:07:00') },
    ), NOW).visits;
    expect(at(withRetry, 'RQ-D', 'READY', 2)).toEqual({ id: 'RQ-D:a2', station: 'READY', pool: 'devin', arrivedAt: ms('14:03:00'), startedAt: ms('14:05:00'), completedAt: ms('14:05:00') });
    expect(at(withRetry, 'RQ-D', 'claimed', 2)?.completedAt).toBe(ms('14:07:00'));

    const noRetry = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-E', lane: 'codex', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-E', lane: 'codex', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-E', lane: 'codex', ts: T('14:02:00') },
      { event: 'launch', job: 'RQ-E', lane: 'devin', ts: T('14:05:00') },
      { event: 'finish', job: 'RQ-E', lane: 'devin', ts: T('14:07:00') },
    ), NOW).visits;
    expect(at(noRetry, 'RQ-E', 'READY', 2)).toBeUndefined();
    expect(at(noRetry, 'RQ-E', 'claimed', 2)).toBeDefined();
  });

  it('completes READY for DONE-NOOP jobs resolved before launch', () => {
    const { visits } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-F', lane: 'codex', ts: T('14:00:00') },
      { event: 'outcome', job: 'RQ-F', state: 'DONE-NOOP', lane: 'codex', launched: false, reason: 'already done', ts: T('14:01:00') },
    ), NOW);
    expect(visits).toEqual([{ id: 'RQ-F:a1', station: 'READY', pool: 'codex', arrivedAt: ms('14:00:00'), startedAt: ms('14:01:00'), completedAt: ms('14:01:00') }]);
  });

  it('matches URL-bearing outcomes to the attempt that published the PR', () => {
    const { visits } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-G', lane: 'codex', ts: T('14:00:00') },
      { event: 'launch', job: 'RQ-G', lane: 'codex', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-G', lane: 'codex', ts: T('14:02:00') },
      { event: 'publish', job: 'RQ-G', url: 'https://github.com/x/y/pull/9', ts: T('14:02:30') },
      { event: 'outcome', job: 'RQ-G', state: 'MERGED', url: 'https://github.com/x/y/pull/9', ts: T('14:20:00') },
      { event: 'launch', job: 'RQ-G', lane: 'devin', ts: T('14:30:00') },
      { event: 'finish', job: 'RQ-G', lane: 'devin', ts: T('14:32:00') },
    ), NOW);
    expect(at(visits, 'RQ-G', 'merged', 1)?.arrivedAt).toBe(ms('14:20:00'));
    expect(at(visits, 'RQ-G', 'merged', 2)).toBeUndefined();
    expect(at(visits, 'RQ-G', 'claimed', 1)?.completedAt).toBe(ms('14:02:00'));
    expect(at(visits, 'RQ-G', 'claimed', 2)?.completedAt).toBe(ms('14:32:00'));
  });

  it('infers kinds from eventless phase rows and normalizes published', () => {
    const { visits } = queueVisitsFromJobs(ledger(
      { job_id: 'RQ-K', lane: 'codex', ts: T('14:00:00'), event: 'enqueue' },
      { jobId: 'RQ-K', lane: 'codex', ts: T('14:00:30'), event: 'launch' },
      { job: 'RQ-K', lane: 'codex', ts: T('14:02:00'), event: 'finish' },
      { job: 'RQ-K', outcome: 'PUBLISHED', prUrl: 'https://github.com/x/y/pull/3', ts: T('14:02:30') },
      { job: 'RQ-K', state: 'MERGED', url: 'https://github.com/x/y/pull/3', mergedAt: '2026-11-05T14:09:00+0000', ts: T('14:08:00') },
    ), NOW);
    expect(at(visits, 'RQ-K', 'publish')?.completedAt).toBe(ms('14:02:30'));
    expect(at(visits, 'RQ-K', 'merged')?.arrivedAt).toBe(ms('14:09:00'));
    expect(at(visits, 'RQ-K', 'claimed')?.completedAt).toBe(ms('14:02:00'));
  });

  it('ignores rows stamped after now and counts invalid ordering', () => {
    const { visits, invalid } = queueVisitsFromJobs(ledger(
      { event: 'enqueue', job: 'RQ-H', lane: 'codex', ts: T('16:00:00') },
      { event: 'launch', job: 'RQ-H', lane: 'codex', ts: T('14:00:30') },
      { event: 'finish', job: 'RQ-H', lane: 'codex', ts: T('14:02:00') },
      { event: 'enqueue', job: 'RQ-I', lane: 'codex', ts: T('14:05:00') },
      { event: 'launch', job: 'RQ-I', lane: 'codex', ts: T('14:00:30') },
    ), NOW);
    // RQ-H's future enqueue is ignored; READY has no arrival so only claimed exists.
    expect(at(visits, 'RQ-H', 'READY')).toBeUndefined();
    expect(at(visits, 'RQ-H', 'claimed')?.completedAt).toBe(ms('14:02:00'));
    // RQ-I's enqueue postdates its launch: the READY visit is invalid and dropped.
    expect(at(visits, 'RQ-I', 'READY')).toBeUndefined();
    expect(invalid).toBe(1);
  });
});

describe('queueReadyVisits', () => {
  const jobs = new Map([
    ['RQ-WAIT', { enqueueAt: ms('14:10:00'), lane: 'codex', launches: 0 }],
    ['RQ-LAUNCHED', { enqueueAt: ms('14:00:00'), lane: 'codex', launches: 1 }],
  ]);
  const queue = [
    '- READY RQ-WAIT (P0, pool=codex, tier=work, repo=phantom, enq=1762340000): Scope.',
    '- READY RQ-LAUNCHED (P1, pool=codex, tier=mid, repo=phantom): Scope.',
    '- READY RQ-UNKNOWN (P2, pool=codex, tier=fast, repo=phantom): Scope.',
    '- CLAIMED RQ-OTHER (P0): not ready',
  ].join('\n');

  it('emits open READY visits only for first-stint jobs with bounded arrival', () => {
    expect(queueReadyVisits(queue, jobs, NOW))
      .toEqual([{ id: 'RQ-WAIT:a1', station: 'READY', pool: 'codex', arrivedAt: ms('14:10:00') }]);
  });

  it('falls back to the enq= epoch token and skips unbounded arrivals', () => {
    expect(queueReadyVisits('- READY RQ-NEW enq=1762341600', new Map(), NOW)[0]?.arrivedAt).toBe(1762341600 * 1000);
    expect(queueReadyVisits('- READY RQ-NEW', new Map(), NOW)).toEqual([]);
  });
});

describe('planVisitSync', () => {
  const open: QueueVisit = { id: 'J:a1', station: 'READY', pool: 'codex', arrivedAt: 1000 };
  const done: QueueVisit = { ...open, startedAt: 2000, completedAt: 2000 };

  it('appends new and progressed snapshots, skips identical, refuses regressions', () => {
    expect(planVisitSync([open, done], [])).toMatchObject({ append: [open, done], unchanged: 0, regression: 0 });
    expect(planVisitSync([open], [open])).toMatchObject({ append: [], unchanged: 1, regression: 0 });
    expect(planVisitSync([done], [open])).toMatchObject({ append: [done], unchanged: 0, regression: 0 });
    expect(planVisitSync([open], [done])).toMatchObject({ append: [], unchanged: 0, regression: 1 });
    expect(planVisitSync([done], [done])).toMatchObject({ append: [], unchanged: 1, regression: 0 });
  });
});

describe('syncQueueVisits', () => {
  let directory: string;
  let runsDir: string;
  let journalPath: string;

  const lifecycle = [
    { event: 'enqueue', job: 'RQ-S', lane: 'codex', ts: T('14:00:00') },
    { event: 'launch', job: 'RQ-S', lane: 'codex', ts: T('14:00:30') },
    { event: 'finish', job: 'RQ-S', lane: 'codex', ts: T('14:02:30') },
    { event: 'publish', job: 'RQ-S', url: 'https://github.com/x/y/pull/1', ts: T('14:03:00') },
    { event: 'outcome', job: 'RQ-S', state: 'MERGED', url: 'https://github.com/x/y/pull/1', ts: T('14:06:00') },
    { event: 'enqueue', job: 'RQ-W', lane: 'codex', ts: T('14:10:00') },
  ];
  const jobsText = ledger(...lifecycle);
  const queueText = '- READY RQ-W (P0, pool=codex, tier=work, repo=phantom): Scope.\n';

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'visit-sync-')));
    runsDir = join(directory, 'runs');
    journalPath = join(directory, 'home', 'queue', 'visits.jsonl');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const writeJobs = (text: string) => writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), text, { mode: 0o600 });
  const writeQueue = (text: string) => writeFileSync(join(runsDir, 'queue', 'router-queue.md'), text, { mode: 0o600 });
  const sync = (over: Partial<Parameters<typeof syncQueueVisits>[0]> = {}) =>
    syncQueueVisits({ runsDir, journalPath, now: () => NOW, ...over });

  it('appends derived ledger and READY visits to a fresh journal, then dedups', async () => {
    writeJobs(jobsText);
    writeQueue(queueText);

    const first = await sync();
    expect(first).toMatchObject({
      state: 'read', queueState: 'read', journalState: 'read',
      truncated: false, rows: 6, unchanged: 0, regression: 0,
    });
    expect(first.derived).toBeGreaterThan(0);
    expect(first.appended).toBe(first.derived);
    const visits = await readQueueVisits(journalPath);
    expect(visits).toHaveLength(first.appended);
    expect(visits.some(v => v.id === 'RQ-W:a1' && v.station === 'READY')).toBe(true);
    expect(visits.some(v => v.id === 'RQ-S:a1' && v.station === 'merged')).toBe(true);

    const second = await sync();
    expect(second).toMatchObject({ state: 'read', appended: 0, unchanged: second.derived, regression: 0 });
    expect(await readQueueVisits(journalPath)).toHaveLength(first.appended);
  });

  it('honors injected jobs and queue text without touching the runs dir', async () => {
    const result = await sync({ runsDir: join(directory, 'absent'), jobsText, queueText });
    expect(result).toMatchObject({ state: 'read', queueState: 'read', journalState: 'read', appended: result.derived });
    expect(result.derived).toBeGreaterThan(0);
  });

  it('reports a missing jobs ledger and writes nothing', async () => {
    writeQueue(queueText);
    const result = await sync();
    expect(result).toMatchObject({ state: 'missing', queueState: 'not-read', journalState: 'not-read', derived: 0, appended: 0 });
    expect(existsSync(journalPath)).toBe(false);
  });

  it('skips live READY visits when the queue file is missing but still folds the ledger', async () => {
    writeJobs(jobsText);
    const result = await sync();
    expect(result).toMatchObject({ state: 'read', queueState: 'missing', journalState: 'read' });
    expect(result.appended).toBe(result.derived);
    const visits = await readQueueVisits(journalPath);
    expect(visits.some(v => v.id === 'RQ-W:a1')).toBe(false);
    expect(visits.some(v => v.id === 'RQ-S:a1' && v.station === 'merged')).toBe(true);
  });

  it('refuses to append against an unreadable journal', async () => {
    writeJobs(jobsText);
    writeQueue(queueText);
    mkdirSync(join(directory, 'home', 'queue'), { recursive: true });
    writeFileSync(journalPath, 'not json\n', { mode: 0o600 });
    const result = await sync();
    expect(result).toMatchObject({ state: 'read', journalState: 'unreadable', derived: result.derived, appended: 0 });
    expect(result.derived).toBeGreaterThan(0);
    expect(readFileSync(journalPath, 'utf8')).toBe('not json\n');
  });

  it('writes nothing when the signal is already aborted', async () => {
    writeJobs(jobsText);
    writeQueue(queueText);
    const result = await sync({ signal: AbortSignal.abort() });
    expect(result).toMatchObject({ state: 'read', queueState: 'not-read', journalState: 'not-read', appended: 0 });
    expect(existsSync(journalPath)).toBe(false);
  });
});

describe('compactQueueVisits', () => {
  let directory: string;
  let journalPath: string;
  const NOW_MS = 1_800_000_000_000;
  const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

  const visit = (id: string, station: string, arrivedAt: number, startedAt?: number, completedAt?: number): QueueVisit => {
    const v: QueueVisit = { id, station, pool: 'codex', arrivedAt };
    if (startedAt !== undefined) v.startedAt = startedAt;
    if (completedAt !== undefined) v.completedAt = completedAt;
    return v;
  };
  const seed = (visits: QueueVisit[]) => {
    mkdirSync(join(directory, 'queue'), { recursive: true });
    writeFileSync(journalPath, visits.map(v => JSON.stringify(v)).join('\n') + '\n', { mode: 0o600 });
  };
  const compact = (keepKeys?: ReadonlySet<string>, maxBytes = 1) =>
    compactQueueVisits(journalPath, { now: NOW_MS, keepKeys, maxBytes, recentMs: RECENT_MS });

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'visit-compact-')));
    journalPath = join(directory, 'queue', 'visits.jsonl');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('skips under-cap and missing journals without writing', async () => {
    const v = visit('a', 'claimed', NOW_MS - 1000, NOW_MS - 900, NOW_MS - 800);
    seed([v]);
    const under = await compactQueueVisits(journalPath, { now: NOW_MS, maxBytes: 1 << 20 });
    expect(under).toMatchObject({ state: 'read', compacted: false, skipped: 'under-cap' });
    expect(readFileSync(journalPath, 'utf8')).toBe(`${JSON.stringify(v)}\n`);
    expect(await compactQueueVisits(join(directory, 'absent.jsonl'), { now: NOW_MS })).toMatchObject({ state: 'missing', compacted: false });
  });

  it('aborts on a malformed line and leaves the file untouched', async () => {
    mkdirSync(join(directory, 'queue'), { recursive: true });
    writeFileSync(journalPath, 'not json\n', { mode: 0o600 });
    const result = await compact();
    expect(result).toMatchObject({ state: 'unreadable', compacted: false, skipped: 'malformed' });
    expect(readFileSync(journalPath, 'utf8')).toBe('not json\n');
  });

  it('keeps the latest snapshot per key plus open, recent and keepKeys visits; drops dead keys', async () => {
    const deadAt = NOW_MS - RECENT_MS - 60_000;
    const recentAt = NOW_MS - 60_000;
    const dead = visit('dead', 'claimed', deadAt, deadAt + 1_000, deadAt + 2_000);
    const open = visit('open', 'claimed', deadAt, deadAt + 1_000);
    const recent = visit('recent', 'merged', recentAt - 2_000, recentAt - 1_000, recentAt);
    const boundary = visit('boundary', 'merged', NOW_MS - RECENT_MS - 3_000, NOW_MS - RECENT_MS - 2_000, NOW_MS - RECENT_MS);
    const keptOld = visit('kept-old', 'claimed', deadAt, deadAt + 1_000, deadAt + 2_000);
    // 'multi' has three snapshots; only the completed one is the live latest.
    const multiEarly = visit('multi', 'publish', recentAt - 5_000, recentAt - 4_000);
    const multiLate = visit('multi', 'publish', recentAt - 5_000, recentAt - 4_000, recentAt - 3_000);
    const order = [dead, open, recent, boundary, keptOld, multiEarly, multiLate];
    seed(order);
    const before = await readQueueVisits(journalPath);

    const result = await compact(new Set([queueVisitKey(keptOld)]));
    expect(result).toMatchObject({ state: 'read', compacted: true, beforeLines: 7, afterLines: 5, dropped: 2 });

    const after = await readQueueVisits(journalPath);
    // Latest-per-key in original file order: dead and the two superseded
    // 'multi' snapshots are gone; boundary sits exactly at the cutoff.
    expect(after.map(v => v.id)).toEqual(['open', 'recent', 'boundary', 'kept-old', 'multi']);
    expect(after.find(v => v.id === 'multi')?.completedAt).toBe(recentAt - 3_000);
    // Every stats window ends before the retention horizon, so dropping dead
    // keys cannot move any aggregate the estimator reports.
    expect(estimateQueueStats(after, NOW_MS)).toEqual(estimateQueueStats(before, NOW_MS));
  });
});

describe('syncQueueVisits journal compaction', () => {
  let directory: string;
  let runsDir: string;
  let journalPath: string;
  const OLD = NOW - 40 * 24 * 60 * 60 * 1000;
  const oldIso = (offsetMs: number) => new Date(OLD + offsetMs).toISOString();

  const lifecycle = [
    { event: 'enqueue', job: 'RQ-OLD', lane: 'old-lane', ts: oldIso(0) },
    { event: 'launch', job: 'RQ-OLD', lane: 'old-lane', ts: oldIso(60_000) },
    { event: 'finish', job: 'RQ-OLD', lane: 'old-lane', ts: oldIso(180_000) },
    { event: 'enqueue', job: 'RQ-S', lane: 'codex', ts: T('14:00:00') },
    { event: 'launch', job: 'RQ-S', lane: 'codex', ts: T('14:00:30') },
    { event: 'finish', job: 'RQ-S', lane: 'codex', ts: T('14:02:30') },
    { event: 'publish', job: 'RQ-S', url: 'https://github.com/x/y/pull/1', ts: T('14:03:00') },
    { event: 'outcome', job: 'RQ-S', state: 'MERGED', url: 'https://github.com/x/y/pull/1', ts: T('14:06:00') },
    { event: 'enqueue', job: 'RQ-W', lane: 'codex', ts: T('14:10:00') },
  ];
  const jobsText = ledger(...lifecycle);

  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), 'visit-sync-compact-')));
    runsDir = join(directory, 'runs');
    journalPath = join(directory, 'home', 'queue', 'visits.jsonl');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), jobsText, { mode: 0o600 });
    writeFileSync(join(runsDir, 'queue', 'router-queue.md'), '- READY RQ-W (P0, pool=codex, tier=work, repo=phantom): Scope.\n', { mode: 0o600 });
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('rewrites an over-cap journal to the live evidence window on the sync pass', async () => {
    // Dead completed history: enough distinct old visits to exceed the byte
    // cap, none derivable from the jobs tail or the live queue.
    const filler: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes <= VISIT_JOURNAL_MAX_BYTES && i < 60000; i++) {
      const line = JSON.stringify({ id: `RQ-F${i}:a1`, station: 'claimed', pool: 'codex', arrivedAt: OLD, startedAt: OLD, completedAt: OLD });
      filler.push(line);
      bytes += line.length + 1;
    }
    expect(bytes).toBeGreaterThan(VISIT_JOURNAL_MAX_BYTES);
    const deadReady = { id: 'RQ-DEAD:a1', station: 'READY', pool: 'codex', arrivedAt: OLD, startedAt: OLD + 1_000, completedAt: OLD + 1_000 };
    const deadClaimed = { id: 'RQ-DEAD:a1', station: 'claimed', pool: 'codex', arrivedAt: OLD + 2_000, startedAt: OLD + 2_000 };
    const deadClaimedDone = { ...deadClaimed, completedAt: OLD + 3_000 };
    const wip = { id: 'RQ-WIP:a1', station: 'claimed', pool: 'codex', arrivedAt: OLD, startedAt: OLD };
    const recent = NOW - 60_000;
    const newEarly = { id: 'RQ-NEW:a1', station: 'merged', pool: 'codex', arrivedAt: recent - 2_000, startedAt: recent - 1_000 };
    const newLate = { ...newEarly, completedAt: recent };
    mkdirSync(join(directory, 'home', 'queue'), { recursive: true });
    writeFileSync(journalPath, [...filler, deadReady, deadClaimed, deadClaimedDone, wip, newEarly, newLate]
      .map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n') + '\n', { mode: 0o600 });

    const result = await syncQueueVisits({ runsDir, journalPath, now: () => NOW });
    expect(result).toMatchObject({ state: 'read', journalState: 'read', journalCompacted: true });
    expect(result.journalDropped).toBeGreaterThan(filler.length);

    const after = await readQueueVisits(journalPath);
    expect(after.length).toBeLessThan(50);
    expect(after.some(v => v.id.startsWith('RQ-F'))).toBe(false);
    expect(after.some(v => v.id === 'RQ-DEAD:a1')).toBe(false);
    // The open WIP visit survives regardless of age.
    expect(after.find(v => v.id === 'RQ-WIP:a1')).toMatchObject({ station: 'claimed' });
    expect(after.find(v => v.id === 'RQ-WIP:a1')?.completedAt).toBeUndefined();
    // Recent completions collapse to their latest snapshot.
    expect(after.filter(v => v.id === 'RQ-NEW:a1')).toHaveLength(1);
    // RQ-OLD completed 40 days ago — past the retention horizon — but its
    // lifecycle is still inside the jobs tail, so the derived keepKeys
    // protect it: dropping it would let the next pass re-append it forever.
    expect(after.some(v => v.id === 'RQ-OLD:a1' && v.station === 'claimed' && v.completedAt !== undefined)).toBe(true);
    expect(after.some(v => v.id === 'RQ-S:a1' && v.station === 'merged')).toBe(true);
  });

  it('leaves an under-cap journal untouched and reports no compaction', async () => {
    const result = await syncQueueVisits({
      runsDir, journalPath, now: () => NOW,
      jobsText: ledger({ event: 'enqueue', job: 'RQ-T', lane: 'codex', ts: T('14:00:00') }),
      queueText: null,
    });
    expect(result).toMatchObject({ state: 'read', journalState: 'read', journalCompacted: false, journalDropped: 0 });
    expect((await readQueueVisits(journalPath)).length).toBe(result.appended);
  });
});
