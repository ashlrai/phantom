/**
 * RQ-PHX-ORDERMCPARTIFACT365 — fleet_order_state must return the PR artifact
 * that actually proves VERIFIED. A first merged sibling carrying a non-PR
 * url used to win `mostAdvancedJob`, so an agent could read VERIFIED next to
 * an unrelated url. The MCP projection now binds `pr` to the same merged
 * github pull artifact orderEvidence verifies on. Hermetic: fake trace and
 * live readers only, reached through createFleetServer + InMemoryTransport
 * into the real readFleetOrderState — never reads ~/.ashlr-runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const PR_A = 'https://github.com/ashlrai/phantom/pull/3651';
const PR_B = 'https://github.com/ashlrai/phantom/pull/3652';
const NON_PR = 'https://example.test/artifacts/build-3651';
const NAME = 'fleet_order_state';

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
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

const order = (jobs: OrderTraceJob[], key = '11-13 22:29'): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key, jobs });

const job = (id: string, state: OrderTraceJob['state'], url: string | null = null, lane = 'devin'): OrderTraceJob =>
  ({ id, lane, state, url });

interface Row { state: string; pr: string | null; key: string; missing: string[] }
interface Body { v: number; asOf: string; live?: string; sources: unknown; orders: Row[] }
const rowKeys = ['at', 'source', 'key', 'state', 'asOf', 'evidenceSource', 'missing', 'pr'];

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map((c) => c.close()));
});

/** The real readFleetOrderState behind the MCP tool seam, fed hermetic
 * trace/live readers — the implementation under test, not a stub. */
async function connect(t: OrderTraceV1, live: LiveWorkersSnapshot) {
  const read = vi.fn(async () => t);
  const liveRead = vi.fn(async () => live);
  const orderState: FleetReaders['orderState'] = (args) =>
    readFleetOrderState({ ...args, read, live: liveRead, now: () => NOW.getTime() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), orderState });
  const client = new Client({ name: 'order-artifact-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, read, liveRead };
}

async function callOrderState(t: OrderTraceV1, live: LiveWorkersSnapshot = liveSnap()): Promise<{ body: Body; raw: string; read: ReturnType<typeof vi.fn>; liveRead: ReturnType<typeof vi.fn> }> {
  const { client, read, liveRead } = await connect(t, live);
  const result = await client.callTool({ name: NAME, arguments: {} });
  const raw = (result as { content: Array<{ text: string }> }).content[0]!.text;
  return { body: JSON.parse(raw) as Body, raw, read, liveRead };
}

describe('fleet_order_state VERIFIED artifact binding', () => {
  it('a merged sibling with a non-PR url cannot stand in for the verifying PR', async () => {
    const t = trace([order([
      job('RQ-PHX-FAKEA1', 'merged', NON_PR),
      job('RQ-PHX-FAKEA1B', 'merged', PR_A),
    ])]);
    const { body, raw, read, liveRead } = await callOrderState(t);
    expect(body.orders[0]).toMatchObject({ state: 'VERIFIED', pr: PR_A });
    expect(raw).not.toContain(NON_PR);
    expect(read).toHaveBeenCalledTimes(1);
    expect(liveRead).toHaveBeenCalledTimes(1);
  });

  it('two valid merged artifacts: the first in trace order wins', async () => {
    const t = trace([order([
      job('RQ-PHX-FAKEB1', 'merged', PR_A),
      job('RQ-PHX-FAKEB1B', 'merged', PR_B),
    ])]);
    const { body } = await callOrderState(t);
    expect(body.orders[0]).toMatchObject({ state: 'VERIFIED', pr: PR_A });
  });

  it('no valid merged artifact is never VERIFIED', async () => {
    const t = trace([order([
      job('RQ-PHX-FAKEC1', 'merged', NON_PR),
      job('RQ-PHX-FAKEC1B', 'merged', 'https://github.com/ashlrai/phantom/issues/9'),
      job('RQ-PHX-FAKEC1C', 'merged', null),
    ])]);
    const { body } = await callOrderState(t);
    expect(body.orders[0]!.state).not.toBe('VERIFIED');
    // Non-verified rows keep the existing most-advanced-job url behavior.
    expect(body.orders[0]!.pr).toBe(NON_PR);
  });

  it('a live launched sibling without merged proof stays RUNNING with its own url', async () => {
    const t = trace([order([
      job('RQ-PHX-FAKED1', 'merged', NON_PR),
      job('RQ-PHX-FAKED1B', 'launched', null),
    ])]);
    const { body } = await callOrderState(t, liveSnap(['RQ-PHX-FAKED1B']));
    expect(body.orders[0]).toMatchObject({ state: 'RUNNING', pr: NON_PR });
  });

  it('output rows carry only the sanitized public fields', async () => {
    const t = trace([order([job('RQ-PHX-FAKEE1', 'merged', PR_A)])]);
    const { body, raw } = await callOrderState(t);
    const row = body.orders[0]!;
    expect(Object.keys(row).sort()).toEqual([...rowKeys].sort());
    expect(raw).not.toContain('/Users/');
    expect(raw).not.toContain('pid');
  });
});
