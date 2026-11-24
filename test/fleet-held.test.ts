import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHeld } from '../src/cli/fleet-held.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { fleetNotRunning, formatNotRunning, unblockFor } from '../src/core/fleet/fleet-held.js';
import { readFleetRunsDirState } from '../src/core/fleet/runs-dir-state.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const dirs: string[] = [];
const savedEnv = process.env.ASHLR_RUNS_DIR;
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = savedEnv;
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function tempRuns(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-held-')); dirs.push(dir);
  return dir;
}
async function record(dir: string, name: string, text: string, minutesAgo: number, at = now): Promise<void> {
  await writeFile(join(dir, name), text);
  const when = new Date(at - minutesAgo * 60_000);
  await utimes(join(dir, name), when, when);
}
const lane = (running: number, target: number, queued: number, effectiveTarget?: number) =>
  ({ running, target, queued, held: false, ...(effectiveTarget === undefined ? {} : { effective_target: effectiveTarget }) });

/** One runs directory holding every kind, plus records that must stay off the list. */
async function fixture(): Promise<string> {
  const dir = await tempRuns();
  await mkdir(join(dir, 'queue')); await mkdir(join(dir, 'metrics'));
  await record(dir, 'grok-one.launch', 'HELD: ultra reading older than 8h\n', 5);
  await record(dir, 'odd-one.launch', 'something new went wrong\nsecond line\n', 20);
  await record(dir, 'slow-one.launch', 'launched slow-one claude pid 1 base abc\n', 90);
  await record(dir, 'fresh-one.launch', 'launched fresh-one claude pid 2 base abc\n', 10);
  await record(dir, 'done-one.launch', 'launched done-one claude pid 3 base abc\n', 180);
  await record(dir, 'pub-one.launch', 'launched pub-one claude pid 4 base abc\n', 180);
  await record(dir, 'pub-one.publish', 'RESULT PR none\n', 100);
  await record(dir, 'old-one.launch', 'HELD: ultra reading older than 8h\n', 8 * 24 * 60);
  await writeFile(join(dir, 'queue/status.json'), JSON.stringify({ last_tick: ago(0), paused: false, mem_free_pct: 50,
    lanes: { grok: lane(0, 3, 2), cursor: lane(0, 1, 0), devin: lane(0, 0, 0), claude: lane(2, 8, 1), zai: lane(0, 3, 0, 0) } }));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), [
    { job: 'grok-one', event: 'launch', lane: 'grok', ts: ago(4000) },
    { job: 'grok-one', event: 'launch', lane: 'grok', ts: ago(5) },
    { job: 'cursor-old', event: 'finish', lane: 'cursor', empty: true, ts: ago(300) },
    { job: 'slow-one', event: 'launch', lane: 'claude', ts: ago(90) },
    { job: 'done-one', event: 'launch', lane: 'claude', ts: ago(180) },
    { job: 'done-one', event: 'finish', lane: 'claude', ts: ago(120) },
    { job: 'pub-one', event: 'launch', lane: 'claude', ts: ago(180) },
    { job: 'pub-one', event: 'finish', lane: 'claude', ts: ago(120) },
    { job: 'merged-one', event: 'finish', lane: 'claude', ts: ago(60) },
    { job: 'merged-one', event: 'publish', lane: 'claude', class: 'pr', ts: ago(58) },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  return dir;
}
const read = (runsDir: string) => readFleetRunsDirState({ runsDir, now: () => now });

