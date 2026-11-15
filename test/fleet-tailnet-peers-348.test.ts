import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetTailnetPeers } from '../src/cli/fleet-tailnet-peers.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  parseTailnetStatus,
  readTailnetPeers,
  type TailnetPeersDeps,
} from '../src/core/fleet/tailnet-peers.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOME = '/Users/fakeuser';

function statusBody(peers: Record<string, unknown>, self: unknown = 'fake-self-mac'): string {
  return JSON.stringify({ Self: { HostName: self }, Peer: peers });
}

function deps(over: Partial<TailnetPeersDeps> = {}): TailnetPeersDeps {
  return {
    now: () => new Date(NOW),
    homeDir: () => HOME,
    exec: () => statusBody({}),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('parseTailnetStatus', () => {
  it('sorts online peers first, then by name, and computes ages from now', () => {
    const raw = statusBody({
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: false,
        LastSeen: '2026-11-14T11:58:40.000Z',
      },
      'nodekey:b': {
        HostName: 'fake-mini-1', OS: 'linux', Online: true,
        LastSeen: '2026-11-14T11:59:00.000Z',
      },
    });
    const result = parseTailnetStatus(raw, new Date(NOW), HOME);
    expect(result.asOf).toBe('2026-11-14T12:00:00.000Z');
    expect(result.self).toBe('fake-self-mac');
    expect(result.reasons).toEqual([]);
    expect(result.peers.map(p => p.name)).toEqual(['fake-mini-1', 'fake-studio-2']);
    expect(result.peers[0]).toEqual({
      name: 'fake-mini-1', os: 'linux', online: true,
      lastSeen: '2026-11-14T11:59:00.000Z', ageSeconds: 60,
    });
    expect(result.peers[1]).toMatchObject({ online: false, ageSeconds: 80 });
  });

  it('never leaks addresses, DNS names or keys from the status payload', () => {
    const raw = statusBody({
      'nodekey:realkeyvalue': {
        HostName: 'fake-mini-1', OS: 'macOS', Online: true,
        LastSeen: '2026-11-14T11:59:00.000Z',
        TailscaleIPs: ['100.64.0.7'],
        DNSName: 'box.example-tailnet.ts.net',
        PublicKey: 'nodekey:fakefakefake',
        Addrs: ['100.64.0.7:41641'],
        CurAddr: '203.0.113.9:41641',
        UserID: 42,
      },
    });
    const text = JSON.stringify(parseTailnetStatus(raw, new Date(NOW), HOME));
    for (const secret of ['100.64.0.7', 'box.example-tailnet.ts.net', 'nodekey:fakefakefake',
      'realkeyvalue', '203.0.113.9', '41641', 'UserID', 'DNSName', 'PublicKey', 'TailscaleIPs']) {
      expect(text).not.toContain(secret);
    }
  });

  it('redacts the home path and IPv4 addresses inside HostName', () => {
    const raw = statusBody({
      'nodekey:a': { HostName: `${HOME}/x-box-10.0.0.5`, OS: 'macOS', Online: true },
    });
    const result = parseTailnetStatus(raw, new Date(NOW), HOME);
    const text = JSON.stringify(result);
    expect(text).not.toContain(HOME);
    expect(text).not.toContain('10.0.0.5');
    expect(result.peers[0]!.name).toContain('~');
    expect(result.peers[0]!.name).toContain('[ip]');
  });

  it('reports empty peers plus a reason on garbage JSON', () => {
    const result = parseTailnetStatus('not json at all', new Date(NOW), HOME);
    expect(result.peers).toEqual([]);
    expect(result.self).toBe('unknown');
    expect(result.reasons).toContain('tailscale unavailable or status unreadable');
  });

  it('reports a reason when the status has no Peer map', () => {
    const result = parseTailnetStatus(JSON.stringify({ Self: { HostName: 'fake-self-mac' } }), new Date(NOW), HOME);
    expect(result.peers).toEqual([]);
    expect(result.self).toBe('fake-self-mac');
    expect(result.reasons).toContain('peers: status has no Peer map');
  });

  it('treats the zero-value LastSeen as unknown', () => {
    const raw = statusBody({
      'nodekey:a': { HostName: 'fake-mini-1', Online: false, LastSeen: '0001-01-01T00:00:00Z' },
    });
    const peer = parseTailnetStatus(raw, new Date(NOW), HOME).peers[0]!;
    expect(peer.lastSeen).toBe('unknown');
    expect(peer.ageSeconds).toBe('unknown');
  });

  it('keeps a future LastSeen but leaves ageSeconds unknown', () => {
    const raw = statusBody({
      'nodekey:a': { HostName: 'fake-mini-1', Online: true, LastSeen: '2026-11-15T00:00:00.000Z' },
    });
    const peer = parseTailnetStatus(raw, new Date(NOW), HOME).peers[0]!;
    expect(peer.lastSeen).toBe('2026-11-15T00:00:00.000Z');
    expect(peer.ageSeconds).toBe('unknown');
  });

  it('truncates to 64 peers with a reason naming the total', () => {
    const peerMap: Record<string, unknown> = {};
    for (let i = 0; i < 70; i++) {
      peerMap[`nodekey:${i}`] = { HostName: `fake-peer-${String(i).padStart(3, '0')}`, Online: i % 2 === 0 };
    }
    const result = parseTailnetStatus(statusBody(peerMap), new Date(NOW), HOME);
    expect(result.peers).toHaveLength(64);
    expect(result.reasons).toContain('peers: truncated to 64 of 70');
  });

  it('fills every missing field with unknown rather than guessing', () => {
    const result = parseTailnetStatus(statusBody({ 'nodekey:a': {} }), new Date(NOW), HOME);
    expect(result.peers[0]).toEqual({
      name: 'unknown', os: 'unknown', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown',
    });
  });
});

describe('readTailnetPeers', () => {
  it('returns empty peers with a reason when tailscale is missing, never throwing', () => {
    const result = readTailnetPeers(deps({ exec: () => { throw new Error('ENOENT'); } }));
    expect(result).toMatchObject({ self: 'unknown', peers: [] });
    expect(result.reasons).toContain('tailscale unavailable or status unreadable');
    expect(result.asOf).toBe('2026-11-14T12:00:00.000Z');
  });

  it('reports unreadable status output the same way', () => {
    const result = readTailnetPeers(deps({ exec: () => '<<garbage>>' }));
    expect(result.peers).toEqual([]);
    expect(result.reasons).toContain('tailscale unavailable or status unreadable');
  });

  it('only ever runs tailscale status --json', () => {
    const exec = vi.fn(() => statusBody({}));
    readTailnetPeers(deps({ exec }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });
});

describe('cmdFleetTailnetPeers', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    return { out, err };
  }

  const twoPeers = deps({
    exec: () => statusBody({
      'nodekey:a': { HostName: 'fake-studio-2', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:58:40.000Z' },
      'nodekey:b': { HostName: 'fake-mini-1', OS: 'linux', Online: true, LastSeen: '2026-11-14T11:59:00.000Z' },
    }),
  });

  it('prints --json that parses to the contract', async () => {
    const { out } = capture();
    expect(await cmdFleetTailnetPeers(['--json'], twoPeers)).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as ReturnType<typeof readTailnetPeers>;
    expect(parsed.self).toBe('fake-self-mac');
    expect(parsed.asOf).toBe('2026-11-14T12:00:00.000Z');
    expect(parsed.peers.map(p => p.name)).toEqual(['fake-mini-1', 'fake-studio-2']);
    expect(parsed.peers[0]).toMatchObject({ online: true, ageSeconds: 60 });
  });

  it('prints a self header and one line per peer in human mode', async () => {
    const { out } = capture();
    expect(await cmdFleetTailnetPeers([], twoPeers)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('self fake-self-mac as of 2026-11-14T12:00:00.000Z');
    expect(text).toContain('online fake-mini-1 linux last seen 60s ago');
    expect(text).toContain('offline fake-studio-2 macOS last seen 80s ago');
  });

  it('exits 0 with reasons when tailscale is missing', async () => {
    const { out } = capture();
    expect(await cmdFleetTailnetPeers([], deps({ exec: () => { throw new Error('ENOENT'); } }))).toBe(0);
    expect(out.join('\n')).toContain('reason: tailscale unavailable or status unreadable');
  });

  it('rejects unknown flags with exit 2 and usage on stderr', async () => {
    const { err } = capture();
    expect(await cmdFleetTailnetPeers(['--set'], twoPeers)).toBe(2);
    expect(err.join('\n')).toContain('Usage: ashlr fleet tailnet-peers');
  });

  it('prints usage and exits 0 on --help', async () => {
    const { out } = capture();
    expect(await cmdFleetTailnetPeers(['--help'], twoPeers)).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet tailnet-peers');
  });

  it('is registered for dispatch without editing fleet.ts', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['tailnet-peers']!();
    expect(mod.cmdFleetTailnetPeers).toBe(cmdFleetTailnetPeers);
  });
});
