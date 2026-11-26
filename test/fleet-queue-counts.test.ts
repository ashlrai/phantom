import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueCounts } from '../src/cli/fleet-queue-counts.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { getLaneQueueCounts } from '../src/core/fleet/queue-counts.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const now = () => NOW;
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const row = (status: string, id: string, pool: string) => `${status}\t${id}\t${pool}\twork\texample/phantom\tFixture`;
const merge = (job: string, lane: string, ts: string | undefined, url?: string) =>
  JSON.stringify({ job, lane, event: 'outcome', state: 'MERGED', ...(ts ? { ts } : {}), ...(url ? { url } : {}) });

let root: string;
let queueDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'queue-counts-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

it('counts ready, parked, running and last-hour merges per lane', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin'), row('READY', 'c-1', 'codex'),
    row('PARKED-DEP.devin', 'a-3', 'devin'),
    row('CLAIMED', 'a-4', 'devin'), row('RUNNING', 'c-2', 'codex'),
  ].join('\n'));
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', minutesAgo(10)), merge('m-2', 'devin', minutesAgo(59)),
    merge('m-3', 'devin', minutesAgo(61)), merge('m-4', 'codex', minutesAgo(5)),
  ].join('\n'));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes).toEqual([
    { lane: 'codex', ready: 1, parked: 0, running: 1, merges: 1, oldestWaitSeconds: null, blockedReasons: [], stale: 0 },
    { lane: 'devin', ready: 2, parked: 1, running: 1, merges: 2, oldestWaitSeconds: null, blockedReasons: [{ reason: 'DEP', count: 1 }], stale: 0 },
  ]);
  expect(report.totals).toEqual({ ready: 3, parked: 1, running: 2, merges: 3, blockedReasons: [{ reason: 'DEP', count: 1 }], stale: 0 });
});

it('ignores merge events with missing or invalid timestamps', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', undefined), merge('m-2', 'devin', 'not-a-date'),
    merge('m-3', 'devin', minutesAgo(-30)), merge('m-4', 'devin', minutesAgo(1)),
  ].join('\n'));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin).toMatchObject({ lane: 'devin', merges: 1 });
});

it('reports zero merges only when the merge ledger is healthy', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    'id\tstatus\tpool\tat',
    `m-1\tLAND\tdevin\t${minutesAgo(5)}`,
    'a-1\tREADY\tcodex\t',
  ].join('\n'));
  const ledger = join(queueDir, 'jobs.jsonl');
  const cases = [
    { contents: null, state: 'missing', codex: null, total: null },
    { contents: 'malformed\n', state: 'degraded', codex: null, total: null },
    { contents: '', state: 'healthy', codex: 0, total: 1 },
  ];
  for (const { contents, state, codex, total } of cases) {
    if (contents !== null) await writeFile(ledger, contents);
    const report = await getLaneQueueCounts({ runsDir: root, now });
    expect(report.sources.ledger).toBe(state);
    expect(report.lanes).toMatchObject([
      { lane: 'codex', merges: codex },
      { lane: 'devin', merges: 1 },
    ]);
    expect(report.totals.merges).toBe(total);
  }
});

it('counts a duplicated merge event once, by PR then by job', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  const pr = 'https://github.com/ashlrai/phantom/pull/42';
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    merge('m-1', 'devin', minutesAgo(9), pr), merge('m-1', 'devin', minutesAgo(8), pr),
    merge('m-1', 'devin', minutesAgo(7)),
    merge('m-2', 'devin', minutesAgo(6)), merge('m-2', 'devin', minutesAgo(5)),
  ].join('\n'));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin!.merges).toBe(2);
});

it('keeps late duplicate receipts out of the trailing-hour merge count', async () => {
  const url = (id: number) => `https://github.com/example/phantom/pull/${id}`;
  const receipts = [
    { job: 'old', lane: 'devin', state: 'MERGED', prUrl: url(1), ts: minutesAgo(5), mergedAt: minutesAgo(70) },
    { job: 'other-attempt', lane: 'claude', state: 'MERGED', prUrl: url(1), ts: minutesAgo(4) },
    { job: 'old', lane: 'devin', state: 'MERGED', ts: minutesAgo(3) },
    { job: 'old', lane: 'devin', state: 'MERGED', prUrl: url(2), ts: minutesAgo(2) },
    { job: 'recent', lane: 'codex', state: 'MERGED', prUrl: url(3), ts: minutesAgo(1), mergedAt: minutesAgo(15) },
    { job: 'recent-copy', lane: 'claude', state: 'MERGED', prUrl: url(3), ts: minutesAgo(16) },
    { job: 'unattributed', state: 'MERGED', prUrl: url(4), mergedAt: minutesAgo(20) },
    { job: 'unattributed-copy', lane: 'devin', state: 'MERGED', prUrl: url(4), ts: minutesAgo(19) },
  ];
  await writeFile(join(queueDir, 'jobs.jsonl'), receipts.reverse().map(receipt => JSON.stringify(receipt)).join('\n'));
  await writeFile(join(queueDir, 'ready.tsv'), `id\tstatus\tpool\tat\nold\tLAND\tdevin\t${minutesAgo(5)}\n`);

  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes.map(({ lane, merges }) => ({ lane, merges }))).toEqual([
    { lane: 'codex', merges: 1 }, { lane: 'devin', merges: 2 },
  ]);
  expect(report.totals.merges).toBe(3);
});

