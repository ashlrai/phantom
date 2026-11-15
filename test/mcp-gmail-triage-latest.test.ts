/**
 * RQ-PHX-MCPGMAILTRIAGE30 — fleet_gmail_triage_latest: read-only saved Gmail
 * triage counts through the fleet MCP server. Hermetic: temp runs dir, fake
 * values, in-memory transport.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import {
  parseFleetGmailTriageLatestArgs, readFleetGmailTriageLatest,
} from '../src/mcp/fleet-gmail-triage-latest.js';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string;
const clients: Client[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-gmail-triage-')); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  rmSync(root, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    gmailTriageLatest: async () => readFleetGmailTriageLatest(root),
  });
  const client = new Client({ name: 'gmail-triage-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text);

function save(unreadInSample: number, target = 100): void {
  writeGmailTriageLatest(root, {
    dir: '/fake/Inbox', scanned: 200, updates: 5, drafted: 3, review: 2, failed: 1,
    unreadInSample, target, archiveCandidateCount: 7, now: () => new Date('2026-11-09T12:00:00Z'),
  });
}
function saveRaw(text: string): void {
  const path = gmailTriageLatestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('readFleetGmailTriageLatest', () => {
  it('reports a present file with counts, overTarget and age', () => {
    save(150);
    const over = readFleetGmailTriageLatest(root, () => new Date('2026-11-09T12:01:30Z'));
    expect(over).toMatchObject({ schema: 'fleet.mcp.gmail-triage-latest.v1', state: 'present', overTarget: true, ageSeconds: 90 });
    expect(over.latest).toMatchObject({ scanned: 200, updates: 5, drafted: 3, review: 2, failed: 1, unreadInSample: 150, target: 100, archiveCandidateCount: 7, dir: 'Inbox' });
    save(80);
    expect(readFleetGmailTriageLatest(root).overTarget).toBe(false);
    save(100);
    expect(readFleetGmailTriageLatest(root).overTarget).toBe(false);
  });

  it('reports missing for an absent, invalid-JSON or wrong-schema file', () => {
    const missing = { schema: 'fleet.mcp.gmail-triage-latest.v1', state: 'missing', latest: null, overTarget: null, ageSeconds: null };
    expect(readFleetGmailTriageLatest(root)).toEqual(missing);
    saveRaw('{not json');
    expect(readFleetGmailTriageLatest(root)).toEqual(missing);
    saveRaw(JSON.stringify({ schema: 'other.v1', at: 'x', dir: 'y' }));
    expect(readFleetGmailTriageLatest(root)).toEqual(missing);
  });
});

describe('parseFleetGmailTriageLatestArgs', () => {
  it('accepts only empty or undefined args', () => {
    expect(parseFleetGmailTriageLatestArgs(undefined)).toEqual({});
    expect(parseFleetGmailTriageLatestArgs({})).toEqual({});
    for (const key of ['dir', 'path', 'root', 'cwd']) expect(parseFleetGmailTriageLatestArgs({ [key]: '/tmp' })).toBeNull();
  });
});

describe('fleet_gmail_triage_latest through the server', () => {
  it('is listed, read-only and takes no arguments', async () => {
    const tool = (await (await connect()).listTools()).tools.find(t => t.name === 'fleet_gmail_triage_latest');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.annotations?.readOnlyHint).toBe(true);
  });

  it('serves the saved result without absolute paths', async () => {
    save(150);
    const result = await (await connect()).callTool({ name: 'fleet_gmail_triage_latest', arguments: {} });
    expect(result.isError).toBeFalsy();
    const body = parse(result);
    expect(body).toMatchObject({ state: 'present', overTarget: true });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it('reports missing when nothing is saved', async () => {
    const body = parse(await (await connect()).callTool({ name: 'fleet_gmail_triage_latest', arguments: {} }));
    expect(body).toMatchObject({ state: 'missing', latest: null, overTarget: null });
  });

  it('rejects any argument key as invalid args', async () => {
    save(150);
    await expect((await connect()).callTool({ name: 'fleet_gmail_triage_latest', arguments: { dir: '/tmp' } }))
      .rejects.toThrow(/Invalid fleet tool arguments/);
  });
});
