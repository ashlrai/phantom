/** fleet_bridge_check over MCP: producer asOf provenance survives the transport. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';
import { readFleetPeerLedger } from '../src/mcp/fleet-peer-ledger.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NAME = 'fleet_bridge_check';
const VERDICT_T0_ISO = '2026-11-15T10:00:00.000Z';
const VERDICT_T1_ISO = '2026-11-15T10:05:00.000Z';
const VERDICT_T2_ISO = '2026-11-15T10:10:00.000Z';
const RUNTIME_AS_OF_T0 = '2026-11-15T09:58:11.000Z';
const CLAIMS_AS_OF_T0 = '2026-11-15T09:59:30.000Z';
const PEERS_AS_OF_T0 = '2026-11-15T09:59:02.000Z';
const RUNTIME_AS_OF_T2 = '2026-11-15T10:09:11.000Z';
const CLAIMS_AS_OF_T2 = '2026-11-15T10:09:30.000Z';
const PEERS_AS_OF_T2 = '2026-11-15T10:09:02.000Z';

let verdictNow = Date.parse(VERDICT_T0_ISO);
let runtimeAsOf = RUNTIME_AS_OF_T0;
let claimsAsOf = CLAIMS_AS_OF_T0;
let peersAsOf = PEERS_AS_OF_T0;
let runtimeActiveClaims = 2;
let peerReport: PeerLedgerReport;
let peerReadShouldFail = false;
let peerReads = 0;
let claimsBoard: FleetBoard;

function claim(id: string, claimedAt: string, expiresAt: string): FleetBoard['claims'][number] {
  return { id, repo: 'fake/repo', task: `fake ${id} task`, agent: 'fake-agent',
    claimedAt: Date.parse(claimedAt), expiresAt: Date.parse(expiresAt) };
}

function board(claims: FleetBoard['claims']): FleetBoard {
  return { schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 };
}

function runtimeSnapshot(asOf: string, activeClaims: number) {
  const fleetStateAgeSeconds = 41;
  return {
    schemaVersion: 1, authority: 'none',
    host: 'fake-runtime-host', tailnetName: 'fake-tailnet', installedVersion: '1.2.3', sourceVersion: '1.2.3',
    pid: 42, uptimeSeconds: 60, platform: 'fakeos', arch: 'fakearch', stateRoot: '~/.ashlr-runs',
    lastFleetStateRead: {
      mtime: new Date(Date.parse(asOf) - fleetStateAgeSeconds * 1000).toISOString(),
      ageSeconds: fleetStateAgeSeconds,
    },
    coordination: { state: 'known', activeClaims, newestReturnAgeSeconds: 45 },
    execution: { state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 },
    asOf, reasons: [],
  };
}

function peerLedger(asOf: string, liveRows: number, inWindow: number, lastAt: string): PeerLedgerReport {
  return {
    v: 1, authority: 'none', status: liveRows === 0 ? 'empty' : 'ok', asOf,
    liveRows, capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
    pairs: liveRows === 0 ? [] : [{ fromAgent: 'fake-dot', target: 'fake-leader', inWindow,
      remaining: Math.max(0, 6 - inWindow), lastAt, retryAt: null }],
    origins: liveRows === 0 ? [] : [{ origin: 'fake-origin', maxHop: 1, nearCap: false }],
    truncated: { pairs: false, origins: false },
  };
}

function deps(): FleetBridgeCheckDeps {
  return {
    runtime: async () => runtimeSnapshot(runtimeAsOf, runtimeActiveClaims),
    claims: () => projectCoordinationClaims(claimsBoard, Date.parse(claimsAsOf)),
    peers: () => {
      peerReads += 1;
      if (peerReadShouldFail) throw new Error('fake peer reader failure /private/path');
      return readFleetPeerLedger({ read: () => peerReport });
    },
    now: () => verdictNow,
  };
}

const servers: Array<ReturnType<typeof createFleetServer>> = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck(deps()),
  });
  servers.push(server);
  const client = new Client({ name: 'bridge-provenance-420s', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client) {
  const result = await client.callTool({ name: NAME, arguments: {} });
  expect(result.isError).not.toBe(true);
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return JSON.parse(text);
}

describe('fleet_bridge_check transport provenance', () => {
  it('keeps producer source/asOf distinct from the verdict clock, then recovers with fresh evidence', async () => {
    claimsBoard = board([
      claim('claim-a', '2026-11-15T09:58:00.000Z', '2026-11-15T11:00:00.000Z'),
      claim('claim-b', '2026-11-15T09:57:00.000Z', '2026-11-15T11:00:00.000Z'),
    ]);
    peerReport = peerLedger(PEERS_AS_OF_T0, 2, 1, '2026-11-15T09:58:30.000Z');

    const client = await connect();
    const first = await call(client);
    expect(first).toMatchObject({ verdict: 'READY', asOf: VERDICT_T0_ISO, missing: [] });
    expect(first.runtime).toMatchObject({ status: 'ok', source: 'fleet-runtime', asOf: RUNTIME_AS_OF_T0,
      host: 'fake-runtime-host', tailnetName: 'fake-tailnet', authority: 'none' });
    expect(first.claims).toMatchObject({ status: 'ok', source: 'coordination-ledger', asOf: CLAIMS_AS_OF_T0,
      state: 'known', live: 2, newestAgeSec: 120 });
    expect(first.peers).toMatchObject({ status: 'ok', source: 'peer-ledger', asOf: PEERS_AS_OF_T0, liveRows: 2 });
    expect(first.asOf).not.toBe(first.runtime.asOf);
    expect(first.asOf).not.toBe(first.claims.asOf);
    expect(first.asOf).not.toBe(first.peers.asOf);
    expect(first).not.toHaveProperty('authority');
    expect(first).not.toHaveProperty('assignment');
    expect(first).not.toHaveProperty('executionAuthority');
    expect(first.claims).not.toHaveProperty('authority');
    expect(first.runtime.execution).toMatchObject({ state: 'known', running: 1 });

    verdictNow = Date.parse(VERDICT_T1_ISO);
    peerReadShouldFail = true;
    const second = await call(client);
    expect(second).toMatchObject({ verdict: 'BLOCKED', asOf: VERDICT_T1_ISO, missing: ['peers'] });
    expect(second.runtime).toMatchObject({ status: 'ok', source: 'fleet-runtime', asOf: RUNTIME_AS_OF_T0,
      host: 'fake-runtime-host' });
    expect(second.claims).toMatchObject({ status: 'ok', source: 'coordination-ledger', asOf: CLAIMS_AS_OF_T0,
      state: 'known', live: 2, newestAgeSec: 420 });
    expect(second.peers).toMatchObject({ status: 'unavailable', source: 'peer-ledger', asOf: VERDICT_T1_ISO,
      reason: 'peers-reader-failed' });
    expect(peerReads).toBe(2);

    verdictNow = Date.parse(VERDICT_T2_ISO);
    runtimeAsOf = RUNTIME_AS_OF_T2;
    claimsAsOf = CLAIMS_AS_OF_T2;
    peersAsOf = PEERS_AS_OF_T2;
    runtimeActiveClaims = 3;
    claimsBoard = board([
      claim('claim-a', '2026-11-15T09:58:00.000Z', '2026-11-15T11:00:00.000Z'),
      claim('claim-b', '2026-11-15T09:57:00.000Z', '2026-11-15T11:00:00.000Z'),
      claim('claim-c', '2026-11-15T10:08:00.000Z', '2026-11-15T11:30:00.000Z'),
    ]);
    peerReport = peerLedger(PEERS_AS_OF_T2, 3, 2, '2026-11-15T10:08:30.000Z');
    peerReadShouldFail = false;

    const third = await call(client);
    expect(third).toMatchObject({ verdict: 'READY', asOf: VERDICT_T2_ISO, missing: [] });
    expect(third.runtime).toMatchObject({ status: 'ok', source: 'fleet-runtime', asOf: RUNTIME_AS_OF_T2,
      host: 'fake-runtime-host', authority: 'none' });
    expect(third.claims).toMatchObject({ status: 'ok', source: 'coordination-ledger', asOf: CLAIMS_AS_OF_T2,
      state: 'known', live: 3, newestAgeSec: 120 });
    expect(third.peers).toMatchObject({ status: 'ok', source: 'peer-ledger', asOf: PEERS_AS_OF_T2, liveRows: 3 });
    expect(peerReads).toBe(3);
  });
});
