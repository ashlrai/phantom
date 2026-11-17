import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const AT = '2026-11-14T10:00:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/3651';
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(trace: OrderTraceV1) {
  const read = vi.fn(async () => trace);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}), loop: async () => ({}),
    orderState: args => readFleetOrderState({
      ...args, read, now: () => Date.parse(AT),
      live: async () => ({ v: 1, generatedAt: AT, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
      lanes: async () => ({ v: 1, generatedAt: AT, sourceState: 'healthy', lanes: [] }),
    }),
  });
  const client = new Client({ name: 'recut-c381', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, read };
}

const trace = (): OrderTraceV1 => ({
  v: 1, generatedAt: AT,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs: [
    { id: 'RQ-UNRELATED', lane: 'claude', state: 'merged', url: 'https://example.test/artifact' },
    { id: 'RQ-VERIFYING', lane: 'devin', state: 'merged', url: PR },
  ] }],
});

describe('C381 artifact preservation through fleet MCP', () => {
  it('binds owner and PR to the same verifying job despite an earlier non-PR sibling', async () => {
    const { client } = await connect(trace());
    const result = await client.callTool({ name: 'fleet_order_state', arguments: {} });
    expect(result.isError).not.toBe(true);
    const raw = (result.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(raw).orders).toEqual([{
      at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29',
      state: 'VERIFIED', asOf: AT, evidenceSource: 'order-trace', missing: [],
      blocker: null, pr: PR, owner: { job: 'RQ-VERIFYING', lane: 'devin' },
    }]);
    expect(raw).not.toContain('RQ-UNRELATED');
    expect(raw).not.toContain('https://example.test/artifact');
  });

  it('rejects caller paths before reaching the trace reader', async () => {
    const { client, read } = await connect(trace());
    await expect(client.callTool({ name: 'fleet_order_state', arguments: { root: '/fake/c381' } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(read).not.toHaveBeenCalled();
  });
});
