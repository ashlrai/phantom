/**
 * fleet_unfed: the shared work queue's per-resource utilization and
 * unfed-capacity read over the isolated fleet MCP server —
 * readUnfedReport, the same assembly `phm fleet unfed --json` serves.
 * fleet_lanes reports each lane's posture and fleet_work_feed lists the
 * jobs; this is the starvation read — which lanes have free slots while
 * runnable rows wait under another lane's hint — with the window folds'
 * own availability flags, one optional windowHours argument, every store
 * root server-owned, and an unreadable status.json reported unavailable,
 * never an invented all-fed fleet.
 *
 * Hermetic: injected readers, in-memory MCP transports and temp runs
 * dirs; the real-projection test runs readUnfedReport against a temp
 * runs dir, never the real ~/.ashlr-runs.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { FLEET_MCP_TOOL_NAMES } from './support/fleet-mcp-tools.js';
import { parseFleetUnfedArgs, readFleetUnfed } from '../src/mcp/fleet-unfed.js';
import { readUnfedReport } from '../src/core/fleet/unfed-read.js';
import type { UnfedReport } from '../src/core/fleet/unfed-capacity.js';

const clients: Client[] = [];
const roots: string[] = [];
const savedRunsDir = process.env.ASHLR_RUNS_DIR;

const NOW = Date.parse('2026-11-22T12:00:00.000Z');

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'fleet-unfed-mcp-'));
  roots.push(root);
  mkdirSync(join(root, 'queue'), { recursive: true });
  mkdirSync(join(root, 'metrics'), { recursive: true });
  return root;
}

function writeStatus(runsDir: string, lanes: Record<string, unknown>): void {
  writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
    schema: 'dispatchd.status.v1', last_tick: new Date(NOW).toISOString(), lanes,
  }));
}

const report = (over: Partial<UnfedReport> = {}): UnfedReport => ({
  schema: 'fleet.unfed.v1', readOnly: true, source: 'derived', derivedReasons: false,
  statusAsOf: new Date(NOW).toISOString(), statusFresh: true, fleetStop: null,
  waiting: 0, invalidRows: 0, unfedLanes: [], unfedSlots: 0, resources: [],
  history: { windowHours: 24, available: false, ticks: 0, lanes: [] },
  overrides: { available: false, decided: 0, overridden: 0, byReason: {}, lanes: [] },
  claims: { available: false, truncated: false, claimed: 0, overridden: 0, byReason: {}, lanes: [] },
  decisionOutcomes: {
    available: false, jobsAvailable: false, jobsTruncated: false, decided: 0,
    hinted: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
    overridden: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
    open: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
    unrouted: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
    unexplained: { decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 },
    byReason: {}, byClass: {},
  },
  rejections: { available: false, decided: 0, unrouted: 0, lanes: [], byReason: {} },
  ...over,
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  if (savedRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = savedRunsDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(readers: Partial<FleetReaders> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'fleet-unfed-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const parsed = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

describe('parseFleetUnfedArgs', () => {
  it('accepts an empty object and a bounded windowHours', () => {
    expect(parseFleetUnfedArgs({})).toEqual({});
    expect(parseFleetUnfedArgs({ windowHours: 24 })).toEqual({ windowHours: 24 });
    expect(parseFleetUnfedArgs({ windowHours: 0.5 })).toEqual({ windowHours: 0.5 });
    expect(parseFleetUnfedArgs({ windowHours: 168 })).toEqual({ windowHours: 168 });
  });

  it('rejects every other key and out-of-contract windowHours before any read', () => {
    for (const bad of [
      { root: '/tmp/fake' }, { path: '/tmp/x' }, { cwd: '/tmp' }, { runsDir: '/tmp' },
      { home: '/tmp' }, { limit: 1 }, { extra: 1 }, { window: 6 }, { hours: 6 },
      { windowHours: 0 }, { windowHours: -1 }, { windowHours: 168.5 }, { windowHours: 169 },
      { windowHours: Number.NaN }, { windowHours: Number.POSITIVE_INFINITY },
      { windowHours: '24' }, { windowHours: null }, { windowHours: true },
    ]) expect(parseFleetUnfedArgs(bad)).toBeNull();
  });
});

describe('readFleetUnfed', () => {
  it('wraps the shared report in the MCP envelope', async () => {
    const payload = report({ waiting: 3, unfedLanes: ['codex-cmp'], unfedSlots: 2 });
    const result = await readFleetUnfed({ windowHours: 6 }, { report: async input => {
      expect(input).toEqual({ windowHours: 6 });
      return payload;
    } });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      schema: 'fleet.unfed.v1', readOnly: true, source: 'derived',
      waiting: 3, unfedLanes: ['codex-cmp'], unfedSlots: 2,
    });
    expect((result as { generatedAt: string }).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports unavailable when the read throws — never an invented all-fed fleet', async () => {
    const result = await readFleetUnfed({}, {
      report: async () => { throw new Error('queue/status.json missing'); },
    });
    expect(result).toMatchObject({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      status: 'unavailable', reason: 'unfed-read-unavailable',
    });
    expect('unfedLanes' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('queue/status.json');
  });

  it('serves the real readUnfedReport assembly from a temp runs dir', async () => {
    const runsDir = fixture();
    writeStatus(runsDir, {
      'codex-cmp': { running: 1, target: 4, held: false, queued: 0 },
      'codex-personal': { running: 2, target: 2, held: false, queued: 3 },
    });
    writeFileSync(join(runsDir, 'queue', 'ready.tsv'), [
      'RQ-A\tphantom\tcodex-personal\twork\t/q/a.md',
      'RQ-B\tphantom\tcodex-personal\twork\t/q/b.md',
      'RQ-C\tphantom\tcodex-personal\twork\t/q/c.md',
      'RQ-D\tphantom\tcodex-cmp\twork\t/q/d.md',
      '',
    ].join('\n'));
    const result = await readFleetUnfed({ windowHours: 1 }, {
      report: input => readUnfedReport({ runsDir, windowHours: input.windowHours, now: () => NOW }),
    });
    expect(result).toMatchObject({
      schema: 'fleet.unfed.v1', readOnly: true, source: 'derived',
      waiting: 4, unfedLanes: ['codex-cmp'], unfedSlots: 3,
      statusAsOf: new Date(NOW).toISOString(), statusFresh: true,
    });
    const resources = (result as UnfedReport).resources;
    expect(resources.find(r => r.lane === 'codex-cmp')).toMatchObject({
      running: 1, target: 4, utilization: 0.25, headroom: 3, unfed: true,
    });
    expect(resources.find(r => r.lane === 'codex-personal')).toMatchObject({
      utilization: 1, headroom: 0, unfed: false,
    });
    const history = (result as UnfedReport).history;
    expect(history).toMatchObject({ windowHours: 1, available: false, ticks: 0 });
    expect(JSON.stringify(result)).not.toContain(runsDir);
  });

  it('reports unavailable through the real reader when status.json is absent', async () => {
    const runsDir = fixture();
    const result = await readFleetUnfed({}, {
      report: () => readUnfedReport({ runsDir, now: () => NOW }),
    });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'unfed-read-unavailable' });
  });
});

describe('fleet_unfed over the fleet MCP server', () => {
  it('is advertised read-only beside the lane reads with a bounded windowHours schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual([...FLEET_MCP_TOOL_NAMES]);
    const tool = tools.find(candidate => candidate.name === 'fleet_unfed');
    expect(tool?.annotations).toEqual({
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    expect(tool?.description).toContain('no caller root, path, cwd or runsDir is accepted');
    expect(tool?.description).toContain('readUnfedReport');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { windowHours: { type: 'number', exclusiveMinimum: 0, maximum: 168 } },
      additionalProperties: false,
    });
  });

  it.each([
    [{ root: '/tmp/fake-root' }], [{ path: '/tmp/x' }], [{ cwd: '/tmp' }],
    [{ runsDir: '/tmp/runs' }], [{ home: '/tmp' }], [{ limit: 5 }],
    [{ windowHours: 0 }], [{ windowHours: 169 }], [{ windowHours: '6' }], [{ windowHours: null }],
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const unfed = vi.fn();
    const client = await connect({ status: async () => ({}), loop: async () => ({}), unfed });
    await expect(client.callTool({ name: 'fleet_unfed', arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(unfed).not.toHaveBeenCalled();
  });

  it('dispatches parsed arguments to the injected reader', async () => {
    const payload = { schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', generatedAt: '2026-01-01T00:00:00.000Z', ok: true };
    const unfed = vi.fn(async () => payload);
    const client = await connect({ status: async () => ({}), loop: async () => ({}), unfed });
    const result = await client.callTool({ name: 'fleet_unfed', arguments: { windowHours: 6 } });
    expect(unfed).toHaveBeenCalledWith({ windowHours: 6 });
    expect(parsed(result)).toEqual(payload);
  });

  it('accepts an omitted arguments object and omitted windowHours', async () => {
    const unfed = vi.fn(async () => ({ ok: true }));
    const client = await connect({ status: async () => ({}), loop: async () => ({}), unfed });
    const result = await client.callTool({ name: 'fleet_unfed', arguments: {} });
    expect(unfed).toHaveBeenCalledWith({});
    expect(parsed(result)).toEqual({ ok: true });
  });

  it('keeps a throwing injected reader behind the sanitized fleet error', async () => {
    const client = await connect({
      status: async () => ({}), loop: async () => ({}),
      unfed: async () => { throw new Error('secret-shaped detail'); },
    });
    const result = await client.callTool({ name: 'fleet_unfed', arguments: {} });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(result.isError).toBe(true);
    expect(content[0]!.text).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });
});
