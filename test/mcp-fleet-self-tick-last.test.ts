// fleet_self_tick_last MCP tool (RQ-PHX-MCPSELFTICKLAST02, recut as RQ-PHX-DIRTYPHXRECUT57).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { SELF_TICK_LAST, writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import { parseFleetSelfTickLastArgs, readFleetSelfTickLast } from '../src/mcp/fleet-self-tick.js';
import type { SelfTickReport, SelfTickStepResult } from '../src/core/fleet/self-tick.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const clients: Client[] = [];
const roots: string[] = [];
const savedRunsDir = process.env.ASHLR_RUNS_DIR;

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  if (savedRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = savedRunsDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phantom-fleet-stl-'));
  roots.push(root);
  return root;
}

function writeReport(runsDir: string, steps: SelfTickStepResult[], atMs = NOW - 120_000, mode: SelfTickReport['mode'] = 'apply'): void {
  writeSelfTickLast(runsDir, { v: 1, at: new Date(atMs).toISOString(), mode, state: 'ran', steps });
}

async function connect(readers: Partial<FleetReaders> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'fleet-stl-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const parsed = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

describe('readFleetSelfTickLast', () => {
  it('returns last: null when no self-tick pass was ever recorded', async () => {
    const result = await readFleetSelfTickLast({ runsDir: fixture(), now: () => NOW });
    expect(result).toEqual({
      schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
      generatedAt: new Date(NOW).toISOString(), last: null,
    });
  });

  it('reports mode, ran state, age and failed step names from a written record', async () => {
    const runsDir = fixture();
    writeReport(runsDir, [
      { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
      { step: 'planner-tick', state: 'failed', exitCode: 1, report: { error: 'timeout' } },
      { step: 'landed-sweep', state: 'ok', exitCode: 0, report: null },
    ]);
    const { last } = await readFleetSelfTickLast({ runsDir, now: () => NOW });
    expect(last).toEqual({
      state: 'ok', at: new Date(NOW - 120_000).toISOString(), mode: 'apply', ranState: 'ran',
      ageSeconds: 120, failedSteps: ['planner-tick'],
    });
  });

  it('reports unreadable for a record that fails validation, never a partial ok', async () => {
    const runsDir = fixture();
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, SELF_TICK_LAST), JSON.stringify({ v: 1, at: 'not-a-date', mode: 'apply', state: 'ran', steps: [] }));
    expect((await readFleetSelfTickLast({ runsDir, now: () => NOW })).last).toEqual({ state: 'unreadable' });
  });

  it('never writes, locks or creates anything under the runs dir', async () => {
    const runsDir = fixture();
    await readFleetSelfTickLast({ runsDir, now: () => NOW });
    expect(readdirSync(runsDir)).toEqual([]);
  });

  it('defaults to ASHLR_RUNS_DIR, as `fleet self-tick --last` does', async () => {
    const runsDir = fixture();
    writeReport(runsDir, [{ step: 'reset-release', state: 'ok', exitCode: 0, report: null }], NOW - 5_000, 'dry-run');
    process.env.ASHLR_RUNS_DIR = runsDir;
    expect((await readFleetSelfTickLast({ now: () => NOW })).last).toMatchObject({ state: 'ok', mode: 'dry-run', ageSeconds: 5 });
  });

  it('accepts only an empty argument object', () => {
    expect(parseFleetSelfTickLastArgs(undefined)).toEqual({});
    expect(parseFleetSelfTickLastArgs({})).toEqual({});
    expect(parseFleetSelfTickLastArgs({ runsDir: '/tmp' })).toBeNull();
  });
});

describe('fleet_self_tick_last over the fleet MCP server', () => {
  it('is listed as a read-only, argument-free tool', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_self_tick_last');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('rejects any argument before reading', async () => {
    const selfTickLast = vi.fn(async () => ({}));
    const client = await connect({ selfTickLast });
    for (const args of [{ bogus: 'value' }, { runsDir: '/tmp' }, { limit: 1 }]) {
      await expect(client.callTool({ name: 'fleet_self_tick_last', arguments: args })).rejects.toMatchObject({ code: -32602 });
    }
    expect(selfTickLast).not.toHaveBeenCalled();
  });

  it('dispatches to the injected reader', async () => {
    const selfTickLast = vi.fn(async () => ({ schemaVersion: 1, last: null }));
    const result = await (await connect({ selfTickLast })).callTool({ name: 'fleet_self_tick_last' });
    expect(result.isError).toBeUndefined();
    expect(parsed(result)).toEqual({ schemaVersion: 1, last: null });
    expect(selfTickLast).toHaveBeenCalledTimes(1);
  });

  it('reads the real record through the default reader', async () => {
    const runsDir = fixture();
    writeReport(runsDir, [
      { step: 'reset-release', state: 'ok', exitCode: 0, report: null },
      { step: 'stray-stop', state: 'failed', exitCode: 2, report: null },
    ], Date.now() - 60_000);
    process.env.ASHLR_RUNS_DIR = runsDir;
    const result = await (await connect()).callTool({ name: 'fleet_self_tick_last', arguments: {} });
    const body = parsed(result);
    expect(body).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none' });
    expect(body['last']).toMatchObject({ state: 'ok', mode: 'apply', ranState: 'ran', failedSteps: ['stray-stop'] });
    expect(JSON.stringify(body)).not.toContain(runsDir);
  });

  it('degrades a throwing reader to a fixed error without leaking its message', async () => {
    const result = await (await connect({ selfTickLast: async () => { throw new Error(`${tmpdir()}/secret-path`); } }))
      .callTool({ name: 'fleet_self_tick_last' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('secret-path');
  });
});
