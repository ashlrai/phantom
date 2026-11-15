import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetPoolReach } from '../src/cli/fleet-pool-reach.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { joinPoolReach, readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { TailnetPeer, TailnetPeers, TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const AS_OF = '2026-11-14T12:00:00.000Z';
const HOME = '/Users/fakeuser';

const CONFIG: PoolConfig = {
  role: 'worker',
  primary: 'mac-primary',
  backup: 'mac-backup',
  owner: 'fake-owner',
  node: 'fake-node',
};

function statusBody(peers: Record<string, unknown>, self: unknown = 'mac-self'): string {
  return JSON.stringify({ Self: { HostName: self }, Peer: peers });
}

function peersDeps(over: Partial<TailnetPeersDeps> = {}): TailnetPeersDeps {
  return {
    now: () => new Date(NOW),
    homeDir: () => HOME,
    exec: () => statusBody({}),
    ...over,
  };
}

function deps(over: Partial<PoolReachDeps> = {}): PoolReachDeps {
  return { readConfig: () => CONFIG, peers: peersDeps(), ...over };
}

function peer(name: string, over: Partial<TailnetPeer> = {}): TailnetPeer {
  return {
    name,
    os: 'macOS',
    online: true,
    lastSeen: '2026-11-14T11:59:00.000Z',
    ageSeconds: 60,
    ...over,
  };
}

function tailnet(peers: TailnetPeer[], over: Partial<TailnetPeers> = {}): TailnetPeers {
  return { asOf: AS_OF, self: 'mac-self', peers, reasons: [], ...over };
}

afterEach(() => vi.restoreAllMocks());

