import { expect, it } from 'vitest';
import { formatWait, mergeWaitView } from './merge-wait-model.js';

const stage = (pr: number, q: number | null, c: number | null, m: number | null) =>
  ({ repo: 'fake/repo', pr, queue_wait_s: q, required_checks_s: c, merge_s: m });
const body = (report: object, ledger = 'present') => ({ schema: 'verse.merge-latency.v1', ledger, report: { window_hours: 24, ...report } });

it('computes medians and slowest over known values only', () => {
  const view = mergeWaitView(body({ pr_stages: [stage(1, 60, 600, null), stage(2, 120, null, 30), stage(3, 300, 1200, 90)] }))!;
  const [queue, checks, merge] = view.stages;
  expect(queue).toMatchObject({ medianS: 120, slowestS: 300, known: 3, total: 3 });
  expect(checks).toMatchObject({ medianS: 900, slowestS: 1200, known: 2, total: 3 });
  expect(merge).toMatchObject({ medianS: 60, slowestS: 90, known: 2, total: 3 });
  expect(view.verdict).toBe('Checks are the longest wait today');
});

it('keeps everything unknown, never 0, when no stage is known', () => {
  const view = mergeWaitView(body({ pr_stages: [stage(1, null, null, null)] }))!;
  for (const s of view.stages) expect(s).toMatchObject({ medianS: null, slowestS: null, known: 0, total: 1 });
  expect(view.verdict).toBeNull();
  expect(mergeWaitView(body({ pr_stages: null }))!.stages[0]).toMatchObject({ medianS: null, total: 0 });
});

it('names no dominant stage on a tie', () => {
  expect(mergeWaitView(body({ pr_stages: [stage(1, 60, 60, 10)] }))!.verdict).toBeNull();
});

it('says the window when it is not 24 hours', () => {
  expect(mergeWaitView(body({ window_hours: 6, pr_stages: [stage(1, 600, 60, 10)] }))!.verdict).toBe('Queue wait is the longest wait in the last 6h');
});

it('builds retry rows with plain reasons and https links', () => {
  const view = mergeWaitView(body({ queue_retries: {
    retryable: [{ repo: 'fake/repo', pr: 5, waiting_s: 3900, retries_left: 2 }],
    needs_person: [
      { repo: 'fake/repo', pr: 6, reason: 'unattributed', retries_used: 0 },
      { repo: 'fake/repo', pr: 7, reason: 'already-requested', retries_used: 1 },
      { repo: 'fake/repo', pr: 8, reason: 'too-many-retries', retries_used: 3 },
      { repo: 'bad repo', pr: 9, reason: 'unattributed', retries_used: 0 },
    ] } }))!;
  expect(view.retryable).toEqual([{ key: 'fake/repo#5', label: 'fake/repo#5', href: 'https://github.com/fake/repo/pull/5', detail: 'waiting 1h 5m, 2 retries left' }]);
  expect(view.needsPerson.map(r => r.detail)).toEqual(['no queue blocker recorded', 'retry already requested', '3 retries used', 'no queue blocker recorded']);
  expect(view.needsPerson[3]!.href).toBeNull();
});

it('rejects other shapes and formats durations', () => {
  expect(mergeWaitView({ schema: 'other' })).toBeNull();
  expect(mergeWaitView(null)).toBeNull();
  expect(mergeWaitView(body({}, 'missing'))!.ledger).toBe('missing');
  expect([formatWait(null), formatWait(45), formatWait(300), formatWait(7200)]).toEqual(['unknown', '45s', '5m', '2h']);
});