it('attributes timed merges only from duplicate receipts with usable timestamps', async () => {
  const prUrl = 'https://github.com/example/phantom/pull/10';
  await writeFile(join(queueDir, 'jobs.jsonl'), [
    { lane: 'claude', state: 'MERGED', prUrl },
    { lane: 'devin', state: 'MERGED', prUrl, ts: minutesAgo(-1) },
    { lane: 'codex', state: 'MERGED', prUrl, ts: minutesAgo(5) },
    { state: 'MERGED', prUrl, mergedAt: minutesAgo(10) },
  ].map(receipt => JSON.stringify(receipt)).join('\n'));

  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes.map(({ lane, merges }) => ({ lane, merges }))).toEqual([{ lane: 'codex', merges: 1 }]);
  expect(report.totals.merges).toBe(1);
});

it('reports unknown (null), not zero, when sources are absent', async () => {
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes).toEqual([]);
  expect(report.totals).toEqual({ ready: null, parked: null, running: null, merges: null, blockedReasons: [], stale: null });
  expect(report.sources).toEqual({ ready: 'missing', running: 'missing', ledger: 'missing' });
  expect(report.notes.length).toBeGreaterThanOrEqual(3);
  expect(report.notes.join(' ')).toContain('queue/ready.tsv not found');
  await writeFile(join(queueDir, 'jobs.jsonl'), merge('m-1', 'devin', minutesAgo(3)));
  const [devin] = (await getLaneQueueCounts({ runsDir: root, now })).lanes;
  expect(devin).toEqual({ lane: 'devin', ready: null, parked: null, running: null, merges: 1, oldestWaitSeconds: null, blockedReasons: [], stale: null });
});

it('includes parked jobs in the oldest wait and refuses incomplete or ambiguous metrics', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('PARKED-DEP.devin', 'a-2', 'devin')].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const queued = (job: string, minutes: number) => JSON.stringify({ job, event: 'queued', ts: minutesAgo(minutes) });
  await writeFile(path, queued('a-1', 5));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBeNull();
  await writeFile(path, [queued('a-1', 5), queued('a-2', 30)].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBe(1800);
  // Repeat sightings of one uninterrupted dwell keep the earliest arrival;
  // they are not conflicting evidence.
  await writeFile(path, [queued('a-1', 5), queued('a-2', 30), queued('a-2', 20)].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBe(1800);
});

it('reads the enqueue spelling dispatchd writes, not only the queued alias', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin')].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const enqueued = (job: string, minutes: number) => JSON.stringify({ job, event: 'enqueue', repo: 'ashlrai/phantom', lane: 'devin', tier: 'work', ts: minutesAgo(minutes) });
  await writeFile(path, [enqueued('a-1', 45), enqueued('a-2', 10)].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBe(2700);
});

it('measures wait from re-arrival, not the first-ever enqueue', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin'), row('READY', 'a-3', 'devin')].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const enqueued = (job: string, minutes: number) => JSON.stringify({ job, event: 'enqueue', ts: minutesAgo(minutes) });
  const departed = (job: string, minutes: number) => JSON.stringify({ job, event: 'launch', ts: minutesAgo(minutes) });
  // dispatchd emits enqueue once per job, so a-1's wait restarted at its
  // launch_failed retry 10 minutes ago — not its 90-minute-old enqueue.
  await writeFile(path, [
    enqueued('a-1', 90), departed('a-1', 80),
    JSON.stringify({ job: 'a-1', event: 'launch_failed', action: 'retry', ts: minutesAgo(10) }),
    enqueued('a-2', 45), departed('a-2', 40),
    // a-2 requeued silently (deferred launch): no re-arrival row exists, so
    // its wait is unknown and the lane reports null rather than 45 minutes.
    enqueued('a-3', 20),
  ].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBeNull();
  // With the silently requeued job gone, the oldest wait is a-3's 20-minute
  // dwell; a-1's retry restarted its own clock only 10 minutes ago.
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-3', 'devin')].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBe(1200);
});

