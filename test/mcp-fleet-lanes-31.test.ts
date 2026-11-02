/**
 * RQ-PHX-MCPFLEETLANES31 — fleet_lanes: a read-only MCP view of persisted
 * per-lane posture so an agent can answer which lanes are held, by whom,
 * why, until when, and how much usage each has left (the Oct 31 gap: the
 * planner could not tell codex-personal was held with 100% usage available).
 *
 * Hermetic: in-memory MCP transports and injected readers; no fleet stores,
 * daemon, transport, or provider calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { MAX_FLEET_LANES, readFleetLanes } from '../src/mcp/fleet-lanes.js';
import type { FleetRunsDirState, FleetRunsLane } from '../src/core/fleet/runs-dir-state.js';
import type { LaneTargetRow, LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
});

async function connect(lanes?: FleetReaders['lanes']) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), lanes });
  const client = new Client({ name: 'fleet-lanes-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callLanes(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_lanes', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text };
}

const NOW = '2026-10-31T20:00:00.000Z';

function slotRow(overrides: Partial<LaneTargetRow> = {}): LaneTargetRow {
  return { lane: 'codex-personal', target: 2, floor: 0, ceiling: 4, held: false,
    heldReason: null, heldUntil: null, pausedFrom: null, lastChange: NOW, changedBy: null, ...overrides };
}
function laneTargets(lanes: LaneTargetRow[], sourceState: LaneTargetsV1['sourceState'] = 'healthy'): LaneTargetsV1 {
  return { v: 1, generatedAt: NOW, sourceState, lanes };
}
function runRow(overrides: Partial<FleetRunsLane> = {}): FleetRunsLane {
  return { lane: 'codex-personal', running: 1, target: 2, floor: 0, ceiling: 4,
    queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null, ...overrides };
}
function runsState(lanes: FleetRunsLane[], sourceState: FleetRunsDirState['sourceState'] = 'healthy'): FleetRunsDirState {
  return { v: 1, generatedAt: NOW, runsDirPresent: true, sourceState,
    sources: { status: sourceState, claimed: 'healthy', events: 'healthy', metrics: 'healthy', claudeLane: 'healthy', switches: 'healthy', drop: 'healthy' },
    lastTick: NOW, paused: null, memFreePct: null, diskFreeGb: null,
    lanes, switches: [], claudeLane: null, publishesLastHour: [], events: [], claimed: [],
    drop: { pending: [], done: 0 } };
}
function budgetRow(overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow {
  return { lane: 'codex-personal', running: null, target: null, held: null, window: 'weekly',
    usedPct: null, creditsRemaining: null, resetAt: null, burnPctPerHour: null,
    tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null, ...overrides };
}
function ledger(lanes: ResourceLaneRow[], status: ResourceLedgerV1['sources']['status'] = 'healthy'): ResourceLedgerV1 {
  return { v: 1, generatedAt: NOW, sources: { status, apiSpend: 'missing', jobs: 'missing' },
    asOf: NOW, lanes, apiSpend: null, jobsMalformedRows: 0 };
}

describe('fleet_lanes MCP tool', () => {
  it('is listed beside the existing read-only tools with an empty schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([
      'fleet_status', 'fleet_loop', 'fleet_bus_hops', 'fleet_host_runs', 'fleet_bus_inbox', 'fleet_lanes',
    ]);
    const tool = tools.find(candidate => candidate.name === 'fleet_lanes');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('returns injected lane rows through the protocol', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', generatedAt: NOW,
      sourceState: 'healthy', lanes: [{ lane: 'codex-personal', running: 1, target: 2, held: true }],
    };
    const client = await connect(async () => payload);
    const { result, text } = await callLanes(client);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toEqual(payload);
  });

  it('joins lane targets, host runs and ledger rows into one row per lane', async () => {
    const lanes = () => readFleetLanes({
      laneTargets: async () => laneTargets([
        slotRow({ held: true, heldReason: 'manual pin', heldUntil: '2026-11-01T00:00:00Z', changedBy: 'mason 2026-10-31T19:30:00Z' }),
        slotRow({ lane: 'claude', target: 3, ceiling: 8 }),
      ]),
      hostRuns: async () => runsState([runRow(), runRow({ lane: 'claude', running: 2, target: 3 })]),
      resourceLedger: async () => ledger([
        budgetRow({ running: 1, target: 2, held: true, usedPct: 0, resetAt: '2026-11-03T00:00:00Z', burnPctPerHour: 0 }),
        budgetRow({ lane: 'claude', running: 2, usedPct: 41.5, resetAt: '2026-11-06T00:00:00Z', burnPctPerHour: 1.2 }),
        budgetRow({ lane: 'devin', window: 'credits', creditsRemaining: 812 }),
      ]),
    });
    const client = await connect(lanes);
    const { result, text } = await callLanes(client);
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', sourceState: 'healthy' });
    expect(parsed.lanes).toEqual([
      { lane: 'claude', running: 2, target: 3, held: false, heldBy: null, heldReason: null, heldUntil: null,
        window: 'weekly', usedPct: 41.5, creditsRemaining: null, resetAt: '2026-11-06T00:00:00Z', burnPctPerHour: 1.2, sourceState: 'healthy' },
      { lane: 'codex-personal', running: 1, target: 2, held: true, heldBy: 'mason 2026-10-31T19:30:00Z',
        heldReason: 'manual pin', heldUntil: '2026-11-01T00:00:00Z',
        window: 'weekly', usedPct: 0, creditsRemaining: null, resetAt: '2026-11-03T00:00:00Z', burnPctPerHour: 0, sourceState: 'healthy' },
      { lane: 'devin', running: null, target: null, held: null, heldBy: null, heldReason: null, heldUntil: null,
        window: 'credits', usedPct: null, creditsRemaining: 812, resetAt: null, burnPctPerHour: null, sourceState: 'healthy' },
    ]);
  });

  it('reports a throwing reader as degraded with an empty list, not an MCP error', async () => {
    const lanes = () => readFleetLanes({
      laneTargets: async () => { throw new Error('private-source-value'); },
      hostRuns: async () => runsState([runRow()]),
      resourceLedger: async () => ledger([budgetRow()]),
    });
    const client = await connect(lanes);
    const { result, text } = await callLanes(client);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text)).toMatchObject({ sourceState: 'degraded', lanes: [] });
    expect(text).not.toContain('private-source-value');
  });

  it.each([{ limit: 1 }, { path: 'elsewhere' }, { command: 'start' }, { extra: null }, { after: 0 }])('rejects unknown arguments before reading: %j', async args => {
    const lanes = vi.fn(async () => ({}));
    const client = await connect(lanes);
    await expect(client.callTool({ name: 'fleet_lanes', arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(lanes).not.toHaveBeenCalled();
  });

  it('bounds the join to 32 lanes', async () => {
    const many = Array.from({ length: MAX_FLEET_LANES + 8 }, (_, index) =>
      slotRow({ lane: `lane-${String(index).padStart(2, '0')}` }));
    const client = await connect(() => readFleetLanes({
      laneTargets: async () => laneTargets(many),
      hostRuns: async () => runsState([]),
      resourceLedger: async () => ledger([]),
    }));
    const { text } = await callLanes(client);
    expect(JSON.parse(text).lanes).toHaveLength(MAX_FLEET_LANES);
  });

  it('scrubs secret-shaped hold text before returning rows', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5);
    const client = await connect(() => readFleetLanes({
      laneTargets: async () => laneTargets([slotRow({ held: true, heldReason: `hold token=${fake}`, changedBy: `mason@example.com ${NOW}` })]),
      hostRuns: async () => runsState([]),
      resourceLedger: async () => ledger([]),
    }));
    const { text } = await callLanes(client);
    const parsed = JSON.parse(text);
    expect(parsed.lanes[0].held).toBe(true);
    expect(text).not.toContain(fake);
    expect(text).not.toContain('mason@example.com');
    expect(text).toContain('REDACTED');
  });
});
