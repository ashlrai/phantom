/**
 * RQ-PHX-RECUTMCPC387, recut of RQ-PHX-ORDERMCPLANES369 — fleet_order_state lane holds for MCP-only agents:
 * a queued order whose every job sits on a held lane reports BLOCKED with a
 * sanitized lane dependency and lanes 'healthy', exactly like the desktop
 * orders API; a mixed sibling keeps its own state; a throwing, non-'healthy'
 * or timed-out lane read claims no BLOCKED, emits blocker null and leaks
 * nothing. Every reader is injected — no real ~/.ashlr-runs, process table
 * or home is read.
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const LANES_AT = '2026-11-14T09:59:30.000Z';
const LIVE_AT = '2026-11-14T09:59:45.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const SENTINEL = 'SENTINEL-private-hold-reason';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null, url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const order = (key: string, jobs: OrderTraceJob[]): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key, jobs });

const laneRow = (over: Partial<LaneTargetRow> & { lane: string }): LaneTargetRow => ({
  target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...over,
});
const lanes = (rows: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({
  v: 1, generatedAt: LANES_AT, sourceState, lanes: rows,
});
const held = (lane: string) => laneRow({ lane, held: true, heldReason: SENTINEL, heldUntil: HELD_UNTIL, changedBy: SENTINEL });

const liveSnap = (jobIds: string[] = []): LiveWorkersSnapshot => ({
  v: 1, generatedAt: LIVE_AT, sourceState: 'healthy',
  workers: jobIds.map((j, i) => ({ pid: 7000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 })),
  leaders: [], orchestratorAgents: 0,
});

interface Body { v: number; asOf: string; live?: string; lanes?: string; sources: unknown; orders: Array<Record<string, unknown>> }
// Exercise every scenario through the real MCP handler and JSON serialization.
// Retain master's stable blocker:null wire contract when lanes are unavailable.
async function call(deps: Parameters<typeof readFleetOrderState>[0]): Promise<Body> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}), loop: async () => ({}),
    orderState: args => readFleetOrderState({ now: () => NOW.getTime(), live: async () => liveSnap(), ...deps, ...args }),
  });
  const client = new Client({ name: 'recut-mcp-c387', version: '1.0.0' });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: 'fleet_order_state', arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0]!.text) as Body;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('fleet_order_state — held lanes', () => {
  it('a queued order with every job on a held lane reports BLOCKED with a sanitized dependency', async () => {
    const t = trace([
      order('11-13 22:29', [job('RQ-PHX-HELD1', 'queued', 'codex-personal'), job('RQ-PHX-HELD2', 'queued', 'codex-personal')]),
    ]);
    const body = await call({ read: async () => t, lanes: async () => lanes([held('codex-personal')]) });
    expect(body.lanes).toBe('healthy');
    const o = body.orders[0]!;
    expect(o.state).toBe('BLOCKED');
    expect(o.evidenceSource).toBe('slots.json');
    expect(o.asOf).toBe(LANES_AT);
    expect(o.blocker).toBe(`lane codex-personal held until ${HELD_UNTIL}`);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('heldReason');
    expect(raw).not.toContain('changedBy');
  });

  it('re-reads lanes on every call: releasing the hold clears a stale BLOCKED', async () => {
    const t = trace([order('held', [job('RQ-PHX-HELD3', 'queued', 'codex-personal')])]);
    let heldNow = true;
    const lanesRead = vi.fn(async () => lanes([laneRow({ lane: 'codex-personal', held: heldNow, heldReason: heldNow ? SENTINEL : null, heldUntil: heldNow ? HELD_UNTIL : null })]));
    const deps = { read: async () => t, lanes: lanesRead };
    const first = await call(deps);
    expect(first.lanes).toBe('healthy');
    expect(first.orders[0]!.state).toBe('BLOCKED');
    expect(first.orders[0]!.blocker).toContain('lane codex-personal held');
    heldNow = false;
    const second = await call(deps);
    expect(lanesRead).toHaveBeenCalledTimes(2);
    expect(second.lanes).toBe('healthy');
    expect(second.orders[0]!.state).not.toBe('BLOCKED');
    expect(second.orders[0]!.blocker).toBeNull();
  });

  it('mixed siblings do not block: a queued job on an unheld lane keeps the order unblocked with blocker null', async () => {
    const t = trace([
      order('mixed', [job('RQ-PHX-MIX1', 'queued', 'codex-personal'), job('RQ-PHX-MIX2', 'queued', 'devin')]),
    ]);
    const body = await call({
      read: async () => t,
      lanes: async () => lanes([held('codex-personal'), laneRow({ lane: 'devin' })]),
    });
    expect(body.lanes).toBe('healthy');
    const o = body.orders[0]!;
    expect(o.state).not.toBe('BLOCKED');
    expect(o.blocker).toBeNull();
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
  });

  it.each([
    ['throws', async (): Promise<LaneTargetsV1> => { throw new Error(`boom ${SENTINEL} /Users/fakehome/secret`); }],
    ['reports degraded', async () => lanes([held('codex-personal')], 'degraded')],
    ['reports missing', async () => lanes([held('codex-personal')], 'missing')],
  ])('a lane read that %s yields lanes unavailable, blocker null and no BLOCKED', async (_kind, lanesRead) => {
    const t = trace([order('held', [job('RQ-PHX-HELD4', 'queued', 'codex-personal')])]);
    const body = await call({ read: async () => t, lanes: lanesRead });
    expect(body.lanes).toBe('unavailable');
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.state).not.toBe('BLOCKED');
    expect(body.orders[0]!.blocker).toBeNull();
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('fakehome');
  });

  it('a lane read that hangs past timeoutMs yields lanes unavailable and still resolves', async () => {
    const t = trace([order('held', [job('RQ-PHX-HELD5', 'queued', 'codex-personal')])]);
    const body = await call({
      read: async () => t,
      lanes: () => new Promise<LaneTargetsV1>(() => {}),
      timeoutMs: 20,
    });
    expect(body.lanes).toBe('unavailable');
    expect(body.orders[0]!.state).not.toBe('BLOCKED');
    expect(body.orders[0]!.blocker).toBeNull();
  });

  it('a throwing lane read preserves rows and live evidence, then recovers', async () => {
    const t = trace([
      order('held', [job('RQ-PHX-HELD6', 'queued', 'codex-personal')]),
      order('live', [job('RQ-PHX-LIVE1', 'launched', 'devin')]),
    ]);
    let fail = true;
    const lanesRead = vi.fn(async () => {
      if (fail) throw new Error(`boom ${SENTINEL}`);
      return lanes([held('codex-personal')]);
    });
    const deps = { read: async () => t, live: async () => liveSnap(['RQ-PHX-LIVE1']), lanes: lanesRead };
    const bad = await call(deps);
    expect(bad.lanes).toBe('unavailable');
    expect(bad.orders.map((o) => o.key)).toEqual(['held', 'live']);
    expect(bad.orders[0]!.state).not.toBe('BLOCKED');
    expect(bad.orders[0]!.blocker).toBeNull();
    expect(bad.orders[1]!.state).toBe('RUNNING');
    expect(bad.orders[1]!.evidenceSource).toBe('live-worker RQ-PHX-LIVE1');
    fail = false;
    const good = await call(deps);
    expect(good.lanes).toBe('healthy');
    expect(good.orders[0]!.state).toBe('BLOCKED');
    expect(lanesRead).toHaveBeenCalledTimes(2);
  });

  it('a trace read that throws reports unavailable and never invokes the live or lanes readers', async () => {
    const live = vi.fn(async () => liveSnap());
    const lanesRead = vi.fn(async () => lanes([held('codex-personal')]));
    const body = await call({
      read: async () => { throw new Error('boom /Users/example/secret'); },
      live,
      lanes: lanesRead,
    });
    expect(body).toEqual({ v: 1, asOf: NOW.toISOString(), sources: 'unavailable', live: 'unavailable', lanes: 'unavailable', orders: [] });
    expect(lanesRead).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
  });
});
