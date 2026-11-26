/**
 * fleet_bus_inbox `result`: the MCP raw-store read takes the same
 * kind-scoped busBodyResultOutcome own-field filter `phm comms bus read
 * --result` and `fleet bus-follow --result` apply — only `work.result`
 * bodies whose own `outcome` strictly equals one WORK_RESULT_OUTCOMES
 * code match; every other body kind (a `work.release` body's own outcome
 * included) and a `work.result` carrying no outcome never match. Hermetic:
 * isolated ASHLR_HOME fixture dirs, in-memory MCP transports, fake
 * envelopes, no daemon or provider calls.
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
  root = mkdtempSync(join(tmpdir(), 'fleet-bus-inbox-result-'));
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
  const client = new Client({ name: 'bus-inbox-result-test', version: '1.0.0' });
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

describe('fleet_bus_inbox result filter', () => {
  it('exposes result in the tool schema beside the other read filters', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(candidate => candidate.name === 'fleet_bus_inbox');
    expect(tool?.inputSchema.properties?.['result'])
      .toMatchObject({ type: 'string', enum: ['reserved', 'admitted', 'complete', 'failed'] });
    expect(tool?.description).toContain('result keeps only work.result bodies');
  });

  it.each([
    [{ result: 'bogus' }], [{ result: 'FAILED' }], [{ result: '' }], [{ result: 5 }], [{ result: null }],
    [{ result: 'completed' }],
  ])('rejects invalid result arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('keeps only work.result bodies reporting that outcome; every other kind never matches', async () => {
    expect(post('r-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed', reason: 'tests red' }).status).toBe('posted');
    expect(post('r-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete', reason: 'merged' }).status).toBe('posted');
    expect(post('r-nooutcome', { kind: 'work.result', jobId: 'RQ-2' }).status).toBe('posted');
    // The work.release body deliberately carries a work.result-vocabulary
    // outcome: the kind-scoped match must still refuse it.
    expect(post('r-release', { kind: 'work.release', jobId: 'RQ-1', outcome: 'failed' }).status).toBe('posted');
    expect(post('r-status', { kind: 'work.status', jobId: 'RQ-1', status: 'running' }).status).toBe('posted');
    expect(post('r-note', { kind: 'note', text: 'failed anyway' }).status).toBe('posted');
    const client = await connect();
    const failed = await callInbox(client, { result: 'failed' });
    expect(failed.parsed['filters']).toEqual({ result: 'failed' });
    expect(rows(failed.parsed).map(row => row.envelope.id)).toEqual(['r-failed']);
    const complete = await callInbox(client, { result: 'complete' });
    expect(rows(complete.parsed).map(row => row.envelope.id)).toEqual(['r-complete']);
    const none = await callInbox(client, { result: 'reserved' });
    expect(none.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 6 });
  });

  it('composes with the other read filters and advances the cursor', async () => {
    expect(post('a', { kind: 'work.result', jobId: 'RQ-9', outcome: 'failed' }).status).toBe('posted');
    expect(post('b', { kind: 'work.result', jobId: 'RQ-8', outcome: 'failed' }).status).toBe('posted');
    expect(post('c', { kind: 'work.result', jobId: 'RQ-9', outcome: 'complete' }).status).toBe('posted');
    const client = await connect();
    const both = await callInbox(client, { result: 'failed', job: 'RQ-9' });
    expect(rows(both.parsed).map(row => row.envelope.id)).toEqual(['a']);
    const kinded = await callInbox(client, { result: 'failed', bodyKind: 'work.result' });
    expect(rows(kinded.parsed).map(row => row.envelope.id)).toEqual(['a', 'b']);
    // The limit counts scanned live records before filtering: two scanned
    // failed rows advance the cursor past the unmatched complete row's slot,
    // and the next page finds it.
    const narrowed = await callInbox(client, { result: 'complete', limit: 2 });
    expect(narrowed.parsed).toMatchObject({ returnedMessages: 0, nextCursor: 2 });
    const rest = await callInbox(client, { after: narrowed.parsed['nextCursor'], result: 'complete' });
    expect(rows(rest.parsed).map(row => row.envelope.id)).toEqual(['c']);
    expect(rest.parsed).toMatchObject({ nextCursor: 3 });
  });
});
