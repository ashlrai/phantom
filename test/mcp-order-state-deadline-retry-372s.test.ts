import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetOrderState, type FleetOrderStateDeps } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const now = '2026-11-14T10:00:00.000Z';
const bound = 50;
const oldJob = 'RQ-PHX-OLD';
const newJob = 'RQ-PHX-NEW';
const sources = { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' } as const;
const trace = (id: string, state: 'launched' | 'queued' = 'launched'): OrderTraceV1 => ({
  v: 1, generatedAt: now, sources,
  orders: [{ at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29',
    jobs: [{ id, lane: 'devin', state, url: null }] }],
});
const live = (id: string): LiveWorkersSnapshot => ({
  v: 1, generatedAt: now, sourceState: 'healthy',
  workers: [{ pid: 987654, job: id, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 }],
  leaders: [], orchestratorAgents: 0,
});
const lanes = (held = false): LaneTargetsV1 => ({
  v: 1, generatedAt: now, sourceState: 'healthy', lanes: [{ lane: 'devin', target: 1, floor: 0, ceiling: 4,
    held, heldReason: 'private-hold-reason', heldUntil: null, pausedFrom: null, lastChange: null, changedBy: null }],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
type Body = { sources: unknown; live: string; lanes?: string; orders: Array<{ state: string; owner: unknown; evidenceSource: string }> };
const connections: Array<{ client: Client; server: ReturnType<typeof createFleetServer> }> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { client, server } of connections.splice(0)) { await client.close(); await server.close(); }
});
async function connect(deps: FleetOrderStateDeps) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}),
    orderState: args => readFleetOrderState({ ...deps, ...args, timeoutMs: bound, now: () => Date.parse(now) }) });
  const client = new Client({ name: 'deadline-retry', version: '1.0.0' });
  connections.push({ client, server });
  await server.connect(st);
  await client.connect(ct);
  return client;
}
async function call(client: Client): Promise<Body> {
  const result = await client.callTool({ name: 'fleet_order_state', arguments: {} });
  const content = result.content as Array<{ text: string }>;
  const raw = content[0]!.text;
  for (const forbidden of ['987654', 'private-hold-reason', '/fake/path', 'private-order-body']) expect(raw).not.toContain(forbidden);
  return JSON.parse(raw) as Body;
}
async function timedCall(client: Client, started: Promise<void>) {
  const pending = call(client);
  await started;
  await vi.advanceTimersByTimeAsync(bound);
  return pending;
}

it('rechecks fresh trace on one MCP connection and ignores a late trace', async () => {
  const stale = deferred<OrderTraceV1>();
  const started = deferred<void>();
  let first = true;
  const client = await connect({ read: () => { if (first) { first = false; started.resolve(); return stale.promise; } return Promise.resolve(trace(newJob)); },
    live: async () => live(newJob), lanes: async () => lanes() });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const unavailable = await timedCall(client, started.promise);
  expect(unavailable).toMatchObject({ sources: 'unavailable', live: 'unavailable', orders: [] });
  const fresh = await call(client);
  expect(fresh).toMatchObject({ sources, live: 'healthy', lanes: 'healthy', orders: [{ state: 'RUNNING', owner: { job: newJob, lane: 'devin' }, evidenceSource: `live-worker ${newJob}` }] });
  stale.resolve(trace(oldJob));
  await Promise.resolve();
  const afterLate = await call(client);
  expect(afterLate).toEqual(fresh);
  expect(JSON.stringify(afterLate)).not.toContain(oldJob);
});

it('degrades a timed-out live read and retries with current live evidence', async () => {
  const delayed = deferred<LiveWorkersSnapshot>();
  const started = deferred<void>();
  let first = true;
  const client = await connect({ read: async () => trace(newJob), live: () => {
    if (first) { first = false; started.resolve(); return delayed.promise; } return Promise.resolve(live(newJob));
  }, lanes: async () => lanes() });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const unavailable = await timedCall(client, started.promise);
  expect(unavailable).toMatchObject({ sources, live: 'unavailable', lanes: 'healthy', orders: [{ state: 'ASSIGNED' }] });
  const fresh = await call(client);
  expect(fresh).toMatchObject({ sources, live: 'healthy', lanes: 'healthy', orders: [{ state: 'RUNNING', owner: { job: newJob, lane: 'devin' } }] });
  delayed.resolve(live(oldJob));
  expect(await call(client)).toEqual(fresh);
});

it('degrades a timed-out lane read and retries with current blocker evidence', async () => {
  const delayed = deferred<LaneTargetsV1>();
  const started = deferred<void>();
  let first = true;
  const client = await connect({ read: async () => trace(newJob, 'queued'), live: async () => live(newJob), lanes: () => {
    if (first) { first = false; started.resolve(); return delayed.promise; } return Promise.resolve(lanes(true));
  } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const unavailable = await timedCall(client, started.promise);
  expect(unavailable).toMatchObject({ sources, live: 'healthy', lanes: 'unavailable', orders: [{ state: 'RECEIVED' }] });
  const fresh = await call(client);
  expect(fresh).toMatchObject({ sources, live: 'healthy', lanes: 'healthy', orders: [{ state: 'BLOCKED', owner: { job: newJob, lane: 'devin' } }] });
  delayed.resolve(lanes());
  expect(await call(client)).toEqual(fresh);
});
