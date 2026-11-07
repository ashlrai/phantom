import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import { readFleetSelfTickLast } from '../src/mcp/fleet-self-tick.js';
import type { SelfTickReport } from '../src/core/fleet/self-tick.js';

const connections: Array<Client> = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phantom-fleet-stl-'));
  roots.push(root);
  return root;
}

function writeReport(runsDir: string, steps: { step: string; state: 'ok' | 'failed'; exitCode: number | null; report?: unknown }[], atMs: number = Date.now() - 120_000) {
  const report: SelfTickReport = {
    at: new Date(atMs).toISOString(),
    mode: 'apply',
    state: 'ran',
    steps,
  };
  writeSelfTickLast(runsDir, report);
}

describe('fleet_self_tick_last MCP tool', () => {
  // (a) no record → last: null
  it('returns last: null when no self-tick record exists', () => {
    const runsDir = fixture();
    const result = readFleetSelfTickLast({ runsDir, now: () => Date.now() });
    expect(result.schemaVersion).toBe(1);
    expect(result.snapshotKind).toBe('local-persisted');
    expect(result.authority).toBe('none');
    expect(result.last).toBeNull();
    expect(typeof result.generatedAt).toBe('string');
  });

  // (b) written record → age and failed steps come back
  it('returns age and failed steps from a written record', () => {
    const runsDir = fixture();
    const now = Date.now();
    const atMs = now - 120_000; // 2 minutes ago
    writeReport(runsDir, [
      { step: 'reset-release', state: 'ok', exitCode: 0 },
      { step: 'lane-autohold', state: 'failed', exitCode: 1, report: { error: 'timeout' } },
      { step: 'planner-tick', state: 'ok', exitCode: 0 },
    ], atMs);
    const result = readFleetSelfTickLast({ runsDir, now: () => now });
    expect(result.schemaVersion).toBe(1);
    expect(result.last).not.toBeNull();
    expect(result.last!.state).toBe('ok');
    expect(result.last!.mode).toBe('apply');
    expect(result.last!.ranState).toBe('ran');
    expect(result.last!.ageSeconds).toBe(120);
    expect(result.last!.failedSteps).toEqual(['lane-autohold']);
  });

  // (c) tool appears in server tool list and dispatches
  it('appears in the server tool list and dispatches to the injected reader', async () => {
    const { client } = await makeClient(async () => ({ injected: true }));
    const { tools } = await client.listTools();
    const selfTickTool = tools.find(t => t.name === 'fleet_self_tick_last');
    expect(selfTickTool).toBeDefined();
    expect(selfTickTool!.inputSchema.type).toBe('object');
    expect(selfTickTool!.inputSchema.additionalProperties).toBe(false);

    const result = await client.callTool({ name: 'fleet_self_tick_last' });
    expect(result.isError).toBeUndefined();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({ injected: true });
  });

  // (c2) without an injected reader the tool reads the real persisted record
  it('reads the persisted record through the default reader when none is injected', async () => {
    const runsDir = fixture();
    writeReport(runsDir, [{ step: 'lane-autohold', state: 'failed', exitCode: 1 }]);
    const previous = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runsDir;
    try {
      const { client } = await makeClient();
      const result = await client.callTool({ name: 'fleet_self_tick_last' });
      expect(result.isError).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0].text);
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.last).not.toBeNull();
      expect(parsed.last.failedSteps).toEqual(['lane-autohold']);
      expect(content[0].text).not.toContain(runsDir);
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = previous;
    }
  });

  // (d) unknown arguments are rejected
  it('rejects unknown arguments for fleet_self_tick_last', async () => {
    const { client } = await makeClient();
    await expect(
      client.callTool({ name: 'fleet_self_tick_last', arguments: { bogus: 'value' } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  // (e) output never contains the temp dir's absolute path
  it('the output never contains the temp runs dir absolute path', () => {
    const runsDir = fixture();
    writeReport(runsDir, [
      { step: 'reset-release', state: 'ok', exitCode: 0 },
    ]);
    // Directly test the reader: it should scrub the runsDir path via sanitizePublicJson
    const result = readFleetSelfTickLast({ runsDir, now: () => Date.now() });
    const text = JSON.stringify(result);
    expect(text).not.toContain(runsDir);
  });
});

async function makeClient(fakeSelfTick?: () => Promise<unknown>) {
  const readers: FleetReaders = {
    status: async () => ({}),
    loop: async () => ({}),
    bus: () => Promise.resolve({ hops: [] }),
    busInbox: () => Promise.resolve({ items: [], nextCursor: 0 }),
    lanes: () => Promise.resolve({ lanes: [] }),
    hostRuns: () => Promise.resolve({}),
    ...(fakeSelfTick ? { selfTick: fakeSelfTick } : {}),
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'fleet-stl-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
}
