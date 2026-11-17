/** fleet_bridge_check: a stalled evidence reader degrades to a bounded BLOCKED verdict. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import {
  BRIDGE_CHECK_READER_DEADLINE_MS,
  readFleetBridgeCheck,
  type FleetBridgeCheckDeps,
} from '../src/mcp/fleet-bridge-check.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const NAME = 'fleet_bridge_check';
const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const NOW_ISO = '2026-11-15T00:00:00.000Z';
const DEADLINE = BRIDGE_CHECK_READER_DEADLINE_MS;

const SNAPSHOT = {
  schemaVersion: 1, authority: 'none',
  host: 'fake-host', installedVersion: '1.2.3',
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
};

const never = () => new Promise<never>(() => {});

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
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
});

async function connect(bridgeDeps: FleetBridgeCheckDeps) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({
    status: async () => ({}),
    loop: async () => ({}),
    bridgeCheck: () => readFleetBridgeCheck(bridgeDeps),
  });
  servers.push(server);
  const client = new Client({ name: 'bridge-deadline-413s', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet_bridge_check reader deadline', () => {
  it.each([
    ['runtime', 'runtime-reader-timeout', { runtime: never }],
    ['claims', 'claims-reader-timeout', { claims: never }],
    ['peers', 'peers-reader-timeout', { peers: never }],
  ] as const)('marks only the stalled %s section unavailable after the deadline', async (section, reason, override) => {
    vi.useFakeTimers();
    const pending = readFleetBridgeCheck(deps(override));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const check = await pending;
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toEqual([section]);
    expect(check[section]).toMatchObject({ status: 'unavailable', reason, asOf: NOW_ISO });
    for (const other of ['runtime', 'claims', 'peers'] as const) {
      if (other === section) continue;
      expect(check[other].status).toBe('ok');
    }
    if (section !== 'claims') {
      expect(check.claims).toMatchObject({ state: 'known', live: 2, newestAgeSec: 60 });
    }
    if (section !== 'peers') expect(check.peers).toMatchObject({ liveRows: 2 });
    if (section !== 'runtime') expect(check.runtime).toMatchObject({ host: 'fake-host' });
  });

  it('returns BLOCKED through the MCP tool in finite time when a reader never settles', async () => {
    vi.useFakeTimers();
    const client = await connect(deps({ peers: never }));
    const pending = client.callTool({ name: NAME, arguments: {} });
    await vi.advanceTimersByTimeAsync(DEADLINE);
    const result = await pending;
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const value = JSON.parse(text);
    expect(value).toMatchObject({ verdict: 'BLOCKED', asOf: NOW_ISO, missing: ['peers'] });
    expect(value.peers).toMatchObject({ status: 'unavailable', reason: 'peers-reader-timeout' });
    expect(value.runtime.status).toBe('ok');
    expect(value.claims.status).toBe('ok');
  });

  it('returns exit 3 with BLOCKED through the CLI in finite time when a reader never settles', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const pending = cmdFleetBridgeCheck([], deps({ runtime: never }));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(await pending).toBe(3);
    const text = log.mock.calls.flat().join('\n');
    expect(text).toContain('Bridge: BLOCKED (missing: runtime)');
    expect(text).toContain('runtime: unavailable (runtime-reader-timeout)');
    expect(text).toContain('claims: 2 live, newest 60s');
    expect(text).toContain('peers: ok');
  });

  it('consumes a late rejection after the deadline without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    let rejectRuntime: (error: Error) => void = () => {};
    const gate = new Promise<never>((_resolve, reject) => { rejectRuntime = reject; });
    try {
      const pending = readFleetBridgeCheck(deps({ runtime: () => gate }));
      await vi.advanceTimersByTimeAsync(DEADLINE);
      const check = await pending;
      expect(check).toMatchObject({ verdict: 'BLOCKED', missing: ['runtime'] });
      expect(check.runtime.reason).toBe('runtime-reader-timeout');
      rejectRuntime(new Error('fake runtime failure /fake/secret-path'));
      await vi.advanceTimersByTimeAsync(0);
      expect(onUnhandled).not.toHaveBeenCalled();
      expect(JSON.stringify(check)).not.toContain('/fake/secret-path');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('a repaired reader set returns READY on the next call', async () => {
    vi.useFakeTimers();
    const stalled = readFleetBridgeCheck(deps({ peers: never }));
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect((await stalled).verdict).toBe('BLOCKED');
    const healed = await readFleetBridgeCheck(deps());
    expect(healed).toMatchObject({ verdict: 'READY', asOf: NOW_ISO, missing: [] });
    expect(healed.runtime.status).toBe('ok');
    expect(healed.claims.status).toBe('ok');
    expect(healed.peers.status).toBe('ok');
  });

  it('does not make successful reads wait out the deadline and clears every timer', async () => {
    vi.useFakeTimers();
    const check = await readFleetBridgeCheck(deps());
    expect(check).toMatchObject({ verdict: 'READY', missing: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
