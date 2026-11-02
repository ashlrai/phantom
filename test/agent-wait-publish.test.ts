import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWaitPublish } from '../examples/agents/wait-publish.js';
import type { FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';

const args = ['--job', 'RQ-FAKE-JOB', '--timeout-ms', '100', '--interval-ms', '20'];
const url = 'https://example.invalid/fake/pull/123';

function detail(state: FleetJobDetailV1['state'], prUrl: string | null = null): FleetJobDetailV1 {
  return {
    schema: 'fleet.job.v1', generatedAt: '2026-01-01T00:00:00.000Z', job: 'RQ-FAKE-JOB', state,
    lane: null, tier: null, model: null, pid: null, launchedAt: null, baseSha: null, branch: null, promptBytes: null,
    publish: prUrl ? { prUrl, autoMerge: null, testLine: null, sensitive: null } : null,
    notes: { hasNotes: false, hasBody: false, notesBytes: null },
    log: { source: 'missing', bytes: null, tail: [], truncated: false },
    sources: { launch: 'missing', base: 'missing', meta: 'missing', publish: prUrl ? 'healthy' : 'missing', log: 'missing' },
  };
}

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line), json: () => lines.map(line => JSON.parse(line)) };
}

afterEach(() => vi.useRealTimers());

describe('wait-publish workflow', () => {
  it('waits from running to published and emits one success', async () => {
    const out = capture();
    let time = 0;
    const read = vi.fn().mockResolvedValueOnce(detail('running', url)).mockResolvedValueOnce(detail('published', url));
    const wait = vi.fn(async (ms: number) => { time += ms; });
    expect(await runWaitPublish(args, { read, wait, now: () => time, write: out.write })).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(out.json()).toEqual([{ job: 'RQ-FAKE-JOB', prUrl: url }]);
  });

  it.each(['unknown', 'archived', 'running'] as const)('never treats %s as publication even with a URL', async state => {
    const out = capture();
    let time = 0;
    const read = vi.fn(async () => detail(state, url));
    expect(await runWaitPublish(args, { read, now: () => time, wait: async ms => { time += ms; }, write: out.write })).toBe(3);
    expect(read).toHaveBeenCalledTimes(5);
    expect(out.json()).toEqual([{ error: 'Timed out waiting for publication.', job: 'RQ-FAKE-JOB' }]);
  });

  it('distinguishes thrown and degraded publish reads from timeout without exposing errors', async () => {
    for (const read of [
      async () => { throw new Error('/fake/private/path'); },
      async () => ({ ...detail('published', url), sources: { ...detail('published', url).sources, publish: 'degraded' as const } }),
    ]) {
      const out = capture();
      expect(await runWaitPublish(args, { read, write: out.write })).toBe(1);
      expect(out.json()).toEqual([{ error: 'Unable to read job publication.', job: 'RQ-FAKE-JOB' }]);
    }
  });

  it('times out even when a reader never settles', async () => {
    vi.useFakeTimers();
    const out = capture();
    const run = runWaitPublish(args, { read: () => new Promise(() => {}), write: out.write });
    await vi.advanceTimersByTimeAsync(100);
    expect(await run).toBe(3);
    expect(out.json()).toEqual([{ error: 'Timed out waiting for publication.', job: 'RQ-FAKE-JOB' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a pending timer, cleans up and stops reading', async () => {
    vi.useFakeTimers();
    const out = capture();
    const controller = new AbortController();
    const read = vi.fn(async () => detail('running'));
    const run = runWaitPublish(args, { read, signal: controller.signal, write: out.write });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    controller.abort();
    expect(await run).toBe(130);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(read).toHaveBeenCalledTimes(1);
    expect(out.json()).toEqual([{ error: 'Wait aborted.', job: 'RQ-FAKE-JOB' }]);
  });

  it('validates bounded, unique options before reading', async () => {
    for (const bad of [[], ['--job', '../bad', '--timeout-ms', '10', '--interval-ms', '1'],
      ['--job', 'RQ-FAKE-JOB', '--timeout-ms', '3600001', '--interval-ms', '1'],
      ['--job', 'RQ-FAKE-JOB', '--timeout-ms', '10', '--interval-ms', '0'],
      [...args, '--job', 'RQ-OTHER']]) {
      const out = capture();
      const read = vi.fn();
      expect(await runWaitPublish(bad, { read, write: out.write })).toBe(2);
      expect(read).not.toHaveBeenCalled();
      expect(out.json()).toHaveLength(1);
      expect(out.json()[0]).toHaveProperty('error');
    }
  });
});
