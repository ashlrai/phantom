/**
 * fleet_agent_channels: the agent-bus channel roster over the isolated
 * fleet MCP server — the same listBusChannels projection `phm agents bus
 * channel list [--agent]` serves, with the optional agent ref validated
 * before any registry read and non-ok results passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned channel
 * lists, no registry access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentChannelsArgs, readFleetAgentChannels, type FleetAgentChannelsArgs,
} from '../src/mcp/fleet-agent-channels.js';
import { listBusChannels, type ChannelList } from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const okList = (over: Partial<Extract<ChannelList, { status: 'ok' }>> = {}): ChannelList => ({
  status: 'ok', source: 'available', agent: null,
  channels: [
    { name: 'alerts', createdBy: 'agent:mason', createdAt: 1_800_000_000_000, members: ['agent:mason', 'agent:devin'] },
    { name: 'ops', createdBy: 'agent:devin', createdAt: 1_800_000_001_000, members: ['agent:devin'] },
  ],
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
  const client = new Client({ name: 'agent-channels-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callChannels(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_channels', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_channels argument parsing', () => {
  it('accepts an omitted agent and a printable-label ref, nothing else', () => {
    expect(parseFleetAgentChannelsArgs({})).toEqual({});
    expect(parseFleetAgentChannelsArgs({ agent: 'agent:devin' })).toEqual({ agent: 'agent:devin' });
    expect(parseFleetAgentChannelsArgs({ agent: 'agt_01JABC' })).toEqual({ agent: 'agt_01JABC' });
  });

  it('rejects unknown keys, caller roots and malformed agent values before any read', () => {
    for (const bad of [
      { agent: 5 }, { agent: '' }, { agent: 'has space' }, { agent: null }, { agent: true },
      { agent: 'x'.repeat(129) },
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' }, { home: '/tmp' },
      { channel: 'ops' }, { limit: 10 }, { agent: 'ok', extra: 1 },
    ]) expect(parseFleetAgentChannelsArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_channels reader', () => {
  it('runs the shared roster read fleet-wide and reports source, agent and channels', async () => {
    const seen: unknown[] = [];
    const read: typeof listBusChannels = agent => {
      seen.push(agent);
      return okList();
    };
    const result = await readFleetAgentChannels(parseFleetAgentChannelsArgs({})!, { read });
    expect(seen).toEqual([undefined]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'ok', source: 'available', agent: null,
    });
    expect(result.channels).toHaveLength(2);
    expect(result.channels?.[0]).toMatchObject({ name: 'alerts', members: ['agent:mason', 'agent:devin'] });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('forwards the agent ref and reports the resolved handle on ok', async () => {
    const seen: unknown[] = [];
    const read: typeof listBusChannels = agent => {
      seen.push(agent);
      return okList({ agent: 'devin', channels: [okList().channels[0]!] });
    };
    const result = await readFleetAgentChannels(
      parseFleetAgentChannelsArgs({ agent: 'agent:devin' })!, { read });
    expect(seen).toEqual(['agent:devin']);
    expect(result).toMatchObject({ status: 'ok', agent: 'devin' });
    expect(result.channels).toHaveLength(1);
  });

  it('keeps a verified-empty missing registry honest', async () => {
    const read: typeof listBusChannels = () => okList({ source: 'missing', channels: [] });
    const result = await readFleetAgentChannels(parseFleetAgentChannelsArgs({})!, { read });
    expect(result).toMatchObject({ status: 'ok', source: 'missing', channels: [] });
  });

  it.each([
    { status: 'unknown-agent', reason: 'Agent is not a registered identity.' },
    { status: 'unavailable', reason: 'Identity registry is not readable.' },
  ] as const)('passes a refused roster through untouched: %j', async list => {
    const read: typeof listBusChannels = () => list;
    const result = await readFleetAgentChannels(parseFleetAgentChannelsArgs({ agent: 'ghost' })!, { read });
    expect(result).toMatchObject({ status: list.status, reason: list.reason });
    expect(result.channels).toBeUndefined();
    expect(result.source).toBeUndefined();
    expect(result.agent).toBeUndefined();
  });
});

describe('fleet_agent_channels MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared agent-ref schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_channels');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties?.['agent'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
  });

  it.each([
    [{ agent: 5 }], [{ agent: '' }], [{ agent: 'has space' }], [{ agent: null }],
    [{ agent: 'x'.repeat(129) }],
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }], [{ home: '/tmp' }],
    [{ channel: 'ops' }], [{ limit: 10 }], [{ agent: 'ok', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentChannels = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentChannels });
    await expect(client.callTool({ name: 'fleet_agent_channels', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentChannels).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', status: 'ok', source: 'available', agent: 'devin',
      channels: [{ name: 'ops', createdBy: 'agent:devin', createdAt: 1_800_000_001_000, members: ['agent:devin'] }],
    };
    const agentChannels = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentChannels });
    const { parsed } = await callChannels(client, { agent: 'agent:devin' });
    expect(agentChannels).toHaveBeenCalledWith(expect.objectContaining({ agent: 'agent:devin' }));
    expect(parsed).toEqual(payload);
  });

  it('accepts an empty argument object for the fleet-wide roster', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', status: 'ok', source: 'available', agent: null, channels: [],
    };
    const agentChannels = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentChannels });
    const { parsed } = await callChannels(client, {});
    expect(agentChannels).toHaveBeenCalledWith(expect.objectContaining({}));
    expect((agentChannels.mock.calls[0]![0] as FleetAgentChannelsArgs).agent).toBeUndefined();
    expect(parsed).toEqual(payload);
  });
});
