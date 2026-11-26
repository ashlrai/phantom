/**
 * fleet_bus_thread: the reply-thread context read over the isolated fleet
 * MCP server — the same readBusThread projection `ashlr fleet bus-thread
 * --id <id>` serves, with the id validated before any store read and the
 * fleet.bus-thread.v1 result passed through with its honesty fields
 * intact.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned thread
 * results, no bus store access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBusThreadArgs, readFleetBusThread } from '../src/mcp/fleet-bus-thread.js';
import { readBusThread, type BusThreadResult } from '../src/core/fleet/bus-thread-context.js';
import type { BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const connections: Client[] = [];

const receipt = (id: string, cursor: number, inReplyTo?: string): BusInboxReceipt => ({
  cursor,
  receivedAt: 1_800_000_000_000 + cursor,
  envelope: {
    id, from: 'agent:sender', to: 'agent:ops', priority: 'P2', ttl: 60_000,
    body: inReplyTo === undefined
      ? { kind: 'note', text: `body of ${id}` }
      : { inReplyTo, text: `reply to ${inReplyTo}` },
  },
});

const okThread = (over: Record<string, unknown> = {}): BusThreadResult => ({
  schema: 'fleet.bus-thread.v1',
  requestedId: 'm-1',
  rootFound: true,
  messages: [receipt('m-1', 3), receipt('m-2', 7, 'm-1'), receipt('m-3', 9, 'm-2')],
  scannedThrough: 10,
  complete: true,
  sourceFailure: null,
  ...over,
} as BusThreadResult);

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
  const client = new Client({ name: 'bus-thread-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callThread(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_thread', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_thread argument parsing', () => {
  it('requires id and accepts the printable routing-label rule', () => {
    expect(parseFleetBusThreadArgs({ id: 'm-1' })).toEqual({ id: 'm-1' });
    expect(parseFleetBusThreadArgs({ id: 'wh-0123456789abcdef0123456789abcdef' }))
      .toEqual({ id: 'wh-0123456789abcdef0123456789abcdef' });
    expect(parseFleetBusThreadArgs({ id: 'x'.repeat(128) })).toEqual({ id: 'x'.repeat(128) });
  });

  it('rejects a missing or malformed id before any read', () => {
    for (const bad of [{}, { id: 5 }, { id: '' }, { id: 'has space' },
      { id: 'x'.repeat(129) }, { id: null }, { id: true }, { id: 'line\nbreak' }]) {
      expect(parseFleetBusThreadArgs(bad)).toBeNull();
    }
  });

  it('rejects unknown keys and caller roots', () => {
    for (const bad of [
      { id: 'm-1', extra: 1 }, { id: 'm-1', root: '/tmp/fake' }, { id: 'm-1', path: '/tmp/x' },
      { id: 'm-1', cwd: '/tmp' }, { id: 'm-1', runsDir: '/tmp' }, { id: 'm-1', home: '/tmp' },
      { id: 'm-1', limit: 5 }, { id: 'm-1', after: 0 },
    ]) expect(parseFleetBusThreadArgs(bad)).toBeNull();
  });

  it('accepts the shared bus-read filters and resolves since/before/contains', () => {
    expect(parseFleetBusThreadArgs({ id: 'm-1', from: 'agent:a', to: 'agent:b',
      excludeFrom: 'agent:c', channel: 'ops', job: 'RQ-1', priority: 'P1', thread: 'rq-1',
      inReplyTo: 'm-0', bodyKind: 'note', result: 'failed',
      since: '1700000000000', before: '2h', contains: '  Hello   World ' }))
      .toEqual({ id: 'm-1', filters: {
        from: 'agent:a', to: 'agent:b', excludeFrom: 'agent:c', channel: 'ops', job: 'RQ-1',
        priority: 'P1', thread: 'rq-1', inReplyTo: 'm-0', bodyKind: 'note', result: 'failed',
        since: 1_700_000_000_000, before: expect.any(Number), contains: 'hello world',
      } });
  });

  it('rejects malformed filter values before any read', () => {
    for (const bad of [
      { id: 'm-1', priority: 'P9' }, { id: 'm-1', priority: 1 }, { id: 'm-1', result: 'lost' },
      { id: 'm-1', result: 'released' }, { id: 'm-1', channel: 'Bad Name' }, { id: 'm-1', channel: '' },
      { id: 'm-1', since: 'whenever' }, { id: 'm-1', since: 5 }, { id: 'm-1', before: 'soon' },
      { id: 'm-1', contains: '' }, { id: 'm-1', contains: 'x'.repeat(600) }, { id: 'm-1', contains: 5 },
      { id: 'm-1', from: 'has space' }, { id: 'm-1', to: '' }, { id: 'm-1', excludeFrom: null },
      { id: 'm-1', job: 'has space' }, { id: 'm-1', thread: 'has space' },
      { id: 'm-1', inReplyTo: 'has space' }, { id: 'm-1', bodyKind: 'has space' },
    ]) expect(parseFleetBusThreadArgs(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('fleet_bus_thread reader', () => {
  it('runs the shared thread read with the parsed id and reports the root', async () => {
    const seen: string[] = [];
    const read: typeof readBusThread = id => {
      seen.push(id);
      return okThread();
    };
    const result = await readFleetBusThread(parseFleetBusThreadArgs({ id: 'm-1' })!, { read });
    expect(seen).toEqual(['m-1']);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'fleet.bus-thread.v1', requestedId: 'm-1', rootFound: true,
      scannedThrough: 10, complete: true, sourceFailure: null,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.messages).toHaveLength(3);
  });

  it('passes a proven miss through untouched', async () => {
    const thread = okThread({ rootFound: false, messages: [], scannedThrough: 4, complete: true });
    const read: typeof readBusThread = () => thread;
    const result = await readFleetBusThread(parseFleetBusThreadArgs({ id: 'ghost' })!, { read });
    expect(result).toMatchObject({
      schema: 'fleet.bus-thread.v1', requestedId: 'm-1', rootFound: false,
      messages: [], scannedThrough: 4, complete: true,
    });
  });

  it('passes an incomplete walk through with its failure reason', async () => {
    const thread = okThread({ complete: false, sourceFailure: 'unavailable' });
    const read: typeof readBusThread = () => thread;
    const result = await readFleetBusThread(parseFleetBusThreadArgs({ id: 'm-1' })!, { read });
    expect(result).toMatchObject({ complete: false, sourceFailure: 'unavailable' });
  });

  it('forwards the parsed filters to the shared read with live evidence', async () => {
    const seen: Array<{ id: string; options: unknown }> = [];
    const read: typeof readBusThread = (id, options) => {
      seen.push({ id, options });
      return okThread();
    };
    const args = parseFleetBusThreadArgs({ id: 'm-1', from: 'agent:a', priority: 'P1',
      since: '1700000000000', contains: 'hello' })!;
    await readFleetBusThread(args, { read });
    expect(seen).toEqual([{ id: 'm-1', options: { liveEvidence: true, filters: {
      from: 'agent:a', priority: 'P1', since: 1_700_000_000_000, contains: 'hello' } } }]);
  });
});

describe('fleet_bus_thread MCP tool', () => {
  it('is advertised read-only beside the bus reads with the id schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_thread');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['id'] });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    for (const key of ['to', 'from', 'excludeFrom', 'channel', 'job', 'priority', 'thread',
      'inReplyTo', 'bodyKind', 'result', 'since', 'before', 'contains']) {
      expect(tool?.inputSchema.properties?.[key], key).toBeDefined();
    }
    expect(tool?.inputSchema.properties?.['priority']).toMatchObject({ enum: ['P0', 'P1', 'P2', 'P3'] });
    expect(tool?.inputSchema.properties?.['result']).toMatchObject({ enum: ['reserved', 'admitted', 'complete', 'failed'] });
  });

  it.each([
    [{}], [{ id: '' }], [{ id: 'has space' }], [{ id: 'x'.repeat(129) }], [{ id: 5 }], [{ id: null }],
    [{ id: 'm-1', root: '/tmp/fake-root' }], [{ id: 'm-1', path: '/tmp/x' }], [{ id: 'm-1', cwd: '/tmp' }],
    [{ id: 'm-1', limit: 5 }], [{ id: 'm-1', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busThread = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busThread });
    await expect(client.callTool({ name: 'fleet_bus_thread', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busThread).not.toHaveBeenCalled();
  });

  it('passes the validated id to the injected reader and returns its thread', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'fleet.bus-thread.v1', requestedId: 'm-1', rootFound: true,
      messages: [
        { cursor: 3, receivedAt: 1_800_000_000_003, envelope: { id: 'm-1', from: 'agent:a', to: 'agent:b', priority: 'P2', ttl: 60_000, body: { kind: 'note', text: 'root' } } },
        { cursor: 7, receivedAt: 1_800_000_000_007, envelope: { id: 'm-2', from: 'agent:b', to: 'agent:a', priority: 'P2', ttl: 60_000, body: { inReplyTo: 'm-1', text: 'reply' } } },
      ],
      scannedThrough: 10, complete: true, sourceFailure: null,
    };
    const busThread = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busThread });
    const { parsed } = await callThread(client, { id: 'm-1' });
    expect(busThread).toHaveBeenCalledWith({ id: 'm-1' });
    expect(parsed).toEqual(payload);
  });

  it('passes validated filters through to the injected reader', async () => {
    const payload = { ...okThread(), schemaVersion: 1, snapshotKind: 'local-persisted',
      authority: 'none', generatedAt: '2026-01-01T00:00:00.000Z' };
    const busThread = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busThread });
    await callThread(client, { id: 'm-1', from: 'agent:a', priority: 'P1',
      since: '1700000000000', contains: 'hello' });
    expect(busThread).toHaveBeenCalledWith({ id: 'm-1', filters: {
      from: 'agent:a', priority: 'P1', since: 1_700_000_000_000, contains: 'hello' } });
  });

  it.each([
    [{ id: 'm-1', priority: 'P9' }], [{ id: 'm-1', result: 'lost' }], [{ id: 'm-1', channel: 'Bad Name' }],
    [{ id: 'm-1', since: 'whenever' }], [{ id: 'm-1', contains: '' }], [{ id: 'm-1', from: 'has space' }],
    [{ id: 'm-1', kind: 'note' }], [{ id: 'm-1', topic: 'fleet.*' }], [{ id: 'm-1', id2: 'x' }],
  ])('rejects invalid filter arguments before invoking the reader: %j', async args => {
    const busThread = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busThread });
    await expect(client.callTool({ name: 'fleet_bus_thread', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busThread).not.toHaveBeenCalled();
  });
});
