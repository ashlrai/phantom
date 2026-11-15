/**
 * RQ-PHX-ORDERMCPRECONNECT365S — same-session recovery qualification for
 * fleet_order_state: ONE MCP connection carrying sequential calls through the
 * REAL readFleetOrderState behind the orderState seam, with mutable hermetic
 * trace/live readers and a controllable clock (never precomputed responses).
 * The answer must track reader health — unavailable evidence, then ASSIGNED,
 * then RUNNING, then ASSIGNED again — with refreshed asOf/evidenceSource, no
 * cached RUNNING, preserved order key/source, no error-text/path/pid/
 * command-line disclosure, and a connection that stays usable throughout.
 * A timed-out read resolving late must never replace a later fresh answer.
 * Hermetic: no host files, processes, network or real sleeps.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const T0 = Date.parse('2026-11-14T14:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const JOB = 'RQ-PHX-FAKE365S';
const ORDER = { at: '2026-11-13 22:29 ET', source: 'mason', key: '11-13 22:29' } as const;
/** 22:29 ET on 2026-11-13 is EST (UTC-5): the receivedAt evidence stamp. */
const RECEIVED_AT = '2026-11-14T03:29:00.000Z';
const LAUNCHED: OrderTraceJob = { id: JOB, lane: 'devin', state: 'launched', url: null };

const traceWith = (jobs: OrderTraceJob[], generatedAt: string): OrderTraceV1 => ({
  v: 1,
  generatedAt,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [{ ...ORDER, jobs }],
});

const liveSnap = (jobIds: string[], generatedAt: string): LiveWorkersSnapshot => ({
  v: 1,
  generatedAt,
  sourceState: 'healthy',
  workers: jobIds.map((job, i) => ({ pid: 4100 + i, job, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 45 })),
  leaders: [],
  orchestratorAgents: 0,
});

type TraceRead = (opts: { now?: () => number }) => Promise<OrderTraceV1>;
type LiveRead = () => Promise<LiveWorkersSnapshot>;

/** The orderState seam wired to the REAL readFleetOrderState: mutable hermetic
 * readers plus an injected clock, so every call re-reads whatever the fakes
 * currently report — exactly like the production readers re-reading disk and
 * the process table, minus the host. */
