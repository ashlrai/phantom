/** GET /api/verse/fleet/work-board/orders live-worker recovery: the same
 * fresh process-table evidence the CLI passes to classifyOrder must reach
 * the desktop API — RUNNING only while the exact job id has a healthy live
 * worker, ASSIGNED when it disappears, never synthesized from a failed or
 * stale snapshot. Fake trace, fake worker snapshots and fake req/res only:
 * no process launches, no host state reads. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/362';
const JOB = 'RQ-PHX-LIVE362';

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
const mergedOrder = {
  at: '2026-11-14 04:00 ET', source: 'mason', key: '11-14 04:00',
  jobs: [{ id: 'RQ-PHX-MERGED362', lane: 'claude', state: 'merged' as const, url: PR }],
};

const worker = (job: string, pid = 4000): LiveWorker => ({
  pid, job, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60,
});
const snapshot = (jobs: string[], generatedAt = NOW.toISOString(), sourceState: 'healthy' | 'unavailable' = 'healthy'): LiveWorkersSnapshot => ({
  v: 1, generatedAt, sourceState,
  workers: sourceState === 'healthy' ? jobs.map((j, i) => worker(j, 4000 + i)) : [],
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

describe('fleet order state api live recovery', () => {
  it('reports RUNNING, ASSIGNED, RUNNING as the exact worker comes and goes', async () => {
    let jobs = [JOB];
    const m = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]),
      now: () => NOW,
      live: async () => snapshot(jobs),
    });
    const running = await call(m, ORDERS);
    expect(running.status).toBe(200);
    expect(running.body.live).toBe('healthy');
    expect(running.body.orders[0]).toMatchObject({
      state: 'RUNNING', asOf: NOW.toISOString(), evidenceSource: `live-worker ${JOB}`,
    });

    jobs = [];
    const assigned = await call(m, ORDERS);
    expect(assigned.body.orders[0]).toMatchObject({ state: 'ASSIGNED' });
    expect(assigned.body.orders[0].evidenceSource).toBe(`claim:${JOB}`);

    jobs = [JOB];
    const again = await call(m, ORDERS);
    expect(again.body.orders[0].state).toBe('RUNNING');
  });

  it('does not promote an order for an unrelated live worker', async () => {
    const m = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]),
      now: () => NOW,
      live: async () => snapshot(['RQ-PHX-OTHER999']),
    });
    const r = await call(m, ORDERS);
    expect(r.body.orders[0].state).toBe('ASSIGNED');
  });

  it('keeps trace evidence usable and never invents RUNNING when live is unavailable or throws', async () => {
    const orders = [launchedOrder, mergedOrder];
    for (const live of [
      async () => snapshot([], NOW.toISOString(), 'unavailable'),
      async () => { throw new Error('SECRET ps failure /Users/fakehome/bin'); },
    ]) {
      const m = createFleetOrderStateApi({ read: async () => trace(orders), now: () => NOW, live });
      const r = await call(m, ORDERS);
      expect(r.status).toBe(200);
      expect(r.body.live).toBe('unavailable');
      expect(r.body.orders.find((o: { key: string }) => o.key === launchedOrder.key).state).toBe('ASSIGNED');
      const merged = r.body.orders.find((o: { key: string }) => o.key === mergedOrder.key);
      expect(merged).toMatchObject({ state: 'VERIFIED', pr: PR });
      expect(r.text).not.toMatch(/SECRET|fakehome/);
    }
  });

  it('follows classifier freshness for stale and future snapshot timestamps', async () => {
    const stale = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]), now: () => NOW,
      live: async () => snapshot([JOB], new Date(NOW.getTime() - 31 * 60_000).toISOString()),
    });
    expect((await call(stale, ORDERS)).body.orders[0].state).toBe('ASSIGNED');
    const future = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]), now: () => NOW,
      live: async () => snapshot([JOB], new Date(NOW.getTime() + 6 * 60_000).toISOString()),
    });
    expect((await call(future, ORDERS)).body.orders[0].state).toBe('ASSIGNED');
    const fresh = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]), now: () => NOW,
      live: async () => snapshot([JOB], new Date(NOW.getTime() - 29 * 60_000).toISOString()),
    });
    expect((await call(fresh, ORDERS)).body.orders[0].state).toBe('RUNNING');
  });

  it('reads at most one worker snapshot per request however many orders', async () => {
    let reads = 0;
    const orders = [launchedOrder, mergedOrder, { ...launchedOrder, key: '11-14 05:00', at: '2026-11-14 05:00 ET', jobs: [{ id: 'RQ-PHX-LIVE363', lane: 'devin', state: 'launched' as const, url: null }] }];
    const m = createFleetOrderStateApi({
      read: async () => trace(orders), now: () => NOW,
      live: async () => { reads++; return snapshot([JOB, 'RQ-PHX-LIVE363']); },
    });
    const r = await call(m, ORDERS);
    expect(r.status).toBe(200);
    expect(reads).toBe(1);
    expect(r.body.orders.filter((o: { state: string }) => o.state === 'RUNNING')).toHaveLength(2);
    await call(m, ORDERS);
    expect(reads).toBe(2);
  });

  it('never reads workers for invalid requests or other paths', async () => {
    let reads = 0;
    const m = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]), now: () => NOW,
      live: async () => { reads++; return snapshot([JOB]); },
    });
    expect((await call(m, ORDERS, 'POST')).status).toBe(405);
    expect((await call(m, ORDERS, 'GET', `${ORDERS}?since=0`)).status).toBe(400);
    expect((await call(m, '/api/verse/other')).handled).toBe(false);
    expect(reads).toBe(0);
    const failingRead = createFleetOrderStateApi({
      read: async () => { throw new Error('trace down'); }, now: () => NOW,
      live: async () => { reads++; return snapshot([JOB]); },
    });
    expect((await call(failingRead, ORDERS)).status).toBe(200);
    expect(reads).toBe(0);
  });

  it('keeps worker internals out of the response', async () => {
    const dirty: LiveWorkersSnapshot = {
      v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
      workers: [{ pid: 424242, job: JOB, repo: '/Users/fakehome/secret-repo', lane: '/Users/fakehome', tier: 'work', ageSeconds: 1 }],
      leaders: [], orchestratorAgents: 0,
    };
    const m = createFleetOrderStateApi({
      read: async () => trace([launchedOrder]), now: () => NOW, live: async () => dirty,
    });
    const r = await call(m, ORDERS);
    expect(r.body.orders[0].state).toBe('RUNNING');
    expect(r.text).not.toMatch(/424242|fakehome|secret-repo|Users\//);
  });
});
