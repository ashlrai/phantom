import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetJobRead } from '../src/cli/fleet-job-read.js';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import { type FleetJobDetailV1, getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

function job(state: FleetJobDetailV1['state'] = 'running'): FleetJobDetailV1 {
  return {
    schema: 'fleet.job.v1', generatedAt: '2026-10-31T00:00:00.000Z', job: 'JOB1', state,
    lane: null, tier: null, model: null, pid: 123, launchedAt: '2026-10-31T00:00:00.000Z',
    baseSha: null, branch: null, promptBytes: null,
    publish: state === 'published' ? { prUrl: 'https://example.invalid/1', autoMerge: false, testLine: 'TEST ok', sensitive: [] } : null,
    notes: { hasNotes: false, hasBody: false, notesBytes: null },
    log: { source: 'live', bytes: 0, tail: [], truncated: false },
    sources: { launch: 'healthy', base: 'missing', meta: 'missing', publish: 'missing', log: 'healthy' },
  };
}

function setup(detail: typeof getFleetJobDetail) {
  const lines: string[] = [];
  const output = { log: (text: string) => lines.push(text), stdout: vi.fn(), stderr: vi.fn() };
  return { lines, output, deps: { detail, changes: getFleetJobChanges, output } };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fleet job watch deadline', () => {
  it('times out a pending job during its abortable sleep and emits one final JSON reason', async () => {
    const { deps, lines } = setup(vi.fn(async () => job()));
    const result = cmdFleetJobRead(['JOB1', '--watch', '--json', '--timeout-ms', '1200'], deps);
    await vi.advanceTimersByTimeAsync(1199);
    expect(lines).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(1);
    expect(lines.map(line => JSON.parse(line))).toEqual([
      expect.objectContaining({ schema: 'fleet.job.v1', state: 'running' }),
      expect.objectContaining({ schema: 'fleet.job.watch.stop.v1', job: 'JOB1', snapshots: 1, reason: 'timeout after 1200 ms; completion not established; check the job again' }),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps terminal completion and exit behavior before the deadline', async () => {
    const detail = vi.fn().mockResolvedValueOnce(job()).mockResolvedValueOnce(job('published'));
    const { deps, lines } = setup(detail);
    const result = cmdFleetJobRead(['JOB1', '--watch', '--interval-ms', '1000', '--timeout-ms', '2000'], deps);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(0);
    expect(lines.at(-1)).toContain('job JOB1 published');
    expect(detail).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated read failures and prints an actionable text stop line', async () => {
    const detail = vi.fn(async () => { throw new Error('unavailable'); });
    const { deps, lines, output } = setup(detail);
    const result = cmdFleetJobRead(['JOB1', '--watch', '--interval-ms', '1000', '--timeout-ms', '1500'], deps);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBe(1);
    expect(detail).toHaveBeenCalledTimes(2);
    expect(output.stderr).toHaveBeenCalledTimes(2);
    expect(lines).toEqual(['watch stopped: timeout after 1500 ms; completion not established; check the job again']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires during a stuck read and ignores a late rejection', async () => {
    let rejectRead!: (error: Error) => void;
    const detail = vi.fn(() => new Promise<FleetJobDetailV1>((_, reject) => { rejectRead = reject; }));
    const { deps, lines } = setup(detail);
    const result = cmdFleetJobRead(['JOB1', '--watch', '--json', '--timeout-ms', '1'], deps);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(1);
    rejectRead(new Error('late failure'));
    await Promise.resolve();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'fleet.job.watch.stop.v1', snapshots: 0, reason: expect.stringContaining('timeout') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets the first signal or deadline win and removes listeners and timers', async () => {
    for (const first of ['signal', 'deadline'] as const) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const { deps, lines } = setup(vi.fn(async () => job()));
      const result = cmdFleetJobRead(['JOB1', '--watch', '--timeout-ms', '100'], deps, { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(first === 'signal' ? 99 : 100);
      controller.abort();
      expect(await result).toBe(first === 'signal' ? 0 : 1);
      expect(lines.at(-1)).toContain(first === 'signal' ? 'interrupted' : 'timeout after 100 ms');
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('uses elapsed monotonic time even if the wall clock moves', async () => {
    const { deps, lines } = setup(vi.fn(async () => job()));
    const result = cmdFleetJobRead(['JOB1', '--watch', '--timeout-ms', '100'], deps);
    vi.setSystemTime(new Date('2050-01-01T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(99);
    expect(lines.at(-1)).not.toContain('watch stopped');
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(1);
  });

  it('validates timeout bounds and combinations before reading', async () => {
    const detail = vi.fn<typeof getFleetJobDetail>();
    const { deps } = setup(detail);
    for (const args of [
      ['--timeout-ms', '1'], ['--watch', '--timeout-ms'], ['--watch', '--timeout-ms', '0'],
      ['--watch', '--timeout-ms', '3600001'], ['--watch', '--timeout-ms', '-1'],
      ['--watch', '--timeout-ms', '1.5'], ['--watch', '--timeout-ms', 'no'],
      ['--watch', '--timeout-ms', '1', '--timeout-ms', '2'], ['--log', '--log-find', '--timeout-ms', '2'],
      ['--watch', '--changes', '--timeout-ms', '1'],
    ]) expect(await cmdFleetJobRead(['JOB1', ...args], deps), args.join(' ')).toBe(2);
    for (const bound of ['1', '3600000']) {
      expect(await cmdFleetJobRead(['JOB1', '--watch', '--timeout-ms', bound], deps, { signal: AbortSignal.abort() })).toBe(0);
    }
    expect(detail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('documents the bounded agent example', async () => {
    const { deps, lines } = setup(vi.fn<typeof getFleetJobDetail>());
    expect(await cmdFleetJobRead(['--help'], deps)).toBe(0);
    expect(lines[0]).toContain('phm fleet job JOB1 --watch --interval-ms 2000 --timeout-ms 30000 --json');
  });
});
