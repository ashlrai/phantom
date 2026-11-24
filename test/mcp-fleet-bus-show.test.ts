/**
 * fleet_bus_show: the single-envelope bus lookup over the isolated fleet
 * MCP server — the same readBusEnvelopeById projection `phm agents bus
 * show <id>` serves, with the id validated before any store read and
 * every lookup status passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned lookups,
 * no bus store, registry, hold table, wake queue or feed access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBusShowArgs, readFleetBusShow } from '../src/mcp/fleet-bus-show.js';
import { readBusEnvelopeById, type BusEnvelopeLookup } from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const okLookup = (over: Record<string, unknown> = {}): BusEnvelopeLookup => ({
  status: 'ok', id: 'm-1',
  message: {
    cursor: 7, receivedAt: 1_800_000_000_000, fromAgent: 'sender',
    envelope: {
      id: 'm-1', from: 'agent:sender', to: 'agent:ops', priority: 'P2', ttl: 60_000,
      body: { kind: 'note', text: 'ping' },
    },
  },
  ...over,
} as BusEnvelopeLookup);

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
  const client = new Client({ name: 'bus-show-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callShow(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_show', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_show argument parsing', () => {
  it('requires id and accepts the printable routing-label rule', () => {
    expect(parseFleetBusShowArgs({ id: 'm-1' })).toEqual({ id: 'm-1' });
    expect(parseFleetBusShowArgs({ id: 'wh-0123456789abcdef0123456789abcdef' }))
      .toEqual({ id: 'wh-0123456789abcdef0123456789abcdef' });
    expect(parseFleetBusShowArgs({ id: 'x'.repeat(128) })).toEqual({ id: 'x'.repeat(128) });
  });

  it('rejects a missing or malformed id before any read', () => {
    for (const bad of [{}, { id: 5 }, { id: '' }, { id: 'has space' },
      { id: 'x'.repeat(129) }, { id: null }, { id: true }, { id: 'line\nbreak' }]) {
      expect(parseFleetBusShowArgs(bad)).toBeNull();
    }
  });

  it('rejects unknown keys and caller roots', () => {
    for (const bad of [
      { id: 'm-1', extra: 1 }, { id: 'm-1', root: '/tmp/fake' }, { id: 'm-1', path: '/tmp/x' },
      { id: 'm-1', cwd: '/tmp' }, { id: 'm-1', runsDir: '/tmp' }, { id: 'm-1', home: '/tmp' },
      { id: 'm-1', limit: 5 }, { id: 'm-1', after: 0 },
    ]) expect(parseFleetBusShowArgs(bad)).toBeNull();
  });
});

describe('fleet_bus_show reader', () => {
  it('runs the shared lookup with the parsed id and reports the resolved id', async () => {
    const seen: string[] = [];
    const read: typeof readBusEnvelopeById = id => {
      seen.push(id);
      return okLookup();
    };
    const result = await readFleetBusShow(parseFleetBusShowArgs({ id: 'm-1' })!, { read });
    expect(seen).toEqual(['m-1']);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', id: 'm-1',
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes an ok lookup through with its hold, job and wake-hint evidence', async () => {
    const lookup = okLookup({
      held: false, holder: null,
      job: { jobId: 'RQ-9', feed: 'ok', job: null },
      wakeHint: { to: 'agent:holder', statusId: 'st-1', jobId: 'RQ-9', status: 'done', detail: 'finished' },
    });
    const read: typeof readBusEnvelopeById = () => lookup;
    const result = await readFleetBusShow(parseFleetBusShowArgs({ id: 'm-1' })!, { read });
    expect(result).toMatchObject({
      status: 'ok', id: 'm-1', held: false, holder: null,
      job: { jobId: 'RQ-9', feed: 'ok', job: null },
      wakeHint: { to: 'agent:holder', statusId: 'st-1', jobId: 'RQ-9', status: 'done', detail: 'finished' },
    });
    expect(result.message).toMatchObject({ cursor: 7, fromAgent: 'sender' });
  });

  it.each([
    { status: 'not-found', id: 'ghost' },
    { status: 'invalid', reason: 'Invalid message id.' },
    { status: 'unavailable', reason: 'Bus store is not readable.' },
    { status: 'retryable', reason: 'Owner share receipt pending.' },
  ] as const)('passes a refused lookup through untouched: %j', async lookup => {
    const read: typeof readBusEnvelopeById = () => lookup;
    const result = await readFleetBusShow(parseFleetBusShowArgs({ id: 'ghost' })!, { read });
    expect(result).toMatchObject({ status: lookup.status });
    expect(result.message).toBeUndefined();
  });
});

describe('fleet_bus_show MCP tool', () => {
  it('is advertised read-only beside the bus reads with the id schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_show');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['id'] });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{}], [{ id: '' }], [{ id: 'has space' }], [{ id: 'x'.repeat(129) }], [{ id: 5 }], [{ id: null }],
    [{ id: 'm-1', root: '/tmp/fake-root' }], [{ id: 'm-1', path: '/tmp/x' }], [{ id: 'm-1', cwd: '/tmp' }],
    [{ id: 'm-1', limit: 5 }], [{ id: 'm-1', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busShow = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busShow });
    await expect(client.callTool({ name: 'fleet_bus_show', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busShow).not.toHaveBeenCalled();
  });

  it('passes the validated id to the injected reader and returns its lookup', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ok', id: 'm-1',
      message: {
        cursor: 7, receivedAt: 1_800_000_000_000, fromAgent: 'sender',
        envelope: {
          id: 'm-1', from: 'agent:sender', to: 'agent:ops', priority: 'P2', ttl: 60_000,
          body: { kind: 'note', text: 'ping' },
        },
      },
      held: true, holder: 'agent:bot',
    };
    const busShow = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busShow });
    const { parsed } = await callShow(client, { id: 'm-1' });
    expect(busShow).toHaveBeenCalledWith({ id: 'm-1' });
    expect(parsed).toEqual(payload);
  });
});
