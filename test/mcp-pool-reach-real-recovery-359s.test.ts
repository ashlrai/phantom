/**
 * RQ-PHX-POOLMCPREALRECOVERY359S — fleet_pool_reach backed by the real
 * readPoolReach join and the real parseTailnetStatus parser over ONE retained
 * MCP connection: a Running/online read, a tailscale exec failure, a recovery
 * with a DIFFERENT configured pool target at a later clock, a pool-config
 * failure and a final recovery must each serve freshly read evidence — never
 * replaying a stale target or online answer (Mason/Dot Nov 13 13:13 recheck
 * order: report current runtime, not yesterday's blocked state). Hermetic:
 * InMemoryTransport and injected config/exec/clock seams only; no real
 * tailscale, home directory or child process. Peer Online is reachability
 * evidence only — it grants no ownership, claim, dispatch, SSH or merge
 * authority.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
});

const NAME = 'fleet_pool_reach';
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

const HOME = '/Users/fakehome';
const SECRET_EXEC = 'SECRET-exec-marker /Users/fakehome/bin 100.64.0.7';
const SECRET_CONFIG = 'SECRET-config-marker /Users/fakehome/pool.json 100.64.0.8';
const T1 = '2026-11-13T13:13:00.000Z'; // Mason/Dot recheck order time
const T2 = '2026-11-13T13:14:00.000Z';
const T3 = '2026-11-13T13:15:00.000Z';
const T4 = '2026-11-13T13:16:00.000Z';
const T5 = '2026-11-13T13:17:00.000Z';

/** Fields tailscale emits that must never reach an MCP result. */
const LEAKS = [
  '100.64.', 'fd7a:', 'ts.net', 'k-fake-key-label', 'tag:fake-only',
  'fake-owner', 'fake-node', 'SECRET', HOME, '/Users/',
];

const CONFIG_A: PoolConfig = {
  role: 'worker', primary: 'mac-primary', backup: 'mac-backup',
  owner: 'fake-owner', node: 'fake-node',
};
const CONFIG_B: PoolConfig = {
  role: 'backup', primary: 'mac-gamma', backup: 'mac-backup',
  owner: 'fake-owner', node: 'fake-node',
};

function peerRecord(name: string, online: boolean, lastSeen: string): Record<string, unknown> {
  return {
    HostName: name,
    DNSName: `${name}.tail00000.ts.net.`,
    OS: 'macOS',
    Online: online,
    LastSeen: lastSeen,
    TailscaleIPs: ['100.64.9.9'],
    Addresses: ['100.64.9.9/32'],
    Key: 'k-fake-key-label',
    Tags: ['tag:fake-only'],
  };
}

function statusBody(peers: Array<Record<string, unknown>>): string {
  const peerMap: Record<string, unknown> = {};
  for (const peer of peers) peerMap[`key-${String(peer.HostName)}`] = peer;
  return JSON.stringify({
    BackendState: 'Running',
    CurrentTailnet: { Name: 'fake-tailnet', MagicDNSSuffix: '.ts.net', Addresses: ['100.64.9.1'] },
    Self: {
      HostName: 'mac-self',
      DNSName: 'mac-self.tail00000.ts.net.',
      TailscaleIPs: ['100.64.9.1', 'fd7a:115c:a1e0::1'],
      OS: 'macOS',
    },
    Peer: peerMap,
  });
}

const STATUS_A = statusBody([
  peerRecord('mac-primary', true, '2026-11-13T13:12:00.000Z'),
  peerRecord('mac-backup', false, '2026-11-13T13:11:00.000Z'),
]);
const STATUS_B = statusBody([
  peerRecord('mac-gamma', true, '2026-11-13T13:14:30.000Z'),
  peerRecord('mac-backup', false, '2026-11-13T13:13:30.000Z'),
]);

type ExecMode = 'ok-a' | 'throw' | 'ok-b';
type ConfigMode = 'a' | 'throw' | 'b';

// Mutable seams: the test advances phases by flipping these, never by
// rebuilding the server or the reader — one retained connection serves all.
let nowMs = Date.parse(T1);
let execMode: ExecMode = 'ok-a';
let configMode: ConfigMode = 'a';
let configCalls = 0;
const execCalls: Array<{ cmd: string; args: readonly string[] }> = [];

const poolDeps: PoolReachDeps = {
  readConfig: () => {
    configCalls += 1;
    if (configMode === 'throw') throw new Error(SECRET_CONFIG);
    return configMode === 'a' ? CONFIG_A : CONFIG_B;
  },
  peers: {
    now: () => new Date(nowMs),
    homeDir: () => HOME,
    exec: (cmd, args) => {
      execCalls.push({ cmd, args });
      if (execMode === 'throw') throw new Error(SECRET_EXEC);
      return execMode === 'ok-a' ? STATUS_A : STATUS_B;
    },
  },
};

