/**
 * RQ-PHX-GMAILMCPBOTH124 — fleet_gmail_triage_latest exposes every saved inbox
 * report, not just the latest. Hermetic: temp runs dir, fake example.test data.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readFleetGmailTriageLatest } from '../src/mcp/fleet-gmail-triage-latest.js';
import { gmailTriageLatestPath, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string;
const clients: Client[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fleet-gmail-both-')); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  rmSync(root, { recursive: true, force: true });
});

function save(dir: string, unreadInSample: number, target: number, at: string, scanned = 10): void {
  writeGmailTriageLatest(root, {
    dir, scanned, updates: 1, drafted: 2, review: 3, failed: 0,
    unreadInSample, target, archiveCandidateCount: 4, now: () => new Date(at),
  });
}
const NOW = () => new Date('2026-11-09T12:10:00Z');

async function callTool(): Promise<Record<string, unknown>> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}), loop: async () => ({}),
    gmailTriageLatest: async () => readFleetGmailTriageLatest(root, NOW),
  });
  const client = new Client({ name: 'gmail-both-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(st);
  await client.connect(ct);
  const result = await client.callTool({ name: 'fleet_gmail_triage_latest', arguments: {} });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

describe('both saved inboxes', () => {
  it('exposes Personal and Company while latest stays Company', async () => {
    save('/fake/accounts/Personal', 150, 100, '2026-11-09T12:00:00Z');
    save('/fake/accounts/Company', 20, 100, '2026-11-09T12:05:00Z', 99);
    const direct = readFleetGmailTriageLatest(root, NOW);
    const viaMcp = await callTool();
    for (const r of [direct, viaMcp] as Array<Record<string, any>>) {
      expect(r.latest.dir).toBe('Company');
      expect(r.state).toBe('present');
      expect(r.overTarget).toBe(false);
      expect(r.ageSeconds).toBe(300);
      expect(r.inboxLabelIdentity).toBe('directory-basename-unverified');
      expect(r.inboxes.map((i: any) => i.label).sort()).toEqual(['Company', 'Personal']);
      const personal = r.inboxes.find((i: any) => i.label === 'Personal');
      const company = r.inboxes.find((i: any) => i.label === 'Company');
      expect(personal).toMatchObject({ unreadInSample: 150, target: 100, overTarget: true, overTargetScope: 'sample', liveInboxTargetState: 'unknown', ageSeconds: 600, archiveCandidateCount: 4 });
      expect(company).toMatchObject({ scanned: 99, overTarget: false, ageSeconds: 300, liveInboxTargetState: 'unknown' });
    }
    expect(viaMcp).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('compares each inbox sample against its own target', () => {
    save('/x/A', 5, 5, '2026-11-09T12:00:00Z');
    save('/x/B', 6, 5, '2026-11-09T12:00:00Z');
    const by = Object.fromEntries(readFleetGmailTriageLatest(root, NOW).inboxes.map(i => [i.label, i.overTarget]));
    expect(by).toEqual({ A: false, B: true });
  });

  it('reports missing and invalid stores with no inboxes', () => {
    const missing = readFleetGmailTriageLatest(root, NOW);
    expect(missing).toMatchObject({ state: 'missing', latest: null, overTarget: null, ageSeconds: null, inboxes: [], liveInboxTargetState: 'unknown' });
    const path = gmailTriageLatestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{not json');
    expect(readFleetGmailTriageLatest(root, NOW)).toMatchObject({ state: 'missing', inboxes: [] });
  });

  it('projects a legacy v1 file as one inbox', () => {
    const path = gmailTriageLatestPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schema: 'fleet.gmail-triage-latest.v1', at: '2026-11-09T12:00:00Z', dir: 'Legacy',
      scanned: 1, updates: 0, drafted: 0, review: 0, failed: 0, unreadInSample: 9, target: 3, archiveCandidateCount: 0,
    }));
    const r = readFleetGmailTriageLatest(root, NOW);
    expect(r.inboxes).toHaveLength(1);
    expect(r.inboxes[0]).toMatchObject({ label: 'Legacy', overTarget: true, ageSeconds: 600 });
    expect(r.latest?.dir).toBe('Legacy');
  });

  it('clamps a future timestamp to age 0', () => {
    save('/x/Bad', 1, 5, '2026-11-09T12:20:00Z');
    expect(readFleetGmailTriageLatest(root, NOW).inboxes[0]!.ageSeconds).toBe(0);
  });

  it('serializes no absolute paths or message content', async () => {
    save('/fake/accounts/Personal', 1, 5, '2026-11-09T12:00:00Z');
    save('/fake/accounts/Company', 1, 5, '2026-11-09T12:01:00Z');
    const text = JSON.stringify(await callTool());
    expect(text).not.toContain('/fake');
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/subject|sender|body|messageId/i);
  });
});
