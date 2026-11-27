/**
 * fleet_agent_identities: the agent-bus identity roster over the isolated
 * fleet MCP server — the same readAgentRegistry + seatParticipants join
 * `phm agents bus id list` serves, with every argument refused before any
 * store read and unreadable sources reported unavailable, never invented.
 *
 * Hermetic: injected registry/participant readers, in-memory MCP
 * transports, no store access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentIdentitiesArgs, readFleetAgentIdentities,
} from '../src/mcp/fleet-agent-identities.js';
import type { AgentRegistry } from '../src/core/agents/bus-identity.js';
import type { Participant } from '../src/core/agents/bus-v2-schema.js';

const connections: Client[] = [];

const registry: AgentRegistry = {
  version: 1,
  identities: [{
    id: 'agt_0123456789abcdef0123',
    handle: 'devin',
    displayName: 'Devin',
    aliases: ['devin-cli'],
    runtimes: [{ cli: 'devin', provider: 'devin', model: null, lastSeenAt: 1_800_000_000_000 }],
    createdAt: 1_799_000_000_000,
  }],
  channels: [{
    name: 'ops',
    members: ['devin', 'comms'],
    createdBy: 'devin',
    createdAt: 1_799_500_000_000,
  }],
};

const participant: Participant = {
  participantId: 'seat-comms',
  provider: 'devin',
  displayName: 'Comms seat',
  capabilities: ['comms'],
  wake: { kind: 'bus', target: 'agent:comms' },
  status: 'active',
};

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
  const client = new Client({ name: 'agent-identities-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callIdentities(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_identities', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_identities argument parsing', () => {
  it('accepts only an empty argument object', () => {
    expect(parseFleetAgentIdentitiesArgs({})).toEqual({});
  });

  it('rejects every key — filters, roots and limits alike — before any read', () => {
    for (const bad of [
      { agent: 'devin' }, { channel: 'ops' }, { limit: 10 }, { extra: 1 },
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' }, { home: '/tmp' },
    ]) expect(parseFleetAgentIdentitiesArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_identities reader', () => {
  it('joins the registry roster with seat participants and reports provenance', async () => {
    const result = await readFleetAgentIdentities({
      registry: () => ({ status: 'ok', source: 'available', registry }),
      participants: async () => [participant],
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', source: 'available',
    });
    expect(result.identities).toEqual(registry.identities);
    expect(result.channels).toEqual(registry.channels);
    expect(result.participants).toEqual([participant]);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports a missing registry as a verified-empty roster, not unavailable', async () => {
    const result = await readFleetAgentIdentities({
      registry: () => ({ status: 'ok', source: 'missing', registry: { version: 1, identities: [], channels: [] } }),
      participants: async () => [],
    });
    expect(result).toMatchObject({ status: 'ok', source: 'missing' });
    expect(result.identities).toEqual([]);
    expect(result.channels).toEqual([]);
    expect(result.participants).toEqual([]);
  });

  it('passes an unreadable registry through as unavailable with its reason', async () => {
    const result = await readFleetAgentIdentities({
      registry: () => ({ status: 'unavailable', reason: 'Agent identity registry is unreadable.' }),
      participants: async () => [participant],
    });
    expect(result).toMatchObject({
      status: 'unavailable', reason: 'Agent identity registry is unreadable.',
    });
    expect(result.identities).toBeUndefined();
    expect(result.channels).toBeUndefined();
    expect(result.participants).toBeUndefined();
  });

  it('reports a throwing participant read as unavailable, never an empty list', async () => {
    const result = await readFleetAgentIdentities({
      registry: () => ({ status: 'ok', source: 'available', registry }),
      participants: async () => { throw new Error('seat store corrupt'); },
    });
    expect(result).toMatchObject({
      status: 'unavailable', reason: 'Bot seat participant roster is unreadable.',
    });
    expect(result.identities).toBeUndefined();
    expect(result.participants).toBeUndefined();
  });

  it('deep-copies every record so the result cannot alias the stores', async () => {
    const mutable = structuredClone(registry);
    const result = await readFleetAgentIdentities({
      registry: () => ({ status: 'ok', source: 'available', registry: mutable }),
      participants: async () => [structuredClone(participant)],
    });
    result.identities![0]!.aliases.push('mutated');
    result.identities![0]!.runtimes[0]!.model = 'mutated';
    result.channels![0]!.members.push('mutated');
    result.participants![0]!.capabilities.push('mutated');
    expect(mutable.identities[0]!.aliases).toEqual(['devin-cli']);
    expect(mutable.identities[0]!.runtimes[0]!.model).toBeNull();
    expect(mutable.channels[0]!.members).toEqual(['devin', 'comms']);
  });
});

describe('fleet_agent_identities MCP tool', () => {
  it('is advertised read-only beside the bus reads with no arguments', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_identities');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties).toEqual({});
  });

  it.each([
    [{ agent: 'devin' }], [{ channel: 'ops' }], [{ limit: 10 }], [{ extra: 1 }],
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }], [{ home: '/tmp' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentIdentities = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentIdentities });
    await expect(client.callTool({ name: 'fleet_agent_identities', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentIdentities).not.toHaveBeenCalled();
  });

  it('invokes the injected reader with no arguments and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', status: 'ok', source: 'available',
      identities: registry.identities, channels: registry.channels, participants: [participant],
    };
    const agentIdentities = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentIdentities });
    const { parsed } = await callIdentities(client);
    expect(agentIdentities).toHaveBeenCalledWith();
    expect(parsed).toEqual(payload);
  });
});
