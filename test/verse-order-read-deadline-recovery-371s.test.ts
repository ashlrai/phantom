/** GET /api/verse/fleet/work-board/orders read deadlines: a hung local
 * evidence reader (trace, live workers or lane targets) must degrade within
 * the per-reader bound instead of stalling Mason's order strip — the trace
 * bound answers the existing sources 'unavailable' / orders [] shape, the
 * live and lanes bounds degrade only their own source without fabricating
 * RUNNING or BLOCKED, timers are cleared, and the next request through the
 * same handler reads fresh evidence with no cached unavailable result. All
 * readers are sanitized fakes; a short injected timeoutMs stands in for the
 * 8 s default — no host reads, no network, no real timers beyond the bound. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const BOUND = 25;
const JOB = 'RQ-PHX-DEADLINE371';

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});
const launchedOrder = {
  at: '2026-11-14 05:30 ET', source: 'mason', key: '11-14 05:30',
  jobs: [{ id: JOB, lane: 'devin', state: 'launched' as const, url: null }],
};
const liveSnap = (): LiveWorkersSnapshot => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
  workers: [{ pid: 9001, job: JOB, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: 0,
});
const lanesSnap = (): LaneTargetsV1 => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
  lanes: [{ lane: 'devin', target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null }],
});
const hang = <T,>() => new Promise<T>(() => {});

async function call(m: ApiModule, path: string, method = 'GET', url = path) {
  let status = 0;
  let text = '';
  let ends = 0;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { ends++; text = body; },
  } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  return { handled, status, text, ends, body: text ? JSON.parse(text) : null };
}

const api = (over: Parameters<typeof createFleetOrderStateApi>[0] = {}) =>
  createFleetOrderStateApi({
    read: async () => trace([launchedOrder]),
    now: () => NOW,
    live: async () => liveSnap(),
    lanes: async () => lanesSnap(),
    timeoutMs: BOUND,
    ...over,
  });

describe('fleet order state api read deadlines', () => {
  it('a never-resolving trace answers the existing unavailable shape within the bound', async () => {
    const started = Date.now();
    const r = await call(api({ read: hang<OrderTraceV1> }), ORDERS);
    expect(Date.now() - started).toBeLessThan(BOUND * 10);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, sources: 'unavailable', orders: [] });
    expect(r.body.asOf).toBe(NOW.toISOString());
    expect(r.text).not.toContain('timeout');
  });

  it('a never-resolving live read degrades only live, keeps trace evidence and never claims RUNNING', async () => {
    const r = await call(api({ live: hang<LiveWorkersSnapshot> }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.live).toBe('unavailable');
    expect(r.body.lanes).toBe('healthy');
    const o = r.body.orders[0];
    expect(o.state).not.toBe('RUNNING');
    expect(o.state).not.toBe('BLOCKED');
    expect(o).toMatchObject({ key: '11-14 05:30', owner: { job: JOB, lane: 'devin' } });
  });

  it('a never-resolving lanes read degrades only lanes and never claims BLOCKED', async () => {
    const r = await call(api({ lanes: hang<LaneTargetsV1> }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.lanes).toBe('unavailable');
    expect(r.body.live).toBe('healthy');
    expect(r.body.orders[0].state).not.toBe('BLOCKED');
    expect(r.body.orders[0].state).toBe('RUNNING');
    expect(r.body.orders[0].blocker).toBeUndefined();
  });

  it('recovers on the next request through the same handler after each failed reader', async () => {
    let traceDown = true;
    let liveDown = true;
    let lanesDown = true;
    const m = api({
      read: async () => { if (traceDown) throw new Error('trace io'); return trace([launchedOrder]); },
      live: async () => { if (liveDown) throw new Error('live io'); return liveSnap(); },
      lanes: async () => { if (lanesDown) throw new Error('lanes io'); return lanesSnap(); },
    });
    const down = await call(m, ORDERS);
    expect(down.body.sources).toBe('unavailable');
    expect(down.body.orders).toEqual([]);

    traceDown = false;
    const partial = await call(m, ORDERS);
    expect(partial.body.sources).toMatchObject({ inbox: 'healthy' });
    expect(partial.body.live).toBe('unavailable');
    expect(partial.body.lanes).toBe('unavailable');
    expect(partial.body.orders[0].state).not.toBe('RUNNING');
    expect(partial.body.orders[0].state).not.toBe('BLOCKED');

    liveDown = false;
    lanesDown = false;
    const up = await call(m, ORDERS);
    expect(up.body.live).toBe('healthy');
    expect(up.body.lanes).toBe('healthy');
    expect(up.body.orders[0].state).toBe('RUNNING');
  });

  it('a hung reader followed by a recovered reader on the same handler serves fresh evidence', async () => {
    let hung = true;
    const m = api({
      live: async () => { if (hung) return hang<LiveWorkersSnapshot>(); return liveSnap(); },
    });
    const first = await call(m, ORDERS);
    expect(first.body.live).toBe('unavailable');
    hung = false;
    const second = await call(m, ORDERS);
    expect(second.body.live).toBe('healthy');
    expect(second.body.orders[0].state).toBe('RUNNING');
  });

  it('a reader that rejects after the bound causes no unhandled rejection and no second response', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let lateReject: (() => void) | undefined;
      const m = api({
        live: () => new Promise<LiveWorkersSnapshot>((_resolve, reject) => {
          lateReject = () => reject(new Error('late live failure'));
        }),
      });
      const r = await call(m, ORDERS);
      expect(r.status).toBe(200);
      expect(r.body.live).toBe('unavailable');
      expect(r.ends).toBe(1);
      lateReject?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
      expect(r.ends).toBe(1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('clears its deadline timer on early success and early failure', async () => {
    vi.useFakeTimers();
    try {
      const ok = api();
      const pendingOk = call(ok, ORDERS);
      await vi.advanceTimersByTimeAsync(0);
      const rOk = await pendingOk;
      expect(rOk.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);

      const bad = api({ live: async () => { throw new Error('live io'); } });
      const pendingBad = call(bad, ORDERS);
      await vi.advanceTimersByTimeAsync(0);
      const rBad = await pendingBad;
      expect(rBad.status).toBe(200);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a malformed query is rejected with zero reader calls', async () => {
    let reads = 0;
    const m = api({
      read: async () => { reads++; return trace([launchedOrder]); },
      live: async () => { reads++; return liveSnap(); },
      lanes: async () => { reads++; return lanesSnap(); },
    });
    const r = await call(m, ORDERS, 'GET', `${ORDERS}?since=0`);
    expect(r.status).toBe(400);
    expect(reads).toBe(0);
    const post = await call(m, ORDERS, 'POST');
    expect(post.status).toBe(405);
    expect(reads).toBe(0);
  });
});