it('counts batch departures and retried member outcomes as queue marks', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin')].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const enqueued = (job: string, minutes: number) => JSON.stringify({ job, event: 'enqueue', ts: minutesAgo(minutes) });
  await writeFile(path, [
    enqueued('a-1', 120),
    JSON.stringify({ job: 'a-1', event: 'batch_claim', batch: 'B-1', ts: minutesAgo(100) }),
    // A failed member goes back to ready.tsv at its task_outcome stamp.
    JSON.stringify({ job: 'a-1', event: 'task_outcome', batch: 'B-1', outcome: 'failed', ts: minutesAgo(15) }),
    enqueued('a-2', 30),
    JSON.stringify({ job: 'a-2', event: 'batch_claim', batch: 'B-2', ts: minutesAgo(25) }),
    // done hands the member off to its own publish; it is not a re-arrival.
    JSON.stringify({ job: 'a-2', event: 'task_outcome', batch: 'B-2', outcome: 'done', ts: minutesAgo(20) }),
  ].join('\n'));
  const counts = await getLaneQueueCounts({ runsDir: root, now });
  // a-1 waits since its failed member outcome; a-2's last mark is a
  // departure, so its wait is unknown and the lane reports null.
  expect(counts.lanes[0]!.oldestWaitSeconds).toBeNull();
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  expect((await getLaneQueueCounts({ runsDir: root, now })).lanes[0]!.oldestWaitSeconds).toBe(900);
});

it('keeps oldest waits honest across both ends of an oversized ledger', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin'), row('READY', 'a-3', 'devin'),
  ].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const enqueued = (job: string, minutes: number) => JSON.stringify({ job, event: 'enqueue', ts: minutesAgo(minutes) });
  const filler = Array.from({ length: 60 }, (_, i) => JSON.stringify({ job: `f-${i}`, event: 'launch', ts: minutesAgo(1) }));
  // a-1's enqueue sits in the head window, a-2's in the tail window, and
  // a-3's lands in the unread middle: its wait stays unknown, so the lane's
  // oldest wait is null rather than silently dropping the uncovered job.
  await writeFile(path, [enqueued('a-1', 60), ...filler.slice(0, 30), enqueued('a-3', 20), ...filler.slice(30), enqueued('a-2', 10)].join('\n'));
  const counts = await getLaneQueueCounts({ runsDir: root, now, ledgerBytes: 512 });
  expect(counts.lanes[0]).toMatchObject({ lane: 'devin', ready: 3, oldestWaitSeconds: null });
  // With a-3 gone, both remaining enqueues are inside the read windows and
  // the oldest wait is the head-window enqueue, not a guess.
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin')].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now, ledgerBytes: 512 })).lanes[0]!.oldestWaitSeconds).toBe(3600);
});

it('dedupes enqueue evidence when the end windows overlap', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [row('READY', 'a-1', 'devin'), row('READY', 'a-2', 'devin')].join('\n'));
  await mkdir(join(root, 'metrics'));
  const path = join(root, 'metrics', 'jobs.jsonl');
  const enqueued = (job: string, minutes: number) => JSON.stringify({ job, event: 'enqueue', ts: minutesAgo(minutes) });
  const filler = (n: number) => JSON.stringify({ job: `f-${n}`, event: 'launch', ts: minutesAgo(1) });
  // File larger than one 1 KiB window but smaller than two: the windows
  // overlap around a-1's line, so it is read twice and must still count once.
  await writeFile(path, [
    ...Array.from({ length: 8 }, (_, i) => filler(i)),
    enqueued('a-1', 50),
    ...Array.from({ length: 6 }, (_, i) => filler(8 + i)),
    enqueued('a-2', 5),
  ].join('\n'));
  expect((await getLaneQueueCounts({ runsDir: root, now, ledgerBytes: 1024 })).lanes[0]!.oldestWaitSeconds).toBe(3000);
});

