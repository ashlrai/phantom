// fleet_recheck + fleet_recheck_history MCP tools (RQ-PHX-RECHECKMCP329).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import {
  DEFAULT_FLEET_RECHECK_HISTORY, MAX_FLEET_RECHECK_HISTORY,
  parseFleetRecheckArgs, parseFleetRecheckHistoryArgs, readFleetRecheckHistoryTool,
} from '../src/mcp/fleet-recheck.js';
import { RECHECK_RECORD_SCHEMA, recheckLogPath, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const clients: Client[] = [];
const roots: string[] = [];
const savedAshlrHome = process.env.ASHLR_HOME;

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  vi.restoreAllMocks();
  if (savedAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = savedAshlrHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'phantom-fleet-recheck-'));
  roots.push(root);
  return root;
}

function record(asOf: string, overall = 'VERIFIED'): RecheckRecord {
  return {
    schema: RECHECK_RECORD_SCHEMA,
    asOf,
    overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '0.0.0-fake', asOf },
      claims: { state: 'VERIFIED', active: 1, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: 'fake-task', owner: 'fake-owner', claimReceipt: 'bus-claim:fake:0:1', asOf },
      missing: null,
    },
  };
}

function writeLog(home: string, lines: string[]): void {
  mkdirSync(join(home, 'fleet'), { recursive: true });
  writeFileSync(recheckLogPath(home), `${lines.join('\n')}\n`);
}

async function connect(readers: Partial<FleetReaders> = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'fleet-recheck-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const parsed = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> =>
  JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

describe('recheck tool argument parsers', () => {
  it('fleet_recheck accepts only an empty argument object', () => {
    expect(parseFleetRecheckArgs(undefined)).toEqual({});
    expect(parseFleetRecheckArgs({})).toEqual({});
    expect(parseFleetRecheckArgs({ last: 5 })).toBeNull();
    expect(parseFleetRecheckArgs({ root: '/tmp' })).toBeNull();
    expect(parseFleetRecheckArgs({ bogus: 'value' })).toBeNull();
  });

  it('fleet_recheck_history accepts last 1..50 or nothing, nothing else', () => {
    expect(parseFleetRecheckHistoryArgs(undefined)).toEqual({ last: DEFAULT_FLEET_RECHECK_HISTORY });
    expect(parseFleetRecheckHistoryArgs({})).toEqual({ last: DEFAULT_FLEET_RECHECK_HISTORY });
    expect(parseFleetRecheckHistoryArgs({ last: 1 })).toEqual({ last: 1 });
    expect(parseFleetRecheckHistoryArgs({ last: MAX_FLEET_RECHECK_HISTORY })).toEqual({ last: MAX_FLEET_RECHECK_HISTORY });
    for (const bad of [
      { last: 0 }, { last: 51 }, { last: 1.5 }, { last: '5' }, { last: null },
      { last: 5, root: '/tmp' }, { bogus: 1 },
    ]) {
      expect(parseFleetRecheckHistoryArgs(bad)).toBeNull();
    }
  });
});

describe('readFleetRecheckHistoryTool', () => {
  it('reads newest-first rows under ASHLR_HOME and counts malformed lines', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    const older = record('2026-11-13T10:00:00.000Z');
    const newer = record('2026-11-13T11:00:00.000Z', 'BLOCKED');
    writeLog(home, [JSON.stringify(older), JSON.stringify(newer), '{malformed']);
    const result = await readFleetRecheckHistoryTool({ last: 5 });
    expect(result.skipped).toBe(1);
    expect(result.missing).toBe(false);
    expect(result.rows.map(r => r.asOf)).toEqual([newer.asOf, older.asOf]);
  });

  it('caps rows at last', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    writeLog(home, ['2026-11-13T10:00:00.000Z', '2026-11-13T11:00:00.000Z'].map(a => JSON.stringify(record(a))));
    const { rows } = await readFleetRecheckHistoryTool({ last: 1 });
    expect(rows.map(r => r.asOf)).toEqual(['2026-11-13T11:00:00.000Z']);
  });

  it('reports missing when no recheck log exists', async () => {
    process.env.ASHLR_HOME = fixture();
    expect(await readFleetRecheckHistoryTool({ last: 5 })).toEqual({ rows: [], skipped: 0, missing: true });
  });
});

