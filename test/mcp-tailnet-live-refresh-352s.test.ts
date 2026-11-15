/**
 * RQ-PHX-TAILNETMCPFRESH352S — fleet_tailnet_peers backed by the real
 * readTailnetPeers parser/reader: repeated calls on one MCP connection must
 * observe changed reachability, a failed read must not replay the previous
 * online evidence, and a reconnect must read fresh state. Hermetic: in-memory
 * transports, injected clock/homeDir/exec only; no real tailscale, network or
 * child process. Peer Online is reachability evidence only — it grants no
 * dispatch, claim, RPC or execution authority.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';
import { readTailnetPeers, type TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';

const connections: Client[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(c => c.close()));
});

const NAME = 'fleet_tailnet_peers';
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

const T1 = '2026-11-13T13:13:00.000Z'; // Mason/Dot request time
const T2 = '2026-11-13T13:14:00.000Z';
const T3 = '2026-11-13T13:15:00.000Z';
const T4 = '2026-11-13T13:16:00.000Z';
const T5 = '2026-11-13T13:17:00.000Z';

/** Fields tailscale emits that must never reach an MCP result. */
const LEAK_SENTINELS = [
  '100.64.9.9',
  '100.64.9.10',
  'fd7a:115c:a1e0::9',
  'fake-studio.tail00000.ts.net',
  'fake-mini.tail00000.ts.net',
  'k-fake-key-label',
  'tag:fake-only',
];

function statusReport(opts: {
  self: string;
  peers: Array<Record<string, unknown>>;
}): string {
  const peerMap: Record<string, unknown> = {};
  for (const peer of opts.peers) peerMap[`key-${String(peer.HostName)}`] = peer;
  return JSON.stringify({
    BackendState: 'Running',
    CurrentTailnet: { Name: 'fake-tailnet', MagicDNSSuffix: '.ts.net', Addresses: ['100.64.9.1'] },
    Self: {
      HostName: opts.self,
      DNSName: `${opts.self}.tail00000.ts.net.`,
      TailscaleIPs: ['100.64.9.1', 'fd7a:115c:a1e0::1'],
      OS: 'macOS',
    },
    Peer: peerMap,
  });
}

function peerRecord(opts: {
  name: string;
  online: boolean;
  lastSeen: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    HostName: opts.name,
    DNSName: `${opts.name}.tail00000.ts.net.`,
    OS: 'macOS',
    Online: opts.online,
    LastSeen: opts.lastSeen,
    TailscaleIPs: ['100.64.9.9'],
    Addresses: ['100.64.9.9/32'],
    Key: 'k-fake-key-label',
    Tags: ['tag:fake-only'],
    ...opts.extra,
  };
}

interface ScriptedCall { cmd: string; args: readonly string[] }

/** Builds injected deps: clock and exec behavior advance only when the reader calls them. */
function scriptedDeps(script: Array<{ at: string } & ({ stdout: string } | { throws: true })>) {
  const execCalls: ScriptedCall[] = [];
  let step = 0;
  const deps: TailnetPeersDeps = {
    now: () => new Date(script[Math.min(step, script.length - 1)]!.at),
    homeDir: () => '/fake/home',
    exec: (cmd, args) => {
      execCalls.push({ cmd, args });
      const behavior = script[step];
      step += 1;
      if (!behavior) throw new Error('script exhausted');
      if ('throws' in behavior) throw new Error('exec unavailable');
      return behavior.stdout;
    },
  };
  return { deps, execCalls };
}

