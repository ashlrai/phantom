import { describe, expect, it } from 'vitest';
import { planVisitSync, queueReadyVisits, queueVisitsFromJobs } from '../src/core/queue/visit-sync.js';
import type { QueueVisit } from '../src/core/queue/stats.js';

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
