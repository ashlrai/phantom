import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const snapshot = (usedPct: number): ResourceLedgerV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', asOf: '2026-10-31T12:00:00Z',
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' },
  apiSpend: null, jobsMalformedRows: null,
  lanes: [{ lane: 'claude', running: 1, target: 2, held: false, window: 'weekly', usedPct,
    creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'status', deadSignal: null }],
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('resource ledger watch', () => {
  it('streams changing snapshots as compact JSON lines at the requested interval', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValueOnce(snapshot(10)).mockResolvedValueOnce(snapshot(14));
    const run = cmdResourceLedger(['--watch', '--json', '--interval-ms', '1000'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await run).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toEqual([JSON.stringify(snapshot(10)), JSON.stringify(snapshot(14))]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for a delayed read to finish before scheduling the next read', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let finish!: (value: ResourceLedgerV1) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<ResourceLedgerV1>(resolve => { finish = resolve; }))
      .mockResolvedValue(snapshot(11));
    const controller = new AbortController();
    const run = cmdResourceLedger(['--watch', '--json'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(1);
    finish(snapshot(10));
    await vi.advanceTimersByTimeAsync(4999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(await run).toBe(0);
  });

  it('emits a safe versioned error and retries after the interval', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn().mockRejectedValueOnce(new Error('private exception details')).mockResolvedValue(snapshot(12));
    const controller = new AbortController();
    const run = cmdResourceLedger(['--watch', '--json', '--interval-ms', '1000'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    expect(await run).toBe(0);
    expect(out.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { v: 1, error: 'resource_ledger_read_failed' }, snapshot(12),
    ]);
    expect(JSON.stringify(out.mock.calls)).not.toContain('private exception details');
    expect(err).not.toHaveBeenCalled();
  });

  it('cleans up timers and signal listeners on abort and repeated invocations', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const run = cmdResourceLedger(['--watch', '--json'], async () => snapshot(10), controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      expect(await run).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event))).toEqual(before);
    }
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops on %s and removes listeners', async event => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.listenerCount(event);
    const run = cmdResourceLedger(['--watch'], async () => snapshot(10));
    await vi.advanceTimersByTimeAsync(0);
    process.emit(event);
    expect(await run).toBe(0);
    expect(process.listenerCount(event)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    expect(await cmdResourceLedger(['--watch'], read, controller.signal)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['--interval-ms', '1000'], ['--watch', '--interval-ms'], ['--watch', '--interval-ms', '999'],
    ['--watch', '--interval-ms', '60001'], ['--watch', '--interval-ms', '1.5'],
    ['--watch', '--interval-ms', '-1000'], ['--watch', '--interval-ms', '1e3'],
    ['--watch', '--interval-ms', '1000', '--interval-ms', '2000'],
    ['--watch', '--watch'], ['--watch', '--bad'], ['--help', '--interval-ms', '1000'],
  ])('rejects invalid arguments %j without reading', async (...args) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
