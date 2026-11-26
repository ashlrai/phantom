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
    expect(tool?.inputSchema.properties?.['state'])
      .toMatchObject({ type: 'string', enum: ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'] });
    expect(tool?.inputSchema.properties?.['id']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['priority'])
      .toMatchObject({ type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] });
    expect(tool?.inputSchema.properties?.['since']).toMatchObject({ type: 'string' });
    expect(tool?.inputSchema.properties?.['before']).toMatchObject({ type: 'string' });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ limit: 0 }], [{ limit: 101 }], [{ limit: 1.5 }],
    [{ limit: '5' }], [{ limit: null }], [{ thread: 5 }], [{ thread: null }],
    [{ thread: 'x'.repeat(513) }], [{ state: 'bogus' }], [{ state: 'running' }],
    [{ state: 5 }], [{ state: null }], [{ path: '/tmp/x' }], [{ command: 'read' }],
    [{ since: 5 }], [{ since: 'bogus' }], [{ since: '' }], [{ since: null }],
    [{ before: 5 }], [{ before: 'not-a-time' }], [{ before: null }],
    [{ since: '15m', before: 'bogus' }],
    [{ id: 5 }], [{ id: '' }], [{ id: 'x'.repeat(129) }], [{ id: 'bad id' }], [{ id: null }],
    [{ priority: 'bogus' }], [{ priority: 'p1' }], [{ priority: 5 }], [{ priority: null }],
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
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined, state: undefined });
    await callBoard(client, { limit: 5, thread: REF_A });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 5, thread: REF_A, state: undefined });
    await callBoard(client, { state: 'BLOCKED' });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined, state: 'BLOCKED' });
    // since/before arrive as the shared time grammar and reach the reader as
    // resolved epoch-ms bounds — relative spellings anchor on the server clock.
    await callBoard(client, { since: '15m', before: String(now + 60_000) });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined, state: undefined,
      since: now - 900_000, before: now + 60_000 });
    await callBoard(client, { since: iso(now - 1_000) });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined, state: undefined,
      since: now - 1_000, before: undefined });
    // id/priority are the shared envelope filters: validated spellings reach
    // the reader verbatim, never re-validated or widened downstream.
    await callBoard(client, { id: 'req-1', priority: 'P0' });
    expect(workBoard).toHaveBeenLastCalledWith({ limit: 20, thread: undefined, state: undefined,
      id: 'req-1', priority: 'P0' });
  });

  it('filters real board items by classified state with a true matched total', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(busRequest('bus-request-b'));
    post(busRequest('bus-request-c'));
    const { parsed } = await callBoard(await connect(), { state: 'RECEIVED', limit: 1 });
    expect(parsed['state']).toBe('RECEIVED');
    expect(parsed['matched']).toBe(3);
    expect(parsed['truncated']).toBe(true);
    const items = parsed['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!['id']).toBe('bus-request-c');
    expect(items[0]!['state']).toBe('RECEIVED');
  });

  it('filters real board items by the [since, before) receivedAt window', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(busRequest('bus-request-b'));
    post(busRequest('bus-request-c'));
    // receivedAt: a=now-3000, b=now-2000, c=now-1000 after the stepped clock.
    const client = await connect();
    const { parsed } = await callBoard(client, { since: String(now - 2_000), before: String(now - 1_000) });
    expect(parsed['matched']).toBe(1);
    expect(parsed['truncated']).toBe(false);
    const items = parsed['items'] as Array<Record<string, unknown>>;
    expect(items.map(item => item['id'])).toEqual(['bus-request-b']);
    // `since` alone is inclusive and still reports the true filtered total.
    const tail = await callBoard(client, { since: String(now - 2_000) });
    expect(tail.parsed['matched']).toBe(2);
    expect((tail.parsed['items'] as Array<Record<string, unknown>>).map(item => item['id']))
      .toEqual(['bus-request-c', 'bus-request-b']);
  });

  it('filters real board items by envelope id and priority band with a true matched total', async () => {
    post(slackRequest('slack-request-a', REF_A));
    post(busRequest('bus-request-b'));
    post(busRequest('bus-request-c'));
    const client = await connect();
    // slackRequest is P2, busRequest is P1: the band keeps its own stamps.
    const urgent = await callBoard(client, { priority: 'P1' });
    expect(urgent.parsed['matched']).toBe(2);
    const urgentItems = urgent.parsed['items'] as Array<Record<string, unknown>>;
    expect(urgentItems.map(item => item['id'])).toEqual(['bus-request-c', 'bus-request-b']);
    expect(urgentItems.every(item => item['priority'] === 'P1')).toBe(true);
    const one = await callBoard(client, { id: 'slack-request-a' });
    expect(one.parsed['matched']).toBe(1);
    const oneItems = one.parsed['items'] as Array<Record<string, unknown>>;
    expect(oneItems.map(item => item['id'])).toEqual(['slack-request-a']);
    expect(oneItems[0]!['priority']).toBe('P2');
    const none = await callBoard(client, { priority: 'P3' });
    expect(none.parsed['matched']).toBe(0);
    expect(none.parsed['items']).toEqual([]);
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