async function connect(readers: Partial<FleetReaders>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers });
  const client = new Client({ name: 'tailnet-live-refresh-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet_tailnet_peers live refresh over real reader', () => {
  it('observes changed reachability across repeated calls, failure, and reconnect', async () => {
    const scripted = scriptedDeps([
      { at: T1, stdout: statusReport({
        self: 'fake-mason-mbp',
        peers: [peerRecord({ name: 'fake-studio', online: false, lastSeen: '2026-11-13T13:00:00.000Z' })],
      }) },
      { at: T2, stdout: statusReport({
        self: 'fake-mason-mbp',
        peers: [peerRecord({ name: 'fake-studio', online: true, lastSeen: '2026-11-13T13:12:30.000Z' })],
      }) },
      { at: T3, throws: true },
      { at: T4, stdout: statusReport({
        self: 'fake-mason-mbp',
        peers: [
          peerRecord({ name: 'fake-mini', online: true, lastSeen: '2026-11-13T13:15:30.000Z' }),
          peerRecord({ name: 'fake-studio', online: false, lastSeen: '2026-11-13T13:10:00.000Z' }),
        ],
      }) },
      { at: T5, stdout: statusReport({
        self: 'fake-mason-mbp',
        peers: [peerRecord({ name: 'fake-mini', online: true, lastSeen: '2026-11-13T13:16:30.000Z' })],
      }) },
    ]);
    const client = await connect({
      tailnetPeers: async () => readTailnetPeers(scripted.deps),
    });
    const call = async () => JSON.parse(text(await client.callTool({ name: NAME })));

    // T1: peer offline.
    const r1 = await call();
    expect(r1.asOf).toBe(T1);
    expect(r1.self).toBe('fake-mason-mbp');
    expect(r1.peers).toHaveLength(1);
    expect(r1.peers[0]).toMatchObject({
      name: 'fake-studio', os: 'macOS', online: false,
      lastSeen: '2026-11-13T13:00:00.000Z', ageSeconds: 780,
    });
    expect(r1.reasons).toEqual([]);

    // T2: same peer now online; evidence reflects this call's clock.
    const r2 = await call();
    expect(r2.asOf).toBe(T2);
    expect(r2.peers[0]).toMatchObject({
      name: 'fake-studio', online: true,
      lastSeen: '2026-11-13T13:12:30.000Z', ageSeconds: 90,
    });

    // T3: exec unavailable — the result is a bounded unavailable report at
    // T3's clock, never yesterday's (or T2's) online evidence.
    const r3 = await call();
    expect(r3).toEqual({
      asOf: T3, self: 'unknown', peers: [],
      reasons: ['tailscale unavailable or status unreadable'],
    });

    // T4: recovery on the same connection with a changed peer set.
    const r4 = await call();
    expect(r4.asOf).toBe(T4);
    expect(r4.peers.map((p: { name: string }) => p.name)).toEqual(['fake-mini', 'fake-studio']);
    expect(r4.peers[0]).toMatchObject({ online: true, lastSeen: '2026-11-13T13:15:30.000Z', ageSeconds: 30 });
    expect(r4.peers[1]).toMatchObject({ online: false });

    // No result ever leaks addresses, DNS names, keys or tags.
    for (const raw of [r1, r2, r3, r4].map(r => JSON.stringify(r))) {
      for (const sentinel of LEAK_SENTINELS) expect(raw).not.toContain(sentinel);
    }

    // Reconnect: a fresh connection observes fresh evidence (T5), not a cached T4.
    await client.close();
    const client2 = await connect({ tailnetPeers: async () => readTailnetPeers(scripted.deps) });
    const r5 = await JSON.parse(text(await client2.callTool({ name: NAME })));
    expect(r5.asOf).toBe(T5);
    expect(r5.peers).toHaveLength(1);
    expect(r5.peers[0]).toMatchObject({ name: 'fake-mini', online: true, lastSeen: '2026-11-13T13:16:30.000Z', ageSeconds: 30 });
    expect(JSON.stringify(r5)).not.toContain(LEAK_SENTINELS[1]!);

    // Every exec was exactly `tailscale status --json` — five reads, five calls.
    expect(scripted.execCalls).toEqual([
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
      { cmd: 'tailscale', args: ['status', '--json'] },
    ]);
  });
});
