/**
 * RQ-PHX-ORDERSTATEMCPTOOL364 — fleet_order_state: read-only MCP projection of
 * `ashlr fleet order-state --json`, the same order states Mason sees
 * (RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED) over the isolated
 * fleet server. Hermetic: fake trace and live readers only — never reads
 * ~/.ashlr-runs or the real process table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR = 'https://github.com/ashlrai/phantom/pull/1';
const NAME = 'fleet_order_state';

const trace = (orders: OrderTraceV1['orders'] = []): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const liveSnap = (jobIds: string[] = []): LiveWorkersSnapshot => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sourceState: 'healthy',
  workers: jobIds.map((job, i) => ({ pid: 100 + i, job, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 })),
  leaders: [],
  orchestratorAgents: 0,
});

const unavailableSnap = (): LiveWorkersSnapshot => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'unavailable', workers: [], leaders: [], orchestratorAgents: 0,
});

const order = (jobs: OrderTraceV1['orders'][number]['jobs']): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29', jobs });

interface Body { v: number; asOf: string; live?: string; sources: unknown; orders: Array<Record<string, unknown>>; status?: string; reason?: string }
const call = (deps: Parameters<typeof readFleetOrderState>[0] = {}): Promise<Body> =>
  readFleetOrderState({ now: () => NOW.getTime(), ...deps }) as Promise<Body>;

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'order-state-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe('readFleetOrderState', () => {
  it('a merged job with a github pull URL gives VERIFIED with the pr url', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEA1', lane: 'claude', state: 'merged', url: PR }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), asOf: NOW.toISOString(), live: 'healthy' });
    expect(body.orders[0]).toMatchObject({ key: '11-13 22:29', state: 'VERIFIED', pr: PR, missing: [] });
  });

  it('a launched job the live snapshot names gives RUNNING', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEB2', lane: 'devin', state: 'launched', url: null }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap(['RQ-PHX-FAKEB2']) });
    expect(body.live).toBe('healthy');
    expect(body.orders[0]).toMatchObject({ state: 'RUNNING', evidenceSource: 'live-worker RQ-PHX-FAKEB2', missing: [] });
  });

  it('the same launched job with live unavailable gives ASSIGNED and live "unavailable"', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEB2', lane: 'devin', state: 'launched', url: null }])]);
    const body = await call({ read: async () => t, live: async () => unavailableSnap() });
    expect(body.live).toBe('unavailable');
    expect(body.orders[0]).toMatchObject({ state: 'ASSIGNED', evidenceSource: 'claim:RQ-PHX-FAKEB2' });
  });

  it('a queued-only order gives RECEIVED and missing names the durable claim receipt', async () => {
    const t = trace([order([{ id: 'RQ-PHX-FAKEC3', lane: 'devin', state: 'queued', url: null }])]);
    const body = await call({ read: async () => t, live: async () => liveSnap() });
    expect(body.orders[0]).toMatchObject({ state: 'RECEIVED' });
    expect(body.orders[0]!.missing).toContain('durable claim receipt');
  });

  it('a trace read that throws reports unavailable without the thrown text or path', async () => {
    const live = vi.fn(async () => liveSnap());
    const body = await call({
      read: async () => { throw new Error('boom /Users/example/secret'); },
      live,
    });
    expect(body).toEqual({ v: 1, asOf: NOW.toISOString(), sources: 'unavailable', live: 'unavailable', orders: [] });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('/Users/example/secret');
    expect(serialized).not.toContain('boom');
  });

  it.each([0, 721, '3'])('sinceHours %s gives status invalid and reads nothing', async (sinceHours) => {
    const read = vi.fn(async () => trace());
    const live = vi.fn(async () => liveSnap());
    const body = await call({ sinceHours, read, live });
    expect(body.status).toBe('invalid');
    expect(typeof body.reason).toBe('string');
    expect(read).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });

  it('sinceHours windows the orders like the API', async () => {
    const t = trace([
      { at: '2026-11-14 09:00 ET', source: 'mason', key: '11-14 09:00', jobs: [] },
      { at: '2026-10-01 09:00 ET', source: 'mason', key: '10-01 09:00', jobs: [] },
    ]);
    const body = await call({ sinceHours: 24, read: async () => t, live: async () => liveSnap() });
    expect(body.orders.map((o) => o.key)).toEqual(['11-14 09:00']);
  });
});

describe('fleet_order_state MCP tool', () => {
  it('is listed with an optional sinceHours and no required args', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === NAME);
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({
      properties: { sinceHours: { type: 'integer', minimum: 1, maximum: 720 } },
      additionalProperties: false,
    });
    expect((tool!.inputSchema as { required?: string[] }).required ?? []).toEqual([]);
    expect(tool!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it('dispatches the reader seam with the parsed args', async () => {
    const orderState = vi.fn(async (a: { sinceHours?: unknown }) => ({ v: 1, echo: a.sinceHours }));
    const result = await (await connect({ orderState })).callTool({ name: NAME, arguments: { sinceHours: 24 } });
    expect(orderState).toHaveBeenCalledWith({ sinceHours: 24 });
    expect(JSON.parse(text(result))).toEqual({ v: 1, echo: 24 });
  });

  it('refuses a caller root, path or cwd', async () => {
    const client = await connect({ orderState: async () => ({}) });
    for (const args of [{ root: '/tmp' }, { path: '/tmp/x' }, { cwd: '.' }, { sinceHours: 1, root: '/tmp' }]) {
      await expect(client.callTool({ name: NAME, arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });
});
