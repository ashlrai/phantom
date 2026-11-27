/**
 * fleet_bus_status: the unified agent-bus health probe over the isolated
 * fleet MCP server — the same readUnifiedBusStatus projection
 * `phm agents bus status` serves. Every other bus tool reports only its
 * own slice; this is the one read that names every dependency the bus
 * verbs touch plus the outbound send gate, with no arguments accepted
 * and the probe's per-section honesty passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, a canned probe
 * result, no bus store, registry, wake queue, claim table, board, seat
 * store or send-gate access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBusStatusArgs, readFleetBusStatus } from '../src/mcp/fleet-bus-status.js';
import { readUnifiedBusStatus, type UnifiedBusStatus } from '../src/core/agents/bus-status.js';

const connections: Client[] = [];

const probe = (over: Partial<UnifiedBusStatus> = {}): UnifiedBusStatus => ({
  asOf: '2026-01-01T00:00:00.000Z',
  store: {
    source: 'available', retainedCount: 3, retainedBytes: 512,
    maxMessages: 1000, maxBytes: 1_048_576, liveCount: 2, expiredCount: 1,
  },
  registry: { source: 'available', identities: 4, channels: 2 },
  wakes: { state: 'ok', hints: 1, truncated: false },
  hoplog: { state: 'ok', bytes: 256, hops: 2, skippedRows: 0, truncated: false },
  coordination: { source: 'available', liveClaims: 2, statuses: 5 },
  workClaims: { source: 'available', claims: 3 },
  claimDrift: { state: 'VERIFIED', matched: 2, busOnly: 0, coordOnly: 0, ownerMismatch: 0 },
  feed: { status: 'ok', jobs: 7 },
  mailbox: { source: 'missing', pending: 0 },
  ownerChat: { source: 'missing', receipts: 0 },
  board: { source: 'available', threads: 1, tasks: 2, pendingDeliveries: 1, claims: 'readable' },
  seats: { source: 'missing', seats: 0, states: 0, handoffs: 0, notices: 0 },
  peerDispatch: { source: 'missing', receipts: 0, unpublished: 0 },
  peerLedger: { source: 'missing', liveRows: 0 },
  peerBindings: { source: 'missing', peers: 0, active: 0 },
  peerDispatchPolicy: { source: 'missing', peers: 0, repositories: 0 },
  peerInbox: { source: 'missing', pending: 0, truncated: false },
  deadLetters: { source: 'missing', pending: 0,
    reasons: { exhausted: 0, expired: 0, noRoute: 0, other: 0 }, truncated: false },
  sessionHandoffs: { source: 'missing', journals: 0, open: 0, awaitingFailover: 0, unreadable: 0, truncated: false },
  fleetCoordination: { source: 'missing', messages: 0, proposals: 0, returns: 0 },
  orgOutbox: { source: 'missing', pending: 0 },
  channels: { source: 'available', adapters: [
    { id: 'bus', adapterRegistered: true, healthy: true },
    { id: 'slack', adapterRegistered: false, healthy: 'unknown' },
    { id: 'imessage', adapterRegistered: false, healthy: 'unknown' },
    { id: 'email', adapterRegistered: false, healthy: 'unknown' },
    { id: 'telegram', adapterRegistered: false, healthy: 'unknown' },
    { id: 'handoff', adapterRegistered: true, healthy: true },
  ] },
  sendGate: {
    state: 'open',
    kill: { state: 'inactive', reason: 'missing' },
    pause: { state: 'clear', since: null, reason: null },
  },
  ...over,
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
});

async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bus-status-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callStatus(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_status', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_status argument parsing', () => {
  it('accepts only an empty argument object — every store root stays server-owned', () => {
    expect(parseFleetBusStatusArgs({})).toEqual({});
  });

  it('rejects every key before any probe runs', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' },
      { runsDir: '/tmp' }, { limit: 1 }, { extra: 1 }, { json: true }, { agent: 'x' },
    ]) expect(parseFleetBusStatusArgs(bad)).toBeNull();
  });
});

describe('fleet_bus_status reader', () => {
  it('runs the shared probe and spreads its sections beside the envelope', async () => {
    const seen: unknown[][] = [];
    const status: typeof readUnifiedBusStatus = (...args: unknown[]) => {
      seen.push(args);
      return probe();
    };
    const result = await readFleetBusStatus({ status });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      asOf: '2026-01-01T00:00:00.000Z',
      registry: { source: 'available', identities: 4, channels: 2 },
      claimDrift: { state: 'VERIFIED', matched: 2 },
      sendGate: { state: 'open', kill: { state: 'inactive' }, pause: { state: 'clear' } },
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes degraded sections through untouched — unknown stays unknown, never zero', async () => {
    const degraded = probe({
      store: { source: 'unavailable', retainedCount: null, retainedBytes: null,
        maxMessages: 1000, maxBytes: 1_048_576, liveCount: null, expiredCount: null },
      registry: { source: 'unavailable', identities: null, channels: null },
      claimDrift: { state: 'UNKNOWN', matched: null, busOnly: null, coordOnly: null, ownerMismatch: null },
      feed: { status: 'unavailable', jobs: null },
      sendGate: {
        state: 'unknown',
        kill: { state: 'unknown', reason: 'uninspectable' },
        pause: { state: 'unknown', since: null, reason: 'unreadable' },
      },
    });
    const status: typeof readUnifiedBusStatus = () => degraded;
    const result = await readFleetBusStatus({ status });
    expect(result.store.retainedCount).toBeNull();
    expect(result.registry.identities).toBeNull();
    expect(result.claimDrift).toMatchObject({ state: 'UNKNOWN', matched: null, busOnly: null });
    expect(result.feed).toMatchObject({ status: 'unavailable', jobs: null });
    expect(result.sendGate.state).toBe('unknown');
  });
});

describe('fleet_bus_status MCP tool', () => {
  it('is advertised read-only beside the bus reads with an empty argument schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_status');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.description).toContain('sendGate.state');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ limit: 5 }], [{ extra: 1 }], [{ agent: 'lane:executor' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busStatus = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busStatus });
    await expect(client.callTool({ name: 'fleet_bus_status', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busStatus).not.toHaveBeenCalled();
  });

  it('calls the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...probe({ sendGate: { state: 'blocked',
        kill: { state: 'active', reason: 'present' },
        pause: { state: 'clear', since: null, reason: null } } }),
    };
    const busStatus = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busStatus });
    const { parsed } = await callStatus(client, {});
    expect(busStatus).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
    expect((parsed.sendGate as { state: string }).state).toBe('blocked');
  });

  it('accepts an omitted arguments object', async () => {
    const busStatus = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busStatus });
    const { parsed } = await callStatus(client);
    expect(busStatus).toHaveBeenCalledWith();
    expect(parsed).toEqual({ ok: true });
  });
});
