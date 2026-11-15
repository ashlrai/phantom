/**
 * RQ-PHX-GMAILARCHIVEMCP42 — fleet_gmail_archive_plan_latest: read-only saved
 * Gmail archive plans through the fleet MCP server. Hermetic: temp runs dir,
 * fake inboxes, in-memory transport.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import {
  parseFleetGmailArchivePlanLatestArgs, readFleetGmailArchivePlanLatest,
} from '../src/mcp/fleet-gmail-archive-plan-latest.js';
import { gmailArchivePlanLatestPath, writeGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

let root: string;
const clients: Client[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-gmail-archive-plan-')); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  rmSync(root, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    gmailArchivePlanLatest: async input => readFleetGmailArchivePlanLatest(input, root),
  });
  const client = new Client({ name: 'gmail-archive-plan-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

function save(inbox: string, unread: number, target = 100): void {
  writeGmailArchivePlanLatest(root, {
    inbox, unread, target, archiveCount: Math.max(0, unread - target),
    topSenders: [{ sender: 'news@example.test', count: 40 }], now: () => new Date('2026-11-09T12:00:00Z'),
  });
}
function saveRaw(text: string): void {
  const path = gmailArchivePlanLatestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('readFleetGmailArchivePlanLatest', () => {
  it('reports missing when no file exists', () => {
    expect(readFleetGmailArchivePlanLatest({}, root)).toEqual({ schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'missing', plans: [] });
  });

  it('computes overTarget per inbox', () => {
    save('work@example.test', 150);
    save('home@example.test', 100);
    const report = readFleetGmailArchivePlanLatest({}, root);
    expect(report.state).toBe('present');
    expect(report.plans).toHaveLength(2);
    expect(report.plans.find(p => p.inbox === 'work@example.test')).toMatchObject({
      unread: 150, target: 100, archiveCount: 50, overTarget: true, at: '2026-11-09T12:00:00.000Z',
      topSenders: [{ sender: 'news@example.test', count: 40 }],
    });
    expect(report.plans.find(p => p.inbox === 'home@example.test')).toMatchObject({ overTarget: false });
  });

  it('filters by inbox; an unknown inbox yields an empty present list', () => {
    save('work@example.test', 150);
    save('home@example.test', 20);
    const one = readFleetGmailArchivePlanLatest({ inbox: 'home@example.test' }, root);
    expect(one.plans.map(p => p.inbox)).toEqual(['home@example.test']);
    expect(readFleetGmailArchivePlanLatest({ inbox: 'nobody@example.test' }, root)).toMatchObject({ state: 'present', plans: [] });
  });

  it('reports missing for invalid-JSON, wrong-schema or oversized files', () => {
    const missing = { schema: 'fleet.mcp.gmail-archive-plan-latest.v1', state: 'missing', plans: [] };
    saveRaw('{not json');
    expect(readFleetGmailArchivePlanLatest({}, root)).toEqual(missing);
    saveRaw(JSON.stringify({ schema: 'other.v1', plans: [] }));
    expect(readFleetGmailArchivePlanLatest({}, root)).toEqual(missing);
    saveRaw(JSON.stringify({ schema: 'fleet.gmail-archive-plan-latest.v1', plans: [], pad: 'x'.repeat(70 * 1024) }));
    expect(readFleetGmailArchivePlanLatest({}, root)).toEqual(missing);
  });
});

describe('parseFleetGmailArchivePlanLatestArgs', () => {
  it('accepts empty args or a short inbox string only', () => {
    expect(parseFleetGmailArchivePlanLatestArgs(undefined)).toEqual({});
    expect(parseFleetGmailArchivePlanLatestArgs({})).toEqual({});
    expect(parseFleetGmailArchivePlanLatestArgs({ inbox: 'work@example.test' })).toEqual({ inbox: 'work@example.test' });
    expect(parseFleetGmailArchivePlanLatestArgs({ inbox: 'x'.repeat(65) })).toBeNull();
    expect(parseFleetGmailArchivePlanLatestArgs({ inbox: 5 })).toBeNull();
    for (const key of ['dir', 'path', 'root', 'cwd']) expect(parseFleetGmailArchivePlanLatestArgs({ [key]: '/tmp' })).toBeNull();
  });
});

describe('fleet_gmail_archive_plan_latest through the server', () => {
  it('is listed and read-only', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_gmail_archive_plan_latest');
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.inputSchema).toMatchObject({ additionalProperties: false });
  });

  it('serves saved plans, honours the filter and exposes no absolute paths', async () => {
    save('work@example.test', 150);
    save('home@example.test', 20);
    const client = await connect();
    const all = parse(await client.callTool({ name: 'fleet_gmail_archive_plan_latest', arguments: {} }));
    expect(all.plans).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain(root);
    const one = parse(await client.callTool({ name: 'fleet_gmail_archive_plan_latest', arguments: { inbox: 'work@example.test' } }));
    // The server's shared redaction masks email-shaped values in tool output, so assert on counts.
    expect(one.plans).toMatchObject([{ unread: 150, overTarget: true }]);
  });

  it('rejects path-like arguments', async () => {
    await expect((await connect()).callTool({ name: 'fleet_gmail_archive_plan_latest', arguments: { dir: '/tmp' } }))
      .rejects.toThrow(/Invalid fleet tool arguments/);
  });
});