const readers: FleetReaders = {
  status: async () => ({}),
  loop: async () => ({}),
  // Every call runs the REAL readPoolReach join and REAL parseTailnetStatus
  // parser on the fake seams above — no completed report is injected. The
  // readConfig seam gets the same fixed-reason translation the CLI
  // (cmdFleetPoolReach) and the verse host-reach API apply at their public
  // boundaries: readPoolReach copies a thrown config message into reasons[],
  // so private diagnostics are replaced before the join ever sees them.
  poolReach: async () => readPoolReach({
    ...poolDeps,
    readConfig: () => {
      try { return poolDeps.readConfig(); } catch { throw new Error('pool config unreadable'); }
    },
  }),
};

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer(readers);
  const client = new Client({ name: 'pool-reach-real-recovery-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

type ReachJson = {
  asOf: string;
  self: string;
  role: string;
  hosts: Array<{
    slot: string; alias: string; matched: string;
    online: unknown; lastSeen: unknown; ageSeconds: unknown; isSelf: boolean;
  }>;
  reasons: string[];
};

async function call(client: Client) {
  const result = await client.callTool({ name: NAME });
  expect(result.isError).toBeFalsy();
  const raw = text(result);
  return { raw, parsed: JSON.parse(raw) as ReachJson };
}

function phase(at: string, exec: ExecMode, config: ConfigMode) {
  nowMs = Date.parse(at);
  execMode = exec;
  configMode = config;
}

describe('fleet_pool_reach real-reader recovery over one MCP connection', () => {
  it('serves fresh reach evidence across online, exec failure, retarget, config failure and recovery', async () => {
    const client = await connect();

    // T1: Running backend, config A — primary online, backup offline.
    phase(T1, 'ok-a', 'a');
    const r1 = await call(client);
    expect(r1.parsed.asOf).toBe(T1);
    expect(r1.parsed.self).toBe('mac-self');
    expect(r1.parsed.role).toBe('worker');
    expect(r1.parsed.reasons).toEqual([]);
    expect(r1.parsed.hosts).toEqual([
      { slot: 'primary', alias: 'mac-primary', matched: 'mac-primary', online: true, lastSeen: '2026-11-13T13:12:00.000Z', ageSeconds: 60, isSelf: false },
      { slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false, lastSeen: '2026-11-13T13:11:00.000Z', ageSeconds: 120, isSelf: false },
    ]);

    // T2: tailscale exec throws — every host degrades to unknown at T2's
    // clock; no T1 target match, online flag or observation time may replay.
    phase(T2, 'throw', 'a');
    const r2 = await call(client);
    expect(r2.parsed.asOf).toBe(T2);
    expect(r2.parsed.self).toBe('unknown');
    expect(r2.parsed.role).toBe('worker'); // config A is still readable
    expect(r2.parsed.hosts).toEqual([
      { slot: 'primary', alias: 'mac-primary', matched: 'unknown', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown', isSelf: false },
      { slot: 'backup', alias: 'mac-backup', matched: 'unknown', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown', isSelf: false },
    ]);
    expect(r2.parsed.reasons).toEqual([
      'tailscale unavailable or status unreadable',
      'primary: no tailnet peer named mac-primary',
      'backup: no tailnet peer named mac-backup',
    ]);
    expect(r2.raw).not.toContain('"online":true');
    expect(r2.raw).not.toContain(T1);
    expect(r2.raw).not.toContain('2026-11-13T13:12:00.000Z');
    expect(r2.raw).not.toContain('2026-11-13T13:11:00.000Z');

    // T3: Running again with a DIFFERENT configured target — config B names
    // mac-gamma; the answer must come from this read, not cached config A.
    phase(T3, 'ok-b', 'b');
    const r3 = await call(client);
    expect(r3.parsed.asOf).toBe(T3);
    expect(r3.parsed.self).toBe('mac-self');
    expect(r3.parsed.role).toBe('backup');
    expect(r3.parsed.reasons).toEqual([]);
    expect(r3.parsed.hosts).toEqual([
      { slot: 'primary', alias: 'mac-gamma', matched: 'mac-gamma', online: true, lastSeen: '2026-11-13T13:14:30.000Z', ageSeconds: 30, isSelf: false },
      { slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false, lastSeen: '2026-11-13T13:13:30.000Z', ageSeconds: 90, isSelf: false },
    ]);
    expect(r3.raw).not.toContain('mac-primary');
    expect(r3.raw).not.toContain(T1);
    expect(r3.raw).not.toContain(T2);

    // T4: the pool config read throws — the public boundary reports the fixed
    // safe reason; no private exception text reaches the client.
    phase(T4, 'ok-b', 'throw');
    const r4 = await call(client);
    expect(r4.parsed.asOf).toBe(T4);
    expect(r4.parsed.self).toBe('mac-self');
    expect(r4.parsed.role).toBe('unknown');
    expect(r4.parsed.hosts).toEqual([]);
    expect(r4.parsed.reasons).toEqual(['pool config: pool config unreadable']);

    // T5: config readable again — the SAME connection serves fresh evidence
    // for the new target; ages prove this read used T5's clock, not T3's.
    phase(T5, 'ok-b', 'b');
    const r5 = await call(client);
    expect(r5.parsed.asOf).toBe(T5);
    expect(r5.parsed.self).toBe('mac-self');
    expect(r5.parsed.role).toBe('backup');
    expect(r5.parsed.reasons).toEqual([]);
    expect(r5.parsed.hosts[0]).toMatchObject({
      slot: 'primary', alias: 'mac-gamma', matched: 'mac-gamma', online: true,
      lastSeen: '2026-11-13T13:14:30.000Z', ageSeconds: 150, isSelf: false,
    });
    expect(r5.parsed.hosts[1]).toMatchObject({
      slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: false,
      lastSeen: '2026-11-13T13:13:30.000Z', ageSeconds: 210, isSelf: false,
    });
    expect(r5.raw).not.toContain('mac-primary');

    // Every call re-ran the real join: five tool calls -> five config reads
    // and five `tailscale status --json` execs with the fixed argument seam.
    expect(configCalls).toBe(5);
    expect(execCalls).toEqual([
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
    ]);

    // No payload ever leaks addresses, DNS names, keys, tags, home paths,
    // owner/node ids or thrown exception text.
    for (const raw of [r1.raw, r2.raw, r3.raw, r4.raw, r5.raw]) {
      for (const leak of LEAKS) expect(raw).not.toContain(leak);
    }
  });
});
