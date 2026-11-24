/**
 * fleet_bus_channel: the agent-bus channel transcript over the isolated
 * fleet MCP server — the same readAgentChannel projection `phm agents bus
 * channel read` serves, with every filter validated before any store read
 * and non-ok pages passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned channel
 * pages, no bus store, registry, hold table or feed access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  FLEET_BUS_CHANNEL_LIMIT_DEFAULT, FLEET_BUS_CHANNEL_LIMIT_MAX,
  parseFleetBusChannelArgs, readFleetBusChannel, type FleetBusChannelArgs,
} from '../src/mcp/fleet-bus-channel.js';
import { readAgentChannel, type ChannelReadMessage, type ChannelReadPage } from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const message = (over: Partial<ChannelReadMessage> = {}): ChannelReadMessage => ({
  cursor: 7, receivedAt: 1_800_000_000_000, priority: 'P2', topic: 'general',
  fromAgent: 'sender',
  envelope: {
    id: 'm-1', from: 'agent:sender', to: 'group:ops:general', priority: 'P2', ttl: 60_000,
    body: { kind: 'note', text: 'ping' },
  },
  ...over,
});

const okPage = (over: Partial<Extract<ChannelReadPage, { status: 'ok' }>> = {}): ChannelReadPage => ({
  status: 'ok', channel: 'ops', messages: [message()], nextCursor: 9, ...over,
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
  const client = new Client({ name: 'bus-channel-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callChannel(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_channel', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_channel argument parsing', () => {
  it('requires channel and defaults the page bounds', () => {
    expect(parseFleetBusChannelArgs({ channel: 'ops' })).toEqual({
      channel: 'ops', after: 0, limit: FLEET_BUS_CHANNEL_LIMIT_DEFAULT, matched: false, filters: {},
    });
    expect(FLEET_BUS_CHANNEL_LIMIT_DEFAULT).toBe(50);
    expect(FLEET_BUS_CHANNEL_LIMIT_MAX).toBe(100);
  });

  it('rejects a missing or malformed channel name before any read', () => {
    for (const bad of [{}, { channel: 5 }, { channel: '' }, { channel: 'Has Space' },
      { channel: 'UPPER' }, { channel: '-lead' }, { channel: 'x'.repeat(33) },
      { channel: null }, { channel: true }]) {
      expect(parseFleetBusChannelArgs(bad)).toBeNull();
    }
  });

  it('accepts the cursor, limit and matched bounds and rejects the rest', () => {
    expect(parseFleetBusChannelArgs({ channel: 'ops', after: 12, limit: 1, matched: true }))
      .toMatchObject({ after: 12, limit: 1, matched: true });
    expect(parseFleetBusChannelArgs({ channel: 'ops', limit: 100, matched: false }))
      .toMatchObject({ limit: 100, matched: false });
    for (const bad of [{ after: -1 }, { after: 1.5 }, { after: '3' }, { after: null },
      { limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: '5' }, { limit: null },
      { matched: 'yes' }, { matched: 1 }, { matched: null }]) {
      expect(parseFleetBusChannelArgs({ channel: 'ops', ...bad })).toBeNull();
    }
  });

  it('maps every shared channel filter onto the page fields', () => {
    const parsed = parseFleetBusChannelArgs({
      channel: 'ops', topic: 'alerts', after: 3, limit: 10, matched: true,
      from: 'agent:sender', excludeFrom: 'agent:bot',
      thread: 't-1', priority: 'P1', job: 'RQ-9',
      since: '1800000000000', before: '1700000000000', contains: '  Parser   Fix ',
      inReplyTo: 'm-0',
    });
    expect(parsed).toMatchObject({
      channel: 'ops', after: 3, limit: 10, matched: true,
      filters: {
        topic: 'alerts', from: 'agent:sender', excludeFrom: 'agent:bot',
        thread: 't-1', priority: 'P1', job: 'RQ-9',
        since: 1800000000000, before: 1700000000000, contains: 'parser fix',
        inReplyTo: 'm-0',
      },
    });
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { channel: 'ops', extra: 1 }, { channel: 'ops', root: '/tmp/fake' }, { channel: 'ops', path: '/tmp/x' },
      { channel: 'ops', cwd: '/tmp' }, { channel: 'ops', runsDir: '/tmp' }, { channel: 'ops', home: '/tmp' },
      { channel: 'ops', topic: 'Has Space' }, { channel: 'ops', topic: '' }, { channel: 'ops', topic: 5 },
      { channel: 'ops', topic: 'x'.repeat(33) },
      { channel: 'ops', from: 5 }, { channel: 'ops', excludeFrom: null }, { channel: 'ops', job: 'has space' },
      { channel: 'ops', thread: 'has space' }, { channel: 'ops', thread: '' }, { channel: 'ops', thread: 5 },
      { channel: 'ops', inReplyTo: 'has space' }, { channel: 'ops', inReplyTo: '' }, { channel: 'ops', inReplyTo: 5 },
      { channel: 'ops', priority: 'P9' }, { channel: 'ops', priority: 1 }, { channel: 'ops', priority: 'p0' },
      { channel: 'ops', since: 'never' }, { channel: 'ops', since: 5 }, { channel: 'ops', since: '' },
      { channel: 'ops', before: 'never' }, { channel: 'ops', before: 5 }, { channel: 'ops', before: '' },
      { channel: 'ops', before: '1960-01-01T00:00:00.000Z' },
      { channel: 'ops', contains: '' }, { channel: 'ops', contains: '   ' },
      { channel: 'ops', contains: 'x'.repeat(513) }, { channel: 'ops', contains: 42 },
    ]) expect(parseFleetBusChannelArgs(bad)).toBeNull();
  });
});

describe('fleet_bus_channel reader', () => {
  it('runs the shared read with the parsed page and reports the resolved channel', async () => {
    const seen: Array<[string, unknown]> = [];
    const read: typeof readAgentChannel = (name, page) => {
      seen.push([name, page]);
      return okPage({ matched: 1 });
    };
    const result = await readFleetBusChannel(
      parseFleetBusChannelArgs({ channel: 'ops', after: 4, limit: 10, matched: true, topic: 'alerts' })!,
      { read });
    expect(seen).toEqual([['ops', { after: 4, limit: 10, matched: true, topic: 'alerts' }]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      channel: 'ops', status: 'ok', nextCursor: 9, matched: 1,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports the newest shown cursor as nextCursor when matched hides rows', async () => {
    // A matched page scans the whole store, so the core nextCursor is the
    // store's end — resuming there would skip the unshown matches. The
    // adapter reports the same honest resume point the CLI does.
    const read: typeof readAgentChannel = () => okPage({
      matched: 3,
      messages: [message({ cursor: 4 }), message({ cursor: 7 })],
      nextCursor: 9,
    });
    const result = await readFleetBusChannel(
      parseFleetBusChannelArgs({ channel: 'ops', matched: true })!, { read });
    expect(result).toMatchObject({ status: 'ok', matched: 3, nextCursor: 7 });
    expect(result.messages).toHaveLength(2);
  });

  it('keeps the store-end cursor when every match fits the page', async () => {
    const read: typeof readAgentChannel = () => okPage({
      matched: 2,
      messages: [message({ cursor: 4 }), message({ cursor: 7 })],
    });
    const result = await readFleetBusChannel(
      parseFleetBusChannelArgs({ channel: 'ops', matched: true })!, { read });
    expect(result).toMatchObject({ status: 'ok', matched: 2, nextCursor: 9 });
  });

  it('omits matched when the page did not count the whole store', async () => {
    const read: typeof readAgentChannel = () => okPage();
    const result = await readFleetBusChannel(parseFleetBusChannelArgs({ channel: 'ops' })!, { read });
    expect(result.status).toBe('ok');
    expect(result.matched).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });

  it('forwards every parsed filter into the shared page read', async () => {
    let seenPage: Record<string, unknown> | undefined;
    const read: typeof readAgentChannel = (_name, page) => {
      seenPage = page as Record<string, unknown>;
      return okPage({ messages: [] });
    };
    await readFleetBusChannel(parseFleetBusChannelArgs({
      channel: 'ops', topic: 'alerts', since: '1800000000000', before: '1700000000000', contains: 'Parser Fix',
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot',
      priority: 'P0', job: 'RQ-1', inReplyTo: 'm-0',
    })!, { read });
    expect(seenPage).toMatchObject({
      topic: 'alerts', since: 1800000000000, before: 1700000000000, contains: 'parser fix',
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot',
      priority: 'P0', job: 'RQ-1', inReplyTo: 'm-0',
    });
  });

  it.each([
    { status: 'invalid', reason: 'Invalid channel topic.' },
    { status: 'unknown-channel', reason: 'Channel does not exist.' },
    { status: 'unavailable', reason: 'Bus store is not readable.' },
    { status: 'retryable', reason: 'Owner share receipt pending.' },
  ] as const)('passes a refused page through untouched: %j', async page => {
    const read: typeof readAgentChannel = () => page;
    const result = await readFleetBusChannel(parseFleetBusChannelArgs({ channel: 'ghost' })!, { read });
    expect(result).toMatchObject({ channel: 'ghost', status: page.status, reason: page.reason });
    expect(result.messages).toBeUndefined();
    expect(result.nextCursor).toBeUndefined();
    expect(result.matched).toBeUndefined();
  });
});

describe('fleet_bus_channel MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_channel');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['channel'] });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['P0', 'P3']) });
    expect(tool?.inputSchema.properties?.['matched']).toMatchObject({ type: 'boolean' });
    expect(tool?.inputSchema.properties?.['before']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['inReplyTo'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{}], [{ channel: '' }], [{ channel: 'Has Space' }], [{ channel: 'UPPER' }], [{ channel: 5 }],
    [{ channel: 'ops', root: '/tmp/fake-root' }], [{ channel: 'ops', path: '/tmp/x' }], [{ channel: 'ops', cwd: '/tmp' }],
    [{ channel: 'ops', limit: 0 }], [{ channel: 'ops', limit: 101 }], [{ channel: 'ops', limit: '5' }],
    [{ channel: 'ops', after: -1 }], [{ channel: 'ops', matched: 'yes' }],
    [{ channel: 'ops', priority: 'P9' }], [{ channel: 'ops', topic: 'Bad Topic!' }],
    [{ channel: 'ops', since: 'never' }], [{ channel: 'ops', before: 'never' }], [{ channel: 'ops', contains: '' }], [{ channel: 'ops', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busChannel = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busChannel });
    await expect(client.callTool({ name: 'fleet_bus_channel', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busChannel).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', channel: 'ops', status: 'ok',
      messages: [message()], nextCursor: 9, matched: 3,
    };
    const busChannel = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busChannel });
    const { parsed } = await callChannel(client, { channel: 'ops', topic: 'alerts', limit: 10, matched: true });
    expect(busChannel).toHaveBeenCalledWith(expect.objectContaining({ channel: 'ops', limit: 10, matched: true }));
    const filters = (busChannel.mock.calls[0]![0] as FleetBusChannelArgs).filters;
    expect(filters).toMatchObject({ topic: 'alerts' });
    expect(parsed).toEqual(payload);
  });
});
