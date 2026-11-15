import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const PR_URL = 'https://github.com/ashlrai/phantom/pull/123';
const trace = (sources: Partial<OrderTraceV1['sources']> = {}): OrderTraceV1 => ({
  v: 1, generatedAt: '2026-11-13T12:00:00.000Z',
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', ...sources },
  orders: [
    { at: '2026-11-12 22:29', source: 'Phantom desktop', key: '11-12 22:29', jobs: [
      { id: 'RQ-PHX-FAKE1', lane: 'devin', state: 'merged', url: PR_URL }] },
    { at: '2026-11-10 14:30', source: 'Phantom desktop', key: '11-10 14:30', jobs: [
      { id: 'RQ-PHX-FAKE2', lane: 'codex', state: 'launched', url: null }] },
    { at: '2026-11-01 00:08', source: 'Phantom desktop', key: '11-01 00:08', jobs: [] },
  ],
});
const now = () => Date.parse('2026-11-13T12:00:00Z');
const noLive: LiveWorkersSnapshot = { v: 1, generatedAt: '2026-11-13T12:00:00.000Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };
const run = (args: string[], t = trace()) => cmdFleetOrderState(args, { read: async () => t, now, live: async () => noLive });
const out = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.map((c) => String(c[0])).join('\n');

afterEach(() => vi.restoreAllMocks());

describe('fleet order-state', () => {
  it('is registered for dispatch', () => {
    expect(resolveFleetSubcommand('order-state')).toEqual({ module: './fleet-order-state.js', exportName: 'cmdFleetOrderState' });
    expect(FLEET_SUBCOMMAND_LOADERS['order-state']).toBeDefined();
  });
  it('prints one contract line per order, newest first', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([])).toBe(0);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      `2026-11-12 22:29 Phantom desktop VERIFIED as-of=2026-11-13T12:00:00.000Z source=order-trace missing=none pr=${PR_URL}`,
      '2026-11-10 14:30 Phantom desktop ASSIGNED as-of=2026-11-10T19:30:00.000Z source=claim:RQ-PHX-FAKE2 missing=none',
      '2026-11-01 00:08 Phantom desktop RECEIVED as-of=2026-11-01T04:08:00.000Z source=receivedAt missing=named owner,durable claim receipt',
    ]);
  });
  it('--json emits per-order state with the pr url when present', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--json'])).toBe(0);
    const parsed = JSON.parse(out(log));
    expect(parsed.v).toBe(1);
    expect(parsed.generatedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(parsed.sources.inbox).toBe('healthy');
    expect(parsed.orders.map((o: { state: string }) => o.state)).toEqual(['VERIFIED', 'ASSIGNED', 'RECEIVED']);
    expect(parsed.orders[0].pr).toBe(PR_URL);
    expect(parsed.orders[1].pr).toBeNull();
    expect(parsed.orders[1].evidenceSource).toBe('claim:RQ-PHX-FAKE2');
    expect(parsed.orders[2].missing).toEqual(['named owner', 'durable claim receipt']);
  });
  it('--since filters by New York wall time', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--since', '24'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(out(log)).toContain('VERIFIED');
    expect(await run(['--since', '720'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(4);
  });
  it('caps output at 20 orders', async () => {
    const many: OrderTraceV1 = {
      v: 1, generatedAt: '2026-11-13T12:00:00.000Z',
      sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
      orders: Array.from({ length: 25 }, (_, i) => ({
        at: `2026-11-${String(i + 1).padStart(2, '0')} 10:00`, source: 'Phantom desktop', key: `11-${String(i + 1).padStart(2, '0')} 10:00`, jobs: [],
      })),
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], many)).toBe(0);
    expect(log).toHaveBeenCalledTimes(20);
    expect(log.mock.calls[0]![0]).toContain('2026-11-25 10:00');
  });
  it('warns when an order source is not healthy', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run([], trace({ publishes: 'degraded' }))).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('warning: order sources not healthy: publishes=degraded');
  });
  it('exits 1 when the trace cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetOrderState([], { read: async () => { throw new Error('boom'); } })).toBe(1);
    expect(out(err)).toContain('unable to read the order trace');
  });
  it('exits 2 on bad arguments', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const args of [['--since', '0'], ['--since', 'abc'], ['--since'], ['--since', '721'], ['--nope'], ['positional']]) {
      expect(await run(args)).toBe(2);
    }
  });
  it('prints usage for --help', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await run(['--help'])).toBe(0);
    expect(out(log)).toContain('Usage: ashlr fleet order-state');
  });
});