function orderReaders(now: () => number, timeoutMs?: number) {
  const calls = { trace: 0, live: 0 };
  let traceImpl: TraceRead = async () => { throw new Error('trace reader not configured'); };
  let liveImpl: LiveRead = async () => { throw new Error('live reader not configured'); };
  const orderState = (args: { sinceHours?: unknown }) => readFleetOrderState({
    sinceHours: args.sinceHours,
    read: (opts) => { calls.trace += 1; return traceImpl(opts); },
    live: () => { calls.live += 1; return liveImpl(); },
    now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return {
    calls,
    orderState,
    setTrace: (fn: TraceRead) => { traceImpl = fn; },
    setLive: (fn: LiveRead) => { liveImpl = fn; },
  };
}

interface OrderRow {
  at: string; source: string; key: string;
  state: string; asOf: string; evidenceSource: string;
  missing: string[]; pr: string | null;
  owner: { job: string; lane: string | null } | null;
}
interface OrderBody {
  v: number; asOf: string; generatedAt?: string;
  sources: unknown; live?: string; orders: OrderRow[];
  status?: string; reason?: string;
}

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(orderState: (args: { sinceHours?: unknown }) => Promise<unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), orderState });
  const client = new Client({ name: 'order-recovery-365s', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callOrder(client: Client) {
  const result = await client.callTool({ name: 'fleet_order_state', arguments: {} });
  const raw = (result.content as Array<{ text: string }>)[0]!.text;
  return { isError: result.isError === true, raw, body: JSON.parse(raw) as OrderBody };
}

/** Strings a hostile reader failure might try to smuggle across the boundary:
 * home paths, pids, command lines and thrown message text. */
const HOSTILE = [
  '/Users/fakeuser', 'pid=4123', '/bin/launch.sh', 'inbox.jsonl', 'blew up',
  'pid=8877', '/bin/ps', 'etime', 'exec failed',
];

describe('fleet_order_state same-session recovery', () => {
  it('answers unavailable, then ASSIGNED, RUNNING, ASSIGNED on one connection as readers heal', async () => {
    let nowMs = T0;
    const rig = orderReaders(() => nowMs);
    const client = await connect(rig.orderState);

    // 1. Trace read throws: unavailable evidence; the live reader is never invoked.
    rig.setTrace(async () => {
      throw new Error('readOrderTrace blew up at /Users/fakeuser/.ashlr-runs/inbox.jsonl pid=4123 cmd=/bin/launch.sh');
    });
    rig.setLive(async () => liveSnap([JOB], iso(nowMs)));
    const r1 = await callOrder(client);
    expect(r1.isError).toBe(false);
    expect(r1.body).toEqual({ v: 1, asOf: iso(nowMs), sources: 'unavailable', live: 'unavailable', orders: [] });
    expect(rig.calls).toEqual({ trace: 1, live: 0 });

    // 2. Trace healthy with a launched job, live read throws: ASSIGNED, live unavailable.
    nowMs += 60_000;
    rig.setTrace(async (opts) => traceWith([LAUNCHED], iso(opts.now?.() ?? nowMs)));
    rig.setLive(async () => {
      throw new Error('ps exec failed /Users/fakeuser/bin/ps pid=8877 /bin/ps -axo pid=,etime=,command=');
    });
    const r2 = await callOrder(client);
    expect(r2.body.asOf).toBe(iso(nowMs));
    expect(r2.body.generatedAt).toBe(iso(nowMs));
    expect(r2.body.live).toBe('unavailable');
    expect(r2.body.sources).toEqual({ inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' });
    expect(r2.body.orders).toHaveLength(1);
    expect(r2.body.orders[0]).toMatchObject({
      at: ORDER.at, source: ORDER.source, key: ORDER.key,
      state: 'ASSIGNED', asOf: RECEIVED_AT, evidenceSource: `claim:${JOB}`,
      pr: null, owner: { job: JOB, lane: 'devin' },
    });
    expect(rig.calls).toEqual({ trace: 2, live: 1 });

    // 3. Live snapshot names the launched job: RUNNING on refreshed evidence.
    nowMs += 60_000;
    rig.setLive(async () => liveSnap([JOB], iso(nowMs)));
    const r3 = await callOrder(client);
    expect(r3.body.live).toBe('healthy');
    expect(r3.body.orders[0]).toMatchObject({
      state: 'RUNNING', evidenceSource: `live-worker ${JOB}`,
      asOf: iso(nowMs), key: ORDER.key, source: ORDER.source,
      owner: { job: JOB, lane: 'devin' },
    });
    expect(rig.calls).toEqual({ trace: 3, live: 2 });

    // 4. Live healthy but the job is gone: ASSIGNED again — RUNNING was never cached.
    nowMs += 60_000;
    rig.setLive(async () => liveSnap([], iso(nowMs)));
    const r4 = await callOrder(client);
    expect(r4.body.live).toBe('healthy');
    expect(r4.body.orders[0]).toMatchObject({
      state: 'ASSIGNED', evidenceSource: `claim:${JOB}`, asOf: RECEIVED_AT,
      key: ORDER.key, source: ORDER.source, owner: { job: JOB, lane: 'devin' },
    });
    expect(rig.calls).toEqual({ trace: 4, live: 3 });

    // Every answer carried a fresh clock stamp, and order identity never moved.
    expect([r1, r2, r3, r4].map(r => r.body.asOf))
      .toEqual([iso(T0), iso(T0 + 60_000), iso(T0 + 120_000), iso(T0 + 180_000)]);
    for (const row of [r2.body.orders[0]!, r3.body.orders[0]!, r4.body.orders[0]!]) {
      expect(row.key).toBe(ORDER.key);
      expect(row.source).toBe(ORDER.source);
      expect(row.at).toBe(ORDER.at);
      expect(row.owner).toEqual({ job: JOB, lane: 'devin' });
    }
    // No thrown text, home path, pid or command line crossed the boundary.
    for (const raw of [r1.raw, r2.raw, r3.raw, r4.raw]) {
      for (const bad of HOSTILE) expect(raw).not.toContain(bad);
    }
    // The same connection still serves other tools after the recovery sequence.
    const { tools } = await client.listTools();
    expect(tools.some(t => t.name === 'fleet_order_state')).toBe(true);
  });

  it('a timed-out read resolving late never replaces a later fresh answer', async () => {
    let nowMs = T0;
    const rig = orderReaders(() => nowMs, 50);
    const client = await connect(rig.orderState);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // The trace read stays pending until released — the orphaned read behind
    // the per-reader bound. The live reader is healthy throughout.
    let releaseStale!: (trace: OrderTraceV1) => void;
    const staleGate = new Promise<OrderTraceV1>((resolve) => { releaseStale = resolve; });
    rig.setTrace(() => staleGate);
    rig.setLive(async () => liveSnap([], iso(nowMs)));

    const pending = client.callTool({ name: 'fleet_order_state', arguments: {} });
    // Let the in-process transport deliver the request so the bounded read is
    // parked on its 50 ms timer, then fire that timer with fake time.
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(60);
    const timedOut = await pending;
    const timedOutBody = JSON.parse((timedOut.content as Array<{ text: string }>)[0]!.text) as OrderBody;
    expect(timedOut.isError).toBeFalsy();
    expect(timedOutBody).toEqual({ v: 1, asOf: iso(nowMs), sources: 'unavailable', live: 'unavailable', orders: [] });
    expect(rig.calls).toEqual({ trace: 1, live: 0 });

    // Readers heal; a fresh call on the SAME connection answers RUNNING while
    // the stale read is still pending.
    nowMs += 60_000;
    rig.setTrace(async (opts) => traceWith([LAUNCHED], iso(opts.now?.() ?? nowMs)));
    rig.setLive(async () => liveSnap([JOB], iso(nowMs)));
    const fresh = await callOrder(client);
    expect(fresh.body.orders[0]).toMatchObject({ state: 'RUNNING', evidenceSource: `live-worker ${JOB}` });
    expect(rig.calls).toEqual({ trace: 2, live: 1 });

    // The orphaned read now resolves carrying a stale VERIFIED payload…
    releaseStale({
      v: 1,
      generatedAt: '2026-11-14T13:59:00.000Z',
      sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
      orders: [{
        at: '2026-01-01 00:00 ET', source: 'stale-fixture', key: '01-01 00:00',
        jobs: [{ id: 'RQ-PHX-STALE99', lane: 'devin', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/9999' }],
      }],
    });
    await new Promise((resolve) => setImmediate(resolve));

    // …and the next call still reflects the live readers, never the stale payload.
    const after = await callOrder(client);
    expect(rig.calls).toEqual({ trace: 3, live: 2 });
    expect(after.body.orders[0]).toMatchObject({
      state: 'RUNNING', key: ORDER.key, source: ORDER.source, evidenceSource: `live-worker ${JOB}`,
    });
    for (const bad of ['01-01 00:00', 'stale-fixture', 'RQ-PHX-STALE', '9999', '2026-11-14T13:59']) {
      expect(after.raw).not.toContain(bad);
    }
  });
});
