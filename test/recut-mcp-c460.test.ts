/**
 * RQ-PHX-RECUTMCPC460 — recut of #5696 (RQ-PHX-ORDERMCPLANES369): the
 * fleet_order_state MCP tool surfaces held-lane evidence to MCP-only agents.
 * A queued order whose every job sits on a held lane answers BLOCKED with a
 * sanitized lane dependency and lanes 'healthy'; a lane read that throws
 * leaves lanes 'unavailable', blocker null and no BLOCKED claim — hold
 * reasons, held_by attribution and thrown paths never cross the tool
 * boundary. Exercises the real MCP tool handler over InMemoryTransport with
 * the real readFleetOrderState reader; only trace, live and lanes readers
 * are injected, so no real ~/.ashlr-runs, process table or home is read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const LANES_AT = '2026-11-14T09:59:30.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const SENTINEL = 'SENTINEL-private-hold-reason';
const NAME = 'fleet_order_state';

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const order = (key: string, jobs: OrderTraceJob[]): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key, jobs });

const job = (id: string, state: OrderTraceJob['state'], lane: string | null): OrderTraceJob =>
  ({ id, lane, state, url: null });

const laneRow = (over: Partial<LaneTargetRow> & { lane: string }): LaneTargetRow => ({
  target: 2, floor: 0, ceiling: 4, held: false, heldReason: null, heldUntil: null,
  pausedFrom: null, lastChange: null, changedBy: null, ...over,
});
const lanes = (rows: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 => ({
  v: 1, generatedAt: LANES_AT, sourceState, lanes: rows,
});
const held = (lane: string) => laneRow({ lane, held: true, heldReason: SENTINEL, heldUntil: HELD_UNTIL, changedBy: SENTINEL });

const liveSnap = (jobIds: string[] = []): LiveWorkersSnapshot => ({
  v: 1, generatedAt: NOW.toISOString(), sourceState: 'healthy',
  workers: jobIds.map((job, i) => ({ pid: 100 + i, job, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 })),
  leaders: [], orchestratorAgents: 0,
});

interface Body { v: number; asOf: string; live?: string; lanes?: string; sources: unknown; orders: Array<Record<string, unknown>> }

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
});

/** Real tool handler end to end: createFleetServer dispatch + argument
 * parsing + the real readFleetOrderState, with only I/O readers injected. */
async function connect(deps: Pick<Parameters<typeof readFleetOrderState>[0], 'read' | 'live' | 'lanes'>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    orderState: (a) => readFleetOrderState({ ...deps, now: () => NOW.getTime(), sinceHours: a.sinceHours }),
  });
  const client = new Client({ name: 'recut-mcp-c460', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe('fleet_order_state MCP tool — held lanes (recut c460)', () => {
  it('a queued order with every job on a held lane reports BLOCKED through the real tool, sanitized', async () => {
    const t = trace([
      order('11-13 22:29', [job('RQ-PHX-HELD1', 'queued', 'codex-personal'), job('RQ-PHX-HELD2', 'queued', 'codex-personal')]),
    ]);
    const client = await connect({
      read: async () => t,
      live: async () => liveSnap(),
      lanes: async () => lanes([held('codex-personal')]),
    });
    const result = await client.callTool({ name: NAME, arguments: {} });
    const body = JSON.parse(text(result)) as Body;
    expect(body.lanes).toBe('healthy');
    const o = body.orders[0]!;
    expect(o.state).toBe('BLOCKED');
    expect(o.evidenceSource).toBe('slots.json');
    expect(o.asOf).toBe(LANES_AT);
    expect(o.blocker).toBe(`lane codex-personal held until ${HELD_UNTIL}`);
    const raw = text(result);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('heldReason');
    expect(raw).not.toContain('changedBy');
  });

  it('a throwing lane read leaves lanes unavailable, blocker null and no BLOCKED, leaking nothing', async () => {
    const t = trace([order('held', [job('RQ-PHX-HELD4', 'queued', 'codex-personal')])]);
    const client = await connect({
      read: async () => t,
      live: async () => liveSnap(),
      lanes: async (): Promise<LaneTargetsV1> => { throw new Error(`boom ${SENTINEL} /Users/fakehome/secret`); },
    });
    const result = await client.callTool({ name: NAME, arguments: {} });
    const body = JSON.parse(text(result)) as Body;
    expect(body.lanes).toBe('unavailable');
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.state).not.toBe('BLOCKED');
    expect(body.orders[0]!.blocker).toBeNull();
    const raw = text(result);
    expect(raw).not.toContain(SENTINEL);
    expect(raw).not.toContain('fakehome');
  });
});
