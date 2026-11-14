import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPoolReach } from '../src/cli/fleet-pool-reach.js';
import { joinPoolReach, readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { TailnetPeers, TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const HOME = '/Users/fakeuser';
const T1 = Date.parse('2026-11-14T12:00:00.000Z');
const T2 = Date.parse('2026-11-14T12:00:30.000Z');
const LAST_SEEN = '2026-11-14T11:59:00.000Z';

const CONFIG: PoolConfig = {
  role: 'worker',
  primary: 'mac-primary',
  backup: 'mac-worker',
  owner: 'fake-owner',
  node: 'fake-node',
};

// This computer is "mac-self"; the configured primary alias names it, while
// two retained peers also claim the same first DNS label.
const SELF_COLLIDING_PEERS = {
  'nodekey:self-a': { HostName: 'mac-self.tail-a.ts.net', OS: 'macOS', Online: true, LastSeen: LAST_SEEN },
  'nodekey:self-b': { HostName: 'mac-self.tail-b.ts.net', OS: 'macOS', Online: false, LastSeen: LAST_SEEN },
  'nodekey:backup': { HostName: 'mac-worker', OS: 'macOS', Online: true, LastSeen: LAST_SEEN },
};

// 64 online peers fill the retained window; the offline second identity for
// "mac-worker" sorts past the 64-peer cap and is truncated away. Retained
// evidence shows exactly one match, which must not be trusted as unique.
function truncatedPeerMap(): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (let i = 0; i < 62; i += 1) {
    map[`nodekey:f${i}`] = {
      HostName: `aaa-filler-${String(i).padStart(2, '0')}`,
      OS: 'macOS', Online: true, LastSeen: LAST_SEEN,
    };
  }
  map['nodekey:p'] = { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: LAST_SEEN };
  map['nodekey:w'] = { HostName: 'mac-worker', OS: 'macOS', Online: true, LastSeen: LAST_SEEN };
  map['nodekey:hidden-1'] = { HostName: 'aab-offline', OS: 'macOS', Online: false, LastSeen: LAST_SEEN };
  map['nodekey:hidden-2'] = { HostName: 'mac-worker.tail-b.ts.net', OS: 'macOS', Online: false, LastSeen: LAST_SEEN };
  return map;
}

// Next read: a complete, small peer set where each alias has one identity.
const COMPLETE_PEERS = {
  'nodekey:p': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:30.000Z' },
  'nodekey:w': { HostName: 'mac-worker', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:30.000Z' },
};

function statusBody(peerMap: Record<string, unknown>, self = 'mac-self'): string {
  return JSON.stringify({ Self: { HostName: self }, Peer: peerMap });
}

function harness() {
  let config: PoolConfig = { ...CONFIG };
  let now = T1;
  let raw = statusBody(SELF_COLLIDING_PEERS);
  const readConfig = vi.fn(() => config);
  const exec = vi.fn((_cmd: string, _args: readonly string[]) => raw);
  const peers: TailnetPeersDeps = {
    now: () => new Date(now),
    homeDir: () => HOME,
    exec,
  };
  const poolDeps: PoolReachDeps = { readConfig, peers };
  return {
    poolDeps, readConfig, exec,
    setConfig(next: PoolConfig) { config = next; },
    setRaw(next: string) { raw = next; },
    advance(ms: number) { now += ms; },
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('pool-reach identity certainty', () => {
  it('refuses online=true when the alias names this computer and peers also claim it', async () => {
    const h = harness();
    h.setConfig({ ...CONFIG, primary: 'mac-self' });

    const first = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const parsed = JSON.parse(first.out.join('\n')) as {
      hosts: { slot: string; alias: string; matched: string; online: unknown; isSelf: boolean }[];
      reasons: string[];
    };
    const primary = parsed.hosts.find(host => host.slot === 'primary')!;
    // Self name plus two colliding peers: identity is ambiguous, never online.
    expect(primary).toMatchObject({
      alias: 'mac-self', matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(parsed.reasons).toContain('primary: mac-self matches this computer and 2 tailnet peers');
    // The unambiguous backup still reports its single retained peer.
    expect(parsed.hosts.find(host => host.slot === 'backup')).toMatchObject({
      matched: 'mac-worker', online: true,
    });
    const serialized = JSON.stringify(parsed) + first.out.join('\n');
    expect(serialized).not.toContain('tail-a.ts.net');
    expect(serialized).not.toContain(HOME);

    // Human output must not label the ambiguous self slot online.
    const second = capture();
    expect(await cmdFleetPoolReach([], h.poolDeps)).toBe(0);
    const human = second.out.join('\n');
    expect(human).toContain('primary mac-self unknown last seen unknown (this computer)');
    expect(human).toContain('reason: primary: mac-self matches this computer and 2 tailnet peers');
    expect(human).not.toMatch(/primary mac-self online/);
  });

  it('readPoolReach refuses self-plus-peer identity collision without the CLI', () => {
    const h = harness();
    h.setConfig({ ...CONFIG, primary: 'mac-self' });
    const result = readPoolReach(h.poolDeps);
    expect(result.hosts.find(host => host.slot === 'primary')).toMatchObject({
      matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain('primary: mac-self matches this computer and 2 tailnet peers');
  });

  it('keeps unambiguous self reporting and complete-set unique matches', () => {
    const peers: TailnetPeers = {
      asOf: '2026-11-14T12:00:00.000Z',
      self: 'mac-self',
      peers: [
        { name: 'mac-worker', os: 'macOS', online: true, lastSeen: LAST_SEEN, ageSeconds: 60 },
      ],
      reasons: [],
    };
    const result = joinPoolReach({ ...CONFIG, primary: 'mac-self' }, null, peers);
    expect(result.hosts[0]).toMatchObject({
      slot: 'primary', matched: 'mac-self', online: true, isSelf: true,
    });
    expect(result.hosts[1]).toMatchObject({ matched: 'mac-worker', online: true });
    expect(result.reasons).toEqual([]);
  });

  it('refuses a retained single match when the peer set is truncated, then recovers on a complete read', async () => {
    const h = harness();
    h.setConfig({ ...CONFIG });
    h.setRaw(statusBody(truncatedPeerMap()));

    // Call 1 (JSON): 66 peers truncated to 64; both aliases have exactly one
    // retained match but uniqueness is unproven, so nothing reports online.
    const first = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const parsed = JSON.parse(first.out.join('\n')) as {
      asOf: string;
      hosts: { slot: string; alias: string; matched: string; online: unknown }[];
      reasons: string[];
    };
    expect(parsed.asOf).toBe(new Date(T1).toISOString());
    for (const slot of ['primary', 'backup']) {
      expect(parsed.hosts.find(host => host.slot === slot)).toMatchObject({
        matched: 'unknown', online: 'unknown',
      });
    }
    expect(parsed.reasons).toContain('peers: truncated to 64 of 66');
    expect(parsed.reasons).toContain(
      'primary: mac-primary matches a tailnet peer but the peer list is truncated; identity not proven unique',
    );
    expect(parsed.reasons).toContain(
      'backup: mac-worker matches a tailnet peer but the peer list is truncated; identity not proven unique',
    );
    // The hidden second identity past the cap must never surface.
    const serialized = JSON.stringify(parsed) + first.out.join('\n');
    expect(serialized).not.toContain('tail-b.ts.net');
    expect(serialized).not.toContain('mac-worker.tail-b');
    expect(serialized).not.toContain(HOME);

    // Call 2 (human): no slot may be labeled online while truncated.
    const second = capture();
    expect(await cmdFleetPoolReach([], h.poolDeps)).toBe(0);
    const human = second.out.join('\n');
    expect(human).toContain('primary mac-primary unknown last seen unknown');
    expect(human).toContain('backup mac-worker unknown last seen unknown');
    expect(human).not.toMatch(/primary mac-primary online/);
    expect(human).not.toMatch(/backup mac-worker online/);
    expect(human).toContain('reason: peers: truncated to 64 of 66');

    // Call 3: next read sees a complete unambiguous peer set; clock advances.
    h.setRaw(statusBody(COMPLETE_PEERS));
    h.advance(30_000);
    const third = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const recovered = JSON.parse(third.out.join('\n')) as typeof parsed;
    expect(recovered.asOf).toBe(new Date(T2).toISOString());
    expect(recovered.hosts.find(host => host.slot === 'primary')).toMatchObject({
      matched: 'mac-primary', online: true, ageSeconds: 60,
    });
    expect(recovered.hosts.find(host => host.slot === 'backup')).toMatchObject({
      matched: 'mac-worker', online: true, ageSeconds: 60,
    });
    expect(recovered.reasons).toEqual([]);

    // Call 4 (human): recovery names the exact hosts, no stale ambiguity.
    const fourth = capture();
    expect(await cmdFleetPoolReach([], h.poolDeps)).toBe(0);
    const recoveredHuman = fourth.out.join('\n');
    expect(recoveredHuman).toContain('primary mac-primary online last seen 60s ago');
    expect(recoveredHuman).toContain('backup mac-worker online last seen 60s ago');
    expect(recoveredHuman).not.toContain('truncated');

    expect(h.readConfig).toHaveBeenCalledTimes(4);
    expect(h.exec).toHaveBeenCalledTimes(4);
    expect(h.exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });

  it('does not claim "no tailnet peer" for a non-self alias when the set is truncated', () => {
    const peers: TailnetPeers = {
      asOf: '2026-11-14T12:00:00.000Z',
      self: 'mac-self',
      peers: [],
      reasons: ['peers: truncated to 64 of 65'],
    };
    const result = joinPoolReach(CONFIG, null, peers);
    expect(result.hosts[0]).toMatchObject({ matched: 'unknown', online: 'unknown' });
    expect(result.reasons).toContain('primary: peer list truncated; cannot confirm mac-primary');
    expect(result.reasons).not.toContain('primary: no tailnet peer named mac-primary');
  });
});
