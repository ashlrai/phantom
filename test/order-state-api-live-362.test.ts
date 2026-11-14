/** GET /api/verse/fleet/work-board/orders live-worker wiring: a healthy
 * snapshot naming a launched job classifies the row RUNNING, matching
 * `ashlr fleet order-state`; a throw or non-healthy snapshot degrades the
 * row to ASSIGNED with body.live 'unavailable'. Fake trace, fake snapshot
 * and fake req/res only — no process table is ever read. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const JOB = 'RQ-PHX-ORDERAPILIVE362';

const trace = (orders: OrderTraceV1['orders'] = []): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});
const launched = trace([
  { at: '2026-11-14 09:55 ET', source: 'mason', key: '11-14 09:55', jobs: [{ id: JOB, lane: 'devin', state: 'launched', url: null }] },
]);

const snapshot = (over: Partial<LiveWorkersSnapshot> = {}): LiveWorkersSnapshot => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sourceState: 'healthy',
  workers: [],
  leaders: [],
  orchestratorAgents: 0,
  ...over,
});
const worker = (job: string) => ({ pid: 4242, job, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 });

const api = (over: Parameters<typeof createFleetOrderStateApi>[0] = {}) =>
  createFleetOrderStateApi({ read: async () => launched, now: () => NOW, ...over });

async function call(m: ApiModule, path: string, method = 'GET', url = path) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet order state api live workers', () => {
  it('classifies a launched job with a live worker RUNNING', async () => {
    const r = await call(api({ live: async () => snapshot({ workers: [worker(JOB)] }) }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.live).toBe('healthy');
    expect(r.body.orders).toHaveLength(1);
    expect(r.body.orders[0].state).toBe('RUNNING');
    expect(r.body.orders[0].evidenceSource).toMatch(/^live-worker/);
    expect(r.body.orders[0].asOf).toBe(NOW.toISOString());
    expect(r.body.orders[0].missing).toEqual([]);
  });

  it('degrades to ASSIGNED with live unavailable when the reader throws', async () => {
    const boom = async (): Promise<LiveWorkersSnapshot> => { throw new Error('SECRET-ps /Users/fakehome/bin/ps'); };
    const r = await call(api({ live: boom }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.live).toBe('unavailable');
    expect(r.body.orders[0].state).toBe('ASSIGNED');
    expect(r.text).not.toMatch(/SECRET|fakehome|bin\/ps/);
  });

  it('degrades to ASSIGNED with live unavailable on a non-healthy snapshot', async () => {
    const r = await call(api({ live: async () => snapshot({ sourceState: 'unavailable' }) }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.live).toBe('unavailable');
    expect(r.body.orders[0].state).toBe('ASSIGNED');
    expect(r.body.orders[0].evidenceSource).toBe(`claim:${JOB}`);
  });

  it('ignores live workers for job ids not in the trace', async () => {
    const r = await call(api({ live: async () => snapshot({ workers: [worker('RQ-PHX-OTHER999')] }) }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.live).toBe('healthy');
    expect(r.body.orders[0].state).toBe('ASSIGNED');
    expect(r.body.orders[0].evidenceSource).toBe(`claim:${JOB}`);
  });

  it('never returns pids or command lines even when the snapshot carries them', async () => {
    const sneaky = {
      ...snapshot({ workers: [worker(JOB)] }),
      command: '/bin/ps -axo pid=,etime=,command= SECRET-cmd',
      pid: 4242,
      cwd: '/Users/fakehome/.ashlr-runs',
    };
    const r = await call(api({ live: async () => sneaky as LiveWorkersSnapshot }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.orders[0].state).toBe('RUNNING');
    expect(r.text).not.toMatch(/pid|command|cwd|SECRET|fakehome|ashlr-runs/);
    expect(Object.keys(r.body).sort()).toEqual(['asOf', 'generatedAt', 'live', 'orders', 'sources', 'v']);
  });

  it('does not read the snapshot when the trace is unavailable', async () => {
    const boom = async (): Promise<OrderTraceV1> => { throw new Error('SECRET-trace'); };
    let liveCalled = false;
    const r = await call(api({
      read: boom,
      live: async () => { liveCalled = true; return snapshot({ workers: [worker(JOB)] }); },
    }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, asOf: NOW.toISOString(), sources: 'unavailable', live: 'unavailable', orders: [] });
    expect(liveCalled).toBe(false);
  });
});
