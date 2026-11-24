/**
 * fleet_bus_claims: the live coordination-claims read over the isolated
 * fleet MCP server — the same listBusClaims projection `phm agents bus
 * claim list` serves, with every filter validated before any store read
 * and non-ok results passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned claim
 * listings, no coordination store, identity registry or feed access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetBusClaimsArgs, readFleetBusClaims } from '../src/mcp/fleet-bus-claims.js';
import type { BusClaimsListOptions, BusClaimsListResult } from '../src/core/agents/bus-claims.js';

const connections: Client[] = [];

const claim = {
  origin: 'resource' as const, key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker',
  leaseUntil: 1_800_000_600_000, sourceId: 'agentbus:op-1:abcd', live: true,
  repo: 'ashlrai/phantom', branch: null, path: 'docs/**', started: '2026-01-01T00:00:00.000Z',
};

const okList = (over: Partial<Extract<BusClaimsListResult, { status: 'ok' }>> = {}): BusClaimsListResult => ({
  status: 'ok', source: 'available', claims: [claim], asOf: '2026-01-01T00:00:00.000Z', ...over,
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
  const client = new Client({ name: 'bus-claims-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callClaims(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_claims', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_bus_claims argument parsing', () => {
  it('accepts an empty argument object — every root stays server-owned', () => {
    expect(parseFleetBusClaimsArgs({})).toEqual({});
  });

  it('maps every shared claim filter onto the list options', () => {
    expect(parseFleetBusClaimsArgs({
      key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker', excludeOwner: 'agent:other',
      contains: 'phantom', origin: 'resource', jobs: true,
    })).toEqual({
      key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker', excludeOwner: 'agent:other',
      contains: 'phantom', origin: 'resource', jobs: true,
    });
    expect(parseFleetBusClaimsArgs({ key: 'queue:RQ-1', owner: 'lane:executor', origin: 'message', jobs: false }))
      .toEqual({ key: 'queue:RQ-1', owner: 'lane:executor', origin: 'message', jobs: false });
    for (const key of ['repo:ashlrai/phantom', 'pr:ashlrai/phantom#12', 'path:o/r:src/**']) {
      expect(parseFleetBusClaimsArgs({ key })).toEqual({ key });
    }
  });

  it('rejects unknown keys, caller roots and malformed values before any read', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' },
      { runsDir: '/tmp' }, { home: '/tmp' }, { limit: 5 },
      { key: 'bogus' }, { key: 'path:ashlrai/phantom' }, { key: 'repo:not-a-repo' },
      { key: 'path:ashlrai/phantom:../escape' }, { key: 'queue:' }, { key: 5 }, { key: null },
      { owner: 'has space' }, { owner: '' }, { owner: 5 }, { owner: null },
      { excludeOwner: 'has space' }, { excludeOwner: '' }, { excludeOwner: 5 }, { excludeOwner: null },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 5 }, { contains: null },
      { origin: 'bogus' }, { origin: 'RESOURCE' }, { origin: 1 }, { origin: null },
      { jobs: 'yes' }, { jobs: 1 }, { jobs: null },
    ]) expect(parseFleetBusClaimsArgs(bad)).toBeNull();
  });

  it('accepts owner labels up to the claim store bound', () => {
    expect(parseFleetBusClaimsArgs({ owner: `a${'b'.repeat(200)}` })).toEqual({ owner: `a${'b'.repeat(200)}` });
    expect(parseFleetBusClaimsArgs({ owner: `a${'b'.repeat(256)}` })).toBeNull();
  });
});

describe('fleet_bus_claims reader', () => {
  it('runs the shared list and spreads its result beside the envelope', async () => {
    const seen: BusClaimsListOptions[] = [];
    const list = (options: BusClaimsListOptions): BusClaimsListResult => {
      seen.push(options);
      return okList({
        owner: { ref: 'agent:worker', identity: 'agt_0123456789abcdef0123', registry: 'available' },
        feed: 'ok',
      });
    };
    const result = await readFleetBusClaims(
      { key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker', excludeOwner: 'agent:other',
        contains: 'phantom', origin: 'resource', jobs: true },
      { list },
    );
    expect(seen).toEqual([{
      key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker', excludeOwner: 'agent:other',
      contains: 'phantom', origin: 'resource', jobs: true,
    }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', source: 'available', asOf: '2026-01-01T00:00:00.000Z', feed: 'ok',
      owner: { ref: 'agent:worker', identity: 'agt_0123456789abcdef0123', registry: 'available' },
      claims: [{ key: 'path:ashlrai/phantom:docs/**', owner: 'agent:worker', live: true }],
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes degraded results through untouched — unknown stays unknown, never an empty list', async () => {
    const unavailable = { status: 'unavailable' as const, asOf: '2026-01-01T00:00:00.000Z' };
    const list = (): BusClaimsListResult => unavailable;
    const result = await readFleetBusClaims({}, { list });
    expect(result).toMatchObject({ status: 'unavailable', asOf: '2026-01-01T00:00:00.000Z' });
    expect(result).not.toHaveProperty('claims');

    const missing = okList({ source: 'missing', claims: [] });
    const result2 = await readFleetBusClaims({}, { list: () => missing });
    expect(result2).toMatchObject({ status: 'ok', source: 'missing', claims: [] });
  });
});

describe('fleet_bus_claims MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_claims');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('caller root, path or cwd');
    expect(tool?.description).toContain('listBusClaims');
    expect(tool?.description).toContain('never acquires');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        key: { type: 'string' },
        owner: { type: 'string' },
        excludeOwner: { type: 'string' },
        contains: { type: 'string' },
        origin: { type: 'string', enum: ['resource', 'message', 'team', 'board'] },
        jobs: { type: 'boolean' },
      },
      additionalProperties: false,
    });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ key: 'bogus' }], [{ owner: 'has space' }], [{ origin: 'bogus' }],
    [{ excludeOwner: 'has space' }], [{ contains: '' }], [{ contains: 'x'.repeat(513) }],
    [{ jobs: 'yes' }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busClaims = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busClaims });
    await expect(client.callTool({ name: 'fleet_bus_claims', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busClaims).not.toHaveBeenCalled();
  });

  it('calls the injected reader with the parsed filters and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...okList({ feed: 'refused' }),
    };
    const busClaims = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busClaims });
    const { parsed } = await callClaims(client, {
      key: 'queue:RQ-9', owner: 'agent:worker', excludeOwner: 'agent:other',
      contains: 'phantom', origin: 'team', jobs: true,
    });
    expect(busClaims).toHaveBeenCalledWith({
      key: 'queue:RQ-9', owner: 'agent:worker', excludeOwner: 'agent:other',
      contains: 'phantom', origin: 'team', jobs: true,
    });
    expect(parsed).toEqual(payload);
    expect((parsed.claims as unknown[]).length).toBe(1);
    expect(parsed.feed).toBe('refused');
  });

  it('accepts an omitted arguments object', async () => {
    const busClaims = vi.fn(async () => ({ status: 'ok', source: 'missing', claims: [], asOf: 'x' }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busClaims });
    const { parsed } = await callClaims(client);
    expect(busClaims).toHaveBeenCalledWith({});
    expect(parsed).toMatchObject({ status: 'ok', source: 'missing', claims: [] });
  });
});
