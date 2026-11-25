/**
 * RQ-PHX-MCPDURABLEINBOXRECUT31 — fleet_bus_inbox: an MCP worker consumes real
 * durable bus messages by cursor through the isolated fleet MCP server, not
 * just send-attempt hop metadata. The tool reuses the canonical bus inbox
 * (src/core/fleet/bus-inbox.ts) behind the same private root as
 * `phm comms bus`; nothing else about the server changes.
 *
 * Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP transports, fake
 * envelopes, no daemon, transport, or provider calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readFleetBusInbox } from '../src/mcp/fleet-inbox.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';

let root: string;
const connections: Client[] = [];
const fleetRoot = () => join(root, 'fleet');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-inbox-'));
  vi.stubEnv('ASHLR_HOME', root);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** Real protocol round trip; busInbox defaults to the canonical store reader. */
async function connect(readers: FleetReaders = {
  status: async () => ({ pending: 2 }),
  loop: async limit => ({ limit }),
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'bus-inbox-test', version: '1.0.0' });
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

interface Row { cursor: number; receivedAt: number; envelope: {
  id: string; from: string; to: string; priority: string; ttl: number; body: unknown;
} }

const rows = (parsed: Record<string, unknown>): Row[] => parsed['messages'] as Row[];

const message = (id: string, fields: Record<string, unknown> = {}) => ({
  id, from: 'fake-sender', to: 'fake-worker', priority: 'P2', ttl: 10 ** 15,
  body: { fake: `body-${id}` }, ...fields,
});
/** receivedAt 0 + huge ttl keeps envelopes live under the real Date.now clock. */
const post = (id: string, fields: Record<string, unknown> = {}, now: () => number = () => 0) =>
  appendBusInbox(message(id, fields), { root: fleetRoot(), now });

