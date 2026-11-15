import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetQueueLatency, queueLatency, validQueueLatencyInput, type QueueLatencyInput } from '../src/cli/fleet-queue-latency.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const sha = 'a'.repeat(40);
const at = (h: number, m = 0) => `2026-11-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const snapshot: QueueLatencyInput = { prs: [
  { repo: 'ashlrai/phantom', number: 1, queuePosition: 1, mergeable: 'MERGEABLE',
    stages: [{ stage: 'opened', at: at(8) }, { stage: 'approved', at: at(9) }, { stage: 'queued', at: at(10) }, { stage: 'checks_started', at: at(11) }] },
  { repo: 'ashlrai/phantom', number: 2, queuePosition: 3, mergeable: 'CONFLICTING', headSha: sha,
    stages: [{ stage: 'queued', at: at(7) }, { stage: 'opened', at: at(5) }] },
  { repo: 'ashlrai/phantom', number: 3, mergeable: 'CONFLICTING', stages: [{ stage: 'opened', at: at(11, 30) }] },
] };
afterEach(() => vi.restoreAllMocks());

it('measures each step, names the slowest and ranks waits without changing input', () => {
  const before = structuredClone(snapshot);
  const r = queueLatency(snapshot, now);
  expect(r).toMatchObject({ schema: 'fleet.queue-latency.v1', readOnly: true, requiredChecksPreserved: true, slowest_stage: 'opened' });
  const by = Object.fromEntries(r.stages.map(s => [s.stage, s]));
  expect(by.opened).toMatchObject({ count: 2, median_s: 3600, max_s: 7200 });
  expect(by.queued).toMatchObject({ count: 1, median_s: 3600 });
  expect(by.checks_started).toMatchObject({ count: 0, median_s: null });
  // Stages may arrive out of order; the latest one is current; a conflict outranks queue position.
  expect(r.prs.map(p => [p.number, p.stage, p.waiting_s, p.wait_cause])).toEqual(
    [[2, 'queued', 18000, 'conflict'], [1, 'checks_started', 3600, 'checks'], [3, 'opened', 1800, 'conflict']]);
  expect(snapshot).toEqual(before);
});

it('recommends an automatic recut once per conflicting head and hands the rest to a person', () => {
  const r = queueLatency(snapshot, now);
  expect(r.advice.map(a => [a.number, a.action])).toEqual([[2, 'recut'], [3, 'needs_person']]);
  expect(r.advice[0]).toMatchObject({ recut: { key: 'RQ-RECUT-phantom-2-aaaaaaa', headSha: sha }, waiting_s: 18000 });
  expect(r.advice[1]).toMatchObject({ reason: 'no-head' });
  const pr = (extra: object) => queueLatency({ prs: [{ ...snapshot.prs[1]!, ...extra }] }, now).advice[0]!;
  expect(pr({ lastRecutHead: 'aaaaaaa' })).toMatchObject({ action: 'needs_person', reason: 'already-requested' });
  expect(pr({ lastRecutHead: 'bbbbbbb' })).toMatchObject({ action: 'recut' });
  expect(pr({ recutRequests: 3 })).toMatchObject({ action: 'needs_person', reason: 'too-many-recuts' });
  expect(pr({ headSha: 'not-a-sha' })).toMatchObject({ reason: 'no-head' });
  expect(pr({ mergeable: 'UNKNOWN' })).toBeUndefined();
});

it('ignores future steps and handles an empty or fully future snapshot', () => {
  expect(queueLatency({ prs: [] }, now)).toMatchObject({ prs: [], advice: [], slowest_stage: null });
  expect(queueLatency({ prs: [{ repo: 'a/b', number: 1, stages: [{ stage: 'opened', at: '2099-01-01T00:00:00Z' }] }] }, now).prs).toEqual([]);
  expect(() => queueLatency({ prs: [] }, NaN)).toThrow();
});

it('counts repeated completed steps and keeps the first chronological longest step on ties', () => {
  const input: QueueLatencyInput = { prs: [{ repo: 'a/b', number: 1, stages: [
    { stage: 'queued', at: at(11) },
    { stage: 'opened', at: at(8) },
    { stage: 'approved', at: at(9) },
    { stage: 'opened', at: at(10) },
    { stage: 'checks_started', at: at(13) },
  ] }] };
  const report = queueLatency(input, now);
  expect(report.prs).toEqual([{ repo: 'a/b', number: 1, stage: 'queued', waiting_s: 3600,
    wait_cause: null, slowest_stage: 'opened' }]);
  expect(report.stages).toEqual([
    { stage: 'opened', label: 'waiting for approval', count: 2, median_s: 3600, max_s: 3600 },
    { stage: 'approved', label: 'waiting to join the queue', count: 1, median_s: 3600, max_s: 3600 },
    { stage: 'queued', label: 'waiting in the queue', count: 0, median_s: null, max_s: null },
    { stage: 'checks_started', label: 'running required checks', count: 0, median_s: null, max_s: null },
  ]);
});

it('preserves stable ordering for simultaneous steps and rounds each interval separately', () => {
  const report = queueLatency({ prs: [{ repo: 'a/b', number: 1, stages: [
    { stage: 'opened', at: new Date(now - 1400).toISOString() },
    { stage: 'approved', at: new Date(now - 1400).toISOString() },
    { stage: 'queued', at: new Date(now - 600).toISOString() },
  ] }] }, now);
  expect(report.prs[0]).toMatchObject({ stage: 'queued', waiting_s: 1, slowest_stage: 'approved' });
  expect(report.stages.map(s => [s.stage, s.count, s.median_s])).toEqual([
    ['opened', 1, 0], ['approved', 1, 1], ['queued', 0, null], ['checks_started', 0, null],
  ]);
});

it('prioritizes missing head evidence, then retry exhaustion, then duplicate requests', () => {
  const pr = { ...snapshot.prs[1]!, recutRequests: 3, lastRecutHead: sha.toUpperCase() };
  expect(queueLatency({ prs: [{ ...pr, headSha: undefined }] }, now).advice[0]).toMatchObject({ reason: 'no-head' });
  expect(queueLatency({ prs: [pr] }, now).advice[0]).toMatchObject({ reason: 'too-many-recuts' });
  expect(queueLatency({ prs: [{ ...pr, recutRequests: 2 }] }, now).advice[0]).toMatchObject({ reason: 'already-requested' });
});

it('validates snapshots strictly', () => {
  expect(validQueueLatencyInput(snapshot)).toBe(true);
  const bad = [null, {}, { prs: [null] }, { prs: [{ repo: 'nope', number: 1, stages: [{ stage: 'opened', at: at(1) }] }] },
    { prs: [{ repo: 'a/b', number: 0, stages: [{ stage: 'opened', at: at(1) }] }] },
    { prs: [{ repo: 'a/b', number: 1, stages: [] }] },
    { prs: [{ repo: 'a/b', number: 1, stages: [{ stage: 'merged', at: at(1) }] }] },
    { prs: [{ repo: 'a/b', number: 1, stages: [{ stage: 'opened', at: 'soon' }] }] },
    { prs: [{ repo: 'a/b', number: 1, mergeable: 'MAYBE', stages: [{ stage: 'opened', at: at(1) }] }] },
    { prs: [1, 1].map(() => ({ repo: 'a/b', number: 1, stages: [{ stage: 'opened', at: at(1) }] })) }];
  for (const b of bad) expect(validQueueLatencyInput(b)).toBe(false);
});

it('is registered and offers plain and JSON output without writing its input', async () => {
  expect(resolveFleetSubcommand('queue-latency')).toEqual({ module: './fleet-queue-latency.js', exportName: 'cmdFleetQueueLatency' });
  expect((await FLEET_SUBCOMMAND_LOADERS['queue-latency']!()).cmdFleetQueueLatency).toBe(cmdFleetQueueLatency);
  const dir = await mkdtemp(join(tmpdir(), 'queue-latency-'));
  const path = join(dir, 'snapshot.json');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const text = JSON.stringify(snapshot);
    await writeFile(path, text);
    expect(await cmdFleetQueueLatency(['--input', path, '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(queueLatency(snapshot, now));
    expect(await cmdFleetQueueLatency(['--input', path])).toBe(0);
    const plain = log.mock.calls[1]![0] as string;
    expect(plain).toContain('Slowest step: waiting for approval.');
    expect(plain).toContain('Recut #2 automatically (RQ-RECUT-phantom-2-aaaaaaa)');
    expect(plain).toContain('#3 conflicts but its head commit is unknown');
    expect(await readFile(path, 'utf8')).toBe(text);
    await writeFile(path, '{"prs":[]}');
    expect(await cmdFleetQueueLatency(['--input', path])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe('No PRs in the merge path.');
    for (const bad of ['{', 'null', '{"prs":[{"repo":"a/b","number":1,"stages":[]}]}']) {
      await writeFile(path, bad);
      expect(await cmdFleetQueueLatency(['--input', path])).toBe(1);
    }
    expect(await cmdFleetQueueLatency(['--input', join(dir, 'missing')])).toBe(1);
    for (const args of [[], ['--input'], ['--admin'], ['--json', '--json'], ['--input', path, '--input', path]]) {
      expect(await cmdFleetQueueLatency(args)).toBe(2);
    }
    expect(await cmdFleetQueueLatency(['--help'])).toBe(0);
    expect(err).toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
