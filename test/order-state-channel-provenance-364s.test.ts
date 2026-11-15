import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetOrderState } from '../src/cli/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const PR_URL = 'https://github.com/ashlrai/phantom/pull/123';
const trace = (sources: Partial<OrderTraceV1['sources']> = {}, alsoChannels?: string[]): OrderTraceV1 => ({
  v: 1, generatedAt: '2026-11-13T12:00:00.000Z',
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', ...sources },
  orders: [
    { at: '2026-11-12 22:29', source: 'Phantom desktop', key: '11-12 22:29', jobs: [
      { id: 'RQ-PHX-FAKE1', lane: 'devin', state: 'merged', url: PR_URL }] },
    { at: '2026-11-10 14:30', source: 'Phantom desktop', key: '11-10 14:30', jobs: [
      { id: 'RQ-PHX-FAKE2', lane: 'codex', state: 'launched', url: null }] },
    { at: '2026-11-01 00:08', source: 'Phantom desktop', key: '11-01 00:08', jobs: [] },
    ...(alsoChannels ? [{
      at: '2026-11-05 09:15',
      source: 'Slack',
      key: '11-05 09:15',
      alsoChannels,
      jobs: [
        { id: 'RQ-PHX-FAKE3', lane: 'claude', state: 'published', url: null }
      ]
    }] : []),
  ],
});
const now = () => Date.parse('2026-11-13T12:00:00Z');
const noLive: LiveWorkersSnapshot = { v: 1, generatedAt: '2026-11-13T12:00:00.000Z', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 };

describe('fleet order-state with channel attribution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves alsoChannels in JSON output when present', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Test with order having alsoChannels
    const testTrace = trace({}, ['iMessage', 'email']);
    expect(await cmdFleetOrderState(['--json'], { read: async () => testTrace, now, live: async () => noLive })).toBe(0);
    
    const parsed = JSON.parse(log.mock.calls[0]![0]);
    expect(parsed.v).toBe(1);
    expect(parsed.generatedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(parsed.sources.inbox).toBe('healthy');
    
    // Find the order with alsoChannels
    const orderWithChannels = parsed.orders.find((o: any) => o.key === '11-05 09:15');
    expect(orderWithChannels).toBeDefined();
    expect(orderWithChannels.alsoChannels).toEqual(['iMessage', 'email']);
    expect(orderWithChannels.source).toBe('Slack');
    
    // Verify that orders without alsoChannels don't have the field
    const orderWithoutChannels = parsed.orders.find((o: any) => o.key === '11-12 22:29');
    expect(orderWithoutChannels).toBeDefined();
    expect(orderWithoutChannels).not.toHaveProperty('alsoChannels');
  });

  it('maintains backward compatibility for orders without alsoChannels', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Test the case where orders don't have alsoChannels (default case)
    const testTrace = trace();
    expect(await cmdFleetOrderState(['--json'], { read: async () => testTrace, now, live: async () => noLive })).toBe(0);
    
    const parsed = JSON.parse(log.mock.calls[0]![0]);
    
    // Verify all orders maintain their existing structure and fields
    expect(parsed.v).toBe(1);
    expect(parsed.generatedAt).toBe('2026-11-13T12:00:00.000Z');
    expect(parsed.sources.inbox).toBe('healthy');
    
    // Ensure orders without alsoChannels don't have the field in output
    parsed.orders.forEach((order: any) => {
      if (order.key !== '11-05 09:15') {
        expect(order).not.toHaveProperty('alsoChannels');
      }
    });
    
    // Also verify that the state fields are still present and correct
    const order1 = parsed.orders.find((o: any) => o.key === '11-12 22:29');
    expect(order1.state).toBe('VERIFIED');
    expect(order1.asOf).toBe('2026-11-13T12:00:00.000Z');
  });

  it('includes alsoChannels field when present in trace orders', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    
    const testTrace = trace({}, ['slack', 'telegram']);
    expect(await cmdFleetOrderState(['--json'], { read: async () => testTrace, now, live: async () => noLive })).toBe(0);
    
    const parsed = JSON.parse(log.mock.calls[0]![0]);
    const orderWithChannels = parsed.orders.find((o: any) => o.key === '11-05 09:15');
    
    // Verify that alsoChannels field is included when present in the trace
    expect(orderWithChannels.alsoChannels).toEqual(['slack', 'telegram']);
    
    // Verify other fields remain intact
    expect(orderWithChannels.at).toBe('2026-11-05 09:15');
    expect(orderWithChannels.source).toBe('Slack');
    expect(orderWithChannels.key).toBe('11-05 09:15');
    expect(orderWithChannels.state).toBe('ASSIGNED');
  });
});
