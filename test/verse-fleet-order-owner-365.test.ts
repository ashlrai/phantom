/** Order rows name a sanitized owner (job + lane). Fake ids only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { VERSE_FLEET_ORDER_STATE_PATH as ORDERS, createFleetOrderStateApi } from '../src/core/verse/fleet-order-state-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/1';
const owners = async (jobs: OrderTraceV1['orders'][number]['jobs']) => {
  const trace: OrderTraceV1 = {
    v: 1, generatedAt: NOW.toISOString(), sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
    orders: [{ at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs }],
  };
  const api = createFleetOrderStateApi({
    read: async () => trace, now: () => NOW,
    live: async () => ({ sourceState: 'healthy', workers: [], generatedAt: NOW.toISOString() }) as never,
  });
  let text = '';
  const res = { writeHead() { return this; }, end(b: string) { text = b; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url: ORDERS } as IncomingMessage, res, ORDERS, 'GET');
  return JSON.parse(text).orders[0].owner;
};

describe('order owner', () => {
  it('names job and lane for a merged job', async () => {
    expect(await owners([{ id: 'RQ-PHX-FAKEA1', lane: 'devin', state: 'merged', url: PR }])).toEqual({ job: 'RQ-PHX-FAKEA1', lane: 'devin' });
  });
  it('drops owner for unsafe job ids', async () => {
    expect(await owners([{ id: '../etc', lane: 'devin', state: 'merged', url: PR }])).toBeNull();
    expect(await owners([{ id: 'RQ-PHX FAKE', lane: 'devin', state: 'merged', url: PR }])).toBeNull();
  });
  it('nulls an unsafe lane but keeps the job', async () => {
    expect(await owners([{ id: 'RQ-PHX-FAKEA1', lane: 'Dev/in', state: 'merged', url: PR }])).toEqual({ job: 'RQ-PHX-FAKEA1', lane: null });
    expect(await owners([{ id: 'RQ-PHX-FAKEA1', lane: null, state: 'merged', url: PR }])).toEqual({ job: 'RQ-PHX-FAKEA1', lane: null });
  });
  it('is null with no jobs', async () => {
    expect(await owners([])).toBeNull();
  });
});
