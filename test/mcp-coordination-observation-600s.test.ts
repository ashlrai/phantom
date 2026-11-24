import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, postFleetMessage } from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const names = ['fleet_coordination_claims', 'fleet_coordination_returns'];
const now = 1_800_000_000_000;
const privateText = 'synthetic private message body 600s';
let leases: string[];
let root: string, path: string, client: Client, server: ReturnType<typeof createFleetServer>;

function snapshot() {
  const bytes = readFileSync(path);
  return { bytes, metadata: statSync(path, { bigint: true }), entries: readdirSync(root).sort() };
}
async function read(name: string) {
  const result = await client.callTool({ name, arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  expect(text).not.toContain(privateText);
  expect(text).not.toContain(path);
  expect(text).not.toContain('leaseHash');
  expect(text).not.toContain('executionAuthorized');
  for (const lease of leases) expect(text).not.toContain(lease);
  return JSON.parse(text);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-observation-600s-'));
  path = join(root, 'coordination.jsonl');
  leases = [];
  vi.stubEnv('HOME', root);
  vi.stubEnv('ASHLR_HOME', root);
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer();
  await server.connect(st);
  client = new Client({ name: 'observation-600s', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('MCP coordination observations over a real isolated ledger', () => {
  it('lists both closed read-only tools', async () => {
    const { tools } = await client.listTools();
    for (const name of names) {
      const tool = tools.find(t => t.name === name);
      expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
      expect(tool?.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.some(tool => tool.name === 'fleet_empties')).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  it('preserves bytes and metadata across repeated reads; explicit mutations still reap', async () => {
    const options = { path, now: now - 1000 };
    const active = claimFleetWork({ repo: 'ashlrai/phantom', task: 'Active synthetic task', agent: 'fixture' }, options);
    expect(active.ok).toBe(true);
    if (active.ok) leases.push(active.value.lease);
    expect(postFleetMessage({ id: 'return-fixture', from: 'fixture', to: 'all',
      body: 'RESULT VERIFIED ashlrai/phantom claim fixture task "Read": pr #540 head abc1234' }, options).ok).toBe(true);
    expect(postFleetMessage({ id: 'return-private', from: 'fixture', to: 'all', body: privateText }, options).ok).toBe(true);
    expect(postFleetMessage({ id: 'return-expired', from: 'fixture', to: 'all', ttlMs: 1,
      body: 'RESULT VERIFIED ashlrai/phantom claim expired task "Expired": pr #600 head def5678' }, options).ok).toBe(true);
    // Create this last: subsequent writers would correctly reap it at their own clock.
    const expired = claimFleetWork({ repo: 'ashlrai/phantom', task: 'Expired', agent: 'fixture', ttlMs: 1 }, options);
    expect(expired.ok).toBe(true);
    if (expired.ok) leases.push(expired.value.lease);
    const before = snapshot();
    leases.push(...before.bytes.toString().trim().split('\n').map(line => JSON.parse(line).claim?.leaseHash).filter(Boolean));
    // An accidental second clock capture in the board would expire both live rows.
    vi.spyOn(Date, 'now').mockImplementation(() =>
      (new Error().stack ?? '').includes('readFleetBoard') ? now + 3_600_000 : now);
    for (let i = 0; i < 3; i++) {
      const claims = await read(names[0]!);
      expect(claims).toMatchObject({ state: 'known', source: 'coordination-ledger',
        asOf: new Date(now).toISOString(), expiredClaims: 1,
        claims: [{ repo: 'ashlrai/phantom', agent: 'fixture', expiresInSeconds: 3599 }] });
      expect(claims.claims).toHaveLength(1);
      expect(claims.claims[0].task).toBe('Active synthetic task');
      const returns = await read(names[1]!);
      expect(returns).toMatchObject({ state: 'known', asOf: claims.asOf, unparsed: 1,
        returns: [{ claimId: 'fixture', pr: 540, head: 'abc1234', temporal: 'current' }] });
      expect(returns.returns).toHaveLength(1);
      expect(snapshot()).toEqual(before);
    }
    expect(postFleetMessage({ from: 'fixture', to: 'all', body: 'Explicit mutation' }, { path, now }).ok).toBe(true);
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.kind === 'reap')).toMatchObject([
      { id: expired.ok ? expired.value.claim.id : '', state: 'RELEASED', reason: 'lease-expired', at: now },
    ]);
  });

  it.each(['malformed', 'unreadable', 'missing'])('degrades %s evidence without leaking details or changing disk', async kind => {
    if (kind === 'malformed') writeFileSync(path, `${privateText}\n`, { mode: 0o600 });
    // A directory cannot be read as a private ledger, even under privileged test users.
    if (kind === 'unreadable') mkdirSync(path);
    const entries = readdirSync(root);
    const before = kind === 'malformed' ? snapshot() : statSync(root, { bigint: true });
    for (const name of names) {
      const value = await read(name);
      expect(value).toMatchObject({ state: 'unknown', source: 'coordination-ledger' });
      expect(value[name.endsWith('claims') ? 'claims' : 'returns']).toEqual([]);
      expect(Number.isFinite(Date.parse(value.asOf))).toBe(true);
    }
    expect(kind === 'malformed' ? snapshot() : statSync(root, { bigint: true })).toEqual(before);
    expect(readdirSync(root)).toEqual(entries);
  });

  it('rejects invalid arguments before entering either evidence helper', async () => {
    let evidenceClockReads = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (/readFleetCoordination(?:Claims|Returns)|readFleetBoard/.test(new Error().stack ?? '')) evidenceClockReads++;
      return now;
    });
    for (const name of names) for (const key of ['path', 'root', 'cwd', 'limit', 'reap', 'now']) {
      await expect(client.callTool({ name, arguments: { [key]: '/fake/private' } }))
        .rejects.toMatchObject({ code: -32602 });
    }
    expect(evidenceClockReads).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });
});
