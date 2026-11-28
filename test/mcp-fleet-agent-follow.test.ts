/**
 * fleet_agent_follow: the bounded addressed-inbox watch over the isolated
 * fleet MCP server — the same followAgentBus projection `phm agents bus
 * follow` streams, collected into one bounded call where fleet_agent_inbox
 * answers one page. Every argument validates before the follower runs and
 * the result keeps the follower's own terminal status plus the record-bound
 * `limit` outcome.
 *
 * Hermetic: injected readers and an injected follower, in-memory MCP
 * transports, canned follow results, no bus store, registry or hold access.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import {
  MAX_FLEET_AGENT_FOLLOW_MS, MAX_FLEET_AGENT_FOLLOW_RECORDS,
  parseFleetAgentFollowArgs, readFleetAgentFollow, type FleetAgentFollowArgs,
} from '../src/mcp/fleet-agent-follow.js';
import {
  followAgentBus,
  type AgentBusFollowMessage, type AgentBusFollowRecord, type AgentBusFollowRequest,
  type AgentBusFollowResult,
} from '../src/core/agents/bus-follow.js';
import type { InboxMessage } from '../src/core/agents/bus-unified.js';

const connections: Client[] = [];

const inboxMessage = (over: Partial<InboxMessage> = {}): InboxMessage => ({
  cursor: 7, receivedAt: 1_800_000_000_000, kind: 'dm', priority: 'P2',
  fromAgent: 'sender', channel: null,
  envelope: {
    id: 'm-1', from: 'agent:sender', to: 'agent:planner', priority: 'P2', ttl: 60_000,
    body: { kind: 'note', text: 'ping' },
  },
  ...over,
});

const followMessage = (over: Partial<AgentBusFollowMessage> = {}): AgentBusFollowMessage => ({
  type: 'message', ...inboxMessage(), summary: 'ping', ...over,
});

const checkpoint = (cursor: number): AgentBusFollowRecord => ({ type: 'checkpoint', cursor });

/** A follower that emits the given records then reports the canned result. */
const fakeFollow = (
  records: AgentBusFollowRecord[],
  result: Partial<AgentBusFollowResult> = {},
): typeof followAgentBus =>
  async (_request, _options, deps) => {
    for (const record of records) await deps.emit(record);
    const delivered = records.filter(record => record.type === 'message').length;
    return { status: 'expired', cursor: 9, delivered, elapsedMs: 5, ...result };
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
  const client = new Client({ name: 'agent-follow-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callFollow(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_agent_follow', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_agent_follow argument parsing', () => {
  it('requires agent and durationMs and defaults the resume cursor', () => {
    expect(parseFleetAgentFollowArgs({ agent: 'planner', durationMs: 5_000 })).toEqual({
      agent: 'planner', after: 0, durationMs: 5_000, filters: {},
    });
    expect(MAX_FLEET_AGENT_FOLLOW_MS).toBe(60_000);
    expect(MAX_FLEET_AGENT_FOLLOW_RECORDS).toBe(200);
  });

  it('rejects a missing agent, a missing durationMs and malformed values', () => {
    for (const bad of [
      {}, { durationMs: 5_000 }, { agent: 'planner' },
      { agent: 5, durationMs: 1 }, { agent: '', durationMs: 1 }, { agent: 'has space', durationMs: 1 },
      { agent: 'a', durationMs: 0 }, { agent: 'a', durationMs: -1 }, { agent: 'a', durationMs: 60_001 },
      { agent: 'a', durationMs: 1.5 }, { agent: 'a', durationMs: '5000' }, { agent: 'a', durationMs: null },
      { agent: 'a', durationMs: true },
    ]) expect(parseFleetAgentFollowArgs(bad)).toBeNull();
  });

  it('bounds the optional cursor and poll interval', () => {
    expect(parseFleetAgentFollowArgs({ agent: 'a', durationMs: 1_000, after: 12, intervalMs: 250 }))
      .toMatchObject({ after: 12, intervalMs: 250 });
    for (const bad of [
      { after: -1 }, { after: 1.5 }, { after: '3' }, { after: null },
      { intervalMs: 0 }, { intervalMs: 99 }, { intervalMs: 60_001 }, { intervalMs: 1.5 }, { intervalMs: '250' },
    ]) expect(parseFleetAgentFollowArgs({ agent: 'a', durationMs: 1_000, ...bad })).toBeNull();
  });

  it('maps every shared inbox filter onto the page fields', () => {
    const parsed = parseFleetAgentFollowArgs({
      agent: 'agent:planner', durationMs: 2_000, after: 3, intervalMs: 100,
      thread: 't-1', from: 'agent:sender', excludeFrom: 'agent:bot', with: 'agent:peer',
      priority: 'P1', kind: 'handoff', job: 'RQ-9',
      since: '1800000000000', before: '1700000000000', channel: 'ops', topic: 'deploy', contains: '  Parser   Fix ',
      inReplyTo: 'm-0', id: 'm-9', bodyKind: 'work.result', result: 'failed',
    });
    expect(parsed).toMatchObject({
      agent: 'agent:planner', after: 3, durationMs: 2_000, intervalMs: 100,
      filters: {
        thread: 't-1', from: 'agent:sender', excludeFrom: 'agent:bot', with: 'agent:peer',
        priority: 'P1', kind: 'handoff', job: 'RQ-9',
        since: 1800000000000, before: 1700000000000, channel: 'ops', topic: 'deploy', contains: 'parser fix',
        inReplyTo: 'm-0', id: 'm-9', bodyKind: 'work.result', result: 'failed',
      },
    });
  });

  it('rejects unknown keys, caller roots and malformed filter values', () => {
    for (const bad of [
      { agent: 'a', durationMs: 1, extra: 1 }, { agent: 'a', durationMs: 1, root: '/tmp/fake' },
      { agent: 'a', durationMs: 1, path: '/tmp/x' }, { agent: 'a', durationMs: 1, cwd: '/tmp' },
      { agent: 'a', durationMs: 1, runsDir: '/tmp' }, { agent: 'a', durationMs: 1, home: '/tmp' },
      { agent: 'a', durationMs: 1, thread: 'has space' }, { agent: 'a', durationMs: 1, thread: '' },
      { agent: 'a', durationMs: 1, priority: 'P9' }, { agent: 'a', durationMs: 1, kind: 'bogus' },
      { agent: 'a', durationMs: 1, result: 'bogus' }, { agent: 'a', durationMs: 1, channel: 'Bad Channel!' },
      { agent: 'a', durationMs: 1, topic: 'Bad Topic' }, { agent: 'a', durationMs: 1, topic: 'deploy:extra' },
      { agent: 'a', durationMs: 1, topic: '' }, { agent: 'a', durationMs: 1, topic: 'x'.repeat(33) },
      { agent: 'a', durationMs: 1, since: 'never' }, { agent: 'a', durationMs: 1, before: 'never' },
      { agent: 'a', durationMs: 1, contains: '' }, { agent: 'a', durationMs: 1, contains: '   ' },
      { agent: 'a', durationMs: 1, id: 'has space' }, { agent: 'a', durationMs: 1, inReplyTo: 5 },
    ]) expect(parseFleetAgentFollowArgs(bad)).toBeNull();
  });
});

describe('fleet_agent_follow reader', () => {
  it('runs the shared follower with the parsed request and collects message records', async () => {
    let seenRequest: AgentBusFollowRequest | undefined;
    const follow: typeof followAgentBus = async (request, _options, deps) => {
      seenRequest = request;
      await deps.emit(followMessage({ cursor: 3 }));
      await deps.emit(checkpoint(4));
      await deps.emit(followMessage({ cursor: 8, summary: 'second' }));
      return { status: 'expired', cursor: 9, delivered: 2, elapsedMs: 7 };
    };
    const result = await readFleetAgentFollow(
      parseFleetAgentFollowArgs({ agent: 'planner', durationMs: 5_000, after: 4, intervalMs: 250, kind: 'dm' })!,
      undefined, { follow });
    expect(seenRequest).toMatchObject({
      agent: 'planner', after: 4, durationMs: 5_000, intervalMs: 250, kind: 'dm',
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      agent: 'planner', outcome: 'expired', cursor: 9, delivered: 2, elapsedMs: 7,
    });
    // Checkpoint records are cursor bookkeeping — never returned as payload.
    expect(result.records).toHaveLength(2);
    expect(result.records.map(record => record.summary)).toEqual(['ping', 'second']);
    expect(result.records.every(record => record.type === 'message')).toBe(true);
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.note).toContain('cursor');
  });

  it('forwards every parsed filter into the follower request', async () => {
    let seenRequest: AgentBusFollowRequest | undefined;
    const follow: typeof followAgentBus = async (request, _options, deps) => {
      seenRequest = request;
      await deps.emit(checkpoint(1));
      return { status: 'expired', cursor: 1, delivered: 0, elapsedMs: 1 };
    };
    await readFleetAgentFollow(parseFleetAgentFollowArgs({
      agent: 'a', durationMs: 1_000,
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot', with: 'agent:peer',
      priority: 'P0', kind: 'channel', job: 'RQ-1', since: '1800000000000', before: '1700000000000',
      channel: 'ops', topic: 'deploy', contains: 'Parser Fix', inReplyTo: 'm-0', id: 'm-9', bodyKind: 'wake', result: 'complete',
    })!, undefined, { follow });
    expect(seenRequest).toMatchObject({
      agent: 'a', durationMs: 1_000,
      thread: 't-9', from: 'agent:sender', excludeFrom: 'agent:bot', with: 'agent:peer',
      priority: 'P0', kind: 'channel', job: 'RQ-1', since: 1800000000000, before: 1700000000000,
      channel: 'ops', topic: 'deploy', contains: 'parser fix', inReplyTo: 'm-0', id: 'm-9', bodyKind: 'wake', result: 'complete',
    });
  });

  it('reports limit and a bounded record slice when the watch emits past the record bound', async () => {
    const records: AgentBusFollowRecord[] = [];
    for (let i = 0; i < MAX_FLEET_AGENT_FOLLOW_RECORDS + 5; i += 1) {
      records.push(followMessage({ cursor: i + 1, summary: `m${i}` }));
    }
    const result = await readFleetAgentFollow(
      parseFleetAgentFollowArgs({ agent: 'planner', durationMs: 60_000 })!,
      undefined, { follow: fakeFollow(records, { status: 'cancelled', cursor: 205, delivered: 205, elapsedMs: 3 }) });
    expect(result.outcome).toBe('limit');
    expect(result.records).toHaveLength(MAX_FLEET_AGENT_FOLLOW_RECORDS);
    // delivered is the follower's own accepted count — honest that more were emitted than returned.
    expect(result.delivered).toBe(MAX_FLEET_AGENT_FOLLOW_RECORDS + 5);
    expect(result.cursor).toBe(205);
  });

  it.each([
    'expired', 'cancelled', 'source-unavailable', 'output-unavailable', 'invalid', 'unknown-agent',
  ] as const)('passes the follower terminal status through as outcome: %s', async status => {
    const result = await readFleetAgentFollow(
      parseFleetAgentFollowArgs({ agent: 'ghost', durationMs: 1_000 })!,
      undefined, { follow: fakeFollow([], { status, cursor: 0, delivered: 0, elapsedMs: 1 }) });
    expect(result.outcome).toBe(status);
    expect(result.records).toEqual([]);
  });
});

