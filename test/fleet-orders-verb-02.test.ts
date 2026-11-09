import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrders, parseOrderAt } from '../src/cli/fleet-orders.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const trace = (sources: Partial<OrderTraceV1['sources']> = {}): OrderTraceV1 => ({
  v: 1, generatedAt: '2026-11-02T12:00:00.000Z',
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', ...sources },
  orders: [
    { at: '2026-10-31 19:28', source: 'Phantom desktop', key: '10-31 19:28', jobs: [
      { id: 'RQ-A', lane: 'x', state: 'queued', url: null },
      { id: 'RQ-B', lane: 'x', state: 'published', url: 'https://example.test/pr/1' }] },
    { at: '2026-11-01 00:08', source: 'Phantom desktop', key: '11-01 00:08', jobs: [] },
  ],
});
const now = () => Date.parse('2026-11-02T12:00:00Z');
const run = (args: string[], t = trace()) => cmdFleetOrders(args, { read: async () => t, now });
const out = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((c) => String(c[0])).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('fleet orders', () => {
  it('marks uncovered orders, newest first, with counts by state', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([])).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '2026-11-01 00:08 Phantom desktop jobs=0 queued=0 launched=0 published=0 UNCOVERED',
      '2026-10-31 19:28 Phantom desktop jobs=2 queued=1 launched=0 published=1',
    ]);
  });
  it('--uncovered lists only the uncovered order', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--uncovered'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(out(log)).toContain('UNCOVERED');
  });
  it('--json emits the documented shape', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--json'])).toBe(0);
    const parsed = JSON.parse(out(log));
    expect(parsed.v).toBe(1);
    expect(parsed.sources.inbox).toBe('healthy');
    expect(parsed.orders.map((o: { uncovered: boolean }) => o.uncovered)).toEqual([true, false]);
  });
  it('--since filters by New York wall time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--since', '36'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(await run(['--since', '720'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(3);
    expect(parseOrderAt('2026-11-01 00:08')).toBe(Date.parse('2026-11-01T04:08:00Z'));
    expect(parseOrderAt('2026-11-02 08:00')).toBe(Date.parse('2026-11-02T13:00:00Z'));
    expect(parseOrderAt('2026-02-31 00:00')).toBeNull();
    expect(parseOrderAt('garbage')).toBeNull();
  });
  it('rejects bad args with 2 and read failures with 1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--since', '0'], ['--since', 'abc'], ['--since'], ['--since', '721'], ['--nope']]) {
      expect(await run(args)).toBe(2);
    }
    expect(await cmdFleetOrders([], { read: async () => { throw new Error('boom'); } })).toBe(1);
  });
  it('prints usage for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--help'])).toBe(0);
    expect(out(log)).toContain('Usage: ashlr fleet orders');
  });
  it('warns when a source is not healthy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace({ publishes: 'degraded' }))).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('publishes=degraded');
  });
});