describe('fleet held: launched but not actually running', () => {
  it('lists each kind from launch records, lane status and the metrics tail', async () => {
    const { notRunning } = await read(await fixture());
    expect(notRunning).toEqual([
      { job_or_lane: 'grok-one', kind: 'held_launch', reason: 'ultra reading older than 8h', since: ago(4000), unblock: 'Record a current Grok usage percent' },
      { job_or_lane: 'odd-one', kind: 'held_launch', reason: 'something new went wrong', since: ago(20), unblock: 'unknown' },
      { job_or_lane: 'cursor', kind: 'idle_lane', reason: 'Target above 0 with nothing running and nothing queued', since: ago(300), unblock: 'Queue work for this lane' },
      { job_or_lane: 'slow-one', kind: 'launched_no_finish', reason: 'No finish recorded more than 60 minutes after launch', since: ago(90), unblock: 'Check the job log, then stop or requeue the job' },
      { job_or_lane: 'done-one', kind: 'finished_no_publish', reason: 'Finished with no publish record', since: ago(120), unblock: 'Republish this job or requeue it' },
    ]);
  });

  it('reads launch, finish and publish facts through the jobs-ledger field dialect', () => {
    const tail = [
      { job_id: 'dial-one', type: 'launch', pool: 'claude', at: ago(180) },
      { jobId: 'dial-one', kind: 'finish', timestamp: ago(120) },
      { id: 'dial-two', event: 'published', lane: 'claude', recordedAt: ago(90) },
      { job_id: 'dial-two', type: 'finish', at: ago(100) },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(fleetNotRunning({ lanes: [], launches: [], metricsTail: tail, now })).toEqual([
      { job_or_lane: 'dial-one', kind: 'finished_no_publish', since: ago(120), reason: 'Finished with no publish record', unblock: 'Republish this job or requeue it' },
    ]);
  });

  it('leaves out a lane with target 0, fresh launches, published jobs and week-old records', async () => {
    const names = (await read(await fixture())).notRunning!.map(row => row.job_or_lane);
    for (const name of ['devin', 'grok', 'claude', 'zai', 'fresh-one', 'pub-one', 'merged-one', 'cursor-old', 'old-one']) expect(names).not.toContain(name);
  });

  it('returns an empty list without throwing when the runs directory is missing', async () => {
    const state = await read(join(await tempRuns(), 'absent'));
    expect(state.runsDirPresent).toBe(false);
    expect(state.notRunning).toEqual([]);
  });

  it('passes an unrecognized reason through and keeps unknown as unknown', () => {
    expect(unblockFor('HELD: brand new reason')).toBe('unknown');
    expect(unblockFor('HELD: ultra reading older than 8h')).toBe('Record a current usage percent for this lane');
    expect(unblockFor('HELD: launches paused (security)', 'grok')).toBe('Resume launches for this lane');
    const launches = [{ job: 'a', firstLine: 'launched a claude pid 1 base x', at: ago(600) }];
    // No readable metrics, or a tail that starts after the launch: the finish is unknown, so nothing is claimed.
    expect(fleetNotRunning({ lanes: [], launches, metricsTail: null, now })).toEqual([]);
    const later = JSON.stringify({ job: 'b', event: 'launch', ts: ago(30) });
    expect(fleetNotRunning({ lanes: [], launches, metricsTail: later, metricsClipped: true, now })).toEqual([]);
    expect(fleetNotRunning({ lanes: [], launches, metricsTail: later, now }).map(row => row.kind)).toEqual(['launched_no_finish']);
    expect(fleetNotRunning({ lanes: [], launches: [{ job: 'c', firstLine: '', at: ago(1) }], metricsTail: '', now })).toEqual([]);
  });

  it('names the hold on an idle held lane and prints plain text', () => {
    const rows = fleetNotRunning({ lanes: [{ lane: 'zai', running: 0, target: 3, queued: 0, held: true, heldReason: 'owner hold' }], launches: [], metricsTail: '', now });
    expect(rows).toEqual([{ job_or_lane: 'zai', kind: 'idle_lane', reason: 'Lane held: owner hold', since: null, unblock: 'Release the hold on this lane' }]);
    expect(formatNotRunning(rows)).toBe('Not actually running: 1\nzai  idle_lane\n  Why: Lane held: owner hold\n  Next: Release the hold on this lane');
    expect(formatNotRunning([])).toMatch(/^Nothing is stuck/);
  });

  it('treats a lane shed to zero launch slots as curtailed, not idle', () => {
    const shed = { lane: 'gemini', running: 0, target: 3, queued: 0, held: false, effectiveTarget: 0 };
    expect(fleetNotRunning({ lanes: [shed], launches: [], metricsTail: '', now })).toEqual([]);
    const partial = { ...shed, effectiveTarget: 2 };
    expect(fleetNotRunning({ lanes: [partial], launches: [], metricsTail: '', now }).map(row => row.job_or_lane)).toEqual(['gemini']);
  });
});

describe('phm fleet held', () => {
  it('prints the fleet.held.v1 JSON shape', async () => {
    const dir = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetHeld(['--json'], () => read(dir))).toBe(0);
    const report = JSON.parse(log.mock.calls[0]![0] as string);
    expect(Object.keys(report)).toEqual(['schema', 'generatedAt', 'count', 'items']);
    expect(report).toMatchObject({ schema: 'fleet.held.v1', generatedAt: new Date(now).toISOString(), count: 5 });
    for (const item of report.items) {
      expect(Object.keys(item).sort()).toEqual(['job_or_lane', 'kind', 'reason', 'since', 'unblock']);
      expect(['held_launch', 'idle_lane', 'launched_no_finish', 'finished_no_publish']).toContain(item.kind);
    }
    expect(await cmdFleetHeld([], () => read(dir))).toBe(0);
    expect((log.mock.calls[1]![0] as string).split('\n').slice(0, 3)).toEqual([
      'Not actually running: 5', `grok-one  held_launch  since ${ago(4000)}`, '  Why: ultra reading older than 8h']);
  });

  it('finds the runs directory through ASHLR_RUNS_DIR', async () => {
    const dir = await tempRuns();
    await record(dir, 'env-one.launch', 'HELD: launches paused (security)\n', 1, Date.now());
    process.env.ASHLR_RUNS_DIR = dir;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetHeld(['--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string).items).toMatchObject([
      { job_or_lane: 'env-one', kind: 'held_launch', reason: 'launches paused (security)', unblock: 'Resume launches for this lane' }]);
  });

  it('prints help, rejects other arguments, reports a failed read and is registered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetHeld(['--help'])).toBe(0);
    expect(log.mock.calls[0]![0]).toMatch(/^Usage: phm fleet held \[--json\]/);
    expect(await cmdFleetHeld(['--bad'])).toBe(2);
    expect(await cmdFleetHeld(['--json', '--json'])).toBe(2);
    expect(await cmdFleetHeld([], async () => { throw new Error('x'); })).toBe(1);
    expect(err).toHaveBeenCalledTimes(3);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['held']!()).cmdFleetHeld).toBe('function');
  });
});
