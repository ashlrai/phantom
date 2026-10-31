import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const snapshot = (usedPct: number): ResourceLedgerV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', asOf: '2026-10-31T12:00:00Z',
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' },
  apiSpend: null, jobsMalformedRows: null,
  lanes: [{ lane: 'fake-personal', running: 1, target: 2, held: false, window: 'weekly', usedPct,
    creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'status', deadSignal: null }],
});

const listenerCounts = () => ['SIGINT', 'SIGTERM'].map(event => process.listenerCount(event));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded resource ledger watch', () => {
  it('emits two distinct JSONL snapshots and exits without another wait or read', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValueOnce(snapshot(10)).mockResolvedValueOnce(snapshot(14));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const before = listenerCounts();
    const run = cmdResourceLedger(['--watch', '--max-samples', '2', '--json', '--interval-ms', '1000'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run).toBe(0);
    expect(out.mock.calls.map(([line]) => line)).toEqual([JSON.stringify(snapshot(10)), JSON.stringify(snapshot(14))]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCounts()).toEqual(before);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('retries a failed read without counting the error as a sample', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockRejectedValueOnce(new Error('fake private detail'))
      .mockResolvedValueOnce(snapshot(10)).mockResolvedValueOnce(snapshot(11));
    const run = cmdResourceLedger(['--watch', '--max-samples', '2', '--json'], read);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await run).toBe(0);
    expect(out.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { v: 1, error: 'resource_ledger_read_failed' }, snapshot(10), snapshot(11),
    ]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read or leave listeners when the signal is already aborted', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    controller.abort();
    const before = listenerCounts();
    const read = vi.fn();
    expect(await cmdResourceLedger(['--watch', '--max-samples', '1', '--json'], read, controller.signal)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(listenerCounts()).toEqual(before);
  });

  it('accepts one text snapshot and exits immediately', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(snapshot(10));
    const before = listenerCounts();
    expect(await cmdResourceLedger(['--watch', '--max-samples', '1'], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(out.mock.calls.flat().join('\n')).toContain('Weekly usage: 10%');
    expect(vi.getTimerCount()).toBe(0);
    expect(listenerCounts()).toEqual(before);
  });

  it.each([
    ['--max-samples', '1'], ['--watch', '--max-samples'], ['--watch', '--max-samples', ''],
    ['--watch', '--max-samples', '0'], ['--watch', '--max-samples', '10001'],
    ['--watch', '--max-samples', '-1'], ['--watch', '--max-samples', '1.5'],
    ['--watch', '--max-samples', '1e2'], ['--watch', '--max-samples', 'NaN'],
    ['--watch', '--max-samples', '1', '--max-samples', '2'],
    ['--help', '--max-samples', '1'],
  ])('rejects invalid arguments %j before reading', async (...args) => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('Invalid ledger arguments; use phm resources ledger --help.\n');
  });

  it('accepts the upper bound and still honors abort', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue(snapshot(10));
    const run = cmdResourceLedger(['--watch', '--max-samples', '10000'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    controller.abort();
    expect(await run).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves one-shot JSON unchanged and documents the JSONL command', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(snapshot(10));
    expect(await cmdResourceLedger(['--json'], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledExactlyOnceWith(JSON.stringify(snapshot(10), null, 2));
    out.mockClear();
    expect(await cmdResourceLedger(['--help'], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(out.mock.calls.flat().join('\n')).toContain('phm resources ledger --watch --max-samples 2 --json');
  });
});
