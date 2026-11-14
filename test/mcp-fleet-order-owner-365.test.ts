/**
 * RQ-PHX-ORDEROWNERMCP365 — fleet_order_state rows name a sanitized owner:
 * { job, lane } from the order's most advanced trace job. The job id must
 * match the fleet's RQ-… shape and the lane a lower-case dispatcher lane id,
 * or the field degrades to null. Hermetic: fake trace and live readers only —
 * never reads ~/.ashlr-runs or the real process table.
 */
import { describe, expect, it } from 'vitest';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/1';

const trace = (orders: OrderTraceV1['orders'] = []): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const liveSnap = (): LiveWorkersSnapshot => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
  workers: [], leaders: [], orchestratorAgents: 0,
});

const order = (jobs: OrderTraceV1['orders'][number]['jobs']): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs });

interface Body { v: number; asOf: string; live?: string; sources: unknown; orders: Array<Record<string, unknown>> }
const call = (deps: Parameters<typeof readFleetOrderState>[0] = {}): Promise<Body> =>
  readFleetOrderState({ now: () => NOW.getTime(), ...deps }) as Promise<Body>;

describe('fleet_order_state owner', () => {
  it('a merged job names { job, lane }', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEOWNER1', lane: 'devin', state: 'merged', url: PR }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ state: 'VERIFIED', pr: PR, owner: { job: 'RQ-PHX-FAKEOWNER1', lane: 'devin' } });
  });

  it('an order with no jobs has owner null', async () => {
    const body = await call({ read: async () => trace([order([])]), live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ owner: null, pr: null });
  });

  it.each(['../x', 'RQ-PHX BAD'])('a job id %j outside the RQ- shape gives owner null', async (id) => {
    const t = trace([order([{ id, lane: 'devin', state: 'queued', url: null }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ owner: null });
    expect(JSON.stringify(body.orders[0])).not.toContain(id);
  });

  it('a lane outside the lane-id shape gives lane null but keeps the job', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEOWNER1', lane: 'Devin/x', state: 'launched', url: null }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ owner: { job: 'RQ-PHX-FAKEOWNER1', lane: null } });
    expect(JSON.stringify(body.orders[0])).not.toContain('Devin/x');
  });

  it('a job with a null lane names the job with lane null', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEOWNER1', lane: null, state: 'queued', url: null }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ owner: { job: 'RQ-PHX-FAKEOWNER1', lane: null } });
  });

  it('a trace read that throws reports unavailable with no orders, body unchanged', async () => {
    const body = await call({ read: async () => { throw new Error('boom /Users/example/secret'); }, live: async () => liveSnap() });
    expect(body).toEqual({ v: 1, asOf: NOW.toISOString(), sources: 'unavailable', live: 'unavailable', orders: [] });
  });
});
