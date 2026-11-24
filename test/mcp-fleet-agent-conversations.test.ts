/**
 * fleet_agent_conversations: the shared agent-to-agent conversation
 * projection over the isolated fleet MCP server — the same
 * readAgentConversations read `phm agents conversations` and
 * GET /api/verse/fleet/control/agent-conversations serve, with every
 * filter validated before any store read and the projection's
 * source/matched/waiting/skipped honesty passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned
 * agents.conversations.v1 pages, no bus store or registry access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  parseFleetAgentConversationsArgs, readFleetAgentConversations,
} from '../src/mcp/fleet-agent-conversations.js';
import {
  readAgentConversations, type AgentConversations, type Conversation,
} from '../src/core/fleet/agent-conversations.js';

const connections: Client[] = [];

const thread = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'm-1',
  participants: [
    { name: 'agent:leader', label: 'leader', known: true, node: 'lane:leader' },
    { name: 'agent:claude', label: 'claude', known: true, node: 'lane:claude' },
  ],
  subject: 'build ok?', messageCount: 2,
  lastAt: '2026-01-01T00:01:00.000Z',
  state: 'waiting', stateText: 'waiting for reply',
  waiting: { on: 'agent:claude', since: '2026-01-01T00:00:00.000Z', ms: 60_000 },
  jobs: ['RQ-9'],
  links: [{ a: 'agent:claude', b: 'agent:leader', count: 2, lastAt: '2026-01-01T00:01:00.000Z' }],
  messages: [
    { id: 'm-1', at: '2026-01-01T00:00:00.000Z', from: 'agent:leader', to: 'agent:claude', kind: 'ask', subject: 'build ok?' },
    { id: 'm-2', at: '2026-01-01T00:01:00.000Z', from: 'agent:claude', to: 'agent:leader', kind: 'reply', subject: 'on it' },
  ],
  ...over,
});

const page = (over: Partial<AgentConversations> = {}): AgentConversations => ({
  schema: 'agents.conversations.v1', version: 1,
  generatedAt: '2026-01-01T00:02:00.000Z', source: 'available',
  conversations: [thread()], matched: 1, waiting: 1, skipped: 0,
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
  const client = new Client({ name: 'agent-conversations-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callConversations(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_conversations', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_conversations argument parsing', () => {
  it('accepts an empty argument object — every filter is optional', () => {
    expect(parseFleetAgentConversationsArgs({})).toEqual({});
  });

  it('maps every shared conversations filter onto the MCP arguments', () => {
    const parsed = parseFleetAgentConversationsArgs({
      agent: 'agent:claude', waiting: true, blocked: true, state: 'waiting',
      job: 'RQ-9', waitingOn: 'agent:leader', since: '1800000000000',
      before: '1800000001000', contains: '  Build   OK ',
      inReplyTo: 'env-7', id: 'env-9', channel: 'dev', priority: 'P0', from: 'agent:bot',
      excludeFrom: 'agent:spam', with: 'agent:peer', thread: 'release-1', bodyKind: 'work.post', limit: 25,
    });
    expect(parsed).toEqual({
      agent: 'agent:claude', waiting: true, blocked: true, state: 'waiting',
      job: 'RQ-9', waitingOn: 'agent:leader', since: 1800000000000,
      before: 1800000001000, contains: 'build ok',
      inReplyTo: 'env-7', id: 'env-9', channel: 'dev', priority: 'P0', from: 'agent:bot',
      excludeFrom: 'agent:spam', with: 'agent:peer', thread: 'release-1', bodyKind: 'work.post', limit: 25,
    });
  });

  it('refuses with without agent — the same needs-agent rule the CLI flag shares', () => {
    expect(parseFleetAgentConversationsArgs({ with: 'agent:peer' })).toBeNull();
    expect(parseFleetAgentConversationsArgs({ agent: 'agent:claude', with: 'agent:peer' }))
      .toMatchObject({ agent: 'agent:claude', with: 'agent:peer' });
  });

  it('treats waiting:false and blocked:false as absent, like the API\'s ?waiting=0', () => {
    expect(parseFleetAgentConversationsArgs({ waiting: false, blocked: false })).toEqual({});
    expect(parseFleetAgentConversationsArgs({ waiting: false, state: 'done' }))
      .toEqual({ state: 'done' });
  });

  it('accepts every conversation state and rejects anything outside the enum', () => {
    for (const state of ['waiting', 'answered', 'blocked', 'done']) {
      expect(parseFleetAgentConversationsArgs({ state })).toMatchObject({ state });
    }
    for (const bad of ['WAITING', 'open', '', 5, null, true, ['waiting']]) {
      expect(parseFleetAgentConversationsArgs({ state: bad })).toBeNull();
    }
  });

  it('resolves the shared since grammar to a non-negative epoch-ms integer', () => {
    const parsed = parseFleetAgentConversationsArgs({ since: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toMatchObject({ since: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(parseFleetAgentConversationsArgs({ since: '15m' })?.since).toBeGreaterThan(0);
  });

  it('resolves before on the same grammar as the exclusive upper bound', () => {
    const parsed = parseFleetAgentConversationsArgs({ before: '2026-01-01T00:00:00.000Z' });
    expect(parsed).toMatchObject({ before: Date.parse('2026-01-01T00:00:00.000Z') });
    expect(parseFleetAgentConversationsArgs({ before: '15m' })?.before).toBeGreaterThan(0);
  });

  it('bounds limit to the projection page size', () => {
    expect(parseFleetAgentConversationsArgs({ limit: 1 })).toMatchObject({ limit: 1 });
    expect(parseFleetAgentConversationsArgs({ limit: 1024 })).toMatchObject({ limit: 1024 });
    for (const bad of [0, 1025, 1.5, '50', null, true]) {
      expect(parseFleetAgentConversationsArgs({ limit: bad })).toBeNull();
    }
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { extra: 1 }, { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' },
      { runsDir: '/tmp' }, { home: '/tmp' }, { after: 0 }, { matched: true },
      { agent: 'has space' }, { agent: '' }, { agent: 5 }, { agent: 'x'.repeat(129) },
      { job: 'has space' }, { job: '' }, { job: 5 },
      { waitingOn: 'has space' }, { waitingOn: '' }, { waitingOn: 5 },
      { waiting: 'yes' }, { waiting: 1 }, { waiting: null }, { blocked: 'no' }, { blocked: 0 },
      { state: 'WAITING' }, { state: 'open' }, { state: 5 }, { state: null },
      { since: 'never' }, { since: 5 }, { since: '' }, { since: '9999999d' },
      { before: 'never' }, { before: 5 }, { before: '' }, { before: '9999999d' },
      { contains: '' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { contains: 42 },
      { inReplyTo: 'has space' }, { inReplyTo: '' }, { inReplyTo: 5 }, { inReplyTo: 'x'.repeat(129) },
      { id: 'has space' }, { id: '' }, { id: 5 }, { id: 'x'.repeat(129) },
      { channel: 'Has Space' }, { channel: '' }, { channel: 5 }, { channel: 'a'.repeat(65) },
      { priority: 'P4' }, { priority: 'p0' }, { priority: 0 }, { priority: null },
      { from: 'has space' }, { from: '' }, { from: 5 },
      { excludeFrom: 'has space' }, { excludeFrom: '' }, { excludeFrom: 5 },
      { with: 'has space' }, { with: '' }, { with: 5 }, { with: 'x'.repeat(129) },
      { thread: 'has space' }, { thread: '' }, { thread: 5 }, { thread: 'x'.repeat(129) },
      { bodyKind: 'has space' }, { bodyKind: '' }, { bodyKind: 5 }, { bodyKind: 'x'.repeat(129) },
      { limit: 0 }, { limit: 1025 }, { limit: 1.5 }, { limit: '50' },
    ]) expect(parseFleetAgentConversationsArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_conversations reader', () => {
  it('runs the shared read with the parsed query and returns the projection under the MCP envelope', async () => {
    const seen: unknown[] = [];
    const read: typeof readAgentConversations = (query) => {
      seen.push(query);
      return page({ matched: 3, waiting: 2, skipped: 1 });
    };
    const result = await readFleetAgentConversations(
      parseFleetAgentConversationsArgs({
        agent: 'agent:claude', waiting: true, blocked: true, state: 'waiting',
        job: 'RQ-9', waitingOn: 'agent:leader', since: '1800000000000',
        before: '1800000001000', contains: 'Build OK', id: 'env-9', with: 'agent:peer',
        thread: 'release-1', bodyKind: 'work.post', limit: 10,
      })!,
      { read });
    expect(seen).toEqual([{
      agent: 'agent:claude', waitingOnly: true, blockedOnly: true, state: 'waiting',
      job: 'RQ-9', waitingOn: 'agent:leader', since: 1800000000000,
      before: 1800000001000, contains: 'build ok', id: 'env-9', with: 'agent:peer',
      thread: 'release-1', bodyKind: 'work.post', limit: 10,
    }]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'agents.conversations.v1', version: 1, source: 'available',
      matched: 3, waiting: 2, skipped: 1,
    });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations?.[0]).toMatchObject({ id: 'm-1', state: 'waiting', jobs: ['RQ-9'] });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('passes an unfiltered read through with an empty query', async () => {
    const seen: unknown[] = [];
    const read: typeof readAgentConversations = (query) => {
      seen.push(query);
      return page({ conversations: [], matched: 0, waiting: 0 });
    };
    const result = await readFleetAgentConversations(parseFleetAgentConversationsArgs({})!, { read });
    expect(seen).toEqual([{}]);
    expect(result).toMatchObject({
      schema: 'agents.conversations.v1', source: 'available',
      conversations: [], matched: 0, waiting: 0,
    });
  });

  it('keeps waiting:false and blocked:false out of the projection query', async () => {
    const seen: unknown[] = [];
    const read: typeof readAgentConversations = (query) => {
      seen.push(query);
      return page();
    };
    await readFleetAgentConversations(
      parseFleetAgentConversationsArgs({ waiting: false, blocked: false, state: 'done' })!, { read });
    expect(seen).toEqual([{ state: 'done' }]);
  });

  it.each([
    { source: 'missing' as const, conversations: [] as Conversation[], matched: 0, waiting: 0 },
    { source: 'unavailable' as const, conversations: null, matched: null, waiting: null },
  ])('keeps the store honesty state untouched: %j', async over => {
    const read: typeof readAgentConversations = () => page(over);
    const result = await readFleetAgentConversations(parseFleetAgentConversationsArgs({})!, { read });
    expect(result).toMatchObject({
      source: over.source, conversations: over.conversations,
      matched: over.matched, waiting: over.waiting,
    });
  });
});

describe('fleet_agent_conversations MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_conversations');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.required).toBeUndefined();
    expect(tool?.inputSchema.properties?.['state'])
      .toMatchObject({ type: 'string', enum: ['waiting', 'answered', 'blocked', 'done'] });
    expect(tool?.inputSchema.properties?.['waiting'])
      .toMatchObject({ type: 'boolean' });
    expect(tool?.inputSchema.properties?.['contains'])
      .toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
    expect(tool?.inputSchema.properties?.['before'])
      .toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 1024 });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }], [{ runsDir: '/tmp' }], [{ home: '/tmp' }],
    [{ agent: 'has space' }], [{ agent: 5 }], [{ agent: 'x'.repeat(129) }],
    [{ job: 'has space' }], [{ waitingOn: 'has space' }], [{ waitingOn: 5 }],
    [{ waiting: 'yes' }], [{ waiting: 1 }], [{ blocked: 'no' }], [{ blocked: 0 }],
    [{ state: 'WAITING' }], [{ state: 'open' }], [{ state: 5 }],
    [{ since: 'never' }], [{ since: 5 }], [{ since: '9999999d' }],
    [{ before: 'never' }], [{ before: 5 }], [{ before: '9999999d' }],
    [{ contains: '' }], [{ contains: '   ' }], [{ contains: 'x'.repeat(513) }], [{ contains: 42 }],
    [{ limit: 0 }], [{ limit: 1025 }], [{ limit: 1.5 }], [{ limit: '50' }],
    [{ extra: 1 }], [{ matched: true }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentConversations = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentConversations });
    await expect(client.callTool({ name: 'fleet_agent_conversations', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentConversations).not.toHaveBeenCalled();
  });

  it('passes the validated arguments to the injected reader and returns its page', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'agents.conversations.v1', version: 1, source: 'available',
      conversations: [thread()], matched: 3, waiting: 2, skipped: 0,
    };
    const agentConversations = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentConversations });
    const { parsed } = await callConversations(client, {
      agent: 'agent:claude', waiting: true, state: 'waiting', job: 'RQ-9',
      waitingOn: 'agent:leader', since: '1800000000000', before: '1800000001000',
      contains: 'Build OK', limit: 10,
    });
    expect(agentConversations).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'agent:claude', waiting: true, state: 'waiting', job: 'RQ-9',
      waitingOn: 'agent:leader', since: 1800000000000, before: 1800000001000,
      contains: 'build ok', limit: 10,
    }));
    expect(parsed).toEqual(payload);
  });

  it('serves an unfiltered call with an empty argument object', async () => {
    const agentConversations = vi.fn(async () => ({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z',
      schema: 'agents.conversations.v1', version: 1, source: 'missing',
      conversations: [], matched: 0, waiting: 0, skipped: 0,
    }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentConversations });
    const { parsed } = await callConversations(client, {});
    expect(agentConversations).toHaveBeenCalledWith({});
    expect(parsed).toMatchObject({ schema: 'agents.conversations.v1', source: 'missing', conversations: [] });
  });
});
