/** GET /api/verse/fleet/work-board/orders with lane holds: a queued order
 * whose every job sits on a held lane reports BLOCKED with a sanitized lane
 * dependency; mixed, live and merged siblings keep their own states; a
 * failed or degraded lane read claims no BLOCKED and leaks nothing. Every
 * dep is injected — no real ~/.ashlr-runs, process table or home is read. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const LANES_AT = '2026-11-14T09:59:30.000Z';
const LIVE_AT = '2026-11-14T09:59:45.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/77';
const SENTINEL = 'SENTINEL-private-hold-reason';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null, url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const laneRow = (over: Partial<LaneTargetRow> & { lane: string }): LaneTargetRow => ({
  target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...over,
});
const lanes = (rows: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({
  v: 1, generatedAt: LANES_AT, sourceState, lanes: rows,
});
const held = (lane: string) => laneRow({ lane, held: true, heldReason: SENTINEL, heldUntil: HELD_UNTIL, changedBy: SENTINEL });

const liveSnap = (jobIds: string[] = []): LiveWorkersSnapshot => ({
  v: 1, generatedAt: LIVE_AT, sourceState: 'healthy',
  workers: jobIds.map((j, i) => ({ pid: 7000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 })),
  leaders: [], orchestratorAgents: 0,
});

async function call(m: ApiModule, path: string, method = 'GET', url = path) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

const api = (t: OrderTraceV1, over: Parameters<typeof createFleetOrderStateApi>[0] = {}) =>
  createFleetOrderStateApi({
    read: async () => t, now: () => NOW, live: async () => liveSnap(), ...over,
  });

describe('fleet order state api — held lanes', () => {
  it('a queued order with every job on a held lane reports BLOCKED with slots.json evidence and a sanitized dependency', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs: [job('RQ-PHX-HELD1', 'queued', 'claude'), job('RQ-PHX-HELD2', 'queued', 'zai')] },
    ]);
    const r = await call(api(t, { lanes: async () => lanes([held('claude'), held('zai')]) }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.lanes).toBe('healthy');
    const o = r.body.orders[0];
    expect(o.state).toBe('BLOCKED');
    expect(o.evidenceSource).toBe('slots.json');
    expect(o.asOf).toBe(LANES_AT);
    expect(o.blocker).toBe('lane claude held until 2026-11-15T00:00:00.000Z, lane zai held until 2026-11-15T00:00:00.000Z');
    expect(r.text).not.toContain(SENTINEL);
    expect(r.text).not.toContain('heldReason');
    expect(r.text).not.toContain('changedBy');
  });

  it('re-reads lanes on every request: releasing the hold clears a stale BLOCKED on the same handler', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs: [job('RQ-PHX-HELD3', 'queued', 'claude')] },
    ]);
    let heldNow = true;
    const lanesRead = vi.fn(async () => lanes([laneRow({ lane: 'claude', held: heldNow, heldReason: heldNow ? SENTINEL : null, heldUntil: heldNow ? HELD_UNTIL : null })]));
    const m = api(t, { lanes: lanesRead });
    const first = await call(m, ORDERS);
    expect(first.body.orders[0].state).toBe('BLOCKED');
    expect(first.body.orders[0].blocker).toContain('lane claude held');
    heldNow = false;
    const second = await call(m, ORDERS);
    expect(lanesRead).toHaveBeenCalledTimes(2);
    expect(second.body.lanes).toBe('healthy');
    expect(second.body.orders[0].state).not.toBe('BLOCKED');
    expect(second.body.orders[0].blocker).toBeNull();
  });

  it('mixed siblings do not block: runnable queued stays unblocked, live stays RUNNING, merged stays VERIFIED', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: 'mixed', jobs: [job('RQ-PHX-MIX1', 'queued', 'claude'), job('RQ-PHX-MIX2', 'queued', 'devin')] },
      { at: '2026-11-13 21:00 ET', source: 'mason', key: 'live', jobs: [job('RQ-PHX-LIVE1', 'queued', 'claude'), job('RQ-PHX-LIVE2', 'launched', 'devin')] },
      { at: '2026-11-13 20:00 ET', source: 'mason', key: 'done', jobs: [job('RQ-PHX-DONE1', 'merged', 'devin', PR)] },
    ]);
    const m = api(t, {
      lanes: async () => lanes([held('claude'), laneRow({ lane: 'devin' })]),
      live: async () => liveSnap(['RQ-PHX-LIVE2']),
    });
    const r = await call(m, ORDERS);
    expect(r.status).toBe(200);
    const byKey = Object.fromEntries(r.body.orders.map((o: { key: string }) => [o.key, o]));
    expect(byKey.mixed.state).not.toBe('BLOCKED');
    expect(byKey.mixed.blocker).toBeNull();
    expect(byKey.live.state).toBe('RUNNING');
    expect(byKey.live.evidenceSource).toBe('live-worker RQ-PHX-LIVE2');
    expect(byKey.done.state).toBe('VERIFIED');
    expect(byKey.done.pr).toBe(PR);
    expect(byKey.done.owner).toEqual({ job: 'RQ-PHX-DONE1', lane: 'devin' });
    expect(r.text).not.toContain(SENTINEL);
  });

  it('a throwing lane read yields lanes unavailable, preserves rows and live evidence, leaks nothing, then recovers', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: 'held', jobs: [job('RQ-PHX-HELD4', 'queued', 'claude')] },
      { at: '2026-11-13 21:00 ET', source: 'mason', key: 'live', jobs: [job('RQ-PHX-LIVE3', 'launched', 'devin')] },
    ]);
    let fail = true;
    const lanesRead = vi.fn(async () => {
      if (fail) throw new Error(`boom ${SENTINEL} /Users/fakehome/secret`);
      return lanes([held('claude')]);
    });
    const m = api(t, { lanes: lanesRead, live: async () => liveSnap(['RQ-PHX-LIVE3']) });
    const bad = await call(m, ORDERS);
    expect(bad.status).toBe(200);
    expect(bad.body.lanes).toBe('unavailable');
    expect(bad.body.orders).toHaveLength(2);
    expect(bad.body.orders.map((o: { key: string }) => o.key)).toEqual(['held', 'live']);
    expect(bad.body.orders[0].state).not.toBe('BLOCKED');
    expect(bad.body.orders[0]).not.toHaveProperty('blocker');
    expect(bad.body.orders[1].state).toBe('RUNNING');
    expect(bad.body.orders[1].evidenceSource).toBe('live-worker RQ-PHX-LIVE3');
    expect(bad.text).not.toContain(SENTINEL);
    expect(bad.text).not.toContain('fakehome');
    fail = false;
    const good = await call(m, ORDERS);
    expect(good.body.lanes).toBe('healthy');
    expect(good.body.orders[0].state).toBe('BLOCKED');
    expect(lanesRead).toHaveBeenCalledTimes(2);
  });

  it('a degraded lane read is unavailable, not healthy, and claims no BLOCKED', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: 'held', jobs: [job('RQ-PHX-HELD5', 'queued', 'claude')] },
    ]);
    const r = await call(api(t, { lanes: async () => lanes([held('claude')], 'degraded') }), ORDERS);
    expect(r.body.lanes).toBe('unavailable');
    expect(r.body.orders[0].state).not.toBe('BLOCKED');
    expect(r.body.orders[0]).not.toHaveProperty('blocker');
  });

  it('invalid method and query never invoke the lane reader', async () => {
    const t = trace([
      { at: '2026-11-13 22:29 ET', source: 'mason', key: 'held', jobs: [job('RQ-PHX-HELD6', 'queued', 'claude')] },
    ]);
    const lanesRead = vi.fn(async () => lanes([held('claude')]));
    const m = api(t, { lanes: lanesRead });
    expect((await call(m, ORDERS, 'POST')).status).toBe(405);
    expect((await call(m, ORDERS, 'GET', `${ORDERS}?since=0`)).status).toBe(400);
    expect((await call(m, ORDERS, 'GET', `${ORDERS}?since=abc`)).status).toBe(400);
    expect(lanesRead).not.toHaveBeenCalled();
  });
});
