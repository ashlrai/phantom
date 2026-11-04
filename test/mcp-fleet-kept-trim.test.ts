import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { parseFleetKeptArgs, readFleetKeptTool } from '../src/mcp/fleet-kept.js';
import { parseFleetTrimArgs, readFleetTrimTool } from '../src/mcp/fleet-trim.js';

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });

async function connect(extra: Partial<FleetReaders> = {}) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kept-trim-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

const row = (job: string, cls: string, ts: string) => JSON.stringify({ job, class: cls, ts });
const ledger = [
  row('RQ-PHX-FAKEJOB01', 'abort_push', '2026-11-01T00:00:00Z'),
  row('RQ-PHX-FAKEJOB02', 'abort_push', '2026-10-31T00:00:00Z'),
  row('RQ-PHX-FAKEJOB03', 'empty', '2026-11-02T00:00:00Z'),
].join('\n');
const keptStatus = (ids: string[]) => JSON.stringify({ kept_worktrees: ids });

describe('fleet_kept', () => {
  it('groups kept ids by reason, oldest first', async () => {
    const out = await readFleetKeptTool({
      readStatus: async () => keptStatus(['RQ-PHX-FAKEJOB01', 'RQ-PHX-FAKEJOB02', 'RQ-PHX-FAKEJOB03', 'RQ-PHX-FAKEJOB04']),
      readJobs: async () => ledger,
    });
    expect(out).toEqual({
      schema: 'fleet.kept.v1', readOnly: true, kept: 4,
      reasons: [
        { reason: 'abort_push', count: 2, oldest: ['RQ-PHX-FAKEJOB02', 'RQ-PHX-FAKEJOB01'] },
        { reason: 'empty', count: 1, oldest: ['RQ-PHX-FAKEJOB03'] },
        { reason: 'unknown', count: 1, oldest: ['RQ-PHX-FAKEJOB04'] },
      ],
    });
  });

  it('reports an empty kept list', async () => {
    const out = await readFleetKeptTool({ readStatus: async () => keptStatus([]), readJobs: async () => '' });
    expect(out).toEqual({ schema: 'fleet.kept.v1', readOnly: true, kept: 0, reasons: [] });
  });

  it('returns the error body when status or the ledger is unreadable', async () => {
    const body = { schema: 'fleet.kept.v1', readOnly: true, error: 'Queue status or jobs ledger is unreadable.' };
    expect(await readFleetKeptTool({ readStatus: async () => { throw new Error('ENOENT'); } })).toEqual(body);
    expect(await readFleetKeptTool({ readStatus: async () => keptStatus(['RQ-PHX-FAKEJOB01']), readJobs: async () => { throw new Error('x'); } })).toEqual(body);
    expect(await readFleetKeptTool({ readStatus: async () => '{not json' })).toEqual(body);
  });

  it('takes no arguments', () => {
    expect(parseFleetKeptArgs({})).toEqual({});
    expect(parseFleetKeptArgs({ a: 1 })).toBeNull();
  });
});

const trimStatus = JSON.stringify({
  admission: { running: 4, cap: 4 },
  lanes: {
    'fake-starved': { running: 0, target: 2, queued: 3, held: false },
    'fake-waster': { running: 1, target: 3, queued: 0, held: false },
    'fake-fine': { running: 1, target: 2, queued: 0, held: false },
  },
  rollup_24h: { by_lane: {
    'fake-waster': { jobs: 12, merged: 1, merge_rate: 0.08, empty_rate: 0.6 },
    'fake-fine': { jobs: 12, merged: 9, merge_rate: 0.75, empty_rate: 0.1 },
  } },
});

describe('fleet_trim', () => {
  it('flags a starved lane and a wasting lane with its SLOTS suggestion', async () => {
    const out = await readFleetTrimTool({ readStatus: async () => trimStatus });
    expect(out).toMatchObject({
      schema: 'fleet.trim.v1', readOnly: true,
      flagged: [{ lane: 'fake-starved', flag: 'starved' }, { lane: 'fake-waster', flag: 'wastes' }],
      suggestions: [{ lane: 'fake-waster', from: 3, to: 2, line: 'SLOTS fake-waster 3 -> 2' }],
    });
  });

  it('returns the error body on invalid or unreadable status', async () => {
    const body = { schema: 'fleet.trim.v1', readOnly: true, error: 'Queue status is unreadable or invalid.' };
    expect(await readFleetTrimTool({ readStatus: async () => '{"lanes":{}}' })).toEqual(body);
    expect(await readFleetTrimTool({ readStatus: async () => 'nope' })).toEqual(body);
    expect(await readFleetTrimTool({ readStatus: async () => { throw new Error('ENOENT'); } })).toEqual(body);
  });

  it('takes no arguments', () => {
    expect(parseFleetTrimArgs({})).toEqual({});
    expect(parseFleetTrimArgs({ a: 1 })).toBeNull();
  });
});

describe('fleet server registration', () => {
  it('lists both tools read-only with empty strict schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const name of ['fleet_kept', 'fleet_trim']) {
      const tool = tools.find(t => t.name === name);
      expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    }
  });

  it('routes calls through injected readers and rejects arguments', async () => {
    const client = await connect({ kept: async () => ({ kept: 0 }), trim: async () => ({ flagged: [] }) });
    expect(parse(await client.callTool({ name: 'fleet_kept', arguments: {} }))).toEqual({ kept: 0 });
    expect(parse(await client.callTool({ name: 'fleet_trim', arguments: {} }))).toEqual({ flagged: [] });
    await expect(client.callTool({ name: 'fleet_trim', arguments: { x: 1 } })).rejects.toThrow();
  });
});
