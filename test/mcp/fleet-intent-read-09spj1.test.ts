import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import { cmdFleetIntentRead } from '../../src/cli/fleet-intent-read.js';
import { INTENT_LEDGER_SCHEMA, type IntentItem } from '../../src/core/intent/schema.js';

const connections: Client[] = [];
let runs: string;
let prior: string | undefined;

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'intent-mcp-'));
  prior = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  if (prior === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = prior;
  rmSync(runs, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function connect(readers = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'intent-read-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const call = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'fleet_intent_read', arguments: args });
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]!.text;

const item = (id: string, status: IntentItem['status'], extra: Partial<IntentItem> = {}): IntentItem => ({
  id, title: `Directive ${id}`, source: 'fixture-source', owner: 'fixture-owner', rq: [`RQ-FIX-${id.toUpperCase()}`],
  prs: [{ repo: 'example/repo', number: 7, state: 'merged' }], status,
  evidence: [{ at: '2026-11-01T00:00:00.000Z', kind: 'note', ref: 'fixture-ref', note: 'fake note' }],
  provenance: [{ source: 'fixture-prov', date: null, verbatim: true, partial: false }],
  partial: false, closureProposal: null, lastTouchedAt: '2026-11-01T00:00:00.000Z', staleAfterMs: 1000,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...extra,
});
const ledgerPath = () => join(runs, 'intent', 'ledger.json');
function seed(items: IntentItem[]) {
  mkdirSync(join(runs, 'intent'), { recursive: true });
  writeFileSync(ledgerPath(), `${JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items })}\n`);
}
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort().map(name => {
    const info = statSync(join(dir, name));
    return `${name}:${info.isFile() ? readFileSync(join(dir, name), 'utf8') : 'dir'}`;
  });
}
async function cli(args: string[]) {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
  await cmdFleetIntentRead(args);
  return JSON.parse(lines[0]!);
}

describe('fleet_intent_read over MCP', () => {
  it('is advertised read-only with a closed schema and no path or write surface', async () => {
    const tools = (await (await connect()).listTools()).tools;
    const tool = tools.find(t => t.name === 'fleet_intent_read');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['action'], additionalProperties: false });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort()).toEqual(['action', 'id', 'limit', 'status']);
    expect(tools.filter(t => /intent/.test(t.name)).map(t => t.name)).toEqual(['fleet_intent_read']);
  });

  it('lists, filters by status and gets with the CLI semantics, leaving files unchanged', async () => {
    seed([item('a1', 'queued'), item('b2', 'shipped'), item('c3', 'queued')]);
    const before = snapshot(runs);
    const client = await connect();
    const all = parse(await call(client, { action: 'list' }));
    expect(all).toMatchObject({ action: 'list', total: 3, limit: 25, truncated: false });
    expect(all.records.map((r: { id: string }) => r.id)).toEqual((await cli(['list', '--json'])).records.map((r: { id: string }) => r.id));
    const queued = parse(await call(client, { action: 'list', status: 'queued' }));
    expect(queued.records.map((r: { id: string }) => r.id)).toEqual(['a1', 'c3']);
    expect(queued.records.map((r: { id: string }) => r.id)).toEqual((await cli(['list', '--status', 'queued', '--json'])).records.map((r: { id: string }) => r.id));
    const got = parse(await call(client, { action: 'get', id: 'b2' }));
    expect(got).toMatchObject({ found: true, item: { id: 'b2', status: 'shipped', prs: [{ repo: 'example/repo', number: 7 }], evidence: [{ ref: 'fixture-ref' }] } });
    expect(got.item).toEqual(JSON.parse(JSON.stringify((await cli(['get', 'b2', '--json'])).item)));
    expect(snapshot(runs)).toEqual(before);
  });

  it('honors limits and reports truncation with the full matching total', async () => {
    seed(['a', 'b', 'c', 'd'].map(id => item(id, 'queued')));
    const client = await connect();
    expect(parse(await call(client, { action: 'list', limit: 2 }))).toMatchObject({ total: 4, limit: 2, truncated: true });
    expect(parse(await call(client, { action: 'list', limit: 2 })).records).toHaveLength(2);
    expect(parse(await call(client, { action: 'list', limit: 4 }))).toMatchObject({ truncated: false });
  });

  it('does not pass unknown ledger keys through', async () => {
    seed([{ ...item('a1', 'queued'), hidden: 'leak-me' } as IntentItem]);
    const client = await connect();
    expect(text(await call(client, { action: 'list' }))).not.toContain('leak-me');
    expect(text(await call(client, { action: 'get', id: 'a1' }))).not.toContain('leak-me');
  });

  it('rejects invalid and extra arguments before reading the ledger', async () => {
    seed([item('a1', 'queued')]);
    const read = vi.fn();
    const client = await connect({ intentRead: read });
    const bad: Array<Record<string, unknown>> = [
      {}, { action: 'delete' }, { action: 'list', status: 'bogus' }, { action: 'list', limit: 0 }, { action: 'list', limit: 101 },
      { action: 'list', limit: 1.5 }, { action: 'list', limit: '5' }, { action: 'list', id: 'a1' }, { action: 'get' },
      { action: 'get', id: '../x' }, { action: 'get', id: 'a1', status: 'queued' }, { action: 'get', id: 'a1', limit: 5 },
      { action: 'list', root: '/tmp' }, { action: 'list', path: '/tmp' }, { action: 'list', env: {} }, { action: 'list', status: null },
    ];
    for (const args of bad) await expect(call(client, args)).rejects.toThrow(/Invalid fleet tool arguments/);
    expect(read).not.toHaveBeenCalled();
  });

  it('treats a missing ledger as empty and an unknown id as not found', async () => {
    const client = await connect();
    expect(parse(await call(client, { action: 'list' }))).toMatchObject({ total: 0, truncated: false, records: [] });
    seed([item('a1', 'queued')]);
    const missing = await call(client, { action: 'get', id: 'zzz' });
    expect(missing.isError).toBeUndefined();
    expect(parse(missing)).toMatchObject({ found: false, id: 'zzz' });
  });

  it('fails honestly and sanitized for malformed, wrong-schema and symlinked ledgers', async () => {
    const client = await connect();
    mkdirSync(join(runs, 'intent'), { recursive: true });
    const bodies = ['{not json', JSON.stringify({ schema: 'other/v9', items: [] }), JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [{ id: 'x' }] })];
    for (const body of bodies) {
      writeFileSync(ledgerPath(), body);
      for (const args of [{ action: 'list' }, { action: 'get', id: 'x' }]) {
        const result = await call(client, args);
        expect(result.isError).toBe(true);
        expect(text(result)).not.toContain(runs);
        expect(text(result)).not.toMatch(/JSON|Unexpected|ashlr\.intent/);
      }
    }
    rmSync(ledgerPath());
    const target = join(runs, 'real.json');
    writeFileSync(target, JSON.stringify({ schema: INTENT_LEDGER_SCHEMA, items: [] }));
    symlinkSync(target, ledgerPath());
    const result = await call(client, { action: 'list' });
    expect(result.isError).toBe(true);
    expect(text(result)).not.toContain(runs);
  });
});
