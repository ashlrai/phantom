import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NAME = 'fleet_bridge_check';
const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const NOW_ISO = '2026-11-15T00:00:00.000Z';
const SNAPSHOT_AS_OF = '2026-11-14T23:59:59.000Z';

/** Producer-shaped runtime snapshot as readRuntimeSnapshot emits on a healthy host. */
const SNAPSHOT = {
  schemaVersion: 1, authority: 'none',
  host: 'fake-host', tailnetName: 'fake-tail', installedVersion: '1.2.3', sourceVersion: '1.2.3',
  pid: 42, uptimeSeconds: 60, platform: 'fakeos', arch: 'fakearch', stateRoot: '~/.ashlr-runs',
  lastFleetStateRead: { mtime: '2026-11-14T23:59:30.000Z', ageSeconds: 30 },
  coordination: { state: 'known', activeClaims: 2, newestReturnAgeSeconds: 45 },
  execution: { state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 },
  asOf: SNAPSHOT_AS_OF, reasons: [],
};

const CLAIMS = {
  v: 1, source: 'coordination-ledger', asOf: NOW_ISO, state: 'known',
  claims: [
    { id: 'claim-a', repo: 'fake/repo', task: 'fake task one', agent: 'fake-agent',
      claimedAt: '2026-11-14T23:59:00.000Z', expiresAt: '2026-11-15T01:00:00.000Z', expiresInSeconds: 3600 },
  ],
  expiredClaims: 0,
};

const EMPTY_CLAIMS = { ...CLAIMS, claims: [] };

const PEERS = {
  v: 1, authority: 'none', status: 'ok', asOf: NOW_ISO, liveRows: 2, capacity: 1024,
  windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'alpha', target: 'beta', inWindow: 1, remaining: 5,
    lastAt: '2026-11-14T23:59:00.000Z', retryAt: null }],
  origins: [{ origin: 'handoff', maxHop: 3, nearCap: false }],
  truncated: { pairs: false, origins: false },
};

/** Legitimate empty peer report: the ledger file was read and held no live rows. */
const EMPTY_PEERS = {
  ...PEERS, status: 'empty', liveRows: 0, pairs: [], origins: [],
};

function deps(overrides: Partial<FleetBridgeCheckDeps> = {}): FleetBridgeCheckDeps {
  return {
    runtime: async () => structuredClone(SNAPSHOT),
    claims: () => structuredClone(CLAIMS),
    peers: () => structuredClone(PEERS),
    now: () => NOW,
    ...overrides,
  };
}

const servers: Array<ReturnType<typeof createFleetServer>> = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect(d: FleetBridgeCheckDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck(d),
  });
  servers.push(server);
  const client = new Client({ name: 'bridge-evidence-test', version: '1.0.0' });
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