describe('fleet_recheck over the fleet MCP server', () => {
  it('is listed as a read-only, argument-free tool', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_recheck');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('rejects any argument before reading', async () => {
    const recheck = vi.fn(async () => ({}));
    const client = await connect({ recheck });
    for (const args of [{ bogus: 'value' }, { root: '/tmp' }, { last: 5 }]) {
      await expect(client.callTool({ name: 'fleet_recheck', arguments: args })).rejects.toMatchObject({ code: -32602 });
    }
    expect(recheck).not.toHaveBeenCalled();
  });

  it('returns the injected reader result verbatim', async () => {
    const verdict = {
      schema: 'fleet.recheck.v1', asOf: '2026-11-13T10:00:00.000Z',
      sections: { runtime: { state: 'VERIFIED' } },
      overall: { state: 'VERIFIED', missing: [] },
    };
    const recheck = vi.fn(async () => verdict);
    const result = await (await connect({ recheck })).callTool({ name: 'fleet_recheck' });
    expect(result.isError).toBeUndefined();
    expect(parsed(result)).toEqual(verdict);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('never creates or appends to the recheck log', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    const result = await (await connect({ recheck: async () => ({ overall: { state: 'VERIFIED', missing: [] } }) }))
      .callTool({ name: 'fleet_recheck' });
    expect(result.isError).toBeUndefined();
    expect(existsSync(recheckLogPath(home))).toBe(false);
  });

  it('degrades a throwing reader to a fixed error without leaking its message', async () => {
    const result = await (await connect({ recheck: async () => { throw new Error(`${tmpdir()}/secret-path`); } }))
      .callTool({ name: 'fleet_recheck' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).not.toContain('secret-path');
  });
});

describe('fleet_recheck_history over the fleet MCP server', () => {
  it('is listed as a read-only tool with the bounded last schema', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_recheck_history');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { last: { type: 'integer', minimum: 1, maximum: MAX_FLEET_RECHECK_HISTORY, default: DEFAULT_FLEET_RECHECK_HISTORY } },
      additionalProperties: false,
    });
  });

  it('rejects invalid arguments before reading', async () => {
    const recheckHistory = vi.fn(async () => ({}));
    const client = await connect({ recheckHistory });
    for (const args of [{ last: 0 }, { last: 51 }, { last: 1.5 }, { last: 'five' }, { last: null }, { root: '/tmp' }, { last: 5, extra: true }]) {
      await expect(client.callTool({ name: 'fleet_recheck_history', arguments: args })).rejects.toMatchObject({ code: -32602 });
    }
    expect(recheckHistory).not.toHaveBeenCalled();
  });

  it('returns the injected reader result verbatim with the parsed last', async () => {
    const recheckHistory = vi.fn(async () => ({ rows: [{ asOf: 'fake' }], skipped: 2, missing: false }));
    const result = await (await connect({ recheckHistory })).callTool({ name: 'fleet_recheck_history', arguments: { last: 7 } });
    expect(result.isError).toBeUndefined();
    expect(parsed(result)).toEqual({ rows: [{ asOf: 'fake' }], skipped: 2, missing: false });
    expect(recheckHistory).toHaveBeenCalledWith({ last: 7 });
  });

  it('reads newest-first rows from the real log with skipped and missing flags', async () => {
    const home = fixture();
    process.env.ASHLR_HOME = home;
    const older = record('2026-11-13T10:00:00.000Z');
    const newer = record('2026-11-13T11:00:00.000Z', 'BLOCKED');
    writeLog(home, [JSON.stringify(older), JSON.stringify(newer), 'not json']);
    const result = await (await connect()).callTool({ name: 'fleet_recheck_history', arguments: { last: 5 } });
    expect(result.isError).toBeUndefined();
    const body = parsed(result);
    expect(body).toMatchObject({ skipped: 1, missing: false });
    const rows = body['rows'] as RecheckRecord[];
    expect(rows.map(r => r.asOf)).toEqual([newer.asOf, older.asOf]);
    expect(rows[0]).toMatchObject({ overall: 'BLOCKED', sections: { task: { claimReceipt: 'bus-claim:fake:0:1' } } });
  });

  it('defaults last to 5 and reports missing when no log exists', async () => {
    process.env.ASHLR_HOME = fixture();
    const result = await (await connect()).callTool({ name: 'fleet_recheck_history' });
    expect(parsed(result)).toEqual({ rows: [], skipped: 0, missing: true });
  });
});