describe('fleet_agent_follow MCP tool', () => {
  it('is advertised read-only beside the bus reads with the shared filter schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_agent_follow');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['agent', 'durationMs'] });
    expect(tool?.inputSchema.properties?.['durationMs'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 60_000 });
    expect(tool?.inputSchema.properties?.['intervalMs'])
      .toMatchObject({ type: 'integer', minimum: 100, maximum: 60_000 });
    expect(tool?.inputSchema.properties?.['kind'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['dm', 'channel', 'handoff', 'legacy']) });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['P0', 'P3']) });
    expect(tool?.inputSchema.properties?.['result'])
      .toMatchObject({ type: 'string', enum: expect.arrayContaining(['reserved', 'admitted', 'complete', 'failed']) });
    expect(tool?.inputSchema.properties?.['with']).toMatchObject({ type: 'string' });
  });

  it('is documented in the fleet MCP tools table', () => {
    const md = readFileSync(new URL('../docs/MCP-TOOLS.md', import.meta.url), 'utf8');
    expect(md).toMatch(/^\| phantom-fleet \| `fleet_agent_follow` \|/m);
  });

  it.each([
    [{}], [{ agent: 'planner' }], [{ durationMs: 1_000 }],
    [{ agent: '', durationMs: 1 }], [{ agent: 'has space', durationMs: 1 }], [{ agent: 5, durationMs: 1 }],
    [{ agent: 'a', durationMs: 0 }], [{ agent: 'a', durationMs: 60_001 }], [{ agent: 'a', durationMs: '5000' }],
    [{ agent: 'a', durationMs: 1, intervalMs: 99 }], [{ agent: 'a', durationMs: 1, intervalMs: 60_001 }],
    [{ agent: 'a', durationMs: 1, root: '/tmp/fake-root' }], [{ agent: 'a', durationMs: 1, path: '/tmp/x' }],
    [{ agent: 'a', durationMs: 1, cwd: '/tmp' }], [{ agent: 'a', durationMs: 1, kind: 'bogus' }],
    [{ agent: 'a', durationMs: 1, priority: 'P9' }], [{ agent: 'a', durationMs: 1, result: 'bogus' }],
    [{ agent: 'a', durationMs: 1, channel: 'Bad Channel!' }], [{ agent: 'a', durationMs: 1, since: 'never' }],
    [{ agent: 'a', durationMs: 1, contains: '' }], [{ agent: 'a', durationMs: 1, extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const agentFollow = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentFollow });
    await expect(client.callTool({ name: 'fleet_agent_follow', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(agentFollow).not.toHaveBeenCalled();
  });

  it('passes validated arguments to the injected reader and returns its projection', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: '2026-01-01T00:00:00.000Z', agent: 'planner', outcome: 'expired',
      cursor: 9, delivered: 2, elapsedMs: 7, records: [followMessage()], note: 'n',
    };
    const agentFollow = vi.fn(async (_input: FleetAgentFollowArgs, _signal?: AbortSignal) => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), agentFollow });
    const { parsed } = await callFollow(client, { agent: 'planner', durationMs: 5_000, kind: 'dm', after: 2 });
    expect(agentFollow).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'planner', durationMs: 5_000, after: 2 }),
      expect.any(AbortSignal),
    );
    const filters = agentFollow.mock.calls[0]![0].filters;
    expect(filters).toMatchObject({ kind: 'dm' });
    expect(parsed).toEqual(payload);
  });
});
