/**
 * RQ-PHX-WORKBOARDMCP318 — fleet_work_board: an MCP worker reads the shared
 * coordination work board (RECEIVED / ASSIGNED / RUNNING / BLOCKED / VERIFIED
 * per request) through the isolated fleet MCP server — the same listWorkBoard
 * listing as `ashlr fleet work-board`, never a second classifier.
 *
 * Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP transports, fake
 * envelopes, no daemon, transport, or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';

let root: string, now: number;
const connections: Client[] = [];
const fleetRoot = () => join(root, 'fleet');
const TTL = 10_000_000;
const REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const REF_B = 'T0FAKEWS/C0FAKECH/1700000000.000002';
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-work-board-318-'));
  vi.stubEnv('ASHLR_HOME', root);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Real protocol round trip; workBoard defaults to the canonical board reader. */
async function connect(readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'work-board-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callBoard(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_work_board', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'slack-coordination', text: 'fake request text' },
});
const busRequest = (id: string, body: BusEnvelope['body'] = { kind: 'work' }): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL, body,
});
/** Posts at the fake clock, then steps it forward so receivedAt orders strictly. */
const post = (envelope: BusEnvelope) => {
  expect(appendBusInbox(envelope, { root: fleetRoot(), now: () => now }).status).toBe('posted');
  now += 1_000;
};

describe('RQ-PHX-WORKBOARDMCP318 fleet_work_board MCP tool', () => {
  it('is listed beside the existing read-only tools with a bounded schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_work_board');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('dispatch, claim or merge authority');
    expect(tool?.description).toContain('never includes message bodies');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['limit'])
      .toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 20 });
    expect(tool?.inputSchema.properties?.['thread']).toMatchObject({ type: 'string', maxLength: 512 });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ limit: 0 }], [{ limit: 101 }], [{ limit: 1.5 }],
    [{ limit: '5' }], [{ limit: null }], [{ thread: 5 }], [{ thread: null }],
    [{ thread: 'x'.repeat(513) }], [{ path: '/tmp/x' }], [{ command: 'read' }],
    [{ extra: 1 }], [{ limit: 1, root: '/tmp/fake-root' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const workBoard = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workBoard });
    await expect(client.callTool({ name: 'fleet_work_board', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(workBoard).not.toHaveBeenCalled();
  });

  it('passes validated arguments with schema defaults to the injected reader', async () => {
    const workBoard = vi.fn(async () => ({ fake: 'board' }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workBoard });
    const { parsed } = await callBoard(client);
    expect(parsed).toEqual({ fake: 'board' });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined });
    await callBoard(client, { limit: 5, thread: REF_A });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 5, thread: REF_A });
  });

  it('reports an empty board on an empty store, never inventing items', async () => {
    const { parsed } = await callBoard(await connect());
    expect(parsed['items']).toEqual([]);
    expect(parsed['truncated']).toBe(false);
    expect(['ok', 'unavailable']).toContain(parsed['inbox']);
    expect(parsed['asOf']).toBe(iso(now));
  });

  it('lists two requests newest first while a reply never becomes an item', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(slackRequest('slack-request-b', REF_B));
    expect(postBusReply('slack-request-a', 'fake-reply-1', { text: 'fake ack' },
      { root: fleetRoot(), now: () => now }).outcome).toBe('posted');
    const { parsed } = await callBoard(await connect());
    expect(parsed['inbox']).toBe('ok');
    expect(parsed['truncated']).toBe(false);
    expect(parsed['asOf']).toBe(iso(now));
    const items = parsed['items'] as Array<Record<string, unknown>>;
    expect(items.map(item => item['id'])).toEqual(['slack-request-b', 'slack-request-a']);
    expect(items.map(item => item['receivedAt'])).toEqual([iso(now - 1_000), iso(now - 2_000)]);
    expect(items[0]).toMatchObject({
      state: 'RECEIVED', channel: 'slack', channelRef: REF_B,
      asOf: iso(now - 1_000), source: 'receivedAt',
      missing: ['named owner', 'durable claim receipt'],
    });
  });

  it('honours limit with a truncated flag', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(busRequest('bus-request-c'));
    const { parsed } = await callBoard(await connect(), { limit: 1 });
    const items = parsed['items'] as Array<Record<string, unknown>>;
    expect(items.map(item => item['id'])).toEqual(['bus-request-c']);
    expect(parsed['truncated']).toBe(true);
    expect(parsed['inbox']).toBe('ok');
  });

  it('filters to one exact channel_ref thread', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(slackRequest('slack-request-b', REF_B));
    post(busRequest('bus-request-c'));
    const client = await connect();
    const filtered = await callBoard(client, { thread: REF_A });
    const items = filtered.parsed['items'] as Array<Record<string, unknown>>;
    expect(items.map(item => item['id'])).toEqual(['slack-request-a']);
    expect(items[0]!['channelRef']).toBe(REF_A);
    const unmatched = await callBoard(client, { thread: 'T0FAKEWS/C0FAKECH/9999999999.000099' });
    expect(unmatched.parsed['items']).toEqual([]);
    expect(unmatched.parsed['inbox']).toBe('ok');
  });

  it('never includes body text: a sentinel body stays out of the response', async () => {
    const sentinel = 'FAKE-SENTINEL-BODY-7f3a9c-never-shown';
    post(busRequest('carrier', { kind: 'work', text: `do the thing ${sentinel}` }));
    const { parsed, text } = await callBoard(await connect());
    expect(text).not.toContain(sentinel);
    const items = parsed['items'] as Array<Record<string, unknown>>;
    expect(items.map(item => item['id'])).toEqual(['carrier']);
    expect(items[0]).not.toHaveProperty('body');
    expect(items[0]).toMatchObject({ state: 'RECEIVED', channel: 'bus', channelRef: null });
  });
});
