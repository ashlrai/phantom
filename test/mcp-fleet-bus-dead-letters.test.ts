/**
 * fleet_bus_dead_letters: the transport dead-letter sink's retained
 * delivery-failure reports over the isolated fleet MCP server — the same
 * readBusDeadLetters projection `phm agents bus dead-letters` serves, with
 * every filter validated before any store read and non-ok results passed
 * through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned dead-letter
 * results, no bus store or registry access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  FLEET_BUS_DEAD_LETTERS_LIMIT_DEFAULT, FLEET_BUS_DEAD_LETTERS_LIMIT_MAX,
  parseFleetBusDeadLettersArgs, readFleetBusDeadLetters,
} from '../src/mcp/fleet-bus-dead-letters.js';
import {
  readBusDeadLetters, type BusDeadLetterItem, type BusDeadLettersOptions, type BusDeadLettersResult,
} from '../src/core/agents/bus-dead-letters.js';

const connections: Client[] = [];

const letter = (over: Partial<BusDeadLetterItem> = {}): BusDeadLetterItem => ({
  cursor: 11, id: 'dl-abc', priority: 'P1',
  ts: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-08T00:00:00.000Z',
  originalId: 'm-1', to: 'agent:worker', from: 'agent:boss', fromAgent: 'boss',
  kind: 'task', reason: 'exhausted', reasonKind: 'exhausted',
  attempts: 5, payloadDropped: false,
  summary: 'dead letter exhausted: agent:boss → agent:worker · 5 attempts · kind task · original m-1',
  ...over,
});

const okResult = (over: Partial<Extract<BusDeadLettersResult, { status: 'ok' }>> = {}): BusDeadLettersResult => ({
  status: 'ok', source: 'available', letters: [letter()], matched: 1, truncated: false,
  asOf: '2026-01-01T00:00:00.000Z', ...over,
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
  const client = new Client({ name: 'bus-dead-letters-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callDeadLetters(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_dead_letters', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_dead_letters argument parsing', () => {
  it('defaults the page bound and accepts an empty argument set', () => {
    expect(parseFleetBusDeadLettersArgs({})).toEqual({ limit: FLEET_BUS_DEAD_LETTERS_LIMIT_DEFAULT, filters: {} });
    expect(FLEET_BUS_DEAD_LETTERS_LIMIT_DEFAULT).toBe(50);
    expect(FLEET_BUS_DEAD_LETTERS_LIMIT_MAX).toBe(100);
  });

  it('accepts the limit bounds and rejects the rest', () => {
    expect(parseFleetBusDeadLettersArgs({ limit: 1 })).toMatchObject({ limit: 1 });
    expect(parseFleetBusDeadLettersArgs({ limit: 100 })).toMatchObject({ limit: 100 });
    for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: '5' }, { limit: null }, { limit: -1 }]) {
      expect(parseFleetBusDeadLettersArgs(bad)).toBeNull();
    }
  });

  it('maps every shared dead-letter filter onto the read options', () => {
    const parsed = parseFleetBusDeadLettersArgs({
      limit: 10, reason: 'expired', id: 'dl-abc', from: 'agent:boss', excludeFrom: 'agent:spammer',
      to: 'agent:worker', channel: 'ops', topic: 'alerts', bodyKind: 'task',
      priority: 'P0', since: '1800000000000', before: '1700000000000', contains: '  Exhausted   Report ',
    });
    expect(parsed).toMatchObject({
      limit: 10,
      filters: {
        reason: 'expired', id: 'dl-abc', from: 'agent:boss', excludeFrom: 'agent:spammer',
        to: 'agent:worker', channel: 'ops', topic: 'alerts', bodyKind: 'task',
        priority: 'P0', since: 1800000000000, before: 1700000000000, contains: 'exhausted report',
      },
    });
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' }, { home: '/tmp' },
      { now: '2026-01-01' }, { agent: 'worker' }, { after: 0 }, { matched: true },
      { reason: 'bogus' }, { reason: 'dead-lettered' }, { reason: '' }, { reason: 5 },
      { id: 'has space' }, { id: '' }, { id: 5 }, { id: 'x'.repeat(129) },
      { from: 5 }, { excludeFrom: null }, { to: 'has space' }, { bodyKind: '' }, { bodyKind: 5 },
      { priority: 'P9' }, { priority: 1 }, { priority: 'p0' },
      { channel: 'Has Space' }, { channel: '' }, { channel: 'UPPER' }, { channel: 'x'.repeat(33) }, { channel: 5 },
      { topic: 'Bad Topic!' }, { topic: '' }, { topic: 5 },
      { since: 'never' }, { since: 5 }, { since: '' }, { since: '1960-01-01T00:00:00.000Z' },
      { before: 'never' }, { before: 5 }, { before: '' }, { before: '1960-01-01T00:00:00.000Z' },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
    ]) expect(parseFleetBusDeadLettersArgs(bad)).toBeNull();
  });
});

describe('fleet_bus_dead_letters reader', () => {
  it('runs the shared read with the parsed options and reports the envelope', async () => {
    const seen: BusDeadLettersOptions[] = [];
    const read: typeof readBusDeadLetters = options => {
      seen.push(options);
      return okResult({ matched: 3, truncated: true });
    };
    const result = await readFleetBusDeadLetters(
      parseFleetBusDeadLettersArgs({ reason: 'exhausted', to: 'agent:worker', limit: 10 })!,
      { read });
    expect(seen).toEqual([{ reason: 'exhausted', to: 'agent:worker', limit: 10 }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', source: 'available', matched: 3, truncated: true,
    });
    expect(result.status === 'ok' && result.letters).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes a missing store through as verified-empty, never invented rows', async () => {
    const read: typeof readBusDeadLetters = () => okResult({ source: 'missing', letters: [], matched: 0 });
    const result = await readFleetBusDeadLetters(parseFleetBusDeadLettersArgs({})!, { read });
    expect(result).toMatchObject({ status: 'ok', source: 'missing', matched: 0 });
    expect(result.status === 'ok' && result.letters).toHaveLength(0);
  });

  it.each([
    { status: 'invalid', reason: 'Clock is unavailable.' },
    { status: 'unavailable', reason: 'Bus store is not readable.' },
    { status: 'retryable', reason: 'Bus store cursor did not advance.' },
  ] as const)('passes a refused read through untouched: %j', async page => {
    const read: typeof readBusDeadLetters = () => page;
    const result = await readFleetBusDeadLetters(parseFleetBusDeadLettersArgs({})!, { read });
    expect(result).toMatchObject({ status: page.status, reason: page.reason });
    expect(result.status === 'ok').toBe(false);
  });
});

describe('fleet_bus_dead_letters MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_dead_letters');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema).not.toHaveProperty('required');
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
    expect(tool?.inputSchema.properties?.['reason'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['exhausted', 'expired', 'no-route', 'other']) });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['P0', 'P3']) });
    expect(tool?.inputSchema.properties?.['channel'])
      .toMatchObject({ type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,31}$' });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['before']).toMatchObject({ type: 'string' });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }],
    [{ limit: 0 }], [{ limit: 101 }], [{ limit: '5' }], [{ limit: null }],
    [{ reason: 'bogus' }], [{ reason: 'dead-lettered' }],
    [{ priority: 'P9' }], [{ channel: 'Has Space' }], [{ topic: 'Bad Topic!' }],
    [{ since: 'never' }], [{ before: 'never' }], [{ contains: '' }], [{ contains: 'x'.repeat(513) }],
    [{ id: 'has space' }], [{ from: 5 }], [{ extra: 1 }], [{ agent: 'worker' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busDeadLetters = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busDeadLetters });
    await expect(client.callTool({ name: 'fleet_bus_dead_letters', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busDeadLetters).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ok', source: 'available', letters: [letter()], matched: 3, truncated: true,
      asOf: '2026-01-01T00:00:00.000Z',
    };
    const busDeadLetters = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busDeadLetters });
    const { parsed } = await callDeadLetters(client, {
      reason: 'exhausted', to: 'agent:worker', channel: 'ops', topic: 'alerts', limit: 10,
    });
    expect(busDeadLetters).toHaveBeenCalledWith(expect.objectContaining({ limit: 10 }));
    const filters = (busDeadLetters.mock.calls[0]![0] as { filters: Record<string, unknown> }).filters;
    expect(filters).toMatchObject({ reason: 'exhausted', to: 'agent:worker', channel: 'ops', topic: 'alerts' });
    expect(parsed).toEqual(payload);
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_bus_dead_letters` \|/m);
  });
});
