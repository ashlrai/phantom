import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer } from '../../src/mcp/fleet-server.js';
import { specialistRosterDirectory } from '../../src/core/fleet/roster.js';
import { parseFleetOrchestrationReadArgs } from '../../src/mcp/fleet-orchestration-read.js';

const connections: Client[] = [];
let home: string, path: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orchestration-mcp-'));
  vi.stubEnv('HOME', home);
  const directory = specialistRosterDirectory();
  expect(directory).toBe(join(home, '.ashlr-runs', 'queue', 'specialists'));
  mkdirSync(directory, { recursive: true });
  path = join(directory, 'orchestration.json');
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(client => client.close()));
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
async function connect(readers = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'orchestration-read-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const call = (client: Client, args: Record<string, unknown> = {}) => client.callTool({ name: 'fleet_orchestration_read', arguments: args });
const text = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0]!.text;
const parse = (result: { content?: unknown }) => JSON.parse(text(result));
const receipt = (day: number, status: 'reserved' | 'admitted' | 'complete', job = 'RQ-FAKE-1') => ({
  key: String(day).repeat(64), job, lane: 'fixture-lane', specialist: `fixture-specialist-${day}`,
  assignedAt: `2026-11-0${day}T00:00:00.000Z`, status,
  ...(status === 'admitted' ? { delivery: 'posted', slack: 'sent' } : {}),
});
const seed = () => writeFileSync(path, JSON.stringify({ version: 1, receipts: [
  receipt(1, 'reserved'), receipt(3, 'complete', 'RQ-FAKE-2'), receipt(2, 'admitted'), receipt(4, 'reserved'),
] }));

// The server's existing secret scrubber redacts the 64-character receipt digest.
const publicReceipt = (...args: Parameters<typeof receipt>) => ({ ...receipt(...args), key: '[REDACTED]' });

describe('fleet_orchestration_read over MCP', () => {
  it('advertises a closed, read-only schema and default bounds', async () => {
    const tools = (await (await connect()).listTools()).tools;
    const tool = tools.find(t => t.name === 'fleet_orchestration_read');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ additionalProperties: false, properties: {
      job: { type: 'string', maxLength: 64 }, limit: { minimum: 1, maximum: 100, default: 25 },
    } });
    expect(Object.keys(tool!.inputSchema.properties!)).toEqual(['status', 'job', 'limit']);
    expect(parseFleetOrchestrationReadArgs({})).toEqual({ limit: 25 });
    expect(parseFleetOrchestrationReadArgs({ job: 'x'.repeat(64), limit: 100 })).toEqual({ job: 'x'.repeat(64), limit: 100 });
  });

  it('returns global counts and all reservations, with sorted, filtered, capped receipts, without writes', async () => {
    seed();
    const before = readFileSync(path);
    const client = await connect();
    const all = parse(await call(client));
    expect(all).toMatchObject({ schemaVersion: 1, authority: 'none', source: 'ok', total: 4, truncated: false,
      counts: { reserved: 2, admitted: 1, complete: 1 } });
    expect(all.receipts).toEqual([publicReceipt(4, 'reserved'), publicReceipt(3, 'complete', 'RQ-FAKE-2'), publicReceipt(2, 'admitted'), publicReceipt(1, 'reserved')]);
    expect(all.unresolved).toEqual([4, 1].map(day => ({ job: 'RQ-FAKE-1', specialist: `fixture-specialist-${day}`, assignedAt: publicReceipt(day, 'reserved').assignedAt })));
    expect(parse(await call(client, { limit: 1 }))).toMatchObject({ total: 4, truncated: true, receipts: [publicReceipt(4, 'reserved')], unresolved: all.unresolved });
    for (const status of ['reserved', 'admitted', 'complete']) {
      const filtered = parse(await call(client, { status }));
      expect(filtered.receipts).toEqual(all.receipts.filter((r: { status: string }) => r.status === status));
      expect(filtered.counts).toEqual(all.counts);
      expect(filtered.unresolved).toEqual(all.unresolved);
    }
    expect(parse(await call(client, { job: 'RQ-FAKE-2' }))).toMatchObject({ total: 1, truncated: false, receipts: [publicReceipt(3, 'complete', 'RQ-FAKE-2')] });
    expect(parse(await call(client, { job: 'RQ-FAKE-1', status: 'reserved', limit: 1 }))).toMatchObject({ total: 2, truncated: true, receipts: [publicReceipt(4, 'reserved')] });
    expect(parse(await call(client, { job: 'RQ-FAKE' }))).toMatchObject({ total: 0, truncated: false, receipts: [] });
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(specialistRosterDirectory())).toEqual(['orchestration.json']);
  });

  it('distinguishes missing state from an empty journal without creating files', async () => {
    const client = await connect();
    const empty = { schemaVersion: 1, authority: 'none', total: 0, truncated: false,
      counts: { reserved: 0, admitted: 0, complete: 0 }, unresolved: [], receipts: [] };
    expect(parse(await call(client))).toEqual({ ...empty, source: 'missing' });
    expect(readdirSync(specialistRosterDirectory())).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, receipts: [] }));
    expect(parse(await call(client))).toEqual({ ...empty, source: 'ok' });
  });

  it.each(['{bad-json', '{"version":2,"receipts":[]}', '{"version":1,"receipts":[{}]}'])('reports sanitized errors for invalid state: %s', async body => {
    writeFileSync(path, body);
    const result = await call(await connect());
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  it.each([{ root: '/fake' }, { path: '/fake' }, { environment: {} }, { command: 'fake' }, { extra: true },
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '25' }, { limit: null },
    { job: 'x'.repeat(65) }, { job: 1 }, { job: null }, { status: 'unknown' }, { status: null },
  ])('rejects invalid arguments before invoking the reader: %j', async args => {
    const read = vi.fn(async () => ({}));
    expect(parseFleetOrchestrationReadArgs(args)).toBeNull();
    await expect(call(await connect({ orchestrationRead: read }), args)).rejects.toThrow('Invalid fleet tool arguments');
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps validation identical to the writer schema', () => {
    const schemas = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
      .match(/const receiptSchema = [\s\S]*?const journalSchema = [^\n]+/)?.[0];
    const writer = schemas('../../src/core/fleet/orchestrate.ts');
    expect(writer).toBeTruthy();
    expect(schemas('../../src/mcp/fleet-orchestration-read.ts')).toBe(writer);
  });
});
