import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetJobLatency, jobLatency } from '../src/cli/fleet-job-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdPulse } from '../src/cli/pulse.js';
import { mergeQueueLatency } from '../src/core/fleet/job-latency.js';
import { defaultGitRunner } from '../src/core/verse/git-ops.js';

const fixture = 'test/fixtures/job-latency/jobs.jsonl';
const gitFixture = 'test/fixtures/job-latency/git-observations.jsonl';
afterEach(() => vi.restoreAllMocks());

it('reads observations from real local Git calls and reports a held index lock', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'phantom-git-observations-'));
  const wt = join(cwd, 'wt');
  const git = async (...args: string[]) => (await defaultGitRunner('git', args, { cwd })).code;
  const home = await mkdtemp(join(tmpdir(), 'phantom-git-observations-home-'));
  vi.stubEnv('HOME', home);
  try {
    expect(await git('init', '-q')).toBe(0);
    expect(await git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'initial')).toBe(0);
    expect(await git('worktree', 'add', '--detach', wt)).toBe(0);
    expect(await git('worktree', 'remove', wt)).toBe(0);
    expect(await git('fetch', '.', 'HEAD')).toBe(0);
    expect(await git('push', '.', 'HEAD:refs/heads/observed')).toBe(0);
    await writeFile(join(cwd, '.git', 'index.lock'), '');
    expect(await git('add', '.')).not.toBe(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetJobLatency(['--json'])).toBe(0);
    const report: ReturnType<typeof jobLatency> = JSON.parse(log.mock.calls[0]![0] as string);
    expect(report.git_contention?.machines?.[0]?.lanes[0]?.operations).toMatchObject([
      { operation: 'index.lock', failures: { samples: 1, total: 1 } },
      { operation: 'worktree_add', timed_samples: 1, p90_ms: expect.any(Number) },
      { operation: 'worktree_remove', timed_samples: 1, p90_ms: expect.any(Number) },
      { operation: 'fetch', timed_samples: 1, retries: { samples: 1, total: 0 } },
      { operation: 'push', timed_samples: 1, retries: { samples: 1, total: 0 } },
    ]);
  } finally {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

it('ranks measured phases and excludes ambiguous and missing boundaries', async () => {
  const report = jobLatency(await readFile(fixture, 'utf8'));
  expect(report).toMatchObject({ jobs: 3, ignored_events: 1 });
  expect(report.top_wastes.map(x => [x.phase, x.total_seconds, x.measured_jobs, x.missing_jobs])).toEqual([
    ['worker', 150, 2, 1], ['merge', 50, 1, 2], ['ci', 40, 1, 2],
    ['queue_wait', 30, 2, 1], ['model', 30, 1, 2], ['publish_wait', 30, 1, 2], ['checkout', 20, 1, 2],
  ]);
  expect(report.top_wastes.every(x => x.fix_line.length > 0)).toBe(true);
  expect(jobLatency('{"job":"a","event":"launch","ts":"2026-01-01T00:00:02Z"}\n{"job":"a","event":"queued","ts":"2026-01-01T00:00:03Z"}').top_wastes).toEqual([]);
});

it('reads the production ledger dialects: enqueue arrival, PUBLISHED/published publish, reconciler MERGED', () => {
  const rows = [
    // dispatchd's queue-arrival stamp is `enqueue`; the publish producer's
    // claim is an outcome/state PUBLISHED row; the reconciler appends MERGED.
    { job: 'RQ-A', event: 'enqueue', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-A', event: 'launch', ts: '2026-01-01T00:00:10Z' },
    { job: 'RQ-A', event: 'finish', ts: '2026-01-01T00:01:00Z' },
    { jobId: 'RQ-A', prUrl: 'https://github.com/x/y/pull/1', outcome: 'PUBLISHED', ts: '2026-01-01T00:01:30Z' },
    // The reconciler copies the publish row and only swaps the outcome: this
    // is merge evidence, never a second publish boundary.
    { event: 'publish', jobId: 'RQ-A', prUrl: 'https://github.com/x/y/pull/1', outcome: 'MERGED', ts: '2026-01-01T00:04:00Z', mergedAt: '2026-01-01T00:04:00Z' },
    // `published` is the publish spelling visit-sync and dispatchd normalize.
    { job: 'RQ-B', event: 'enqueue', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-B', event: 'launch', ts: '2026-01-01T00:00:05Z' },
    { job: 'RQ-B', event: 'finish', ts: '2026-01-01T00:00:50Z' },
    { job: 'RQ-B', event: 'published', url: 'https://github.com/x/y/pull/2', ts: '2026-01-01T00:01:00Z' },
    // A closed-PR reconciler row is close evidence, never a second publish.
    { event: 'publish', jobId: 'RQ-B', prUrl: 'https://github.com/x/y/pull/2', outcome: 'CLOSED', ts: '2026-01-01T00:02:00Z', closedAt: '2026-01-01T00:02:00Z' },
  ];
  const text = rows.map(row => JSON.stringify(row)).join('\n');
  const report = jobLatency(text);
  const phase = (name: string) => report.phases.find(p => p.phase === name)!;
  expect(phase('queue_wait')).toMatchObject({ total_seconds: 15, measured_jobs: 2, missing_jobs: 0 });
  expect(phase('worker')).toMatchObject({ total_seconds: 95, measured_jobs: 2, missing_jobs: 0 });
  expect(phase('publish_wait')).toMatchObject({ total_seconds: 40, measured_jobs: 2, missing_jobs: 0 });
  // publish→merged is measurable even though no ci_start/ci_complete exists.
  const merge = mergeQueueLatency(text);
  expect(merge.phases.find(p => p.phase === 'open_to_merge')).toMatchObject({ total_seconds: 150, measured_jobs: 1, missing_jobs: 1 });
});

it('uses terminal verdicts even when earlier fields carry publish or unknown states', () => {
  const text = [
    { job: 'RQ-M', event: 'publish', ts: '2026-01-01T00:01:00Z' },
    { job: 'RQ-M', event: 'publish', state: 'PUBLISHED', status: 'MERGED', mergedAt: '2026-01-01T00:03:00Z' },
    { job: 'RQ-C', event: 'finish', ts: '2026-01-01T00:01:00Z' },
    { job: 'RQ-C', outcome: 'unknown', status: 'PUBLISHED', ts: '2026-01-01T00:02:00Z' },
    { job: 'RQ-C', event: 'publish', outcome: 'unknown', status: 'CLOSED', closedAt: '2026-01-01T00:04:00Z' },
  ].map(row => JSON.stringify(row)).join('\n');
  expect(mergeQueueLatency(text).phases.find(p => p.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: 120, measured_jobs: 1, missing_jobs: 1 });
  expect(jobLatency(text).phases.find(p => p.phase === 'publish_wait'))
    .toMatchObject({ total_seconds: 60, measured_jobs: 1, missing_jobs: 1 });
});

it('keeps conflicting publish dialects ambiguous rather than picking one', () => {
  const text = [
    { job: 'RQ-C', event: 'enqueue', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-C', event: 'launch', ts: '2026-01-01T00:00:10Z' },
    { job: 'RQ-C', event: 'finish', ts: '2026-01-01T00:01:00Z' },
    { job: 'RQ-C', event: 'publish', url: 'https://github.com/x/y/pull/3', ts: '2026-01-01T00:01:20Z' },
    { jobId: 'RQ-C', prUrl: 'https://github.com/x/y/pull/3', outcome: 'PUBLISHED', ts: '2026-01-01T00:01:40Z' },
  ].map(row => JSON.stringify(row)).join('\n');
  const report = jobLatency(text);
  expect(report.phases.find(p => p.phase === 'publish_wait')).toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it('measures job attempts without counting batch sessions or node-pool telemetry', () => {
  const rows = [
    { job: 'RQ-BATCH-1', event: 'launch', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-BATCH-1', event: 'finish', ts: '2026-01-01T00:10:00Z' },
    { job: 'RQ-MEMBER', batch: 'RQ-BATCH-1', event: 'publish', ts: '2026-01-01T00:02:00Z' },
    { job: 'RQ-MEMBER', outcome: 'MERGED', mergedAt: '2026-01-01T00:03:00Z' },
    { schema: 'fleet.session-pool.v1', job: 'session:1', event: 'launch', ts: '2026-01-01T00:00:00Z' },
    { schema: 'fleet.session-pool.v1', job: 'session:1', event: 'finish', ts: '2026-01-01T00:05:00Z' },
    { schema: 'phm-node-runner.v1', job: 'node:1', event: 'launch', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-SOLO', event: 'launch', ts: '2026-01-01T00:00:00Z' },
    { job: 'RQ-SOLO', event: 'finish', ts: '2026-01-01T00:01:00Z' },
  ];
  const text = rows.map(row => JSON.stringify(row)).join('\n');
  const report = jobLatency(text);
  expect(report).toMatchObject({ jobs: 2, ignored_events: 0 });
  expect(report.phases.find(p => p.phase === 'worker')).toMatchObject({ total_seconds: 60, measured_jobs: 1, missing_jobs: 1 });
  const merge = mergeQueueLatency(text);
  expect(merge).toMatchObject({ jobs: 2, ignored_events: 0 });
  expect(merge.phases.find(p => p.phase === 'open_to_merge')).toMatchObject({ total_seconds: 60, measured_jobs: 1, missing_jobs: 1 });
});

it('supports JSON, reports read errors, and is registered', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetJobLatency(['--jobs', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('fleet.job-latency.v1');
  // An unreadable ledger still prints the honest known:false report — the same
  // contract pulse merge-latency keeps — in text and --json mode, exit 1.
  expect(await cmdFleetJobLatency(['--jobs', '/missing'])).toBe(1);
  const textReport = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(textReport).toMatchObject({ schema: 'fleet.job-latency.v1', known: false, jobs: null });
  expect(await cmdFleetJobLatency(['--jobs', '/missing', '--json'])).toBe(1);
  const jsonReport = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(jsonReport).toMatchObject({ schema: 'fleet.job-latency.v1', known: false, jobs: null, ignored_events: null });
  expect(jsonReport.phases.every((p: { total_seconds: unknown }) => p.total_seconds === null)).toBe(true);
  expect(jsonReport.git_contention).toEqual({
    checkout_p90_ms: null, checkout_measured_jobs: null, recovery_measured_jobs: null,
    manual_recoveries_per_100_observed_jobs: null, machines: null,
  });
  expect(await cmdFleetJobLatency(['--json', '--json'])).toBe(2);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['job-latency']!()).cmdFleetJobLatency).toBe('function');
});

it('reports measured local Git operations and exact cross-lane overlaps only', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetJobLatency(['--jobs', gitFixture, '--json'])).toBe(0);
  const report: ReturnType<typeof jobLatency> = JSON.parse(log.mock.calls[0]![0] as string);
  expect(report).toMatchObject({ jobs: 3, ignored_events: 0, git_contention: {
    checkout_p90_ms: 4000, checkout_measured_jobs: 3, recovery_measured_jobs: 2, manual_recoveries_per_100_observed_jobs: 50,
  } });
  const op = (machine: string, lane: string, operation: string) => report.git_contention?.machines
    ?.find(m => m.machine === machine)?.lanes.find(l => l.lane === lane)?.operations.find(o => o.operation === operation);
  expect(op('mac-a', 'work', 'index.lock')).toMatchObject({ timed_samples: 2, p90_ms: 110, failures: { samples: 2, total: 1 } });
  expect(op('mac-a', 'work', 'worktree_add')).toMatchObject({ timed_samples: 1, p90_ms: 325 });
  expect(op('mac-a', 'work', 'worktree_remove')).toMatchObject({ timed_samples: 1, p90_ms: 100 });
  expect(op('mac-a', 'work', 'fetch')).toMatchObject({ p90_ms: 1000, retries: { samples: 2, total: 2 }, concurrent_retries: { samples: 2, total: 2 } });
  expect(op('mac-a', 'fast', 'push')).toMatchObject({ retries: { samples: 2, total: 5 }, concurrent_retries: { samples: 1, total: 1 } });
  expect(op('mac-b', 'mid', 'fetch')).toMatchObject({ retries: { samples: 1, total: 0 }, concurrent_retries: { samples: null, total: null } });
  expect(op('mac-b', 'mid', 'worktree_remove')).toMatchObject({ timed_samples: null, p90_ms: null });
  expect(jobLatency(await readFile(fixture, 'utf8')).git_contention).toMatchObject({ machines: null, recovery_measured_jobs: null });
  expect(mergeQueueLatency(await readFile(gitFixture, 'utf8'))).not.toHaveProperty('git_contention');
});

const event = (event: string, ts: string | null) => ({ job: 'attempt-1', event, ts });
const start = '2026-01-01T00:00:00Z', end = '2026-01-01T00:01:00Z';
it('keeps phases that span a recorded relaunch unmeasured', () => {
  const firstLaunch = event('launch', start);
  const relaunch = event('launch', end);
  const checkout = event('checkout_complete', '2026-01-01T00:00:30Z');
  const finish = event('finish', end);
  const merged = event('merged', '2026-01-01T00:02:00Z');
  const text = [merged, relaunch, event('publish', checkout.ts), finish, firstLaunch, checkout]
    .map(row => JSON.stringify(row)).join('\n');

  expect(jobLatency(text).phases.find(p => p.phase === 'model'))
    .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
  expect(mergeQueueLatency(text).phases.find(p => p.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it('measures phases whose boundaries both follow the last launch', () => {
  const text = [
    event('launch', start), event('launch', end),
    event('checkout_complete', '2026-01-01T00:01:10Z'),
    event('finish', '2026-01-01T00:01:30Z'),
    event('publish', '2026-01-01T00:02:00Z'),
  ].map(row => JSON.stringify(row)).join('\n');

  expect(jobLatency(text).phases.find(p => p.phase === 'model'))
    .toMatchObject({ total_seconds: 20, measured_jobs: 1, missing_jobs: 0 });
  expect(jobLatency(text).phases.find(p => p.phase === 'publish_wait'))
    .toMatchObject({ total_seconds: 30, measured_jobs: 1, missing_jobs: 0 });
});

it('withholds phase timings when a retry launch ties a non-launch start boundary', () => {
  const text = [
    event('launch', start),
    event('checkout_complete', end),
    event('publish', end),
    event('launch', end),
    event('finish', '2026-01-01T00:01:30Z'),
    event('merged', '2026-01-01T00:03:00Z'),
  ].map(row => JSON.stringify(row)).join('\n');

  expect(jobLatency(text).phases.find(phase => phase.phase === 'model'))
    .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
  expect(mergeQueueLatency(text).phases.find(phase => phase.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it.each([start, end, null])('withholds latency across a batch member claim at %s', timestamp => {
  const text = [
    event('publish', start),
    { ...event('batch_claim', timestamp), batch: 'RQ-BATCH-2' },
    event('merged', '2026-01-01T00:03:00Z'),
  ].map(row => JSON.stringify(row)).join('\n');

  expect(mergeQueueLatency(text).phases.find(phase => phase.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it('uses batch claims to separate attempts while requiring a launch for worker timing', () => {
  const text = [
    event('enqueue', start), event('finish', start),
    { ...event('batch_claim', end), batch: 'RQ-BATCH-2' },
    event('publish', '2026-01-01T00:02:00Z'), event('merged', '2026-01-01T00:03:00Z'),
  ].map(row => JSON.stringify(row)).join('\n');

  const report = jobLatency(text);
  for (const name of ['queue_wait', 'worker', 'publish_wait']) {
    expect(report.phases.find(phase => phase.phase === name))
      .toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
  }
  expect(mergeQueueLatency(text).phases.find(phase => phase.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: 60, measured_jobs: 1, missing_jobs: 0 });
});

it.each([null, 'bad-date'])('withholds phase timings when a launch timestamp is %s', timestamp => {
  const text = [
    event('enqueue', start),
    event('launch', end),
    event('checkout_complete', '2026-01-01T00:01:10Z'),
    event('finish', '2026-01-01T00:01:30Z'),
    event('publish', '2026-01-01T00:02:00Z'),
    event('merged', '2026-01-01T00:03:00Z'),
    event('launch', timestamp),
  ].map(row => JSON.stringify(row)).join('\n');

  for (const report of [jobLatency(text), mergeQueueLatency(text)]) {
    expect(report).toMatchObject({ jobs: 1, ignored_events: 1, top_wastes: [] });
    expect(report.phases.every(phase => phase.missing_jobs === 1 && phase.total_seconds === null)).toBe(true);
  }
});

it.each([
  ['missing', [event('ci_start', start)]],
  ['reversed', [event('ci_start', end), event('ci_complete', start)]],
  ['ambiguous', [event('ci_start', start), event('ci_start', end), event('ci_complete', end)]],
  ['invalid', [event('ci_start', 'bad-date'), event('ci_complete', end)]],
  ['invalid duplicate', [event('ci_start', start), event('ci_start', null), event('ci_complete', end)]],
] as const)('keeps %s check boundaries unknown', (_name, rows) => {
  const report = mergeQueueLatency(rows.map(row => JSON.stringify(row)).join('\n'));
  expect(report.phases[1]).toMatchObject({ total_seconds: null, measured_jobs: 0, missing_jobs: 1 });
});

it('uses actual merge time, aliases and shuffled events without counting duplicate boundaries twice', () => {
  const rows = [
    { job_id: 'attempt-1', type: 'outcome', state: 'MERGED', timestamp: '2026-01-02T00:00:00Z', mergedAt: '2026-01-01T00:03:00Z' },
    event('ci_complete', '2026-01-01T00:02:00Z'), event('publish', start), event('ci_start', end), event('ci_start', end),
  ];
  const report = mergeQueueLatency(rows.map(row => JSON.stringify(row)).join('\n'));
  expect(report.schema).toBe('pulse.merge-latency.v1');
  expect(report.phases.map(p => [p.phase, p.total_seconds, p.measured_jobs, p.missing_jobs])).toEqual([
    ['check_wait', 60, 1, 0], ['ci', 60, 1, 0], ['merge', 60, 1, 0], ['open_to_merge', 180, 1, 0],
  ]);
  expect(mergeQueueLatency([event('ci_start', start), event('ci_complete', start)].map(row => JSON.stringify(row)).join('\n')).phases[1]?.total_seconds).toBe(0);
});

it('withholds phases whose boundaries name different pull requests', () => {
  const first = 'https://github.com/acme/phantom/pull/1';
  const second = 'https://github.com/acme/phantom/pull/2';
  const text = [
    { ...event('publish', start), prUrl: first },
    { ...event('ci_start', end), pr_url: 'https://github.com/Acme/Phantom/pull/1/' },
    { ...event('ci_complete', '2026-01-01T00:02:00Z'), url: second },
    { ...event('merged', '2026-01-01T00:03:00Z'), pr: second },
  ].map(row => JSON.stringify(row)).join('\n');

  expect(mergeQueueLatency(text).phases.map(phase => [phase.phase, phase.total_seconds])).toEqual([
    ['check_wait', 60], ['ci', null], ['merge', 60], ['open_to_merge', null],
  ]);
  expect(jobLatency(text).phases.find(phase => phase.phase === 'ci'))
    .toMatchObject({ measured_jobs: 0, missing_jobs: 1, total_seconds: null });
});

it('retains conflicting PR claims on otherwise duplicate boundaries', () => {
  const text = [
    event('ci_start', start),
    { ...event('ci_complete', end), url: 'https://github.com/acme/phantom/pull/1' },
    { ...event('ci_complete', end), url: 'https://github.com/acme/phantom/pull/2' },
  ].map(row => JSON.stringify(row)).join('\n');

  for (const report of [jobLatency(text), mergeQueueLatency(text)]) {
    expect(report.phases.find(phase => phase.phase === 'ci'))
      .toMatchObject({ measured_jobs: 0, missing_jobs: 1, total_seconds: null });
  }
});

it.each([
  ['matching CI identity', 'ci_start', end, 1, 180],
  ['conflicting CI start', 'ci_start', end, 2, null],
  ['conflicting CI completion', 'ci_complete', end, 2, null],
  ['undated conflicting CI identity', 'ci_start', null, 2, null],
  ['conflicting CI identity before publish', 'ci_start', '2025-12-31T23:59:59Z', 2, 180],
  ['conflicting CI identity after merge', 'ci_complete', '2026-01-01T00:03:01Z', 2, 180],
] as const)('checks the publish-to-merge span with %s', (_name, stage, at, pr, seconds) => {
  const text = [
    { ...event('publish', start), url: 'https://github.com/acme/phantom/pull/1' },
    { ...event(stage, at), url: `https://github.com/acme/phantom/pull/${pr}` },
    event('merged', '2026-01-01T00:03:00Z'),
  ].map(row => JSON.stringify(row)).join('\n');

  expect(mergeQueueLatency(text).phases.find(phase => phase.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: seconds, measured_jobs: seconds === null ? 0 : 1 });
});

it('reads the remaining timestamp aliases and the kind event key', () => {
  const rows = [
    { job: 'attempt-1', kind: 'enqueue', time: '2026-01-01T00:00:00Z' },
    { job: 'attempt-1', type: 'launch', at: '2026-01-01T00:00:10Z' },
    { job: 'attempt-1', event: 'finish', recordedAt: '2026-01-01T00:01:00Z' },
    { job: 'attempt-1', outcome: 'PUBLISHED', updatedAt: '2026-01-01T00:01:30Z' },
  ];
  const text = rows.map(row => JSON.stringify(row)).join('\n');
  const report = jobLatency(text);
  const phase = (name: string) => report.phases.find(p => p.phase === name)!;
  expect(report).toMatchObject({ jobs: 1, ignored_events: 0 });
  expect(phase('queue_wait')).toMatchObject({ total_seconds: 10, measured_jobs: 1 });
  expect(phase('worker')).toMatchObject({ total_seconds: 50, measured_jobs: 1 });
  expect(phase('publish_wait')).toMatchObject({ total_seconds: 30, measured_jobs: 1 });
});

it('joins latency boundaries using the first usable lifecycle aliases', () => {
  const text = [
    { job: ' ', job_id: 'attempt-1', event: '', type: ' Enqueue ', ts: '2026-01-01T00:00:00Z' },
    { job: 42, jobId: 'attempt-1', event: false, type: ' ', kind: 'Launch', at: '2026-01-01 01:00:10+0100' },
    { id: ' attempt-1 ', event: ' Finish ', ts: '2026-01-01T00:01:00Z' },
    { job: 'attempt-1', event: 'Published', ts: '2026-01-01T00:02:00Z' },
    { job: 'attempt-1', outcome: 'MERGED', mergedAt: '2026-01-01T00:04:00Z' },
  ].map(row => JSON.stringify(row)).join('\n');

  const report = jobLatency(text);
  expect(report).toMatchObject({ jobs: 1, ignored_events: 0 });
  expect(report.phases.find(p => p.phase === 'queue_wait')).toMatchObject({ total_seconds: 10, measured_jobs: 1 });
  expect(report.phases.find(p => p.phase === 'worker')).toMatchObject({ total_seconds: 50, measured_jobs: 1 });
  expect(report.phases.find(p => p.phase === 'publish_wait')).toMatchObject({ total_seconds: 60, measured_jobs: 1 });
  expect(mergeQueueLatency(text).phases.find(p => p.phase === 'open_to_merge'))
    .toMatchObject({ total_seconds: 120, measured_jobs: 1 });
});

it('exposes versioned pulse JSON and plain text, including unreadable ledgers and usage errors', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdPulse(['merge-latency', '--jobs', fixture, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ schema: 'pulse.merge-latency.v1', known: true, jobs: 3 });
  expect(await cmdPulse(['merge-latency', '--jobs', fixture])).toBe(0);
  expect(log.mock.calls.at(-1)![0]).toContain('Waiting for checks: unknown');
  expect(log.mock.calls.at(-1)![0]).toContain('Running checks: 40s total observed');
  expect(await cmdPulse(['merge-latency', '--jobs', '/missing', '--json'])).toBe(1);
  const missing = JSON.parse(log.mock.calls.at(-1)![0] as string);
  expect(missing).toMatchObject({ schema: 'pulse.merge-latency.v1', known: false, jobs: null });
  expect(missing.phases.every((p: { total_seconds: null }) => p.total_seconds === null)).toBe(true);
  expect(await cmdPulse(['merge-latency', '--jobs'])).toBe(2);
  expect(await cmdPulse(['merge-latency', '--json', '--json'])).toBe(2);
  expect(await cmdPulse(['merge-latency', '--help'])).toBe(0);
});
