import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetStuck, readStuckJobs } from '../src/cli/fleet-stuck.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { findStuckJobs, formatAge, stuckSummaryLine } from '../src/core/fleet/stuck-jobs.js';

// Log lines carry the local wall clock, so expected instants are built the same way.
const at = (hour: number, minute: number) => new Date(2026, 10, 16, hour, minute, 0);
const line = (hour: number, minute: number, rest: string) =>
  `2026-11-16 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00 ${rest}`;
const ticks = (rest: string, minutes = [0, 5, 10]) => minutes.map(m => line(10, m, rest));
const NOW = at(12, 0).getTime();
const find = (lines: string[], lanes: Record<string, string> = {}) => findStuckJobs(lines.join('\n'), new Map(Object.entries(lanes)), NOW);

describe('findStuckJobs', () => {
  it('types a size refusal and names the lane from the ready list', () => {
    const report = find(ticks('DEVIN_FLASH_REFUSED CANARY-FAKE-LANE-1 size-not-sm'), { 'CANARY-FAKE-LANE-1': 'devin-flash' });
    expect(report).toEqual({ schema: 'fleet.stuck.v1', count: 1, oldestAgeSeconds: 7200, jobs: [{
      job: 'CANARY-FAKE-LANE-1', lane: 'devin-flash', cause: 'lane_refused_size', events: 3,
      firstSeen: at(10, 0).toISOString(), lastSeen: at(10, 10).toISOString(), ageSeconds: 7200,
      action: 'move to a lane that accepts this size', kind: 'DEVIN_FLASH_REFUSED', reason: 'size-not-sm' }] });
  });

  it('types a repo refusal and falls back to the refusing lane when the ready list does not name the job', () => {
    expect(find(ticks('DEVIN_FLASH_REFUSED FIXUP-CI-fake-repo-ci-000001 repo-not-eligible')).jobs[0]).toMatchObject({
      job: 'FIXUP-CI-fake-repo-ci-000001', lane: 'devin-flash', cause: 'lane_refused_repo', action: 'move to a lane that accepts this repo' });
  });

  it('types a worktree cleanup failure; its lane is unknown without the ready list', () => {
    expect(find(ticks('WT_ORPHAN_REMOVE_FAILED RQ-FAKE-TOOLTIPS-1 (RuntimeError)')).jobs[0]).toMatchObject({
      lane: null, cause: 'worktree_cleanup_failed', events: 3, reason: '(RuntimeError)',
      action: 'worktree cleanup keeps failing; needs a manual look' });
  });

  it('shows an unrecognised refusal reason or failure kind as unknown, never drops it', () => {
    const report = find([...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-A-1 some-new-reason'), ...ticks('PUBLISH_FAILED RQ-FAKE-B-1 exit 3')]);
    expect(report.jobs.map(row => [row.job, row.cause, row.lane, row.reason])).toEqual([
      ['RQ-FAKE-A-1', 'unknown', 'devin-flash', 'some-new-reason'], ['RQ-FAKE-B-1', 'unknown', null, 'exit 3']]);
    expect(report.jobs[0]!.action).toBe('cause not recognised; read the event log lines for this job');
  });

  it('leaves out a job that was refused and later launched', () => {
    const refused = ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm');
    expect(find([...refused, line(10, 15, 'LAUNCH RQ-FAKE-1 phantom claude frontier')]).count).toBe(0);
    // Trouble that starts again after the launch counts from there.
    const again = find([...refused, line(10, 15, 'LAUNCH RQ-FAKE-1 phantom claude frontier'), ...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm', [20, 25])]);
    expect(again.jobs[0]).toMatchObject({ events: 2, firstSeen: at(10, 20).toISOString() });
  });

  it('needs a repeat, a job id, and trouble that is still being logged', () => {
    expect(find([line(10, 0, 'DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm')]).count).toBe(0);
    expect(find(ticks('RESTOCK_FAILED timeout')).count).toBe(0);
    expect(find(ticks('LANE_HOLD RQ-FAKE-1 claude')).count).toBe(0);
    // Quiet for over an hour while the log kept moving: fixed or removed.
    expect(find([...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm'), line(11, 30, 'TICK ok')]).count).toBe(0);
    expect(find([...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm'), line(11, 0, 'TICK ok')]).count).toBe(1);
  });

  it('reports nothing for an empty log and skips lines it cannot parse', () => {
    expect(find([])).toEqual({ schema: 'fleet.stuck.v1', count: 0, oldestAgeSeconds: null, jobs: [] });
    expect(find(['not a log line', '', ...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm')]).count).toBe(1);
  });

  it('lists the oldest first and words the vitals row', () => {
    const report = find([...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-NEW-1 size-not-sm', [30, 35]), ...ticks('WT_ORPHAN_REMOVE_FAILED RQ-FAKE-OLD-1 (RuntimeError)', [1, 40])]);
    expect(report.jobs.map(row => row.job)).toEqual(['RQ-FAKE-OLD-1', 'RQ-FAKE-NEW-1']);
    expect(stuckSummaryLine(report)).toBe('2 jobs stuck; oldest 1h 59m');
    expect(stuckSummaryLine({ count: 0, oldestAgeSeconds: null })).toBe('0 jobs stuck');
    expect(stuckSummaryLine({ count: null, oldestAgeSeconds: null })).toBe('Jobs stuck: unknown');
    expect([40, 300, 7500, 439_200].map(formatAge)).toEqual(['40s', '5m', '2h 5m', '5d 2h']);
  });
});

describe('phm fleet stuck', () => {
  let dir: string;
  const out = () => vi.mocked(console.log).mock.calls.map(call => String(call[0]));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-stuck-'));
    mkdirSync(join(dir, 'queue'));
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });
  const writeLog = (lines: string[], file = join(dir, 'queue/dispatch-events.log')) => writeFileSync(file, lines.join('\n') + '\n');

  it('prints one plain line per stuck job, and the same rows as JSON', async () => {
    writeLog([...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm'), ...ticks('WT_ORPHAN_REMOVE_FAILED RQ-FAKE-2 (RuntimeError)')]);
    writeFileSync(join(dir, 'queue/ready.tsv'), 'RQ-FAKE-1\tdevin-flash\tfast\tphantom\tfake title\n');
    expect(await cmdFleetStuck([])).toBe(0);
    expect(out()).toHaveLength(2);
    expect(out()[0]).toMatch(/^RQ-FAKE-1: stuck .+ on lane devin-flash; cause lane_refused_size; 3 events; move to a lane that accepts this size\.$/);
    expect(out()[1]).toMatch(/^RQ-FAKE-2: stuck .+ on lane unknown; cause worktree_cleanup_failed; 3 events; worktree cleanup keeps failing; needs a manual look\.$/);
    expect(await cmdFleetStuck(['--json'])).toBe(0);
    const report = JSON.parse(out().at(-1)!);
    expect(report).toMatchObject({ schema: 'fleet.stuck.v1', count: 2, sources: { events: 'healthy', ready: 'healthy' } });
    expect(report.jobs.map((row: { job: string }) => row.job)).toEqual(['RQ-FAKE-1', 'RQ-FAKE-2']);
  });

  it('takes the log and ready list from the paths given', async () => {
    const events = join(dir, 'elsewhere.log'), ready = join(dir, 'elsewhere.tsv');
    writeLog(ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 repo-not-eligible'), events);
    writeFileSync(ready, 'RQ-FAKE-1\tsome-lane\n');
    expect((await readStuckJobs({ events, ready }, NOW)).jobs[0]).toMatchObject({ lane: 'some-lane', cause: 'lane_refused_repo', ageSeconds: 7200 });
    expect(await cmdFleetStuck(['--events', events, '--ready', ready])).toBe(0);
    expect(out()[0]).toContain('on lane some-lane; cause lane_refused_repo');
  });

  it('reads only the end of a large log', async () => {
    const filler = Array.from({ length: 70_000 }, () => line(10, 0, 'DEVIN_FLASH_REFUSED RQ-FAKE-OLD-1 size-not-sm padding-padding-padding-padding'));
    writeLog([...filler, ...ticks('DEVIN_FLASH_REFUSED RQ-FAKE-1 size-not-sm')]);
    const report = await readStuckJobs({ runsDir: dir }, NOW);
    expect(report.jobs.find(row => row.job === 'RQ-FAKE-OLD-1')!.events).toBeLessThan(70_000);
    expect(report.jobs.find(row => row.job === 'RQ-FAKE-1')!.events).toBe(3);
  });

  it('says so for an empty log, and reports unknown with exit 1 for a missing one', async () => {
    writeLog([]);
    expect(await cmdFleetStuck([])).toBe(0);
    expect(out()).toEqual(['No stuck jobs.']);
    rmSync(join(dir, 'queue/dispatch-events.log'));
    expect(await cmdFleetStuck([])).toBe(1);
    expect(out().at(-1)).toBe('Stuck jobs: unknown; the dispatch event log is missing.');
    expect(await cmdFleetStuck(['--json'])).toBe(1);
    expect(JSON.parse(out().at(-1)!)).toMatchObject({ count: null, jobs: [], sources: { events: 'missing', ready: 'missing' } });
  });

  it('prints help, rejects bad arguments, and is registered', async () => {
    expect(await cmdFleetStuck(['--help'])).toBe(0);
    expect(out()[0]).toMatch(/^Usage: phm fleet stuck /);
    for (const args of [['--bogus'], ['--json', '--json'], ['--events'], ['--ready', '--json']]) expect(await cmdFleetStuck(args)).toBe(2);
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS.stuck!()).cmdFleetStuck).toBe('function');
  });
});
