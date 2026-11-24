/**
 * fleet_agent_messages: the fleet-wide agent-to-agent message timeline over
 * the isolated fleet MCP server — the same readAgentMessages projection
 * `phm messages`, GET /api/verse/agent-bus/messages and the desktop
 * Messages/Org panes serve, with every filter validated before any store
 * read and the projection's source/matched/skipped honesty passed through
 * untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned
 * agent-messages.v1 pages, no bus store, registry, hold table or feed
 * access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentMessagesArgs, readFleetAgentMessages,
} from '../src/mcp/fleet-agent-messages.js';
import {
  readAgentMessages, type AgentMessage, type AgentMessages,
} from '../src/core/fleet/agent-messages.js';

const connections: Client[] = [];

const message = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'm-1', ts: '2026-01-01T00:00:00.000Z', priority: 'P1',
  from: { name: 'agent:sender', lane: 'claude' },
  to: { name: 'agent:planner', lane: null },
  kind: 'ask', summary: 'Parser fix ready', conversation: 'pair:planner|sender',
  job: null, pr: null,
  ...over,
});

const page = (over: Partial<AgentMessages> = {}): AgentMessages => ({
  schema: 'agent-messages.v1', source: 'available',
  messages: [message()], matched: 1, skipped: 0, ...over,
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
  const client = new Client({ name: 'agent-messages-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callMessages(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_messages', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_messages argument parsing', () => {
  it('accepts an empty argument object — every filter is optional', () => {
    expect(parseFleetAgentMessagesArgs({})).toEqual({});
  });

  it('maps every shared messages filter onto the projection query', () => {
    const parsed = parseFleetAgentMessagesArgs({
      since: '1800000000000', before: '1800086400000', agent: 'agent:planner', with: 'agent:worker',
      kind: 'ASK', priority: 'P0', job: 'RQ-9', thread: 't-1',
      channel: 'fleet-ops', contains: '  Parser   Fix ',
      from: 'agent:sender', excludeFrom: 'agent:bot', inReplyTo: 'm-1', limit: 25,
    });
    expect(parsed).toEqual({
      since: 1800000000000, before: 1800086400000, agent: 'agent:planner', with: 'agent:worker',
      kind: 'ask', priority: 'P0', job: 'RQ-9', thread: 't-1',
      channel: 'fleet-ops', contains: 'parser fix',
      from: 'agent:sender', excludeFrom: 'agent:bot', inReplyTo: 'm-1', limit: 25,
    });
  });

  it('accepts every classified kind case-insensitively like the CLI flag', () => {
    for (const kind of ['ask', 'reply', 'handoff', 'status', 'blocker', 'ASK', 'Blocker']) {
      const parsed = parseFleetAgentMessagesArgs({ kind });
      expect(parsed?.kind).toBe(kind.toLowerCase());
    }
  });

  it('accepts every P0..P3 band and rejects anything outside the enum', () => {
    for (const band of ['P0', 'P1', 'P2', 'P3']) {
      expect(parseFleetAgentMessagesArgs({ priority: band })).toMatchObject({ priority: band });
    }
    for (const bad of ['p0', 'P4', 'high', 'urgent', '', 5, null, true, ['P0']]) {
      expect(parseFleetAgentMessagesArgs({ priority: bad })).toBeNull();
    }
  });

  it('resolves the shared since grammar to a non-negative epoch-ms integer', () => {
    const parsed = parseFleetAgentMessagesArgs({ since: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toMatchObject({ since: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(parseFleetAgentMessagesArgs({ since: '15m' })?.since).toBeGreaterThan(0);
  });

  it('requires agent when with is given, exactly like --with needs --agent', () => {
    expect(parseFleetAgentMessagesArgs({ with: 'agent:worker' })).toBeNull();
    expect(parseFleetAgentMessagesArgs({ agent: 'a', with: 'b' })).toMatchObject({ agent: 'a', with: 'b' });
  });

  it('bounds limit to the projection page size', () => {
    expect(parseFleetAgentMessagesArgs({ limit: 1 })).toMatchObject({ limit: 1 });
    expect(parseFleetAgentMessagesArgs({ limit: 1024 })).toMatchObject({ limit: 1024 });
    for (const bad of [0, 1025, 1.5, '50', null, true]) {
      expect(parseFleetAgentMessagesArgs({ limit: bad })).toBeNull();
    }
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' },
      { runsDir: '/tmp' }, { home: '/tmp' }, { after: 0 }, { matched: true },
      { agent: 'has space' }, { agent: '' }, { agent: 5 }, { agent: 'x'.repeat(129) },
      { with: 'has space' }, { with: 5 }, { job: 'has space' }, { job: '' }, { job: 5 },
      { thread: 'has space' }, { thread: null }, { from: null }, { from: 'has space' }, { from: 5 },
      { excludeFrom: null }, { excludeFrom: 'has space' },
      { inReplyTo: 'has space' }, { inReplyTo: '' }, { inReplyTo: 5 }, { inReplyTo: null }, { inReplyTo: 'x'.repeat(129) },
      { channel: 'Not A Channel' }, { channel: '-lead' }, { channel: 'x'.repeat(33) }, { channel: 5 },
      { kind: 'gossip' }, { kind: 'ASKS' }, { kind: 5 }, { kind: null },
      { priority: 'P4' }, { priority: 'high' }, { priority: 5 },
      { since: 'never' }, { since: 5 }, { since: '' }, { since: '9999999d' },
      { before: 'never' }, { before: 5 }, { before: '' }, { before: '9999999d' },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
      { limit: 0 }, { limit: 1025 }, { limit: 1.5 }, { limit: '50' },
    ]) expect(parseFleetAgentMessagesArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_messages reader', () => {
  it('runs the shared read with the parsed query and returns the projection under the MCP envelope', async () => {
    const seen: unknown[] = [];
    const read: typeof readAgentMessages = (query) => {
      seen.push(query);
      return page({ matched: 3, skipped: 1 });
    };
    const result = await readFleetAgentMessages(
      parseFleetAgentMessagesArgs({
        agent: 'planner', since: '1800000000000', kind: 'ask',
        priority: 'P1', job: 'RQ-9', contains: 'Parser Fix', from: 'sender', limit: 10,
      })!,
      { read });
    expect(seen).toEqual([{
      agent: 'planner', since: 1800000000000, kind: 'ask',
      priority: 'P1', job: 'RQ-9', contains: 'parser fix', from: 'sender', limit: 10,
    }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'agent-messages.v1', source: 'available', matched: 3, skipped: 1,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes an unfiltered read through with an empty query', async () => {
    const seen: unknown[] = [];
    const read: typeof readAgentMessages = (query) => {
      seen.push(query);
      return page({ messages: [] });
    };
    const result = await readFleetAgentMessages(parseFleetAgentMessagesArgs({})!, { read });
    expect(seen).toEqual([{}]);
    expect(result).toMatchObject({ schema: 'agent-messages.v1', source: 'available', messages: [], matched: 1 });
  });

  it.each([
    { source: 'missing' as const },
    { source: 'unavailable' as const },
  ])('keeps the store honesty state untouched: %j', async over => {
    const read: typeof readAgentMessages = () => page({ ...over, messages: [], matched: 0 });
    const result = await readFleetAgentMessages(parseFleetAgentMessagesArgs({})!, { read });
    expect(result).toMatchObject({ source: over.source, messages: [], matched: 0 });
  });
});

describe('fleet_agent_messages MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_messages');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties?.['since'])
      .toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['before'])
      .toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['kind'])
      .toMatchObject({ type: 'string', enum: ['ask', 'reply', 'handoff', 'status', 'blocker'] });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] });
    expect(tool?.inputSchema.properties?.['contains'])
      .toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
    expect(tool?.inputSchema.properties?.['from'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['inReplyTo'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 1024, default: 50 });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }],
    [{ agent: 'has space' }], [{ agent: 5 }], [{ with: 'agent:worker' }], [{ with: 'has space' }],
    [{ job: 'has space' }], [{ thread: null }], [{ from: 'has space' }], [{ from: 5 }],
    [{ excludeFrom: 'has space' }], [{ inReplyTo: 'has space' }], [{ inReplyTo: 5 }],
    [{ channel: 'Not A Channel' }], [{ channel: 5 }],
    [{ kind: 'gossip' }], [{ kind: 'ASKS' }], [{ kind: 5 }],
    [{ priority: 'P4' }], [{ priority: 'high' }], [{ priority: 5 }],
    [{ since: 'never' }], [{ since: 5 }], [{ since: '9999999d' }],
    [{ before: 'never' }], [{ before: 5 }], [{ before: '' }],
    [{ contains: '' }], [{ contains: '   ' }], [{ contains: 'x'.repeat(513) }], [{ contains: 42 }],
    [{ limit: 0 }], [{ limit: 1025 }], [{ limit: 1.5 }], [{ limit: '50' }],
    [{ extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentMessages = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMessages });
    await expect(client.callTool({ name: 'fleet_agent_messages', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentMessages).not.toHaveBeenCalled();
  });

  it('passes the validated arguments to the injected reader and returns its page', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'agent-messages.v1', source: 'available',
      messages: [message()], matched: 3, skipped: 0,
    };
    const agentMessages = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMessages });
    const { parsed } = await callMessages(client, {
      agent: 'planner', with: 'agent:worker', since: '1800000000000', before: '1800086400000',
      kind: 'ASK', priority: 'P2', job: 'RQ-9', thread: 't-1',
      channel: 'fleet-ops', contains: 'Parser Fix', from: 'agent:sender',
      excludeFrom: 'agent:bot', inReplyTo: 'm-9', limit: 10,
    });
    expect(agentMessages).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'planner', with: 'agent:worker', since: 1800000000000, before: 1800086400000,
      kind: 'ask', priority: 'P2', job: 'RQ-9', thread: 't-1',
      channel: 'fleet-ops', contains: 'parser fix', from: 'agent:sender',
      excludeFrom: 'agent:bot', inReplyTo: 'm-9', limit: 10,
    }));
    expect(parsed).toEqual(payload);
  });

  it('serves an unfiltered call with an empty query object', async () => {
    const agentMessages = vi.fn(async () => ({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'agent-messages.v1', source: 'missing', messages: [], matched: 0, skipped: 0,
    }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentMessages });
    const { parsed } = await callMessages(client, {});
    expect(agentMessages).toHaveBeenCalledWith({});
    expect(parsed).toMatchObject({ schema: 'agent-messages.v1', source: 'missing', messages: [] });
  });
});
