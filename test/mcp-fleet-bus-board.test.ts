/**
 * fleet_bus_board: the shared task board's fleet-wide pending digest over
 * the isolated fleet MCP server — the same readBusBoardPending/
 * BusBoard.pendingAll read `phm comms inbox`'s board source projects,
 * with every filter validated before any store read and the
 * missing/unavailable union passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned board
 * digests, no board store, fleet queue or config access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBusBoardArgs, readFleetBusBoard, type FleetBusBoardArgs } from '../src/mcp/fleet-bus-board.js';
import type {
  BusBoardPendingPeers, BusBoardPendingRead, BusBoardPendingReadOptions,
} from '../src/core/fleet/bus-board.js';

const connections: Client[] = [];

const pending: BusBoardPendingPeers = {
  peers: ['alice', 'bob'],
  claims: 'readable',
  threads: [{
    id: 'thread-1', members: ['alice', 'bob'],
    content: { trust: 'untrusted', text: 'Release thread' },
    pendingDeliveries: 1,
    tasks: { open: 1, held: 0, ambiguous: 0, unknown: 0 },
  }],
  deliveries: {
    matched: 1,
    items: [{
      id: 'del-1', threadId: 'thread-1', sender: 'alice', recipient: 'bob',
      schemaVersion: 1, createdAt: '2026-01-01T00:00:00.000Z',
      message: { id: 'del-1', from: 'alice', to: 'bob', priority: 'P2', ttl: 60_000 },
      content: { trust: 'untrusted', text: '{"body":{"text":"please review"}}' },
    }],
    truncated: false,
  },
  tasks: {
    matched: 1,
    items: [{
      id: 'task-1', threadId: 'thread-1', itemId: 'job-1',
      content: { trust: 'untrusted', text: 'Ship the fix' },
      claimed: false, hold: 'open', owner: null,
    }],
    truncated: false,
  },
};

const okRead = (over: Partial<BusBoardPendingPeers> = {}): BusBoardPendingRead => ({
  source: 'available', pending: { ...pending, ...over },
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
  const client = new Client({ name: 'bus-board-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callBoard(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_board', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_board argument parsing', () => {
  it('accepts an empty argument object — every root stays server-owned', () => {
    expect(parseFleetBusBoardArgs({})).toEqual({});
  });

  it('maps the shared board filters onto the read options', () => {
    expect(parseFleetBusBoardArgs({ job: 'RQ-1', contains: '  Frobnicate  ', since: '2h', before: '1h' }))
      .toEqual({ job: 'RQ-1', contains: 'frobnicate', since: expect.any(Number), before: expect.any(Number) });
    expect(parseFleetBusBoardArgs({ since: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ since: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(parseFleetBusBoardArgs({ since: '1767225600000' })).toEqual({ since: 1767225600000 });
    expect(parseFleetBusBoardArgs({ before: '2026-01-01T00:00:00.000Z' }))
      .toEqual({ before: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(parseFleetBusBoardArgs({ before: '1767225600000' })).toEqual({ before: 1767225600000 });
  });

  it('maps the sender filters onto the read options under the printable-label rule', () => {
    expect(parseFleetBusBoardArgs({ from: 'nova', excludeFrom: 'agent:ghost' }))
      .toEqual({ from: 'nova', excludeFrom: 'agent:ghost' });
    expect(parseFleetBusBoardArgs({ from: 'agt_0123456789abcdef0123' }))
      .toEqual({ from: 'agt_0123456789abcdef0123' });
  });

  it('rejects unknown keys, caller roots and malformed values before any read', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' },
      { runsDir: '/tmp' }, { home: '/tmp' }, { busRoot: '/tmp' }, { limit: 5 }, { agent: 'bob' },
      { job: 'has space' }, { job: '' }, { job: 5 }, { job: null },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 5 }, { contains: null },
      { since: 'bogus' }, { since: '0x10' }, { since: 5 }, { since: null }, { since: true },
      { before: 'bogus' }, { before: '0x10' }, { before: 5 }, { before: null }, { before: true },
      { since: '1d', before: '-5' }, { since: '1d', before: '1969-12-31T23:59:59.000Z' },
      { from: 'has space' }, { from: '' }, { from: 5 }, { from: null }, { from: true },
      { excludeFrom: 'has space' }, { excludeFrom: '' }, { excludeFrom: 5 }, { excludeFrom: null },
    ]) expect(parseFleetBusBoardArgs(bad)).toBeNull();
  });
});

describe('fleet_bus_board reader', () => {
  it('runs the shared read and spreads its result beside the envelope', async () => {
    const seen: BusBoardPendingReadOptions[] = [];
    const read = (options: BusBoardPendingReadOptions): BusBoardPendingRead => {
      seen.push(options);
      return okRead();
    };
    const before = Date.now();
    const result = await readFleetBusBoard({ job: 'job-1', contains: 'review', since: 1_700_000_000_000, before: 1_800_000_000_000 }, { read });
    expect(seen).toEqual([{ jobId: 'job-1', contains: 'review', sinceMs: 1_700_000_000_000, beforeMs: 1_800_000_000_000 }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      source: 'available',
    });
    expect(Date.parse(result.generatedAt)).toBeGreaterThanOrEqual(before);
    if (result.source !== 'available') throw new Error('expected an available board read');
    expect(result.pending).toMatchObject({ claims: 'readable', peers: ['alice', 'bob'] });
    expect(result.pending.tasks.items[0]).toMatchObject({ itemId: 'job-1', hold: 'open' });
  });

  it('passes the sender refs through to the shared read untouched', async () => {
    const seen: BusBoardPendingReadOptions[] = [];
    const read = (options: BusBoardPendingReadOptions): BusBoardPendingRead => {
      seen.push(options);
      return okRead();
    };
    // The refs stay agent refs — readBusBoardPending resolves them through
    // the fleet-root identity registry, the same rule every bus read's
    // sender filter applies.
    const result = await readFleetBusBoard({ from: 'nova', excludeFrom: 'agent:ghost' }, { read });
    expect(seen).toEqual([{ from: 'nova', excludeFrom: 'agent:ghost' }]);
    expect(result.source).toBe('available');
  });

  it('passes degraded results through untouched — unknown stays unknown, never an empty digest', async () => {
    const read = (): BusBoardPendingRead => ({ source: 'missing' });
    const result = await readFleetBusBoard({}, { read });
    expect(result).toMatchObject({ source: 'missing' });
    expect(result).not.toHaveProperty('pending');

    const unavailable = { source: 'unavailable' as const };
    const result2 = await readFleetBusBoard({ job: 'job-1' }, { read: () => unavailable });
    expect(result2).toMatchObject({ source: 'unavailable' });
    expect(result2).not.toHaveProperty('pending');
  });
});

describe('fleet_bus_board MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_board');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('caller root, path or cwd');
    expect(tool?.description).toContain('BusBoard.pendingAll');
    expect(tool?.description).toContain('never acknowledges');
    expect(tool?.description).toContain('fleet_work_board');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        job: { type: 'string' },
        contains: { type: 'string' },
        since: { type: 'string' },
        before: { type: 'string' },
        from: { type: 'string' },
        excludeFrom: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ busRoot: '/tmp/bus' }], [{ job: 'has space' }], [{ contains: '' }],
    [{ contains: 'x'.repeat(513) }], [{ since: 'bogus' }], [{ since: 5 }], [{ extra: 1 }],
    [{ before: 'bogus' }], [{ before: 5 }], [{ before: '1969-12-31T23:59:59.000Z' }],
    [{ from: 'has space' }], [{ from: '' }], [{ from: 5 }], [{ excludeFrom: 'has space' }], [{ excludeFrom: 5 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busBoard = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busBoard });
    await expect(client.callTool({ name: 'fleet_bus_board', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busBoard).not.toHaveBeenCalled();
  });

  it('calls the injected reader with the parsed filters and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...okRead(),
    };
    const busBoard = vi.fn(async (_args: FleetBusBoardArgs) => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busBoard });
    const { parsed } = await callBoard(client, { job: 'job-1', contains: 'review', since: '1d', before: '12h' });
    const expectedSince = Date.now() - 86_400_000;
    const expectedBefore = Date.now() - 43_200_000;
    // The server-level reader seam sees the parsed MCP args — `since` and
    // `before` already resolved to epoch ms — exactly like every other
    // fleet tool.
    expect(busBoard).toHaveBeenCalledWith({
      job: 'job-1', contains: 'review', since: expect.any(Number), before: expect.any(Number),
    });
    const call = busBoard.mock.calls[0]![0];
    expect(Math.abs((call.since ?? 0) - expectedSince)).toBeLessThan(5_000);
    expect(Math.abs((call.before ?? 0) - expectedBefore)).toBeLessThan(5_000);
    expect(parsed).toEqual(payload);
    expect(parsed.source).toBe('available');
    expect(parsed.pending).toMatchObject({ peers: ['alice', 'bob'] });
  });

  it('accepts an omitted arguments object', async () => {
    const busBoard = vi.fn(async () => ({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: 'x', source: 'missing',
    }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busBoard });
    const { parsed } = await callBoard(client);
    expect(busBoard).toHaveBeenCalledWith({});
    expect(parsed).toMatchObject({ source: 'missing' });
  });
});