describe('joinPoolReach', () => {
  it('reports both pool hosts online when their aliases match online peers', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([
      peer('mac-primary'), peer('mac-backup'), peer('mac-other'),
    ]));
    expect(result.asOf).toBe(AS_OF);
    expect(result.self).toBe('mac-self');
    expect(result.role).toBe('worker');
    expect(result.reasons).toEqual([]);
    expect(result.hosts).toEqual([
      {
        slot: 'primary', alias: 'mac-primary', matched: 'mac-primary', online: true,
        lastSeen: '2026-11-14T11:59:00.000Z', ageSeconds: 60, isSelf: false,
      },
      {
        slot: 'backup', alias: 'mac-backup', matched: 'mac-backup', online: true,
        lastSeen: '2026-11-14T11:59:00.000Z', ageSeconds: 60, isSelf: false,
      },
    ]);
  });

  it('reports an offline backup with its lastSeen age', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([
      peer('mac-primary'),
      peer('mac-backup', { online: false, lastSeen: '2026-11-14T11:58:40.000Z', ageSeconds: 80 }),
      peer('mac-other'),
    ]));
    expect(result.hosts[1]).toMatchObject({
      slot: 'backup', matched: 'mac-backup', online: false,
      lastSeen: '2026-11-14T11:58:40.000Z', ageSeconds: 80,
    });
    expect(result.reasons).toEqual([]);
  });

  it('matches an alias against the peer name first DNS label', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([
      peer('mac-primary.tail-fake.ts.net'), peer('mac-backup.tail-fake.ts.net'),
    ]));
    expect(result.hosts[0]).toMatchObject({ matched: 'mac-primary.tail-fake.ts.net', online: true });
    expect(result.hosts[1]).toMatchObject({ matched: 'mac-backup.tail-fake.ts.net', online: true });
    expect(result.reasons).toEqual([]);
  });

  it('matches an FQDN alias against a short peer name', () => {
    const config = { ...CONFIG, backup: 'mac-backup.tail-fake.ts.net' };
    const result = joinPoolReach(config, null, tailnet([peer('mac-primary'), peer('mac-backup')]));
    expect(result.hosts[1]).toMatchObject({ matched: 'mac-backup', online: true });
  });

  it('does not match on first-label-vs-first-label', () => {
    const config = { ...CONFIG, backup: 'mac-other.fake.example' };
    const result = joinPoolReach(config, null, tailnet([
      peer('mac-primary'), peer('mac-other.tail-fake.ts.net'),
    ]));
    expect(result.hosts[1]).toMatchObject({ matched: 'unknown', online: 'unknown' });
    expect(result.reasons).toContain('backup: no tailnet peer named mac-other.fake.example');
  });

  it('marks the slot self when the alias names this computer, online without a peer record', () => {
    const config = { ...CONFIG, primary: 'mac-self' };
    const result = joinPoolReach(config, null, tailnet([peer('mac-backup')], { self: 'mac-self' }));
    expect(result.hosts[0]).toMatchObject({
      slot: 'primary', alias: 'mac-self', matched: 'mac-self', online: true, isSelf: true,
    });
    expect(result.hosts[1]).toMatchObject({ isSelf: false, online: true });
    expect(result.reasons).toEqual([]);
  });

  it('matches self by first label too', () => {
    const config = { ...CONFIG, primary: 'mac-self' };
    const result = joinPoolReach(config, null, tailnet([peer('mac-backup')], {
      self: 'mac-self.tail-fake.ts.net',
    }));
    expect(result.hosts[0]).toMatchObject({ isSelf: true, online: true, matched: 'mac-self.tail-fake.ts.net' });
    expect(result.self).toBe('mac-self.tail-fake.ts.net');
  });

  it('reports an unmatched alias as unknown with a per-slot reason', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([peer('mac-primary'), peer('mac-other')]));
    expect(result.hosts[1]).toMatchObject({ matched: 'unknown', online: 'unknown', isSelf: false });
    expect(result.reasons).toContain('backup: no tailnet peer named mac-backup');
  });

  it('reports an ambiguous alias as unknown with a reason, never guessing', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([
      peer('mac-primary'), peer('mac-backup'), peer('mac-backup.tail-fake.ts.net'),
    ]));
    expect(result.hosts[1]).toMatchObject({
      matched: 'unknown', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown',
    });
    expect(result.reasons).toContain('backup: mac-backup matches 2 tailnet peers');
  });

  it('never lets a sanitization-placeholder peer name confirm an alias', () => {
    const result = joinPoolReach({ ...CONFIG, backup: 'unknown' }, null, tailnet([
      peer('mac-primary'), peer('unknown'),
    ]));
    expect(result.hosts[1]).toMatchObject({ matched: 'unknown', online: 'unknown' });
    expect(result.reasons).toContain('backup: no tailnet peer named unknown');
  });

  it('returns empty hosts plus a reason when the node pool is not configured', () => {
    const result = joinPoolReach(null, null, tailnet([peer('mac-primary')]));
    expect(result.role).toBe('unknown');
    expect(result.hosts).toEqual([]);
    expect(result.reasons).toContain('node pool not configured');
  });

  it('returns empty hosts plus a sanitized reason on a config error', () => {
    const result = joinPoolReach(null, `bad config at ${HOME}/.ashlr/node-pool/config.json`, tailnet([]), HOME);
    expect(result.hosts).toEqual([]);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('pool config:');
    expect(result.reasons[0]).not.toContain(HOME);
    expect(result.reasons[0]).toContain('~/.ashlr/node-pool/config.json');
  });

  it('redacts IP addresses inside printed aliases', () => {
    const config = { ...CONFIG, backup: 'mac-box-10.0.0.9' };
    const result = joinPoolReach(config, null, tailnet([peer('mac-primary')]), HOME);
    expect(result.hosts[1]!.alias).toBe('mac-box-[ip]');
    expect(JSON.stringify(result)).not.toContain('10.0.0.9');
  });

  it('carries tailnet reasons through ahead of its own', () => {
    const result = joinPoolReach(CONFIG, null, tailnet([], {
      reasons: ['tailscale unavailable or status unreadable'],
    }));
    expect(result.reasons[0]).toBe('tailscale unavailable or status unreadable');
    expect(result.reasons).toContain('primary: no tailnet peer named mac-primary');
    expect(result.reasons).toContain('backup: no tailnet peer named mac-backup');
  });
});

