/**
 * RQ-PHX-MCPDURABLEINBOXRECUT31 — fleet_bus_inbox: an MCP worker consumes real
 * durable bus messages by cursor through the isolated fleet MCP server, not
 * just send-attempt hop metadata. The tool reuses the canonical bus inbox
 * (src/core/fleet/bus-inbox.ts) behind the same private root as
 * `phm comms bus`; nothing else about the server changes.
 *
 * Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP transports, fake
 * envelopes, no daemon, transport, or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readFleetBusInbox } from '../src/mcp/fleet-inbox.js';

let root: string;
const connections: Client[] = [];
const fleetRoot = () => join(root, 'fleet');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-inbox-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Real protocol round trip; busInbox defaults to the canonical store reader. */
async function connect(readers: FleetReaders = {
  status: async () => ({ pending: 2 }),
  loop: async limit => ({ limit }),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bus-inbox-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callInbox(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_inbox', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

interface Row { cursor: number; receivedAt: number; envelope: {
  id: string; from: string; to: string; priority: string; ttl: number; body: unknown;
} }

const rows = (parsed: Record<string, unknown>): Row[] => parsed['messages'] as Row[];

const message = (id: string, fields: Record<string, unknown> = {}) => ({
  id, from: 'fake-sender', to: 'fake-worker', priority: 'P2', ttl: 10 ** 15,
  body: { fake: `body-${id}` }, ...fields,
});
/** receivedAt 0 + huge ttl keeps envelopes live under the real Date.now clock. */
const post = (id: string, fields: Record<string, unknown> = {}, now: () => number = () => 0) =>
  appendBusInbox(message(id, fields), { root: fleetRoot(), now });

describe('RQ-PHX-MCPDURABLEINBOXRECUT31 fleet_bus_inbox MCP tool', () => {
  it('is listed beside the existing read-only tools with a bounded schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([
      'fleet_status', 'fleet_loop', 'fleet_bus_hops', 'fleet_host_runs', 'fleet_bus_inbox',
    ]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_inbox');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('untrusted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['after']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(tool?.inputSchema.properties?.['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
  });

  it.each([
    [{ after: -1 }], [{ after: 1.5 }], [{ after: '1' }], [{ after: null }], [{ after: true }],
    [{ limit: 0 }], [{ limit: 101 }], [{ limit: 1.5 }], [{ limit: '5' }], [{ limit: null }],
    [{ to: 5 }], [{ to: null }], [{ to: '' }], [{ to: 'has space' }],
    [{ from: {} }], [{ from: 'line\nbreak' }],
    [{ after: 0, extra: 1 }], [{ path: '/tmp/x' }], [{ command: 'read' }], [{ file: 'x' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('rejects unknown tool names and non-object arguments', async () => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_send' })).rejects.toMatchObject({ code: -32602 });
    // The SDK's request schema refuses non-record `arguments` before dispatch.
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: [1, 2] as unknown as Record<string, unknown> }))
      .rejects.toMatchObject({ code: -32603 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('passes validated arguments with schema defaults to the injected reader', async () => {
    const busInbox = vi.fn(async () => ({ fake: 'page' }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await client.callTool({ name: 'fleet_bus_inbox' });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 0, limit: 50, to: undefined, from: undefined });
    await client.callTool({ name: 'fleet_bus_inbox', arguments: { after: 3, limit: 5, to: 'w', from: 'a' } });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 3, limit: 5, to: 'w', from: 'a' });
  });

  it('reads durable envelopes with bodies by cursor and resumes without replay', async () => {
    for (const id of ['m1', 'm2', 'm3', 'm4']) expect(post(id).status).toBe('posted');
    const client = await connect();
    const first = await callInbox(client, { limit: 2 });
    expect(first.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 2, nextCursor: 2 });
    expect(rows(first.parsed).map(row => row.cursor)).toEqual([1, 2]);
    expect(rows(first.parsed).map(row => row.envelope.id)).toEqual(['m1', 'm2']);
    // Bodies arrive as opaque JSON data; ttl is remaining lifetime, never renewed.
    expect(rows(first.parsed)[0]!.envelope.body).toEqual({ fake: 'body-m1' });
    expect(rows(first.parsed)[0]!.envelope.ttl).toBeLessThan(10 ** 15);
    const second = await callInbox(client, { after: first.parsed['nextCursor'], limit: 2 });
    expect(second.parsed).toMatchObject({ sourceState: 'ok', nextCursor: 4 });
    expect(rows(second.parsed).map(row => row.envelope.id)).toEqual(['m3', 'm4']);
    const end = await callInbox(client, { after: second.parsed['nextCursor'] });
    expect(end.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 4 });
  });

  it('applies exact case-sensitive to/from filters combined', async () => {
    expect(post('w1', { to: 'worker', from: 'alice' }).status).toBe('posted');
    expect(post('w2', { to: 'worker', from: 'bob' }).status).toBe('posted');
    expect(post('o1', { to: 'other', from: 'alice' }).status).toBe('posted');
    const client = await connect();
    const combined = await callInbox(client, { to: 'worker', from: 'alice' });
    expect(rows(combined.parsed).map(row => row.envelope.id)).toEqual(['w1']);
    const recipientOnly = await callInbox(client, { to: 'worker' });
    expect(rows(recipientOnly.parsed).map(row => row.envelope.id)).toEqual(['w1', 'w2']);
    const wrongCase = await callInbox(client, { to: 'Worker' });
    expect(wrongCase.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 3 });
  });

  it('advances nextCursor through empty filtered pages without replay', async () => {
    for (const id of ['a', 'b', 'c']) expect(post(id).status).toBe('posted');
    const client = await connect();
    // Limit counts scanned live records before filtering: two scanned, none match.
    const page = await callInbox(client, { to: 'nobody', limit: 2 });
    expect(page.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 2 });
    const rest = await callInbox(client, { after: page.parsed['nextCursor'], to: 'nobody' });
    expect(rest.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 3 });
  });

  it('excludes expired records while the cursor still skips them', async () => {
    expect(post('stale', { ttl: 5 }).status).toBe('posted'); // receivedAt 0: elapsed dwarfs ttl
    expect(post('fresh').status).toBe('posted');
    const client = await connect();
    const { parsed } = await callInbox(client);
    expect(parsed).toMatchObject({ sourceState: 'ok', expiredCount: 1, liveCount: 1 });
    expect(rows(parsed).map(row => row.envelope.id)).toEqual(['fresh']);
    expect(parsed['nextCursor']).toBe(2);
    const after = await callInbox(client, { after: parsed['nextCursor'] });
    expect(after.parsed).toMatchObject({ sourceState: 'ok', messages: [], nextCursor: 2 });
  });

  it('distinguishes missing, unavailable and retryable sources, never inventing an empty page', async () => {
    const client = await connect();
    const missing = await callInbox(client);
    expect(missing.parsed).toMatchObject({
      sourceState: 'missing', messages: null, returnedMessages: null,
      nextCursor: null, retainedCount: null,
    });
    expect(existsSync(fleetRoot())).toBe(false); // a read never creates the store
    expect(post('m1').status).toBe('posted');
    writeFileSync(join(fleetRoot(), 'bus-inbox', 'messages.json'), '[{"fake":');
    const unreadable = await callInbox(client);
    expect(unreadable.parsed).toMatchObject({ sourceState: 'unavailable', messages: null, nextCursor: null });
    const retryable = await readFleetBusInbox({ after: 0, limit: 50 }, {
      inspect: () => ({
        source: 'available', retainedCount: 1, retainedBytes: 10,
        maxMessages: 1024, maxBytes: 1048576, liveCount: 1, expiredCount: 0,
      }),
      list: () => ({ status: 'retryable' }),
    });
    expect(retryable).toMatchObject({ sourceState: 'retryable', messages: null, nextCursor: null });
  });

  it('scrubs secret-shaped and private text inside opaque bodies', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5); // FAKE fixture; assert containment, never print.
    expect(post('carrier', { body: { note: `token=${fake}`, contact: 'agent@fake.example.com' } }).status).toBe('posted');
    const { parsed, text } = await callInbox(await connect());
    expect(text).not.toContain(fake);
    expect(text).not.toContain('agent@fake.example.com');
    expect(text).toContain('REDACTED');
    expect(rows(parsed)[0]!.envelope.id).toBe('carrier');
    expect(rows(parsed)[0]!.envelope.body).toEqual({ note: expect.not.stringContaining(fake), contact: '[REDACTED]' });
  });

  it('returns a generic error on reader failure without leaking source details', async () => {
    const busInbox = vi.fn(async () => { throw new Error('private-source-value'); });
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    const result = await client.callTool({ name: 'fleet_bus_inbox' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('keeps the 64 KiB serialized output bound instead of truncating JSON', async () => {
    expect(post('big-1', { body: 'x'.repeat(60_000) }).status).toBe('posted');
    expect(post('big-2', { body: 'y'.repeat(60_000) }).status).toBe('posted');
    const result = await (await connect()).callTool({ name: 'fleet_bus_inbox' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });

  it('keeps the existing fleet tools working alongside the inbox reader', async () => {
    const client = await connect();
    const hops = await client.callTool({ name: 'fleet_bus_hops' });
    expect(hops.isError).not.toBe(true);
    const hopContent = hops.content as Array<{ text: string }>;
    expect(JSON.parse(hopContent[0]!.text)).toMatchObject({ sourceState: 'missing' });
    await expect(client.callTool({ name: 'fleet_status', arguments: { limit: 1 } }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
