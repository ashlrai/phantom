/** GET /api/verse/fleet/work-board/orders: fake trace and fake req/res only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_ORDER_STATE_PATH as ORDERS,
  createFleetOrderStateApi,
} from '../src/core/verse/fleet-order-state-api.js';
import {
  VERSE_FLEET_WORK_BOARD_PATH as BOARD,
  VERSE_FLEET_WORK_RESULT_PATH as RESULT,
  createFleetWorkBoardApi,
} from '../src/core/verse/fleet-work-board-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/1';

const trace = (orders: OrderTraceV1['orders'] = []): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});
const sample = trace([
  { at: '2026-11-13 13:13 ET', source: 'mason', key: '11-13 13:13', jobs: [] },
  { at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs: [{ id: 'RQ-PHX-FAKEA1', lane: 'claude', state: 'merged', url: PR }] },
]);
const api = (over: Parameters<typeof createFleetOrderStateApi>[0] = {}) =>
  createFleetOrderStateApi({ read: async () => sample, now: () => NOW, ...over });

async function call(m: ApiModule, path: string, method = 'GET', url = path) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const req = { url } as IncomingMessage;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('fleet order state api', () => {
  it('returns classified rows newest first', async () => {
    const r = await call(api(), ORDERS);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), asOf: NOW.toISOString(), sources: sample.sources });
    expect(r.body.orders.map((o: { key: string }) => o.key)).toEqual(['11-13 22:29', '11-13 13:13']);
    expect(r.body.orders[0]).toMatchObject({ state: 'VERIFIED', pr: PR, missing: [] });
    expect(r.body.orders[1]).toMatchObject({ state: 'RECEIVED', pr: null });
    expect(Object.keys(r.body.orders[0]).sort()).toEqual(['asOf', 'at', 'evidenceSource', 'key', 'missing', 'owner', 'pr', 'source', 'state']);
  });

  it('caps at 20 orders and honours since', async () => {
    const many = trace(Array.from({ length: 30 }, (_, i) => ({
      at: `2026-11-14 ${String(i % 10).padStart(2, '0')}:${String(i).padStart(2, '0')} ET`, source: 'mason', key: `11-14 k${i}`, jobs: [],
    })));
    expect((await call(api({ read: async () => many }), ORDERS)).body.orders).toHaveLength(20);
    const r = await call(api(), ORDERS, 'GET', `${ORDERS}?since=24`);
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeLessThanOrEqual(2);
  });

  it.each(['0', 'abc', '721', '1.5', '-3', ''])('rejects since=%s with 400', async (v) => {
    const r = await call(api(), ORDERS, 'GET', `${ORDERS}?since=${v}`);
    expect(r.status).toBe(400);
    expect(typeof r.body.error).toBe('string');
  });

  it('answers 405 for non-GET and ignores other paths', async () => {
    expect((await call(api(), ORDERS, 'POST')).status).toBe(405);
    expect((await call(api(), '/api/verse/other')).handled).toBe(false);
  });

  it('answers 200 unavailable when the reader throws, without the thrown text', async () => {
    const boom = async (): Promise<OrderTraceV1> => { throw new Error('SECRET-boom /Users/fakehome/.ashlr-runs'); };
    const r = await call(api({ read: boom }), ORDERS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ v: 1, asOf: NOW.toISOString(), sources: 'unavailable', orders: [] });
    expect(r.text).not.toMatch(/SECRET|fakehome/);
  });
});

describe('work-board family chaining', () => {
  it('routes the orders sub-path to the injected module', async () => {
    const m = createFleetWorkBoardApi({ orders: api() });
    const r = await call(m, ORDERS);
    expect(r.status).toBe(200);
    expect(r.body.orders).toHaveLength(2);
  });

  it('keeps GET work-board and POST result behaviour', async () => {
    const m = createFleetWorkBoardApi({
      orders: api(),
      now: () => NOW,
      read: () => ({ items: [], inbox: 'unavailable', truncated: false, claims: 'unavailable' }),
    });
    const board = await call(m, BOARD);
    expect(board.status).toBe(200);
    expect(board.body).toEqual({ items: [], inbox: 'unavailable', truncated: false, claims: 'unavailable', asOf: NOW.toISOString() });
    expect((await call(m, BOARD, 'POST')).status).toBe(405);
    expect((await call(m, RESULT, 'GET')).status).toBe(405);
  });
});