describe('fleet_bridge_check evidence validation', () => {
  it('stays READY on valid producer-shaped evidence', async () => {
    const check = await readFleetBridgeCheck(deps());
    expect(check).toMatchObject({ verdict: 'READY', missing: [] });
    expect(check.runtime).toMatchObject({ status: 'ok', asOf: SNAPSHOT_AS_OF });
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 1 });
    expect(check.peers).toMatchObject({ status: 'ok' });
  });

  it('stays READY on a known empty claims board and a legitimate empty peer report', async () => {
    const check = await readFleetBridgeCheck(deps({
      claims: () => structuredClone(EMPTY_CLAIMS),
      peers: () => structuredClone(EMPTY_PEERS),
    }));
    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 0 });
    expect(check.peers).toMatchObject({ status: 'empty' });
  });

  it.each(['unavailable', 'unknown', 'degraded'])(
    'BLOCKED when the runtime snapshot carries explicit status %s despite a fresh age',
    async (status) => {
      const check = await readFleetBridgeCheck(deps({
        runtime: async () => ({ ...structuredClone(SNAPSHOT), status }),
      }));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toContain('runtime');
      expect(check.runtime.status).toBe(status);
      // Independent healthy sections and the snapshot's own asOf are preserved.
      expect(check.claims.status).toBe('ok');
      expect(check.peers.status).toBe('ok');
      expect(check.runtime.asOf).toBe(SNAPSHOT_AS_OF);
    });

  it('BLOCKED when the runtime status is present but not a string', async () => {
    const check = await readFleetBridgeCheck(deps({
      runtime: async () => ({ ...structuredClone(SNAPSHOT), status: 42 }),
    }));
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toContain('runtime');
    expect(check.runtime.status).toBe('unavailable');
  });

  it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, 'UNKNOWN', '30'])(
    'BLOCKED when fleet-state ageSeconds is %s',
    async (ageSeconds) => {
      const check = await readFleetBridgeCheck(deps({
        runtime: async () => ({ ...structuredClone(SNAPSHOT),
          lastFleetStateRead: { mtime: '2026-11-14T23:59:30.000Z', ageSeconds } }),
      }));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toContain('runtime.fleet-state');
      expect(check.runtime.reason).toBe('fleet-state-unreadable');
    });

  it('BLOCKED when the snapshot reports unknown coordination or execution state', async () => {
    const coordination = await readFleetBridgeCheck(deps({
      runtime: async () => ({ ...structuredClone(SNAPSHOT),
        coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN' } }),
    }));
    expect(coordination.verdict).toBe('BLOCKED');
    expect(coordination.missing).toContain('runtime.coordination');

    const execution = await readFleetBridgeCheck(deps({
      runtime: async () => ({ ...structuredClone(SNAPSHOT),
        execution: { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
          reason: 'execution: process table unavailable' } }),
    }));
    expect(execution.verdict).toBe('BLOCKED');
    expect(execution.missing).toContain('runtime.execution');
    expect(execution.runtime.reason).toBe('runtime-execution-unknown');
    // The producer's own nested reason is preserved inside the section.
    expect(execution.runtime.execution).toMatchObject({ state: 'UNKNOWN' });
  });

  it.each(['unavailable', 'unknown', 'degraded', 'OK'])(
    'BLOCKED when the peer ledger reports status %s',
    async (status) => {
      const check = await readFleetBridgeCheck(deps({
        peers: () => ({ ...structuredClone(PEERS), status }),
      }));
      expect(check.verdict).toBe('BLOCKED');
      expect(check.missing).toContain('peers');
      expect(check.peers.status).toBe(status);
      expect(check.runtime.status).toBe('ok');
      expect(check.claims.status).toBe('ok');
    });

  it('BLOCKED with a bounded diagnostic when the peer status is not a string', async () => {
    const check = await readFleetBridgeCheck(deps({
      peers: () => ({ ...structuredClone(PEERS), status: 7 }),
    }));
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toContain('peers');
    expect(check.peers).toMatchObject({ status: 'unavailable', reason: 'peer-status-unreadable' });
  });

  it('recovers to READY on a subsequent fresh call with no cached failure', async () => {
    let peersBad = true;
    const d = deps({
      peers: () => (peersBad ? { ...structuredClone(PEERS), status: 'unknown' } : structuredClone(PEERS)),
    });
    const first = await readFleetBridgeCheck(d);
    expect(first.verdict).toBe('BLOCKED');
    expect(first.missing).toContain('peers');
    peersBad = false;
    const second = await readFleetBridgeCheck(d);
    expect(second).toMatchObject({ verdict: 'READY', missing: [] });
    expect(second.peers.status).toBe('ok');
  });

  it('reports BLOCKED through the MCP tool for unknown peer evidence', async () => {
    const client = await connect(deps({
      peers: () => ({ ...structuredClone(PEERS), status: 'unknown', reason: 'peer-ledger-unreadable' }),
    }));
    const { result, value } = await call(client);
    expect(result.isError).not.toBe(true);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('peers');
    expect(value.runtime.status).toBe('ok');
    expect(value.claims.status).toBe('ok');
  });

  it('reports BLOCKED through the MCP tool for a negative fleet-state age', async () => {
    const client = await connect(deps({
      runtime: async () => ({ ...structuredClone(SNAPSHOT),
        lastFleetStateRead: { mtime: '2026-11-14T23:59:30.000Z', ageSeconds: -3 } }),
    }));
    const { value } = await call(client);
    expect(value.verdict).toBe('BLOCKED');
    expect(value.missing).toContain('runtime.fleet-state');
    expect(value.claims.status).toBe('ok');
    expect(value.peers.status).toBe('ok');
  });
});
