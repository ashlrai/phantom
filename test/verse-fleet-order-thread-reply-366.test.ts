import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { VERSE_FLEET_ORDER_STATE_PATH as ORDERS, createFleetOrderStateApi } from '../src/core/verse/fleet-order-state-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const [A, B, C] = ['a', 'b', 'c'].map((c) => c.repeat(64));
const trace: OrderTraceV1 = {
  v: 1, generatedAt: NOW.toISOString(), sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    { at: '2026-11-14 09:00 ET', source: 'slack', key: '11-14 09:00', requestId: A, jobs: [] },
    { at: '2026-11-14 08:00 ET', source: 'slack', key: '11-14 08:00', requestId: B, jobs: [] },
    { at: '2026-11-14 07:00 ET', source: 'slack', key: '11-14 07:00', requestId: C, jobs: [] },
    { at: '2026-11-14 06:00 ET', source: 'desktop', key: '11-14 06:00', jobs: [] },
  ],
};
async function get(replies?: () => never | Map<string, { delivered: boolean; attempted: boolean }> | null) {
  const api = createFleetOrderStateApi({
    read: async () => trace, now: () => NOW, ...(replies ? { replies } : {}),
    live: async () => ({ sourceState: 'healthy', workers: [], generatedAt: NOW.toISOString() }) as never,
  });
  let text = ''; let status = 0;
  const res = { writeHead(s: number) { status = s; return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url: ORDERS } as IncomingMessage, res, ORDERS, 'GET');
  return { status, replies: (JSON.parse(text).orders as Array<{ threadReply: string }>).map((o) => o.threadReply) };
}

describe('order threadReply', () => {
  it('reports delivered, attempted, none and unknown (no request id)', async () => {
    const r = await get(() => new Map([[A, { delivered: true, attempted: false }], [B, { delivered: false, attempted: true }]]));
    expect(r).toEqual({ status: 200, replies: ['delivered', 'attempted', 'none', 'unknown'] });
  });
  it('a throwing seam makes every row unknown and still answers 200', async () => {
    expect(await get(() => { throw new Error('/Users/x/secret'); })).toEqual({ status: 200, replies: ['unknown', 'unknown', 'unknown', 'unknown'] });
  });
  it('an unreadable store (null) makes every row unknown', async () => {
    expect((await get(() => null)).replies).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });
});
