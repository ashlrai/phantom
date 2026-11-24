/**
 * fleet_agent_identity: one agent's bus identity card over the isolated
 * fleet MCP server — the same busAgentView projection `phm agents bus
 * id show <ref>` serves, with the required agent ref validated before any
 * registry read and non-ok results passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned identity
 * cards, no registry access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentIdentityArgs, readFleetAgentIdentity,
} from '../src/mcp/fleet-agent-identity.js';
import { busAgentView, type BusAgentView } from '../src/core/agents/bus-cli-adapters.js';
import type { AgentIdentity } from '../src/core/agents/bus-identity.js';

const connections: Client[] = [];

const okIdentity: AgentIdentity = {
  id: 'agt_0123456789abcdef0123',
  handle: 'devin',
  displayName: 'Devin',
  aliases: ['devin-cli'],
  runtimes: [{ cli: 'devin', provider: 'devin', model: null, lastSeenAt: 1_800_000_000_000 }],
  createdAt: 1_799_000_000_000,
};

const okCard = (over: Partial<Extract<BusAgentView, { status: 'ok'; self: false }>> = {}): BusAgentView => ({
  status: 'ok', ref: 'agent:devin', self: false,
  identity: okIdentity, channels: ['alerts', 'ops'], address: 'agent:devin',
  ...over,
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
  const client = new Client({ name: 'agent-identity-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callIdentity(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_identity', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_identity argument parsing', () => {
  it('requires a printable-label agent ref and nothing else', () => {
    expect(parseFleetAgentIdentityArgs({ agent: 'agent:devin' })).toEqual({ agent: 'agent:devin' });
    expect(parseFleetAgentIdentityArgs({ agent: 'agt_0123456789abcdef0123' })).toEqual({ agent: 'agt_0123456789abcdef0123' });
    expect(parseFleetAgentIdentityArgs({ agent: 'devin' })).toEqual({ agent: 'devin' });
  });

  it('rejects a missing agent, unknown keys, caller roots and malformed values before any read', () => {
    for (const bad of [
      {}, { agent: 5 }, { agent: '' }, { agent: 'has space' }, { agent: null }, { agent: true },
      { agent: 'x'.repeat(129) },
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' }, { home: '/tmp' },
      { channel: 'ops' }, { limit: 10 }, { agent: 'ok', extra: 1 },
    ]) expect(parseFleetAgentIdentityArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_identity reader', () => {
  it('runs the shared card read for the ref and reports identity, channels and address', async () => {
    const seen: unknown[] = [];
    const view: typeof busAgentView = ref => {
      seen.push(ref);
      return okCard();
    };
    const result = await readFleetAgentIdentity(
      parseFleetAgentIdentityArgs({ agent: 'agent:devin' })!, { view });
    expect(seen).toEqual(['agent:devin']);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', ref: 'agent:devin', self: false,
      address: 'agent:devin', channels: ['alerts', 'ops'],
    });
    expect(result.identity).toEqual({
      id: 'agt_0123456789abcdef0123', handle: 'devin', displayName: 'Devin',
      aliases: ['devin-cli'],
      runtimes: [{ cli: 'devin', provider: 'devin', model: null, lastSeenAt: 1_800_000_000_000 }],
      createdAt: 1_799_000_000_000,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('copies identity arrays so the result cannot alias the registry', async () => {
    const mutable = okCard() as Extract<BusAgentView, { status: 'ok' }>;
    const view: typeof busAgentView = () => mutable;
    const result = await readFleetAgentIdentity(
      parseFleetAgentIdentityArgs({ agent: 'devin' })!, { view });
    result.identity!.aliases.push('mutated');
    result.channels!.push('mutated');
    expect(mutable.identity.aliases).toEqual(['devin-cli']);
    expect(mutable.channels).toEqual(['alerts', 'ops']);
  });

  it.each([
    { status: 'unknown', ref: 'ghost', self: false, reason: 'Agent is not a registered identity.' },
    { status: 'invalid', ref: 'bad ref', self: false, reason: 'Agent ref must be a printable routing label of 1-128 characters.' },
    { status: 'unavailable', ref: 'devin', self: false, reason: 'Identity registry is not readable.' },
    { status: 'unset', reason: 'PHM_AGENT_ID is not set.' },
  ] as const)('passes a refused card through untouched: %j', async card => {
    const view: typeof busAgentView = () => card;
    const result = await readFleetAgentIdentity(
      parseFleetAgentIdentityArgs({ agent: 'ghost' })!, { view });
    expect(result).toMatchObject({ status: card.status, reason: card.reason });
    if ('ref' in card) {
      expect(result).toMatchObject({ ref: card.ref, self: card.self });
    } else {
      expect(result.ref).toBeUndefined();
      expect(result.self).toBeUndefined();
    }
    expect(result.identity).toBeUndefined();
    expect(result.address).toBeUndefined();
    expect(result.channels).toBeUndefined();
  });
});

describe('fleet_agent_identity MCP tool', () => {
  it('is advertised read-only beside the bus reads with a required agent ref', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_identity');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toEqual(['agent']);
    expect(tool?.inputSchema.properties?.['agent'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{}], [{ agent: 5 }], [{ agent: '' }], [{ agent: 'has space' }], [{ agent: null }],
    [{ agent: 'x'.repeat(129) }],
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }], [{ home: '/tmp' }],
    [{ channel: 'ops' }], [{ limit: 10 }], [{ agent: 'ok', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentIdentity = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentIdentity });
    await expect(client.callTool({ name: 'fleet_agent_identity', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentIdentity).not.toHaveBeenCalled();
  });

  it('passes the validated ref to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', status: 'ok', ref: 'agent:devin', self: false,
      identity: {
        id: 'agt_0123456789abcdef0123', handle: 'devin', displayName: 'Devin',
        aliases: ['devin-cli'],
        runtimes: [{ cli: 'devin', provider: 'devin', model: null, lastSeenAt: 1_800_000_000_000 }],
        createdAt: 1_799_000_000_000,
      },
      address: 'agent:devin', channels: ['alerts'],
    };
    const agentIdentity = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentIdentity });
    const { parsed } = await callIdentity(client, { agent: 'agent:devin' });
    expect(agentIdentity).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agent:devin' }));
    expect(parsed).toEqual(payload);
  });
});
