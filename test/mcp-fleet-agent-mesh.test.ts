/**
 * fleet_agent_mesh: the flat agent mesh over the isolated fleet MCP
 * server — the same readAgentMesh projection `phm agents mesh status
 * [--json]` serves. Every other fleet_agent_* read answers one slice of
 * the bus; this is the bus-native observation read — which registered
 * identities are visible right now, under which direct agent:<handle>
 * address, lane, last-seen, current task and status.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned mesh
 * unions, no registry or bus-store access.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetAgentMeshArgs, readFleetAgentMesh } from '../src/mcp/fleet-agent-mesh.js';
import { readAgentMesh, type MeshAgent } from '../src/core/agents/mesh.js';

const connections: Client[] = [];

const meshAgent = (over: Partial<MeshAgent> = {}): MeshAgent => ({
  agent: 'devin', address: 'agent:devin', displayName: 'Devin',
  provider: 'devin', lane: 'codex', lastSeen: 1_800_000_000_000,
  currentTask: 'bus work', status: 'active', source: 'cli', observedAt: 1_800_000_000_000,
  ...over,
});

const okMesh = (): ReturnType<typeof readAgentMesh> => ({
  schema: 'agent-mesh.v1', status: 'ok', asOf: 1_800_000_000_000,
  agents: [
    meshAgent(),
    meshAgent({
      agent: 'mason', address: 'agent:mason', displayName: 'Mason',
      provider: null, lane: 'unknown', lastSeen: null, currentTask: null,
      status: 'unknown', source: 'registry', observedAt: null,
    }),
  ],
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
  const client = new Client({ name: 'agent-mesh-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callAgentMesh(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_mesh', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_mesh argument parsing', () => {
  it('accepts only an empty argument object — every store root stays server-owned', () => {
    expect(parseFleetAgentMeshArgs({})).toEqual({});
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { home: '/tmp' }, { runsDir: '/tmp' },
      { agent: 'devin' }, { limit: 1 }, { extra: 1 }, { since: '1h' }, { provider: 'devin' },
    ]) expect(parseFleetAgentMeshArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_mesh reader', () => {
  it('runs the shared mesh read and spreads its agent-mesh.v1 view beside the envelope', async () => {
    const seen: unknown[][] = [];
    const mesh = () => {
      seen.push([]);
      return okMesh();
    };
    const result = await readFleetAgentMesh({ mesh });
    expect(seen).toEqual([[]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'agent-mesh.v1', status: 'ok', asOf: 1_800_000_000_000,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const agents = (result as { agents: MeshAgent[] }).agents;
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({ agent: 'devin', address: 'agent:devin', source: 'cli', status: 'active' });
    expect(agents[1]).toMatchObject({ agent: 'mason', source: 'registry', status: 'unknown', provider: null });
  });

  it.each([
    { status: 'unavailable' as const, agents: [] },
    { status: 'retryable' as const, agents: [] },
  ])('passes a refused mesh through untouched: %j', async meshResult => {
    const mesh = () => meshResult;
    const result = await readFleetAgentMesh({ mesh });
    expect(result).toMatchObject({ status: meshResult.status, agents: [] });
    expect((result as { schema?: string }).schema).toBeUndefined();
    expect(result.schemaVersion).toBe(1);
  });

  it('reports unavailable with an empty list when the shared read throws', async () => {
    const mesh = () => { throw new Error('store detail'); };
    const result = await readFleetAgentMesh({ mesh });
    expect(result).toMatchObject({ status: 'unavailable', agents: [] });
    expect(result.schemaVersion).toBe(1);
  });
});

describe('fleet_agent_mesh MCP tool', () => {
  it('is advertised read-only beside the bus reads with an empty argument schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_mesh');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties).toEqual({});
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }], [{ home: '/tmp' }],
    [{ agent: 'devin' }], [{ limit: 10 }], [{ provider: 'devin' }], [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentMesh = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMesh });
    await expect(client.callTool({ name: 'fleet_agent_mesh', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentMesh).not.toHaveBeenCalled();
  });

  it('passes the empty argument object to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'agent-mesh.v1', status: 'ok', asOf: 1_800_000_000_000,
      agents: [meshAgent()],
    };
    const agentMesh = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMesh });
    const { parsed } = await callAgentMesh(client, {});
    expect(agentMesh).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
  });

  it('accepts an omitted arguments object', async () => {
    const agentMesh = vi.fn(async () => ({ status: 'unavailable', agents: [] }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMesh });
    const { parsed } = await callAgentMesh(client);
    expect(agentMesh).toHaveBeenCalledWith();
    expect(parsed).toMatchObject({ status: 'unavailable', agents: [] });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      agentMesh: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_agent_mesh', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('documents the tool in the MCP catalog', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_agent_mesh` \|/m);
  });
});
