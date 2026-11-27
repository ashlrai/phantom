/**
 * fleet_bus_inbox `result`: the MCP raw-store read takes the same
 * busBodyResultOutcome own-field outcome filter `fleet bus-follow
 * --result`, `phm agents bus inbox --result`, `phm messages --result`
 * and the work feed's `--result` apply — only a `work.result` body whose
 * own `outcome` strictly equals one WORK_RESULT_OUTCOMES code matches, so
 * a `work.release` body's released/completed outcome (a different
 * vocabulary), every other body kind and a result carrying no outcome
 * never match. Hermetic: isolated ASHLR_HOME fixture dirs, in-memory MCP
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
import { WORK_RESULT_OUTCOMES } from '../src/core/agents/bus-v2-schema.js';

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
      .toMatchObject({ type: 'string', enum: [...WORK_RESULT_OUTCOMES] });
    expect(tool?.description).toContain('result');
  });

  it.each([
    [{ result: 'bogus' }], [{ result: 'P0' }], [{ result: 'COMPLETE' }], [{ result: 'completed' }],
    [{ result: 'released' }], [{ result: '' }], [{ result: 5 }], [{ result: null }],
  ])('rejects invalid result arguments before invoking the reader: %j', async args => {
    const busInbox = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), busInbox });
    await expect(client.callTool({ name: 'fleet_bus_inbox', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(busInbox).not.toHaveBeenCalled();
  });

  it('keeps only work.result bodies reporting the exact outcome', async () => {
    expect(post('res-ok', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' }).status).toBe('posted');
    expect(post('res-bad', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' }).status).toBe('posted');
    expect(post('res-none', { kind: 'work.result', jobId: 'RQ-2' }).status).toBe('posted');
    // A work.release outcome is a different vocabulary; a note's stray
    // outcome field, a kindless body's outcome and a non-result kind never match.
    expect(post('rel', { kind: 'work.release', claimKey: 'queue:RQ-1', outcome: 'completed' }).status).toBe('posted');
    expect(post('note', { kind: 'note', text: 'done', outcome: 'failed' }).status).toBe('posted');
    expect(post('kindless', { outcome: 'failed', text: 'no kind' }).status).toBe('posted');
    const client = await connect();
    const failed = await callInbox(client, { result: 'failed' });
    expect(failed.parsed).toMatchObject({ sourceState: 'ok', filters: { result: 'failed' } });
    expect(rows(failed.parsed).map(row => row.envelope.id)).toEqual(['res-bad']);
    const complete = await callInbox(client, { result: 'complete' });
    expect(rows(complete.parsed).map(row => row.envelope.id)).toEqual(['res-ok']);
    // Every WORK_RESULT_OUTCOMES code is a valid filter; the ones no receipt
    // reports answer an honest empty page.
    const reserved = await callInbox(client, { result: 'reserved' });
    expect(reserved.parsed).toMatchObject({ sourceState: 'ok', returnedMessages: 0, nextCursor: 6 });
  });

  it('composes with the other read filters and advances the cursor', async () => {
    expect(post('a', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' }).status).toBe('posted');
    expect(post('b', { kind: 'work.result', jobId: 'RQ-2', outcome: 'failed' }).status).toBe('posted');
    expect(post('c', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' }).status).toBe('posted');
    const client = await connect();
    const both = await callInbox(client, { result: 'failed', job: 'RQ-1' });
    expect(rows(both.parsed).map(row => row.envelope.id)).toEqual(['a']);
    const kinded = await callInbox(client, { result: 'complete', bodyKind: 'work.result' });
    expect(rows(kinded.parsed).map(row => row.envelope.id)).toEqual(['c']);
    // Filtered rows still advance nextCursor: the two failed receipts inside
    // the limit page through, then the complete row is scanned past unseen.
    const narrowed = await callInbox(client, { result: 'failed', limit: 2 });
    expect(narrowed.parsed).toMatchObject({ returnedMessages: 2, nextCursor: 2 });
    const rest = await callInbox(client, { after: narrowed.parsed['nextCursor'], result: 'failed' });
    expect(rest.parsed).toMatchObject({ messages: [], nextCursor: 3 });
  });
});
