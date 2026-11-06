import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../examples/usage-motion-incident.js';

const anchor = Date.parse('2026-10-31T23:00:00.000Z');
const at = (minutes: number) => new Date(anchor - minutes * 60_000).toISOString();
const reading = (pool: string, minutes: number, pctUsed = 40) =>
  JSON.stringify({ pool, pctUsed, fetchedAt: at(minutes), resetAt: '2026-11-01T00:00:00Z' });
let root: string;
let queue: string;
let out: string;
let err: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'motion-recipe-'));
  queue = join(root, 'queue');
  await mkdir(queue);
  out = ''; err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err += String(chunk); return true; });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const files = {
    'ready.tsv': 'id\tstatus\tpool\nRQ-A\tREADY\tlane-active\nRQ-B\tREADY\tlane-queued\nRQ-C\tDONE\tlane-idle\nRQ-D\tREADY\tlane-single\n',
    'queue.v1.json': JSON.stringify({ schema: 'queue.v1', jobs: [{ id: 'RQ-A', status: 'CLAIMED', pool: 'lane-active' }] }),
    'usage-readings.log': [
      reading('lane-active', 60), reading('lane-active', 0),
      reading('lane-queued', 60), reading('lane-queued', 0),
      reading('lane-idle', 60), reading('lane-idle', 0),
      reading('lane-single', 0),
    ].join('\n') + '\n',
  };
  for (const [name, data] of Object.entries(files)) await writeFile(join(queue, name), data);
  return files;
}

const ps = '123 01:05:00 /fake/bin/launch.sh RQ-A phantom lane-active work\n';
async function run(runPs: () => Promise<string> = async () => ps) {
  const code = await main(['--queue-dir', queue], { runPs, now: () => anchor });
  return { code, report: JSON.parse(out) };
}

describe('usage motion incident example', () => {
  it('joins real audit history with the live process snapshot without changing either classification or files', async () => {
    const files = await fixture();
    const { code, report } = await run();
    expect(code).toBe(0);
    expect(report.schema).toBe('usage-motion-incident.v1');
    expect(report.observation).toMatchObject({
      audit: { generatedAt: at(0), sources: { queue: 'healthy', queueState: 'healthy', usageJournal: { state: 'healthy' } } },
      workers: { generatedAt: at(0), sourceState: 'healthy' },
    });
    const row = (name: string) => report.lanes.find((item: { audit: { lane: string } }) => item.audit.lane === name);
    expect(row('lane-active')).toMatchObject({ audit: { classification: 'incident', firstReadingAt: at(60), lastReadingAt: at(0), observedMinutes: 60, pctUsedDelta: 0 }, liveWorkers: 1, explanation: 'unchanged-with-live-workers' });
    expect(row('lane-queued')).toMatchObject({ audit: { classification: 'incident', queued: 1, live: 0 }, liveWorkers: 0, explanation: 'unchanged-without-live-workers' });
    expect(row('lane-idle')).toMatchObject({ audit: { classification: 'idle' }, liveWorkers: 0, explanation: 'unchanged-without-live-workers' });
    expect(row('lane-single')).toMatchObject({ audit: { classification: 'insufficient-evidence', readings: 1, pctUsedDelta: null }, explanation: 'insufficient-usage-or-queue-evidence' });
    expect(report.commands).toContainEqual(['ashlr', 'fleet', 'usage-audit', '--queue-dir', queue, '--json']);
    expect(report.commands).toContainEqual(['ashlr', 'fleet', 'workers', '--json']);
    for (const [name, data] of Object.entries(files)) expect(await readFile(join(queue, name), 'utf8')).toBe(data);
  });

  it('preserves an unavailable process source as unknown, including for queued work', async () => {
    await fixture();
    const { code, report } = await run(async () => { throw new Error('ps unavailable'); });
    expect(code).toBe(0);
    expect(report.observation.workers).toEqual({ generatedAt: at(0), sourceState: 'unavailable' });
    const row = report.lanes.find((item: { audit: { lane: string } }) => item.audit.lane === 'lane-queued');
    expect(row).toMatchObject({ audit: { classification: 'incident' }, liveWorkers: null, explanation: 'unchanged-process-evidence-unknown' });
  });

  it('does not infer absence for lane names outside the process projection and reports unmatched workers', async () => {
    await fixture();
    await writeFile(join(queue, 'usage-readings.log'), [reading('Lane.Mixed', 60), reading('Lane.Mixed', 0)].join('\n'));
    await writeFile(join(queue, 'ready.tsv'), 'id\tstatus\tpool\nRQ-E\tREADY\tLane.Mixed\n');
    const { report } = await run(async () => '124 01:05:00 /fake/bin/launch.sh RQ-Z phantom lane-stray work\n');
    expect(report.lanes.find((item: { audit: { lane: string } }) => item.audit.lane === 'Lane.Mixed'))
      .toMatchObject({ audit: { classification: 'incident' }, liveWorkers: null, explanation: 'unchanged-process-evidence-unknown' });
    expect(report.uncorrelatedWorkers).toContainEqual({ lane: 'lane-stray', count: 1 });
  });

  it('handles help and argument errors without reading the process table', async () => {
    const runPs = vi.fn(async () => ps);
    expect(await main(['--help'], { runPs })).toBe(0);
    expect(out).toContain('--queue-dir ABSOLUTE_PATH');
    for (const args of [[], ['--queue-dir'], ['--queue-dir', 'relative'], ['--queue-dir', queue, '--json'], ['--bogus']]) {
      expect(await main(args, { runPs })).toBe(2);
    }
    expect(err).toContain('Invalid arguments');
    expect(runPs).not.toHaveBeenCalled();
  });

  it('returns a reader error without exposing its details', async () => {
    expect(await main(['--queue-dir', queue], { now: () => { throw new Error('sensitive detail'); }, runPs: async () => ps })).toBe(1);
    expect(err).toContain('Unable to produce');
    expect(err).not.toContain('sensitive detail');
  });

  it('runs directly with --help', () => {
    const help = execFileSync(process.execPath, ['--import', 'tsx', 'examples/usage-motion-incident.ts', '--help'], { encoding: 'utf8' });
    expect(help).toContain('Usage:');
  }, 20_000);
});