describe('readPoolReach', () => {
  it('joins the injected config read with the injected tailscale status', () => {
    const result = readPoolReach(deps({
      peers: peersDeps({
        exec: () => statusBody({
          'nodekey:a': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z' },
          'nodekey:b': { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:58:40.000Z' },
          'nodekey:c': { HostName: 'mac-other', OS: 'linux', Online: true },
        }),
      }),
    }));
    expect(result.role).toBe('worker');
    expect(result.self).toBe('mac-self');
    expect(result.hosts[0]).toMatchObject({ matched: 'mac-primary', online: true });
    expect(result.hosts[1]).toMatchObject({ matched: 'mac-backup', online: false, ageSeconds: 80 });
    expect(result.reasons).toEqual([]);
  });

  it('returns a sanitized reason and never throws when readConfig throws', () => {
    const result = readPoolReach(deps({
      readConfig: () => { throw new Error(`bad config at ${HOME}/.ashlr/node-pool/config.json`); },
    }));
    expect(result.hosts).toEqual([]);
    expect(result.role).toBe('unknown');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain('pool config:');
    expect(JSON.stringify(result)).not.toContain(HOME);
  });

  it('reports node pool not configured when readConfig returns null', () => {
    const result = readPoolReach(deps({ readConfig: () => null }));
    expect(result.hosts).toEqual([]);
    expect(result.reasons).toContain('node pool not configured');
  });

  it('carries tailscale-unreadable reasons through and marks hosts unknown', () => {
    const result = readPoolReach(deps({
      peers: peersDeps({ exec: () => { throw new Error('ENOENT'); } }),
    }));
    expect(result.reasons).toContain('tailscale unavailable or status unreadable');
    expect(result.hosts).toHaveLength(2);
    expect(result.hosts[0]).toMatchObject({ matched: 'unknown', online: 'unknown' });
  });
});

describe('cmdFleetPoolReach', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    return { out, err };
  }

  const liveDeps = deps({
    peers: peersDeps({
      exec: () => statusBody({
        'nodekey:a': { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z' },
        'nodekey:b': { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T11:58:40.000Z' },
      }),
    }),
  });

  it('prints --json that parses to the contract', async () => {
    const { out } = capture();
    expect(await cmdFleetPoolReach(['--json'], liveDeps)).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as ReturnType<typeof readPoolReach>;
    expect(parsed.self).toBe('mac-self');
    expect(parsed.role).toBe('worker');
    expect(parsed.asOf).toBe(AS_OF);
    expect(parsed.hosts.map(host => host.slot)).toEqual(['primary', 'backup']);
    expect(parsed.hosts[0]).toMatchObject({ alias: 'mac-primary', matched: 'mac-primary', online: true });
    expect(parsed.hosts[1]).toMatchObject({ alias: 'mac-backup', online: false, ageSeconds: 80 });
  });

  it('prints a self header and one line per slot in human mode', async () => {
    const { out } = capture();
    expect(await cmdFleetPoolReach([], liveDeps)).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`self mac-self role worker as of ${AS_OF}`);
    expect(text).toContain('primary mac-primary online last seen 60s ago');
    expect(text).toContain('backup mac-backup offline last seen 80s ago');
  });

  it('tags the self slot with (this computer)', async () => {
    const { out } = capture();
    const selfDeps = deps({
      readConfig: () => ({ ...CONFIG, primary: 'mac-self' }),
      peers: peersDeps({
        exec: () => statusBody({
          'nodekey:b': { HostName: 'mac-backup', OS: 'macOS', Online: true, LastSeen: '2026-11-14T11:59:00.000Z' },
        }),
      }),
    });
    expect(await cmdFleetPoolReach([], selfDeps)).toBe(0);
    expect(out.join('\n')).toContain('primary mac-self online last seen unknown (this computer)');
  });

  it('exits 0 with reasons when the pool is not configured', async () => {
    const { out } = capture();
    expect(await cmdFleetPoolReach([], deps({ readConfig: () => null }))).toBe(0);
    expect(out.join('\n')).toContain('reason: node pool not configured');
  });

  it('exits 0 even when every host is unknown', async () => {
    const { out } = capture();
    expect(await cmdFleetPoolReach([], deps({
      peers: peersDeps({ exec: () => { throw new Error('ENOENT'); } }),
    }))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('primary mac-primary unknown last seen unknown');
    expect(text).toContain('reason: tailscale unavailable or status unreadable');
  });

  it('rejects unknown flags with exit 2 and usage on stderr', async () => {
    const { err } = capture();
    expect(await cmdFleetPoolReach(['--set'], liveDeps)).toBe(2);
    expect(err.join('\n')).toContain('Usage: ashlr fleet pool-reach');
  });

  it('prints usage and exits 0 on --help', async () => {
    const { out } = capture();
    expect(await cmdFleetPoolReach(['--help'], liveDeps)).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet pool-reach');
  });

  it('is registered for dispatch without editing fleet.ts', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['pool-reach']!();
    expect(mod.cmdFleetPoolReach).toBe(cmdFleetPoolReach);
  });
});
