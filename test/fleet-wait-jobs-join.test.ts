import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEventListeners } from 'node:events';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';
import { type FleetWaitJobsDeps } from '../src/cli/fleet-wait-jobs.js';
import { cmdFleet } from '../src/cli/fleet.js';

// Exercise actual dispatcher routing while keeping timing and reads hermetic.
const injected = vi.hoisted(() => ({ deps: {} as FleetWaitJobsDeps }));
vi.mock('../src/cli/fleet-wait-jobs.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/cli/fleet-wait-jobs.js')>();
  return { ...original, cmdFleetWaitJobs: (args: string[]) => original.cmdFleetWaitJobs(args, injected.deps) };
});
const publication = 'RESULT PR https://github.com/example/repo/pull/1\nTEST focused tests passed\n';
const args = (...jobs: string[]) => ['wait-jobs', ...jobs.flatMap(job => ['--job', job]), '--timeout-ms', '3000', '--interval-ms', '1000', '--json'];

describe('fleet wait-jobs bounded artifact join', () => {
  let dir: string;
  let time: number;
  let output: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-join-'));
    time = 0;
    output = [];
    injected.deps = {
      now: () => time,
      read: job => getFleetJobDetail(job, { runsDir: dir }),
      wait: async ms => { time += ms; },
      output: text => output.push(text),
    };
  });
  afterEach(async () => { vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
  const result = (lines: string[]) => JSON.parse(lines.at(-1)!);

  it('joins workers publishing on different polls, retaining caller order', async () => {
    await writeFile(join(dir, 'JOB-A.log'), 'working\n');
    await writeFile(join(dir, 'JOB-B.log'), 'working\n');
    injected.deps.wait = async ms => {
      time += ms;
      await writeFile(join(dir, time === 1000 ? 'JOB-B.publish' : 'JOB-A.publish'), publication);
    };
    expect(await cmdFleet(args('JOB-A', 'JOB-B'))).toBe(0);
    expect(time).toBe(2000);
    expect(result(output)).toMatchObject({ schema: 'fleet.wait-jobs.v1', outcome: 'published', jobs: [
      { job: 'JOB-A', state: 'published', sources: { publish: 'healthy' }, processLiveness: 'not-checked' },
      { job: 'JOB-B', state: 'published', prUrl: 'https://github.com/example/repo/pull/1' },
    ] });
  });

  it('stops on an archived failure and includes unresolved siblings', async () => {
    await writeFile(join(dir, 'JOB-A.log.gz'), gzipSync('worker ended\n'));
    expect(await cmdFleet(args('JOB-A', 'JOB-B'))).toBe(1);
    expect(result(output)).toMatchObject({ outcome: 'ended-without-publication', jobs: [
      { state: 'ended-without-publication', artifactState: 'archived' }, { state: 'pending' },
    ] });
    expect(time).toBe(0);
  });

  it('keeps a missing job pending until the explicit deadline', async () => {
    expect(await cmdFleet(args('JOB-MISSING'))).toBe(3);
    expect(time).toBe(3000);
    expect(result(output)).toMatchObject({ outcome: 'timed-out', jobs: [{ state: 'pending', artifactState: 'unknown' }] });
  });

  it('reports degraded canonical sources and rejected reads without leaking errors', async () => {
    await mkdir(join(dir, 'JOB-A.publish'));
    expect(await cmdFleet(args('JOB-A'))).toBe(4);
    expect(result(output).jobs[0].sources.publish).toBe('degraded');
    injected.deps.read = async () => { throw new Error('private diagnostic'); };
    expect(await cmdFleet(args('JOB-A'))).toBe(4);
    expect(output.join('')).not.toContain('private diagnostic');
  });

  it('requires healthy PR and test evidence and rejects stale publication', async () => {
    await writeFile(join(dir, 'JOB-A.publish'), 'RESULT PR https://github.com/example/repo/pull/1\n');
    expect(await cmdFleet(args('JOB-A'))).toBe(4);
    await writeFile(join(dir, 'JOB-A.publish'), publication);
    const { utimes } = await import('node:fs/promises');
    await utimes(join(dir, 'JOB-A.publish'), new Date(1000), new Date(1000));
    await writeFile(join(dir, 'JOB-A.launch'), 'launched JOB-A work pid 123 base abcd\n');
    await writeFile(join(dir, 'JOB-A.log'), 'retry running\n');
    expect(await cmdFleet(args('JOB-A'))).toBe(3);
    expect(result(output).jobs[0]).toMatchObject({ state: 'pending', artifactState: 'running' });
  });

  it('bounds concurrent reads at four and detaches deadline waits and listeners', async () => {
    vi.useFakeTimers();
    const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    const signals: AbortSignal[] = [];
    const read = vi.fn((_job: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<Awaited<ReturnType<typeof getFleetJobDetail>>>(() => {});
    });
    injected.deps.read = read;
    const pending = cmdFleet(args('JOB-A', 'JOB-B', 'JOB-C', 'JOB-D', 'JOB-E'));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBe(3);
    expect(read).toHaveBeenCalledTimes(4);
    expect(signals.every(s => s.aborted && getEventListeners(s, 'abort').length === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))).toEqual(before);
  });

  it('cancels a sleeping join without surviving timers or listeners', async () => {
    vi.useFakeTimers();
    const external = new AbortController();
    const before = ['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s));
    let sleeping = false;
    injected.deps.signal = external.signal;
    injected.deps.wait = undefined;
    const read = injected.deps.read!;
    injected.deps.read = async (job, signal) => { const d = await read(job, signal); sleeping = true; return d; };
    const pending = cmdFleet(args('JOB-A'));
    await vi.waitFor(() => expect(sleeping).toBe(true));
    external.abort();
    expect(await pending).toBe(130);
    expect(result(output).outcome).toBe('interrupted');
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(external.signal, 'abort')).toHaveLength(0);
    expect(['SIGINT', 'SIGTERM'].map(s => process.listenerCount(s))).toEqual(before);
  });

  it.each([
    [], ['--job', 'JOB-A', '--json'], ['--job', 'JOB-A', '--timeout-ms', 'Infinity', '--json'],
    ['--job', 'JOB-A', '--timeout-ms', '0', '--json'],
    ['--job', 'JOB-A', '--timeout-ms', '3600001', '--json'],
    ['--job', 'JOB-A', '--job', 'JOB-A', '--timeout-ms', '1', '--json'],
    ['--job', '../escape', '--timeout-ms', '1', '--json'],
    ['--job', 'JOB-A', '--timeout-ms', '1', '--interval-ms', '999', '--json'],
    ['--job', 'JOB-A', '--timeout-ms', '1', '--interval-ms', '60001', '--json'],
    [...Array.from({ length: 33 }, (_, i) => ['--job', `JOB-${i}`]).flat(), '--timeout-ms', '1', '--json'],
  ])('rejects invalid usage %j', async (...argv) => {
    const read = vi.fn(injected.deps.read!);
    injected.deps.read = read;
    expect(await cmdFleet(['wait-jobs', ...argv])).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('runs one real local child through the dispatcher with fake artifacts', async () => {
    await mkdir(join(dir, '.ashlr-runs'));
    await writeFile(join(dir, '.ashlr-runs', 'JOB-A.publish'), publication);
    const moduleUrl = new URL('../src/cli/fleet.ts', import.meta.url).href;
    const script = `import { cmdFleet } from ${JSON.stringify(moduleUrl)}; process.exitCode = await cmdFleet(${JSON.stringify(args('JOB-A'))});`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, HOME: dir }, timeout: 20000,
    });
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'published', jobs: [{ state: 'published' }] });
  }, 30000);
});
