/**
 * RQ-PHX-TAILNETBACKENDUNKNOWN358S - an absent or malformed tailscale
 * BackendState must not vouch for retained Online=true claims. Only an
 * explicit "Running" supports current online evidence; absent, blank or
 * non-string states keep each peer's identity/lastSeen evidence but report
 * connectivity as unknown, with one bounded reason on the existing
 * "tailscale backend not running:" convention that pool-reach matches.
 * Evidence only: fake hosts, injected exec, the real reader/parser, and no
 * real tailscale invocation.
 */
import { describe, expect, it } from 'vitest';
import {
  parseTailnetStatus,
  readTailnetPeers,
  type TailnetPeersDeps,
} from '../src/core/fleet/tailnet-peers.js';
import { joinPoolReach } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const HOME = '/Users/fakeuser';
const SELF = 'fake-self-mac';
const LAST_SEEN = '2026-11-14T11:58:40.000Z';
const BACKEND_REASON = 'tailscale backend not running: unknown';

/** Status body with any BackendState value, including absent. */
function statusBody(backendState: unknown, peers?: Record<string, unknown>, self: unknown = SELF): string {
  const body: Record<string, unknown> = {
    Self: { HostName: self },
    Peer: peers ?? {
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true, LastSeen: LAST_SEEN,
      },
    },
  };
  if (backendState !== undefined) body.BackendState = backendState;
  return JSON.stringify(body);
}

function deps(over: Partial<TailnetPeersDeps> = {}): TailnetPeersDeps {
  return {
    now: () => new Date(NOW),
    homeDir: () => HOME,
    exec: () => statusBody('Running'),
    ...over,
  };
}

const readRaw = (raw: string) => readTailnetPeers(deps({ exec: () => raw }));

describe('tailnet peers with no usable backend state', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a number', 4242],
    ['an empty string', ''],
    ['a blank string', '   \n\t  '],
    ['an object', { detail: 'PRIVATE-DIAG-7f3a' }],
    ['an array', ['Running']],
    ['a boolean', true],
  ])('BackendState %s never asserts online; connectivity is unknown with a bounded reason', (_label, state) => {
    const result = readRaw(statusBody(state));

    // Identity and lastSeen evidence stay; only the connectivity claim is refused.
    expect(result.peers).toHaveLength(1);
    const peer = result.peers[0]!;
    expect(peer.online).not.toBe(true);
    expect(peer.online).toBe('unknown');
    expect(peer.name).toBe('fake-studio-2');
    expect(peer.os).toBe('macOS');
    expect(peer.lastSeen).toBe('2026-11-14T11:58:40.000Z');
    expect(peer.ageSeconds).toBe(80);
    expect(result.self).toBe(SELF);

    // Exactly one bounded reason, on the convention pool-reach matches.
    expect(result.reasons).toEqual([BACKEND_REASON]);
  });

  it.each([
    ['a number', 4242, '4242'],
    ['an object', { detail: 'PRIVATE-DIAG-7f3a' }, 'PRIVATE-DIAG-7f3a'],
    ['an object-shaped string key', { toString: 'x' }, 'toString'],
  ])('never exposes the raw BackendState value for %s', (_label, state, marker) => {
    const result = readRaw(statusBody(state));
    for (const reason of result.reasons) expect(reason).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('keeps retained Online=false claims untouched when the state is unusable', () => {
    const result = readRaw(statusBody(null, {
      'nodekey:a': { HostName: 'fake-off-1', OS: 'linux', Online: false, LastSeen: LAST_SEEN },
      'nodekey:b': { HostName: 'fake-on-1', OS: 'macOS', Online: true, LastSeen: LAST_SEEN },
    }));
    const byName = new Map(result.peers.map(peer => [peer.name, peer.online]));
    expect(byName.get('fake-off-1')).toBe(false);
    expect(byName.get('fake-on-1')).toBe('unknown');
    expect(result.reasons).toEqual([BACKEND_REASON]);
  });

  it('preserves current online behavior only on an explicit Running state', () => {
    const result = readRaw(statusBody('Running'));
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]?.online).toBe(true);
    expect(result.peers[0]?.ageSeconds).toBe(80);
    expect(result.reasons).toEqual([]);
  });

  it('keeps explicit stopped behavior: retained online claims are dropped with the state named', () => {
    for (const state of ['Stopped', 'Starting', 'NeedsLogin']) {
      const result = readRaw(statusBody(state));
      expect(result.peers).toHaveLength(0);
      expect(result.reasons).toEqual([`tailscale backend not running: ${state}`]);
    }
  });

  it('keeps retained offline peers visible during an explicit stopped state', () => {
    const result = readRaw(statusBody('Stopped', {
      'nodekey:a': { HostName: 'fake-off-1', OS: 'linux', Online: false, LastSeen: LAST_SEEN },
      'nodekey:b': { HostName: 'fake-on-1', OS: 'macOS', Online: true, LastSeen: LAST_SEEN },
    }));
    expect(result.peers).toHaveLength(1);
    expect(result.peers[0]?.name).toBe('fake-off-1');
    expect(result.peers[0]?.online).toBe(false);
  });

  it('does not let a peer-level flag or a successful read prove the backend running', () => {
    // No BackendState plus extra peer fields that could look like health:
    // none of them is the backend's own state, so connectivity stays unknown.
    const result = readRaw(statusBody(undefined, {
      'nodekey:a': {
        HostName: 'fake-studio-2', OS: 'macOS', Online: true, LastSeen: LAST_SEEN,
        TailscaleUp: true, BackendState: 'Running', Active: true,
      },
    }));
    expect(result.peers[0]?.online).toBe('unknown');
    expect(result.reasons).toEqual([BACKEND_REASON]);
  });

  it('stays nonthrowing on malformed status JSON', () => {
    for (const bad of ['not json', '', '{', '[1,2]', 'null', '"Running"', '42']) {
      const result = readRaw(bad);
      expect(result.peers).toEqual([]);
      expect(result.reasons).toContain('tailscale unavailable or status unreadable');
    }
  });

  it('stays nonthrowing when the exec itself fails', () => {
    const result = readTailnetPeers(deps({
      exec: () => { throw new Error('fake tailscale missing'); },
    }));
    expect(result.peers).toEqual([]);
    expect(result.reasons).toEqual(['tailscale unavailable or status unreadable']);
  });

  it('parseTailnetStatus agrees with readTailnetPeers on the same raw input', () => {
    const raw = statusBody(null);
    expect(parseTailnetStatus(raw, new Date(NOW), HOME)).toEqual(readRaw(raw));
  });

  it('lets pool-reach recognize the uncertainty via the non-running reason convention', () => {
    // joinPoolReach is pure: config + peers in, sanitized reach out. The fixed
    // reason prefix is what stops a self alias being promoted to online on
    // stale evidence, and a retained unknown peer match stays unknown.
    const config: PoolConfig = { role: 'worker', primary: SELF, backup: 'fake-studio-2', owner: 'o', node: 'n' };
    const reach = joinPoolReach(config, null, readRaw(statusBody(null)), HOME);
    const primary = reach.hosts.find(host => host.slot === 'primary')!;
    const backup = reach.hosts.find(host => host.slot === 'backup')!;
    expect(primary.online).not.toBe(true);
    expect(backup.matched).toBe('fake-studio-2');
    expect(backup.online).toBe('unknown');
    expect(reach.reasons).toContain(BACKEND_REASON);
  });
});
