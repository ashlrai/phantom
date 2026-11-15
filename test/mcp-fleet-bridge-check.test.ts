import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { NOTE, readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NAME = 'fleet_bridge_check';
const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const NOW_ISO = '2026-11-15T00:00:00.000Z';

const SNAPSHOT = {
  schemaVersion: 1, authority: 'none', note: 'fleet_runtime adapter note',
  host: 'fake-host', tailnetName: 'fake-tail', installedVersion: '1.2.3', sourceVersion: '1.2.3',
  pid: 42, uptimeSeconds: 60, platform: 'fakeos', arch: 'fakearch', stateRoot: '~/.ashlr-runs',
  lastFleetStateRead: { mtime: '2026-11-14T23:59:30.000Z', ageSeconds: 30 },
  coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 45 },
  execution: { state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 },
  asOf: NOW_ISO, reasons: [],
};

const CLAIMS = {
  v: 1, source: 'coordination-ledger', asOf: NOW_ISO, state: 'known',
  claims: [
    { id: 'claim-a', repo: 'fake/repo', task: 'fake task one', agent: 'fake-agent',
      claimedAt: '2026-11-14T23:59:00.000Z', expiresAt: '2026-11-15T01:00:00.000Z', expiresInSeconds: 3600 },
    { id: 'claim-b', repo: 'fake/repo', task: 'fake task two', agent: 'fake-agent',
      claimedAt: '2026-11-14T23:58:00.000Z', expiresAt: '2026-11-15T01:00:00.000Z', expiresInSeconds: 3600 },
  ],
  expiredClaims: 0,
};

const PEERS = {
  v: 1, authority: 'none', status: 'ok', asOf: NOW_ISO, liveRows: 2, capacity: 1024,
  windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'alpha', target: 'beta', inWindow: 1, remaining: 5,
    lastAt: '2026-11-14T23:59:00.000Z', retryAt: null }],
  origins: [{ origin: 'handoff', maxHop: 3, nearCap: false }],
  truncated: { pairs: false, origins: false },
  note: 'fleet_peer_ledger adapter note',
};

const servers: Array<ReturnType<typeof createFleetServer>> = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect(deps: Partial<FleetBridgeCheckDeps> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck({
      runtime: deps.runtime ?? (async () => structuredClone(SNAPSHOT)),
      claims: deps.claims ?? (() => structuredClone(CLAIMS)),
      peers: deps.peers ?? (() => structuredClone(PEERS)),
      now: deps.now ?? (() => NOW),
    }),
  });
  servers.push(server);
  const client = new Client({ name: 'bridge-check-test', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client) {
  const result = await client.callTool({ name: NAME, arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text, value: JSON.parse(text) };
}

describe('fleet_bridge_check MCP tool', () => {
  it('lists a closed read-only tool with the shared annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === NAME);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool?.description).toBe(NOTE);
    expect(tool?.annotations).toEqual(tools.find(t => t.name === 'fleet_runtime')?.annotations);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it('READY with asOf on every section when all readers return clean evidence', async () => {
    const client = await connect();
    const { result, value } = await call(client);
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ verdict: 'READY', asOf: NOW_ISO, missing: [] });
    expect(value.runtime).toMatchObject({ status: 'ok', source: 'fleet-runtime', asOf: NOW_ISO,
      host: 'fake-host', installedVersion: '1.2.3' });
    expect(value.runtime['note']).toBeUndefined();
    expect(value.claims).toEqual({ status: 'ok', state: 'known', live: 2, newestAgeSec: 60,
      source: 'coordination-ledger', asOf: NOW_ISO });
    expect(value.peers).toMatchObject({ status: 'ok', source: 'peer-ledger', asOf: NOW_ISO, liveRows: 2 });
    expect(value.peers['note']).toBeUndefined();
  });

  it('BLOCKED naming the missing part when the runtime snapshot is absent', async () => {
    const client = await connect({ runtime: async () => { throw new Error('private-reader-detail'); } });
    const { result, text, value } = await call(client);
    expect(result.isError).not.toBe(true);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('runtime');
    expect(value.runtime).toMatchObject({ status: 'unavailable', source: 'fleet-runtime', asOf: NOW_ISO });
    expect(value.claims.asOf).toBe(NOW_ISO);
    expect(value.peers.asOf).toBe(NOW_ISO);
    expect(text).not.toContain('private-reader-detail');
  });

  it('a reader that throws becomes a missing entry, not an error', async () => {
    const client = await connect({ claims: () => { throw new Error('ledger exploded at /private/path'); } });
    const { result, text, value } = await call(client);
    expect(result.isError).not.toBe(true);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('claims');
    expect(value.claims).toMatchObject({ status: 'unavailable', asOf: NOW_ISO });
    expect(value.runtime.status).toBe('ok');
    expect(value.peers.status).toBe('ok');
    expect(text).not.toContain('ledger exploded');
    expect(text).not.toContain('/private/path');
  });

  it('BLOCKED with claims unreadable when the ledger state is unknown', async () => {
    const client = await connect({ claims: () => ({ ...structuredClone(CLAIMS), state: 'unknown', claims: [],
      reason: 'coordination ledger: reader failed' }) });
    const { value } = await call(client);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('claims');
    expect(value.claims).toMatchObject({ status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null });
  });

  it('BLOCKED when the peer ledger reports unavailable', async () => {
    const client = await connect({ peers: () => ({ ...structuredClone(PEERS), status: 'unavailable',
      reason: 'peer-ledger-unreadable', pairs: [], origins: [], liveRows: 0 }) });
    const { value } = await call(client);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('peers');
    expect(value.peers).toMatchObject({ status: 'unavailable', source: 'peer-ledger' });
  });

  it('BLOCKED when fleet state is stale or unreadable inside an otherwise clean snapshot', async () => {
    const client = await connect({ runtime: async () => ({ ...structuredClone(SNAPSHOT),
      lastFleetStateRead: { mtime: '2026-11-14T00:00:00.000Z', ageSeconds: 2000 } }) });
    const { value } = await call(client);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('runtime.fleet-state-stale');

    const unreadable = await connect({ runtime: async () => ({ ...structuredClone(SNAPSHOT),
      lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' } }) });
    const again = await call(unreadable);
    expect(again.value.verdict).toBe('BLOCKED');
    expect(again.value.missing).toContain('runtime.fleet-state');
  });

  it('refuses caller arguments before invoking any reader', async () => {
    const client = await connect();
    await expect(client.callTool({ name: NAME, arguments: { root: '/tmp' } }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