describe('RQ-PHX-MCPDURABLEINBOXRECUT31 fleet_bus_inbox MCP tool', () => {
  it('is listed beside the existing read-only tools with a bounded schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_inbox');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('untrusted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool?.inputSchema.properties?.['after']).toMatchObject({ type: 'integer', minimum: 0 });
    expect(tool?.inputSchema.properties?.['limit']).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
  });

  it.each([
    [{ after: -1 }], [{ after: 1.5 }], [{ after: '1' }], [{ after: null }], [{ after: true }],
    [{ limit: 0 }], [{ limit: 101 }], [{ limit: 1.5 }], [{ limit: '5' }], [{ limit: null }],
    [{ to: 5 }], [{ to: null }], [{ to: '' }], [{ to: 'has space' }],
    [{ from: {} }], [{ from: 'line\nbreak' }],
    [{ id: 'has space' }], [{ id: 5 }], [{ id: null }],
    [{ inReplyTo: '' }], [{ inReplyTo: 'line\nbreak' }],
    [{ excludeFrom: 'has space' }], [{ excludeFrom: 5 }],
    [{ priority: 'P9' }], [{ priority: 'p0' }], [{ priority: 0 }], [{ priority: null }],
    [{ kind: 'bogus' }], [{ kind: 'TASK' }], [{ kind: 5 }],
    [{ topic: 'not a topic' }], [{ topic: 'fleetx.*' }], [{ topic: 'fleet..deploy' }], [{ topic: 5 }],
    [{ thread: 'has space' }], [{ thread: 'x'.repeat(129) }], [{ thread: '' }],
    [{ job: 'has space' }], [{ job: '' }], [{ job: 'x'.repeat(129) }],
    [{ channel: 'Eng' }], [{ channel: 'has space' }], [{ channel: 'x'.repeat(33) }],
    [{ channel: '-lead' }], [{ channel: 'group:eng' }], [{ channel: 'eng:general' }],
    [{ channel: '' }], [{ channel: 5 }], [{ channel: null }],
    [{ since: 'not-a-time' }], [{ since: '' }], [{ since: 1735689600000 }], [{ since: '999999d' }], [{ since: null }],
    [{ before: 'not-a-time' }], [{ before: '' }], [{ before: 1735689600000 }], [{ before: '999999d' }], [{ before: null }],
    [{ contains: '' }], [{ contains: '   ' }], [{ contains: 'x'.repeat(513) }], [{ contains: 42 }],
    [{ result: 'done' }], [{ result: 'Complete' }], [{ result: 'released' }], [{ result: '' }],
    [{ result: 5 }], [{ result: null }], [{ result: {} }],
    [{ after: 0, extra: 1 }], [{ path: '/tmp/x' }], [{ command: 'read' }], [{ file: 'x' }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('rejects unknown tool names and non-object arguments', async () => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_send' })).rejects.toMatchObject({ code: -32602 });
    // The SDK's request schema refuses non-record `arguments` before dispatch.
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: [1, 2] as unknown as Record<string, unknown> }))
      .rejects.toMatchObject({ code: -32603 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('passes validated arguments with schema defaults to the injected reader', async () => {
    const busInbox = vi.fn(async () => ({ fake: 'page' }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await client.callTool({ name: 'fleet_bus_inbox' });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 0, limit: 50, to: undefined, from: undefined });
    await client.callTool({ name: 'fleet_bus_inbox', arguments: { after: 3, limit: 5, to: 'w', from: 'a' } });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 3, limit: 5, to: 'w', from: 'a' });
    await client.callTool({ name: 'fleet_bus_inbox', arguments: { priority: 'P1', job: 'RQ-1', contains: 'Fake' } });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 0, limit: 50, to: undefined, from: undefined,
      filters: { priority: 'P1', job: 'RQ-1', contains: 'fake' } });
    await client.callTool({ name: 'fleet_bus_inbox', arguments: { channel: 'eng' } });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 0, limit: 50, to: undefined, from: undefined,
      filters: { channel: 'eng' } });
    await client.callTool({ name: 'fleet_bus_inbox', arguments: { result: 'complete' } });
    expect(busInbox).toHaveBeenLastCalledWith({ after: 0, limit: 50, to: undefined, from: undefined,
      filters: { result: 'complete' } });
  });

  it('reads durable envelopes with bodies by cursor and resumes without replay', async () => {
    for (const id of ['m1', 'm2', 'm3', 'm4']) expect(post(id).status).toBe('posted');
    const client = await connect();
    const first = await callInbox(client, { limit: 2 });
    expect(first.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 2, nextCursor: 2 });
    expect(rows(first.parsed).map(row => row.cursor)).toEqual([1, 2]);
    expect(rows(first.parsed).map(row => row.envelope.id)).toEqual(['m1', 'm2']);
    // Bodies arrive as opaque JSON data; ttl is remaining lifetime, never renewed.
    expect(rows(first.parsed)[0]!.envelope.body).toEqual({ fake: 'body-m1' });
    expect(rows(first.parsed)[0]!.envelope.ttl).toBeLessThan(10 ** 15);
    const second = await callInbox(client, { after: first.parsed['nextCursor'], limit: 2 });
    expect(second.parsed).toMatchObject({ sourceState: 'ok', nextCursor: 4 });
    expect(rows(second.parsed).map(row => row.envelope.id)).toEqual(['m3', 'm4']);
    const end = await callInbox(client, { after: second.parsed['nextCursor'] });
    expect(end.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 4 });
  });

  it('applies exact case-sensitive to/from filters combined', async () => {
    expect(post('w1', { to: 'worker', from: 'alice' }).status).toBe('posted');
    expect(post('w2', { to: 'worker', from: 'bob' }).status).toBe('posted');
    expect(post('o1', { to: 'other', from: 'alice' }).status).toBe('posted');
    const client = await connect();
    const combined = await callInbox(client, { to: 'worker', from: 'alice' });
    expect(rows(combined.parsed).map(row => row.envelope.id)).toEqual(['w1']);
    const recipientOnly = await callInbox(client, { to: 'worker' });
    expect(rows(recipientOnly.parsed).map(row => row.envelope.id)).toEqual(['w1', 'w2']);
    const wrongCase = await callInbox(client, { to: 'Worker' });
    expect(wrongCase.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 3 });
  });

  it('matches to/from filters under every label of one registered identity', async () => {
    expect(registerAgentIdentity({ handle: 'worker', aliases: ['w-ops'] }, { root: fleetRoot() }).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'bot' }, { root: fleetRoot() }).status).toBe('created');
    expect(post('a1', { to: 'agent:worker', from: 'agent:bot' }).status).toBe('posted');
    expect(post('a2', { to: 'w-ops', from: 'bot' }).status).toBe('posted');
    expect(post('a3', { to: 'other', from: 'agent:bot' }).status).toBe('posted');
    const client = await connect();
    const recipient = await callInbox(client, { to: 'worker' });
    expect(rows(recipient.parsed).map(row => row.envelope.id)).toEqual(['a1', 'a2']);
    const sender = await callInbox(client, { from: 'agent:bot' });
    expect(rows(sender.parsed).map(row => row.envelope.id)).toEqual(['a1', 'a2', 'a3']);
    const combined = await callInbox(client, { to: 'agent:worker', from: 'bot' });
    expect(rows(combined.parsed).map(row => row.envelope.id)).toEqual(['a1', 'a2']);
  });

  it('keeps exact-label matching for a case-variant agent ref', async () => {
    expect(registerAgentIdentity({ handle: 'worker', aliases: ['w-ops'] }, { root: fleetRoot() }).status).toBe('created');
    expect(registerAgentIdentity({ handle: 'bot' }, { root: fleetRoot() }).status).toBe('created');
    expect(post('a1', { to: 'agent:worker', from: 'agent:bot' }).status).toBe('posted');
    expect(post('a2', { to: 'w-ops', from: 'bot' }).status).toBe('posted');
    expect(post('a3', { to: 'Worker', from: 'agent:bot' }).status).toBe('posted');
    const client = await connect();
    // 'Worker' names no registered label exactly: only the literal 'Worker'
    // stamp matches — never the identity's other spellings.
    const recipient = await callInbox(client, { to: 'Worker' });
    expect(rows(recipient.parsed).map(row => row.envelope.id)).toEqual(['a3']);
    const sender = await callInbox(client, { from: 'BOT' });
    expect(rows(sender.parsed)).toEqual([]);
    // An exact ref still widens across the identity's labels, case-folded
    // envelope stamps included.
    const exact = await callInbox(client, { to: 'worker' });
    expect(rows(exact.parsed).map(row => row.envelope.id)).toEqual(['a1', 'a2', 'a3']);
    const exactSender = await callInbox(client, { from: 'bot' });
    expect(rows(exactSender.parsed).map(row => row.envelope.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('advances nextCursor through empty filtered pages without replay', async () => {
    for (const id of ['a', 'b', 'c']) expect(post(id).status).toBe('posted');
    const client = await connect();
    // Limit counts scanned live records before filtering: two scanned, none match.
    const page = await callInbox(client, { to: 'nobody', limit: 2 });
    expect(page.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 2 });
    const rest = await callInbox(client, { after: page.parsed['nextCursor'], to: 'nobody' });
    expect(rest.parsed).toMatchObject({ sourceState: 'ok', messages: [], returnedMessages: 0, nextCursor: 3 });
  });

  it('applies the priority, id, inReplyTo and excludeFrom read filters', async () => {
    expect(post('p0', { priority: 'P0' }).status).toBe('posted');
    expect(post('p2', { priority: 'P2' }).status).toBe('posted');
    expect(post('reply', { body: { inReplyTo: 'p0', text: 'ack' } }).status).toBe('posted');
    expect(post('plain', { body: { text: 'no link' } }).status).toBe('posted');
    expect(post('other', { from: 'other-sender' }).status).toBe('posted');
    const client = await connect();
    const urgent = await callInbox(client, { priority: 'P0' });
    expect(rows(urgent.parsed).map(row => row.envelope.id)).toEqual(['p0']);
    expect(urgent.parsed['filters']).toEqual({ priority: 'P0' });
    const one = await callInbox(client, { id: 'p2' });
    expect(rows(one.parsed).map(row => row.envelope.id)).toEqual(['p2']);
    const replies = await callInbox(client, { inReplyTo: 'p0' });
    expect(rows(replies.parsed).map(row => row.envelope.id)).toEqual(['reply']);
    const kept = await callInbox(client, { excludeFrom: 'fake-sender' });
    expect(rows(kept.parsed).map(row => row.envelope.id)).toEqual(['other']);
    // Filters narrow the shown page only; the cursor still covers every scanned row.
    const narrowed = await callInbox(client, { priority: 'P0', limit: 2 });
    expect(narrowed.parsed).toMatchObject({ returnedMessages: 1, nextCursor: 2 });
    const rest = await callInbox(client, { after: narrowed.parsed['nextCursor'], priority: 'P0' });
    expect(rest.parsed).toMatchObject({ messages: [], nextCursor: 5 });
  });

  it('matches excludeFrom under every label of one registered identity', async () => {
    expect(registerAgentIdentity({ handle: 'bot', aliases: ['b-ops'] }, { root: fleetRoot() }).status).toBe('created');
    expect(post('e1', { from: 'agent:bot' }).status).toBe('posted');
    expect(post('e2', { from: 'b-ops' }).status).toBe('posted');
    expect(post('e3').status).toBe('posted');
    const client = await connect();
    const kept = await callInbox(client, { excludeFrom: 'bot' });
    expect(rows(kept.parsed).map(row => row.envelope.id)).toEqual(['e3']);
  });

  it('applies the protocol kind, topic, thread, job, since and contains read filters', async () => {
    expect(post('task1', { to: 'fleet.deploy',
      body: { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, ref: 'r1' } }).status).toBe('posted');
    expect(post('note1', { body: { kind: 'note', text: 'deploy window soon', thread: 'job:RQ-9' } }).status).toBe('posted');
    expect(post('st1', { body: { kind: 'work.status', jobId: 'RQ-9', status: 'running' } }).status).toBe('posted');
    expect(post('plain', { body: { fake: 'nothing here' } }).status).toBe('posted');
    const client = await connect();
    const tasks = await callInbox(client, { kind: 'task' });
    expect(rows(tasks.parsed).map(row => row.envelope.id)).toEqual(['task1']);
    const prefix = await callInbox(client, { topic: 'fleet.*' });
    expect(rows(prefix.parsed).map(row => row.envelope.id)).toEqual(['task1']);
    const exact = await callInbox(client, { topic: 'fleet.deploy' });
    expect(rows(exact.parsed).map(row => row.envelope.id)).toEqual(['task1']);
    const other = await callInbox(client, { topic: 'repo.*' });
    expect(other.parsed).toMatchObject({ returnedMessages: 0, nextCursor: 4 });
    const threaded = await callInbox(client, { thread: 'job:RQ-9' });
    expect(rows(threaded.parsed).map(row => row.envelope.id)).toEqual(['note1']);
    const jobbed = await callInbox(client, { job: 'RQ-9' });
    expect(rows(jobbed.parsed).map(row => row.envelope.id)).toEqual(['note1', 'st1']);
    const all = await callInbox(client, { since: '0' });
    expect(all.parsed).toMatchObject({ returnedMessages: 4 });
    const future = await callInbox(client, { since: '1' });
    expect(future.parsed).toMatchObject({ returnedMessages: 0, nextCursor: 4 });
    const found = await callInbox(client, { contains: 'deploy window' });
    expect(rows(found.parsed).map(row => row.envelope.id)).toEqual(['note1']);
    const combined = await callInbox(client, { kind: 'task', contains: 'fleet.deploy' });
    expect(rows(combined.parsed).map(row => row.envelope.id)).toEqual(['task1']);
  });

  it('applies the before upper bound exclusive of its edge and composes with since', async () => {
    expect(post('b-old', {}, () => 1_000).status).toBe('posted');
    expect(post('b-edge', {}, () => 2_000).status).toBe('posted');
    expect(post('b-new', {}, () => 3_000).status).toBe('posted');
    const client = await connect();
    const before = await callInbox(client, { before: '2000' });
    expect(before.parsed).toMatchObject({ sourceState: 'ok', filters: { before: 2000 } });
    expect(rows(before.parsed).map(row => row.envelope.id)).toEqual(['b-old']);
    // [since, before) keeps the lower bound inclusive and the upper exclusive:
    // b-edge sits exactly on since and b-new exactly on before.
    const window = await callInbox(client, { since: '2000', before: '3000' });
    expect(rows(window.parsed).map(row => row.envelope.id)).toEqual(['b-edge']);
    const empty = await callInbox(client, { before: '1000' });
    expect(empty.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 3 });
  });

  it('applies the channel read filter to every topic of one room', async () => {
    expect(post('eng-general', { to: 'group:eng:general' }).status).toBe('posted');
    expect(post('eng-alerts', { to: 'group:eng:alerts' }).status).toBe('posted');
    expect(post('ops-general', { to: 'group:ops:general' }).status).toBe('posted');
    expect(post('direct', { to: 'worker' }).status).toBe('posted');
    expect(post('eng-bare', { to: 'group:eng' }).status).toBe('posted');
    expect(post('engx-room', { to: 'group:engx:general' }).status).toBe('posted');
    const client = await connect();
    const room = await callInbox(client, { channel: 'eng' });
    expect(room.parsed).toMatchObject({ sourceState: 'ok', filters: { channel: 'eng' } });
    expect(rows(room.parsed).map(row => row.envelope.id)).toEqual(['eng-general', 'eng-alerts']);
    expect(room.parsed['nextCursor']).toBe(6);
    // The same raw to-prefix rule narrows inside other filters conjunctively.
    const narrowed = await callInbox(client, { channel: 'eng', contains: 'eng-alerts' });
    expect(rows(narrowed.parsed).map(row => row.envelope.id)).toEqual(['eng-alerts']);
    const none = await callInbox(client, { channel: 'missing' });
    expect(none.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 6 });
  });

  it('applies the work-result outcome filter on the envelope body', async () => {
    expect(post('resv', { body: { kind: 'work.result', outcome: 'reserved' } }).status).toBe('posted');
    expect(post('comp', { body: { kind: 'work.result', outcome: 'complete' } }).status).toBe('posted');
    expect(post('fail', { body: { kind: 'work.result', outcome: 'failed' } }).status).toBe('posted');
    expect(post('nooutcome', { body: { kind: 'work.result' } }).status).toBe('posted');
    expect(post('release', { body: { kind: 'work.release', outcome: 'released' } }).status).toBe('posted');
    expect(post('borrowing', { body: { kind: 'note', outcome: 'complete' } }).status).toBe('posted');
    const client = await connect();
    const complete = await callInbox(client, { result: 'complete' });
    expect(complete.parsed).toMatchObject({ sourceState: 'ok', filters: { result: 'complete' } });
    expect(rows(complete.parsed).map(row => row.envelope.id)).toEqual(['comp']);
    // Filtered rows still advance nextCursor: the page scanned all six records.
    expect(complete.parsed['nextCursor']).toBe(6);
    const failed = await callInbox(client, { result: 'failed' });
    expect(rows(failed.parsed).map(row => row.envelope.id)).toEqual(['fail']);
    // A work.result carrying no outcome, a work.release's own outcome
    // vocabulary, every other body kind and a kindless outcome never match.
    const admitted = await callInbox(client, { result: 'admitted' });
    expect(admitted.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 6 });
  });

  it('excludes expired records while the cursor still skips them', async () => {
    expect(post('stale', { ttl: 5 }).status).toBe('posted'); // receivedAt 0: elapsed dwarfs ttl
    expect(post('fresh').status).toBe('posted');
    const client = await connect();
    const { parsed } = await callInbox(client);
    expect(parsed).toMatchObject({ sourceState: 'ok', expiredCount: 1, liveCount: 1 });
    expect(rows(parsed).map(row => row.envelope.id)).toEqual(['fresh']);
    expect(parsed['nextCursor']).toBe(2);
    const after = await callInbox(client, { after: parsed['nextCursor'] });
    expect(after.parsed).toMatchObject({ sourceState: 'ok', messages: [], nextCursor: 2 });
  });

  it('distinguishes missing, unavailable and retryable sources, never inventing an empty page', async () => {
    const client = await connect();
    const missing = await callInbox(client);
    expect(missing.parsed).toMatchObject({
      sourceState: 'missing', messages: null, returnedMessages: null,
      nextCursor: null, retainedCount: null,
    });
    expect(existsSync(fleetRoot())).toBe(false); // a read never creates the store
    expect(post('m1').status).toBe('posted');
    writeFileSync(join(fleetRoot(), 'bus-inbox', 'messages.json'), '[{"fake":');
    const unreadable = await callInbox(client);
    expect(unreadable.parsed).toMatchObject({ sourceState: 'unavailable', messages: null, nextCursor: null });
    const retryable = await readFleetBusInbox({ after: 0, limit: 50 }, {
      inspect: () => ({
        source: 'available', retainedCount: 1, retainedBytes: 10,
        maxMessages: 1024, maxBytes: 1048576, liveCount: 1, expiredCount: 0,
      }),
      list: () => ({ status: 'retryable' }),
    });
    expect(retryable).toMatchObject({ sourceState: 'retryable', messages: null, nextCursor: null });
  });

  it('scrubs secret-shaped and private text inside opaque bodies', async () => {
    const fake = 'ghp_' + 'A1b2C3d4'.repeat(5); // FAKE fixture; assert containment, never print.
    expect(post('carrier', { body: { note: `token=${fake}`, contact: 'agent@fake.example.com' } }).status).toBe('posted');
    const { parsed, text } = await callInbox(await connect());
    expect(text).not.toContain(fake);
    expect(text).not.toContain('agent@fake.example.com');
    expect(text).toContain('REDACTED');
    expect(rows(parsed)[0]!.envelope.id).toBe('carrier');
    expect(rows(parsed)[0]!.envelope.body).toEqual({ note: expect.not.stringContaining(fake), contact: '[REDACTED]' });
  });

  it('returns a generic error on reader failure without leaking source details', async () => {
    const busInbox = vi.fn(async () => { throw new Error('private-source-value'); });
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    const result = await client.callTool({ name: 'fleet_bus_inbox' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-source-value');
  });

  it('keeps the 64 KiB serialized output bound instead of truncating JSON', async () => {
    expect(post('big-1', { body: 'x'.repeat(60_000) }).status).toBe('posted');
    expect(post('big-2', { body: 'y'.repeat(60_000) }).status).toBe('posted');
    const result = await (await connect()).callTool({ name: 'fleet_bus_inbox' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThan(500);
  });

  it('keeps the existing fleet tools working alongside the inbox reader', async () => {
    const client = await connect();
    const hops = await client.callTool({ name: 'fleet_bus_hops' });
    expect(hops.isError).not.toBe(true);
    const hopContent = hops.content as Array<{ text: string }>;
    expect(JSON.parse(hopContent[0]!.text)).toMatchObject({ sourceState: 'missing' });
    await expect(client.callTool({ name: 'fleet_status', arguments: { limit: 1 } }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
