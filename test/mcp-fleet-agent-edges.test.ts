/**
 * fleet_agent_edges: the agent-to-agent message-link projection over the
 * isolated fleet MCP server — the same readFleetEdges read `phm fleet
 * edges` and `ashlr agents edges` serve, with windowMinutes/from/to
 * validated before any store read and every source state passed through
 * untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned edge
 * projections, no bus store or registry access.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetAgentEdgesArgs, readFleetAgentEdges } from '../src/mcp/fleet-agent-edges.js';
import { readFleetEdges, type FleetEdges } from '../src/core/fleet/fleet-edges.js';

const connections: Client[] = [];

const availableEdges = (over: Record<string, unknown> = {}): FleetEdges => ({
  schema: 'fleet.edges.v1', source: 'available',
  edges: [
    {
      from: { address: 'agent:sender', provider: 'devin' },
      to: { address: 'agent:ops', provider: null },
      messages: 3, messagesLastHour: 1, lastAt: 1_800_000_000_000,
    },
  ],
  ...over,
} as FleetEdges);

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
  const client = new Client({ name: 'agent-edges-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callEdges(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_edges', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_edges argument parsing', () => {
  it('accepts the empty call and every documented filter', () => {
    expect(parseFleetAgentEdgesArgs({})).toEqual({});
    expect(parseFleetAgentEdgesArgs({ windowMinutes: 60 })).toEqual({ windowMinutes: 60 });
    expect(parseFleetAgentEdgesArgs({ from: 'agent:sender' })).toEqual({ from: 'agent:sender' });
    expect(parseFleetAgentEdgesArgs({ to: 'ops' })).toEqual({ to: 'ops' });
    expect(parseFleetAgentEdgesArgs({ windowMinutes: 1, from: 'a', to: 'b' }))
      .toEqual({ windowMinutes: 1, from: 'a', to: 'b' });
    expect(parseFleetAgentEdgesArgs({ windowMinutes: 1440 })).toEqual({ windowMinutes: 1440 });
    expect(parseFleetAgentEdgesArgs({ from: 'x'.repeat(128) })).toEqual({ from: 'x'.repeat(128) });
  });

  it('rejects an out-of-range or non-integer windowMinutes', () => {
    for (const bad of [0, 1441, -5, 1.5, Number.NaN, '60', null, true]) {
      expect(parseFleetAgentEdgesArgs({ windowMinutes: bad })).toBeNull();
    }
  });

  it('rejects malformed from/to labels', () => {
    for (const bad of ['', 'has space', 'x'.repeat(129), 'line\nbreak', 5, null, true, ['a']]) {
      expect(parseFleetAgentEdgesArgs({ from: bad })).toBeNull();
      expect(parseFleetAgentEdgesArgs({ to: bad })).toBeNull();
    }
  });

  it('rejects unknown keys and caller roots', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' },
      { runsDir: '/tmp' }, { home: '/tmp' }, { limit: 5 }, { now: 0 },
      { windowMinutes: 60, root: '/tmp/fake' },
    ]) expect(parseFleetAgentEdgesArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_edges reader', () => {
  it('runs the shared projection with the parsed options and reports the edges', async () => {
    const seen: unknown[] = [];
    const read: typeof readFleetEdges = options => {
      seen.push(options);
      return availableEdges();
    };
    const result = await readFleetAgentEdges(
      parseFleetAgentEdgesArgs({ windowMinutes: 30, from: 'agent:sender', to: 'ops' })!,
      { read },
    );
    expect(seen).toEqual([{ windowMinutes: 30, from: 'agent:sender', to: 'ops' }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'fleet.edges.v1', source: 'available',
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges?.[0]).toMatchObject({
      from: { address: 'agent:sender', provider: 'devin' },
      to: { address: 'agent:ops', provider: null },
      messages: 3, messagesLastHour: 1,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes missing and unavailable sources through with edges null', async () => {
    for (const source of ['missing', 'unavailable'] as const) {
      const read: typeof readFleetEdges = () => ({ schema: 'fleet.edges.v1', source, edges: null });
      const result = await readFleetAgentEdges({}, { read });
      expect(result).toMatchObject({ source, edges: null });
    }
  });
});

describe('fleet_agent_edges MCP tool', () => {
  it('is advertised read-only beside the agent reads with the filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_edges');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['windowMinutes'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 1440 });
    expect(tool?.inputSchema.properties?.['from'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['to'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{ windowMinutes: 0 }], [{ windowMinutes: 1441 }], [{ windowMinutes: 1.5 }], [{ windowMinutes: '60' }],
    [{ from: '' }], [{ from: 'has space' }], [{ from: 'x'.repeat(129) }], [{ to: 5 }],
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ limit: 5 }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentEdges = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentEdges });
    await expect(client.callTool({ name: 'fleet_agent_edges', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentEdges).not.toHaveBeenCalled();
  });

  it('passes the validated options to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'fleet.edges.v1', source: 'available',
      edges: [{
        from: { address: 'agent:sender', provider: 'devin' },
        to: { address: 'agent:ops', provider: null },
        messages: 2, messagesLastHour: 0, lastAt: 1_800_000_000_000,
      }],
    };
    const agentEdges = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentEdges });
    const { parsed } = await callEdges(client, { windowMinutes: 15, to: 'agent:ops' });
    expect(agentEdges).toHaveBeenCalledWith({ windowMinutes: 15, to: 'agent:ops' });
    expect(parsed).toEqual(payload);
  });

  it('accepts the empty argument object', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'fleet.edges.v1', source: 'missing', edges: null,
    };
    const agentEdges = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentEdges });
    const { parsed } = await callEdges(client, {});
    expect(agentEdges).toHaveBeenCalledWith({});
    expect(parsed).toEqual(payload);
  });

  it('reports a throwing reader as unavailable, never an invented projection', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      agentEdges: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_agent_edges', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_agent_edges` \|/m);
  });
});
