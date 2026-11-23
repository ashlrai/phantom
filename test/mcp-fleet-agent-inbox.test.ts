/**
 * fleet_agent_inbox: the per-agent addressed bus inbox over the isolated
 * fleet MCP server — the same readAgentInbox projection `phm agents bus
 * inbox` and `work mine`'s inbox section serve, with every filter validated
 * before any store read and non-ok pages passed through untouched.
 *
 * Hermetic: injected readers, in-memory MCP transports, canned inbox pages,
 * no bus store, registry, hold table or feed access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  FLEET_AGENT_INBOX_LIMIT_DEFAULT, FLEET_AGENT_INBOX_LIMIT_MAX,
  parseFleetAgentInboxArgs, readFleetAgentInbox, type FleetAgentInboxArgs,
} from '../src/mcp/fleet-agent-inbox.js';
import { readAgentInbox, type InboxMessage, type InboxPage } from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const message = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  cursor: 7, receivedAt: 1_800_000_000_000, kind: 'dm', priority: 'P2',
  fromAgent: 'sender', channel: null,
  envelope: {
    id: 'm-1', from: 'agent:sender', to: 'agent:planner', priority: 'P2', ttl: 60_000,
    body: { kind: 'note', text: 'ping' },
  },
  ...over,
});

const okPage = (over: Partial<Extract<InboxPage, { status: 'ok' }>> = {}): InboxPage => ({
  status: 'ok', agent: 'planner', messages: [message()], nextCursor: 9, ...over,
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
  const client = new Client({ name: 'agent-inbox-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callInbox(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_inbox', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_inbox argument parsing', () => {
  it('requires agent and defaults the page bounds', () => {
    expect(parseFleetAgentInboxArgs({ agent: 'planner' })).toEqual({
      agent: 'planner', after: 0, limit: FLEET_AGENT_INBOX_LIMIT_DEFAULT, matched: false, filters: {},
    });
    expect(FLEET_AGENT_INBOX_LIMIT_DEFAULT).toBe(50);
    expect(FLEET_AGENT_INBOX_LIMIT_MAX).toBe(100);
  });

  it('rejects a missing or malformed agent ref before any read', () => {
    for (const bad of [{}, { agent: 5 }, { agent: '' }, { agent: 'has space' },
      { agent: 'x'.repeat(129) }, { agent: null }, { agent: true }]) {
      expect(parseFleetAgentInboxArgs(bad)).toBeNull();
    }
  });

  it('accepts the cursor, limit and matched bounds and rejects the rest', () => {
    expect(parseFleetAgentInboxArgs({ agent: 'a', after: 12, limit: 1, matched: true }))
      .toMatchObject({ after: 12, limit: 1, matched: true });
    expect(parseFleetAgentInboxArgs({ agent: 'a', limit: 100, matched: false }))
      .toMatchObject({ limit: 100, matched: false });
    for (const bad of [{ after: -1 }, { after: 1.5 }, { after: '3' }, { after: null },
      { limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: '5' }, { limit: null },
      { matched: 'yes' }, { matched: 1 }, { matched: null }]) {
      expect(parseFleetAgentInboxArgs({ agent: 'a', ...bad })).toBeNull();
    }
  });

  it('maps every shared inbox filter onto the page fields', () => {
    const parsed = parseFleetAgentInboxArgs({
      agent: 'agent:planner', after: 3, limit: 10, matched: true,
      thread: 't-1', from: 'agent:sender', excludeFrom: 'agent:bot',
      priority: 'P1', kind: 'handoff', job: 'RQ-9',
      since: '1800000000000', channel: 'ops', contains: '  Parser   Fix ',
    });
    expect(parsed).toMatchObject({
      agent: 'agent:planner', after: 3, limit: 10, matched: true,
      filters: {
        thread: 't-1', from: 'agent:sender', excludeFrom: 'agent:bot',
        priority: 'P1', kind: 'handoff', job: 'RQ-9',
        since: 1800000000000, channel: 'ops', contains: 'parser fix',
      },
    });
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { agent: 'a', extra: 1 }, { agent: 'a', root: '/tmp/fake' }, { agent: 'a', path: '/tmp/x' },
      { agent: 'a', cwd: '/tmp' }, { agent: 'a', runsDir: '/tmp' }, { agent: 'a', home: '/tmp' },
      { agent: 'a', thread: 'has space' }, { agent: 'a', thread: '' }, { agent: 'a', thread: 5 },
      { agent: 'a', from: 5 }, { agent: 'a', excludeFrom: null }, { agent: 'a', job: 'has space' },
      { agent: 'a', priority: 'P9' }, { agent: 'a', priority: 1 }, { agent: 'a', priority: 'p0' },
      { agent: 'a', kind: 'bogus' }, { agent: 'a', kind: 'work' }, { agent: 'a', kind: 3 },
      { agent: 'a', channel: 'Bad Channel!' }, { agent: 'a', channel: 'x'.repeat(33) },
      { agent: 'a', channel: 7 },
      { agent: 'a', since: 'never' }, { agent: 'a', since: 5 }, { agent: 'a', since: '' },
      { agent: 'a', contains: '' }, { agent: 'a', contains: '   ' },
      { agent: 'a', contains: 'x'.repeat(513) }, { agent: 'a', contains: 42 },
    ]) expect(parseFleetAgentInboxArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_inbox reader', () => {
  it('runs the shared read with the parsed page and reports the resolved agent', async () => {
    const seen: Array<[string, unknown]> = [];
    const read: typeof readAgentInbox = (ref, page) => {
      seen.push([ref, page]);
      return okPage({ matched: 1 });
    };
    const result = await readFleetAgentInbox(
      parseFleetAgentInboxArgs({ agent: 'planner', after: 4, limit: 10, matched: true, kind: 'handoff' })!,
      { read });
    expect(seen).toEqual([['planner', { after: 4, limit: 10, matched: true, kind: 'handoff' }]]);
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      agent: 'planner', status: 'ok', nextCursor: 9, matched: 1,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports the newest shown cursor as nextCursor when matched hides rows', async () => {
    // A matched page scans the whole store, so the core nextCursor is the
    // store's end — resuming there would skip the unshown matches. The
    // adapter reports the same honest resume point the CLI does.
    const read: typeof readAgentInbox = () => okPage({
      matched: 3,
      messages: [message({ cursor: 4 }), message({ cursor: 7 })],
      nextCursor: 9,
    });
    const result = await readFleetAgentInbox(
      parseFleetAgentInboxArgs({ agent: 'planner', matched: true })!, { read });
    expect(result).toMatchObject({ status: 'ok', matched: 3, nextCursor: 7 });
    expect(result.messages).toHaveLength(2);
  });

  it('keeps the store-end cursor when every match fits the page', async () => {
    const read: typeof readAgentInbox = () => okPage({
      matched: 2,
      messages: [message({ cursor: 4 }), message({ cursor: 7 })],
    });
    const result = await readFleetAgentInbox(
      parseFleetAgentInboxArgs({ agent: 'planner', matched: true })!, { read });
    expect(result).toMatchObject({ status: 'ok', matched: 2, nextCursor: 9 });
  });

  it('omits matched when the page did not count the whole store', async () => {
    const read: typeof readAgentInbox = () => okPage();
    const result = await readFleetAgentInbox(parseFleetAgentInboxArgs({ agent: 'planner' })!, { read });
    expect(result.status).toBe('ok');
    expect(result.matched).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });

  it('forwards every parsed filter into the shared page read', async () => {
    let seenPage: Record<string, unknown> | undefined;
    const read: typeof readAgentInbox = (_ref, page) => {
      seenPage = page as Record<string, unknown>;
      return okPage({ messages: [] });
    };
    await readFleetAgentInbox(parseFleetAgentInboxArgs({
      agent: 'a', since: '1800000000000', contains: 'Parser Fix', channel: 'ops',
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot',
      priority: 'P0', kind: 'channel', job: 'RQ-1',
    })!, { read });
    expect(seenPage).toMatchObject({
      since: 1800000000000, contains: 'parser fix', channel: 'ops',
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot',
      priority: 'P0', kind: 'channel', job: 'RQ-1',
    });
  });

  it.each([
    { status: 'invalid', reason: 'Invalid thread label.' },
    { status: 'unknown-agent', reason: 'Agent is not a registered identity.' },
    { status: 'unavailable', reason: 'Bus store is not readable.' },
    { status: 'retryable', reason: 'Owner share receipt pending.' },
  ] as const)('passes a refused page through untouched: %j', async page => {
    const read: typeof readAgentInbox = () => page;
    const result = await readFleetAgentInbox(parseFleetAgentInboxArgs({ agent: 'ghost' })!, { read });
    expect(result).toMatchObject({ agent: 'ghost', status: page.status, reason: page.reason });
    expect(result.messages).toBeUndefined();
    expect(result.nextCursor).toBeUndefined();
    expect(result.matched).toBeUndefined();
  });
});

describe('fleet_agent_inbox MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_inbox');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['agent'] });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
    expect(tool?.inputSchema.properties?.['kind'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['dm', 'channel', 'handoff', 'legacy']) });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['P0', 'P3']) });
    expect(tool?.inputSchema.properties?.['matched']).toMatchObject({ type: 'boolean' });
  });

  it.each([
    [{}], [{ agent: '' }], [{ agent: 'has space' }], [{ agent: 5 }],
    [{ agent: 'a', root: '/tmp/fake-root' }], [{ agent: 'a', path: '/tmp/x' }], [{ agent: 'a', cwd: '/tmp' }],
    [{ agent: 'a', limit: 0 }], [{ agent: 'a', limit: 101 }], [{ agent: 'a', limit: '5' }],
    [{ agent: 'a', after: -1 }], [{ agent: 'a', matched: 'yes' }],
    [{ agent: 'a', kind: 'bogus' }], [{ agent: 'a', priority: 'P9' }],
    [{ agent: 'a', channel: 'Bad Channel!' }], [{ agent: 'a', since: 'never' }],
    [{ agent: 'a', contains: '' }], [{ agent: 'a', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentInbox });
    await expect(client.callTool({ name: 'fleet_agent_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentInbox).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', agent: 'planner', status: 'ok',
      messages: [message()], nextCursor: 9, matched: 3,
    };
    const agentInbox = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentInbox });
    const { parsed } = await callInbox(client, { agent: 'planner', kind: 'handoff', limit: 10, matched: true });
    expect(agentInbox).toHaveBeenCalledWith(expect.objectContaining({ agent: 'planner', limit: 10, matched: true }));
    const filters = (agentInbox.mock.calls[0]![0] as FleetAgentInboxArgs).filters;
    expect(filters).toMatchObject({ kind: 'handoff' });
    expect(parsed).toEqual(payload);
  });
});
