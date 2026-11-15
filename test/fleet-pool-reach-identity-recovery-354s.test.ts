import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPoolReach } from '../src/cli/fleet-pool-reach.js';
import type { PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const HOME = '/Users/fakeuser';
const T1 = Date.parse('2026-11-14T12:00:00.000Z');
const T2 = Date.parse('2026-11-14T12:00:30.000Z');

// Two distinct tailnet peers share the first DNS label "mac-backup"; the
// configured backup alias "mac-backup" cannot pick one without guessing.
const AMBIGUOUS_PEERS = {
  'nodekey:a': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z', TailscaleIPs: ['100.64.0.1'] },
  'nodekey:b': { HostName: 'mac-backup.tail-a.ts.net', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z', TailscaleIPs: ['100.64.0.2'] },
  'nodekey:c': { HostName: 'mac-backup.tail-b.ts.net', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:59:00.000Z', TailscaleIPs: ['100.64.0.3'] },
};

// Next read: only one matching peer remains, and it is offline.
const SINGLE_PEERS = {
  'nodekey:a': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:30.000Z' },
  'nodekey:b': { HostName: 'mac-backup.tail-a.ts.net', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:59:00.000Z' },
};

function statusBody(peerMap: Record<string, unknown>): string {
  return JSON.stringify({ Self: { HostName: 'mac-self' }, Peer: peerMap });
}

afterEach(() => vi.restoreAllMocks());

describe('cmdFleetPoolReach identity recovery across successive reads', () => {
  function harness() {
    let config: PoolConfig = {
      role: 'worker',
      primary: 'mac-primary',
      backup: 'mac-backup',
      owner: 'fake-owner',
      node: 'fake-node',
    };
    let now = T1;
    let raw = statusBody(AMBIGUOUS_PEERS);
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
      setRaw(next: Record<string, unknown>) { raw = statusBody(next); },
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

  it('refuses the ambiguous alias, then reports the recovered offline peer on the next read', async () => {
    const h = harness();

    // Call 1 (JSON): two colliding first-label peers -> unknown, not the online one.
    const first = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const parsed = JSON.parse(first.out.join('\n')) as {
      asOf: string;
      hosts: { slot: string; alias: string; matched: string; online: unknown }[];
      reasons: string[];
    };
    expect(parsed.asOf).toBe(new Date(T1).toISOString());
    const backup = parsed.hosts.find(host => host.slot === 'backup')!;
    expect(backup).toMatchObject({
      alias: 'mac-backup', matched: 'unknown', online: 'unknown',
    });
    expect(parsed.reasons).toContain('backup: mac-backup matches 2 tailnet peers');
    // The online colliding peer must not be selected as the answer.
    expect(JSON.stringify(parsed)).not.toContain('tail-a.ts.net');
    expect(JSON.stringify(parsed)).not.toContain('tail-b.ts.net');
    // No fabricated owner/claim and no tailnet IP or home-path leakage.
    const serialized = JSON.stringify(parsed) + first.out.join('\n');
    expect(serialized).not.toContain(HOME);
    expect(serialized).not.toContain('100.64.0.');
    expect(serialized).not.toContain('fake-owner');

    // Call 2 (human): same ambiguous evidence, no false online label.
    const second = capture();
    expect(await cmdFleetPoolReach([], h.poolDeps)).toBe(0);
    const human = second.out.join('\n');
    expect(human).toContain('backup mac-backup unknown last seen unknown');
    expect(human).toContain('reason: backup: mac-backup matches 2 tailnet peers');
    expect(human).not.toMatch(/backup mac-backup online/);
    expect(human).not.toContain('tail-a.ts.net');

    // Call 3: next read sees one offline matching peer; clock advances.
    h.setRaw(SINGLE_PEERS);
    h.advance(30_000);
    const third = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const recovered = JSON.parse(third.out.join('\n')) as typeof parsed;
    expect(recovered.asOf).toBe(new Date(T2).toISOString());
    expect(recovered.hosts.find(host => host.slot === 'backup')).toMatchObject({
      alias: 'mac-backup',
      matched: 'mac-backup.tail-a.ts.net',
      online: false,
      ageSeconds: 90,
    });
    expect(recovered.reasons).toEqual([]);

    // Call 4 (human): the recovered state names the exact offline host.
    const fourth = capture();
    expect(await cmdFleetPoolReach([], h.poolDeps)).toBe(0);
    const recoveredHuman = fourth.out.join('\n');
    expect(recoveredHuman).toContain(`as of ${new Date(T2).toISOString()}`);
    expect(recoveredHuman).toContain('backup mac-backup offline last seen 90s ago');
    expect(recoveredHuman).not.toContain('matches 2 tailnet peers');

    // Call 5: rename the configured backup to an unmatched alias; the CLI must
    // re-read config each call and must not reuse the prior matched evidence.
    h.setConfig({
      role: 'worker',
      primary: 'mac-primary',
      backup: 'mac-backup-renamed',
      owner: 'fake-owner',
      node: 'fake-node',
    });
    const fifth = capture();
    expect(await cmdFleetPoolReach(['--json'], h.poolDeps)).toBe(0);
    const renamed = JSON.parse(fifth.out.join('\n')) as typeof parsed;
    expect(renamed.hosts.find(host => host.slot === 'backup')).toMatchObject({
      alias: 'mac-backup-renamed', matched: 'unknown', online: 'unknown',
    });
    expect(renamed.reasons).toContain('backup: no tailnet peer named mac-backup-renamed');

    // Every call re-read both config and tailscale: 5 calls -> 5 of each.
    expect(h.readConfig).toHaveBeenCalledTimes(5);
    expect(h.exec).toHaveBeenCalledTimes(5);
    expect(h.exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });
});