it('prints text and JSON from the CLI and rejects bad arguments', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('READY', 'a-1', 'devin'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetQueueCounts(['--root', root])).toBe(0);
  expect(log.mock.calls.map(c => String(c[0]))).toEqual([
    'devin  ready 1  parked 0  running unknown  oldest wait unknown  merges in last hour unknown',
    'total  ready 1  parked 0  running unknown  merges in last hour unknown',
    'note: merge ledger (jobs.jsonl) not found: merges are unknown.',
    'note: metrics/jobs.jsonl not found: oldest waits are unknown.',
  ]);
  expect(await cmdFleetQueueCounts(['--root', root, '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).schema).toBe('fleet.queue-counts.v1');
  expect(await cmdFleetQueueCounts(['--root', 'relative'])).toBe(2);
  expect(await cmdFleetQueueCounts(['--bogus'])).toBe(2);
  expect(err).toHaveBeenCalled();
  expect(FLEET_SUBCOMMAND_LOADERS['queue-counts']).toBeTypeOf('function');
});

it('reports a healthy empty queue as zeros with no notes', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), '');
  await writeFile(join(queueDir, 'jobs.jsonl'), '');
  await writeFile(join(queueDir, 'queue.v1.json'), JSON.stringify({ v: 1, jobs: [] }));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.lanes).toEqual([]);
  expect(report.sources.ready).toBe('healthy');
  expect(report.totals).toMatchObject({ ready: 0, parked: 0, blockedReasons: [], stale: 0 });
});

it('groups blocked jobs by reason per lane, biggest first', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), [
    row('PARKED-DEP.devin', 'a-1', 'devin'), row('PARKED-HOLD.devin', 'a-2', 'devin'), row('PARKED-HOLD.devin', 'a-3', 'devin'),
    row('PARKED-DEP.codex', 'c-1', 'codex'), row('READY', 'c-2', 'codex'),
  ].join('\n'));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  const byLane = Object.fromEntries(report.lanes.map(l => [l.lane, l.blockedReasons]));
  expect(byLane.devin).toEqual([{ reason: 'HOLD', count: 2 }, { reason: 'DEP', count: 1 }]);
  expect(byLane.codex).toEqual([{ reason: 'DEP', count: 1 }]);
  expect(report.totals.blockedReasons).toEqual([{ reason: 'DEP', count: 2 }, { reason: 'HOLD', count: 2 }]);
});

it('flags stale parked rows whose dependency gates are all merged', async () => {
  await mkdir(join(queueDir, 'prompts'));
  await mkdir(join(root, 'metrics'));
  const done = join(queueDir, 'prompts', 'done.md');
  const open = join(queueDir, 'prompts', 'open.md');
  await writeFile(done, 'DEPENDENCY GATE: RQ-DONE\n');
  await writeFile(open, 'DEPENDENCY GATE: RQ-OPEN\n');
  await writeFile(join(queueDir, 'ready.tsv'), [
    `PARKED-DEP.devin\tRQ-STALE\tdevin\twork\tphantom\t${done}`,
    `PARKED-DEP.devin\tRQ-WAIT\tdevin\twork\tphantom\t${open}`,
  ].join('\n'));
  await writeFile(join(root, 'metrics', 'jobs.jsonl'), JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DONE' }));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  const devin = report.lanes.find(l => l.lane === 'devin');
  expect(devin).toMatchObject({ parked: 2, stale: 1 });
  expect(report.totals.stale).toBe(1);
});

it('marks a malformed queue as degraded and keeps counts null-safe', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), `${row('READY', 'a-1', 'devin')}\nthis is not a row`);
  await writeFile(join(queueDir, 'jobs.jsonl'), 'not json');
  const report = await getLaneQueueCounts({ runsDir: root, now });
  expect(report.sources.ready).toBe('degraded');
  expect(report.sources.ledger).toBe('degraded');
  expect(report.notes.some(n => n.includes('unreadable or has malformed rows'))).toBe(true);
});

it('withholds queue counts for an unreadable ready source while preserving measured merges', async () => {
  await mkdir(join(queueDir, 'ready.tsv'));
  await writeFile(join(queueDir, 'jobs.jsonl'), merge('m-1', 'codex', minutesAgo(5)));
  const report = await getLaneQueueCounts({ runsDir: root, now });
  const unknownQueue = { ready: null, parked: null, stale: null, blockedReasons: [] };
  expect(report.sources.ready).toBe('degraded');
  expect(report.lanes).toMatchObject([{ lane: 'codex', ...unknownQueue, merges: 1, oldestWaitSeconds: null }]);
  expect(report.totals).toMatchObject({ ...unknownQueue, merges: 1 });
});

it('prints blocked reasons and notes in text output', async () => {
  await writeFile(join(queueDir, 'ready.tsv'), row('PARKED-HOLD.devin', 'a-1', 'devin'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetQueueCounts(['--root', root])).toBe(0);
  const out = log.mock.calls.map(c => String(c[0]));
  expect(out[0]).toContain('parked 1  blocked by HOLD 1');
  expect(out.some(l => l.startsWith('note: '))).toBe(true);
});
