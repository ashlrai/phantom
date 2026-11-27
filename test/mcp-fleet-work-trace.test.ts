/**
 * fleet_work_trace: the single work-item state read over the isolated
 * fleet MCP server — the same collectBusWorkItemEvidence +
 * classifyWorkItem composition `phm fleet work-trace --id <id>` and GET
 * /api/verse/fleet/control/work-trace?id=<id> serve, with the id
 * validated before any store read and a failed evidence read degrading
 * to the API's honest unknown item.
 *
 * Hermetic: injected collectors and clocks, in-memory MCP transports,
 * no bus store, claims table or coordination ledger access.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetWorkTraceArgs, readFleetWorkTrace } from '../src/mcp/fleet-work-trace.js';
import { collectBusWorkItemEvidence,
  type BusWorkItemEvidenceResult, type BusWorkItemSources } from '../src/core/comms/work-item-bus-evidence.js';
import type { WorkItemEvidence } from '../src/core/comms/work-item-state.js';
import { ashlrHome } from '../src/core/cloud/store.js';
import { join } from 'node:path';

const connections: Client[] = [];

const NOW = Date.parse('2026-11-17T12:00:00Z');
const NOW_ISO = '2026-11-17T12:00:00.000Z';

const collected = (evidence: WorkItemEvidence, sources: Partial<BusWorkItemSources> = {}): BusWorkItemEvidenceResult => ({
  evidence,
  sources: { inbox: 'found', claims: 'available', coordination: 'available', ...sources },
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
  const client = new Client({ name: 'work-trace-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function callTrace(client: Client, args?: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_work_trace', arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return { result, text: content[0]!.text, parsed: JSON.parse(content[0]!.text) as Record<string, unknown> };
}

describe('fleet_work_trace argument parsing', () => {
  it('requires id and accepts the HTTP route bound', () => {
    expect(parseFleetWorkTraceArgs({ id: 'm-1' })).toEqual({ id: 'm-1' });
    expect(parseFleetWorkTraceArgs({ id: 'wh-0123456789abcdef0123456789abcdef' }))
      .toEqual({ id: 'wh-0123456789abcdef0123456789abcdef' });
    expect(parseFleetWorkTraceArgs({ id: 'x'.repeat(200) })).toEqual({ id: 'x'.repeat(200) });
    expect(parseFleetWorkTraceArgs({ id: 'slack T1/C1/1700000000.000100' })).toEqual({ id: 'slack T1/C1/1700000000.000100' });
  });

  it('rejects a missing, blank, oversized or NUL-carrying id before any read', () => {
    for (const bad of [{}, { id: '' }, { id: '   ' }, { id: 'x'.repeat(201) },
      { id: 'a\0b' }, { id: 5 }, { id: null }, { id: true }]) {
      expect(parseFleetWorkTraceArgs(bad)).toBeNull();
    }
  });

  it('rejects unknown keys and caller roots', () => {
    for (const bad of [
      { id: 'm-1', extra: 1 }, { id: 'm-1', root: '/tmp/fake' }, { id: 'm-1', path: '/tmp/x' },
      { id: 'm-1', cwd: '/tmp' }, { id: 'm-1', runsDir: '/tmp' }, { id: 'm-1', home: '/tmp' },
      { id: 'm-1', limit: 5 }, { id: 'm-1', ids: ['a', 'b'] },
    ]) expect(parseFleetWorkTraceArgs(bad)).toBeNull();
  });
});

describe('fleet_work_trace reader', () => {
  it('collects evidence under the server-owned fleet root with the injected clock', async () => {
    const seen: Array<{ id: string; opts: { root: string; now: number } }> = [];
    const collect: typeof collectBusWorkItemEvidence = (id, opts) => {
      seen.push({ id, opts });
      return collected({ id, receivedAt: '2026-11-17T11:00:00.000Z' });
    };
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe('m-1');
    expect(seen[0]!.opts.now).toBe(NOW);
    expect(seen[0]!.opts.root).toBe(join(ashlrHome(), 'fleet'));
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: NOW_ISO, id: 'm-1', state: 'RECEIVED',
    });
  });

  it('reports RECEIVED with the missing evidence for a bare request', async () => {
    const collect: typeof collectBusWorkItemEvidence = id =>
      collected({ id, receivedAt: '2026-11-17T11:00:00.000Z' });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({
      id: 'm-1', state: 'RECEIVED', asOf: '2026-11-17T11:00:00.000Z', source: 'receivedAt',
      owner: null, claimReceipt: null, inbox: 'found', claims: 'available', coordination: 'available',
    });
    expect(result.missing).toEqual(expect.arrayContaining(['named owner', 'durable claim receipt']));
    expect(result.result).toBeUndefined();
  });

  it('reports ASSIGNED with owner and claim receipt for claimed work', async () => {
    const collect: typeof collectBusWorkItemEvidence = id => collected({
      id, receivedAt: '2026-11-17T11:00:00.000Z', owner: 'agent:bot', claimReceipt: 'bus-claim:m-1:3:2026-11-17T11:05:00.000Z',
    });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({
      state: 'ASSIGNED', source: 'claim:bus-claim:m-1:3:2026-11-17T11:05:00.000Z',
      owner: 'agent:bot', claimReceipt: 'bus-claim:m-1:3:2026-11-17T11:05:00.000Z', missing: [],
    });
  });

  it('reports RUNNING only on fresh running evidence', async () => {
    const collect: typeof collectBusWorkItemEvidence = id => collected({
      id, receivedAt: '2026-11-17T11:00:00.000Z', owner: 'agent:bot', claimReceipt: 'bus-claim:m-1:3:t',
      runningEvidence: { source: 'bus-work-claims lease-until 2026-11-17T12:30:00.000Z', at: '2026-11-17T11:55:00.000Z' },
    });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({ state: 'RUNNING', asOf: '2026-11-17T11:55:00.000Z' });
  });

  it('attaches the BLOCKED dependency proof', async () => {
    const collect: typeof collectBusWorkItemEvidence = id => collected({
      id, receivedAt: '2026-11-17T11:00:00.000Z',
      blocker: { dependency: 'needs m-0 merged', source: 'bus-reply:r1', at: '2026-11-17T11:30:00.000Z' },
    });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({
      state: 'BLOCKED', asOf: '2026-11-17T11:30:00.000Z', source: 'bus-reply:r1',
      result: { kind: 'blocked', dependency: 'needs m-0 merged' },
    });
  });

  it('attaches the VERIFIED proof with nulls for absent fields', async () => {
    const collect: typeof collectBusWorkItemEvidence = id => collected({
      id, receivedAt: '2026-11-17T11:00:00.000Z',
      verified: { pr: 412, tests: 'fake suite', source: 'bus-reply:r1', at: '2026-11-17T11:30:00.000Z' },
    });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'm-1' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({
      state: 'VERIFIED',
      result: { kind: 'verified', pr: 412, head: null, tests: 'fake suite', artifact: null },
    });
  });

  it('passes the per-source read states through untouched', async () => {
    const collect: typeof collectBusWorkItemEvidence = id =>
      collected({ id }, { inbox: 'unavailable', claims: 'missing', coordination: 'unavailable' });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'ghost' })!, { collect, now: () => NOW });
    expect(result).toMatchObject({ inbox: 'unavailable', claims: 'missing', coordination: 'unavailable' });
  });

  it('degrades a throwing collector to the API\'s unknown item without its message', async () => {
    const collect = vi.fn(() => { throw new Error('PRIVATE-DETAIL /real/path'); });
    const result = await readFleetWorkTrace(parseFleetWorkTraceArgs({ id: 'bad' })!, { collect: collect as never, now: () => NOW });
    expect(result).toMatchObject({
      schemaVersion: 1, generatedAt: NOW_ISO, id: 'bad', state: 'RECEIVED',
      asOf: 'unknown', source: 'none', missing: ['work-item evidence'],
      owner: null, claimReceipt: null,
      inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-DETAIL');
  });
});

describe('fleet_work_trace MCP tool', () => {
  it('is advertised read-only beside the work reads with the id schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_work_trace');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path or cwd is accepted');
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['id'] });
    expect(tool?.inputSchema.properties?.['id'])
      .toMatchObject({ type: 'string', pattern: '^[^\\x00]{1,200}$' });
  });

  it.each([
    [{}], [{ id: '' }], [{ id: '   ' }], [{ id: 'x'.repeat(201) }], [{ id: 'a\0b' }], [{ id: 5 }], [{ id: null }],
    [{ id: 'm-1', root: '/tmp/fake-root' }], [{ id: 'm-1', path: '/tmp/x' }], [{ id: 'm-1', cwd: '/tmp' }],
    [{ id: 'm-1', limit: 5 }], [{ id: 'm-1', extra: 1 }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const workTrace = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workTrace });
    await expect(client.callTool({ name: 'fleet_work_trace', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(workTrace).not.toHaveBeenCalled();
  });

  it('passes the validated id to the injected reader and returns its trace', async () => {
    const payload = {
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: NOW_ISO, id: 'm-1', state: 'ASSIGNED', asOf: '2026-11-17T11:00:00.000Z',
      source: 'claim:bus-claim:m-1:3:t', missing: [], owner: 'agent:bot',
      claimReceipt: 'bus-claim:m-1:3:t', inbox: 'found', claims: 'available', coordination: 'available',
    };
    const workTrace = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), workTrace });
    const { parsed } = await callTrace(client, { id: 'm-1' });
    expect(workTrace).toHaveBeenCalledWith({ id: 'm-1' });
    expect(parsed).toEqual(payload);
  });
});
