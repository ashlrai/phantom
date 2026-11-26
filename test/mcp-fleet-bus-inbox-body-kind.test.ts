/**
 * fleet_bus_inbox `bodyKind`: the MCP raw-store read takes the same
 * busBodyKind own-field discriminator filter `phm comms bus read
 * --body-kind` and `fleet bus-follow --body-kind` apply — the v2 `kind`
 * field, a `worker-handoff` assignment, a notice kind, a v1
 * `protocol.kind` or a `type`/`schema` notice discriminator — matched
 * exactly and case-sensitively, a body carrying no discriminator never
 * matching. Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP
 * transports, fake envelopes, no daemon or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

let root: string;
const connections: Client[] = [];
const fleetRoot = () => join(root, 'fleet');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-inbox-body-kind-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function connect(readers: FleetReaders = {
  status: async () => ({ pending: 2 }),
  loop: async limit => ({ limit }),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bus-inbox-body-kind-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callInbox(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_bus_inbox', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

interface Row { cursor: number; envelope: { id: string; body: unknown } }
const rows = (parsed: Record<string, unknown>): Row[] => parsed['messages'] as Row[];

const post = (id: string, body: unknown, fields: Record<string, unknown> = {}) =>
  appendBusInbox({
    id, from: 'fake-sender', to: 'fake-worker', priority: 'P2', ttl: 10 ** 15, body, ...fields,
  }, { root: fleetRoot(), now: () => 0 });

describe('fleet_bus_inbox bodyKind filter', () => {
  it('exposes bodyKind in the tool schema beside the other read filters', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_inbox');
    expect(tool?.inputSchema.properties?.['bodyKind'])
      .toMatchObject({ type: 'string', pattern: '^[\\x21-\\x7e]{1,128}$' });
    expect(tool?.description).toContain('bodyKind');
  });

  it.each([
    [{ bodyKind: 'has space' }], [{ bodyKind: '' }], [{ bodyKind: 5 }], [{ bodyKind: null }],
    [{ bodyKind: 'x'.repeat(129) }], [{ bodyKind: 'line\nbreak' }],
  ])('rejects invalid bodyKind arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('keeps only bodies carrying the exact discriminator across every kind source', async () => {
    expect(post('v2-note', { kind: 'note', text: 'hi' }).status).toBe('posted');
    expect(post('v2-work', { kind: 'work.post', jobId: 'RQ-1', text: 'claim' }).status).toBe('posted');
    expect(post('v1-task', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, ref: 'r1' },
      { to: 'fleet.deploy' }).status).toBe('posted');
    expect(post('typed', { type: 'fleet.status', detail: 'ok' }).status).toBe('posted');
    expect(post('kindless', { fake: 'nothing here' }).status).toBe('posted');
    const client = await connect();
    const notes = await callInbox(client, { bodyKind: 'note' });
    expect(notes.parsed['filters']).toEqual({ bodyKind: 'note' });
    expect(rows(notes.parsed).map(row => row.envelope.id)).toEqual(['v2-note']);
    const tasks = await callInbox(client, { bodyKind: 'task' });
    expect(rows(tasks.parsed).map(row => row.envelope.id)).toEqual(['v1-task']);
    const status = await callInbox(client, { bodyKind: 'fleet.status' });
    expect(rows(status.parsed).map(row => row.envelope.id)).toEqual(['typed']);
    // Exact and case-sensitive: a near-miss is an honest empty page, and the
    // cursor still covers every scanned row.
    const near = await callInbox(client, { bodyKind: 'Note' });
    expect(near.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 5 });
    const work = await callInbox(client, { bodyKind: 'work.post' });
    expect(rows(work.parsed).map(row => row.envelope.id)).toEqual(['v2-work']);
  });

  it('composes with the other read filters and advances the cursor', async () => {
    expect(post('a', { kind: 'note', text: 'alpha', thread: 'job:RQ-9' }).status).toBe('posted');
    expect(post('b', { kind: 'note', text: 'beta' }).status).toBe('posted');
    expect(post('c', { kind: 'work.status', jobId: 'RQ-9', status: 'running' }).status).toBe('posted');
    const client = await connect();
    const both = await callInbox(client, { bodyKind: 'note', thread: 'job:RQ-9' });
    expect(rows(both.parsed).map(row => row.envelope.id)).toEqual(['a']);
    const jobbed = await callInbox(client, { bodyKind: 'work.status', job: 'RQ-9' });
    expect(rows(jobbed.parsed).map(row => row.envelope.id)).toEqual(['c']);
    // Filtered rows still advance nextCursor: both notes inside the limit
    // page through, then the work.status row is scanned past unseen.
    const narrowed = await callInbox(client, { bodyKind: 'note', limit: 2 });
    expect(narrowed.parsed).toMatchObject({ returnedMessages: 2, nextCursor: 2 });
    const rest = await callInbox(client, { after: narrowed.parsed['nextCursor'], bodyKind: 'note' });
    expect(rest.parsed).toMatchObject({ messages: [], nextCursor: 3 });
  });
});

describe('fleet_bus_inbox result filter', () => {
  it('exposes result in the tool schema beside the other read filters', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_inbox');
    expect(tool?.inputSchema.properties?.['result'])
      .toMatchObject({ type: 'string', enum: ['reserved', 'admitted', 'complete', 'failed'] });
    expect(tool?.description).toContain('result');
  });

  it.each([
    [{ result: 'bogus' }], [{ result: '' }], [{ result: 5 }], [{ result: null }],
    [{ result: 'COMPLETE' }], [{ result: 'P0' }],
  ])('rejects invalid result arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('keeps only work.result bodies reporting the requested outcome', async () => {
    expect(post('r-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' }).status).toBe('posted');
    expect(post('r-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' }).status).toBe('posted');
    // A work.release outcome is a different vocabulary and never matches.
    expect(post('r-release', { kind: 'work.release', claimKey: 'queue:RQ-1', outcome: 'failed' }).status).toBe('posted');
    expect(post('r-note', { kind: 'note', text: 'done', outcome: 'failed' }).status).toBe('posted');
    const client = await connect();
    const failed = await callInbox(client, { result: 'failed' });
    expect(failed.parsed['filters']).toEqual({ result: 'failed' });
    expect(rows(failed.parsed).map(row => row.envelope.id)).toEqual(['r-failed']);
    const complete = await callInbox(client, { result: 'complete' });
    expect(rows(complete.parsed).map(row => row.envelope.id)).toEqual(['r-complete']);
    const reserved = await callInbox(client, { result: 'reserved' });
    expect(reserved.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0 });
  });
});
