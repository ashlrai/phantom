/**
 * RQ-PHX-POOLSELFSTOPPED356S - pool-reach must not report this computer online
 * through Tailscale when the backend explicitly reports a non-running state.
 * Evidence only: fake hosts, injected deps, no real tailscale or home.
 */
import { describe, expect, it } from 'vitest';
import { readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const HOME = '/Users/fakeuser';
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const SELF = 'mac-self';
const WORKER = 'mac-worker';
const LAST_SEEN = '2026-11-14T11:59:00.000Z';

const ONLINE_PEERS = {
  'nodekey:w': { HostName: WORKER, OS: 'macOS', Online: true, LastSeen: LAST_SEEN },
};

function statusBody(backendState: string, peers: Record<string, unknown>): string {
  return JSON.stringify({ BackendState: backendState, Self: { HostName: SELF }, Peer: peers });
}

function config(primary: string, backup: string): PoolConfig {
  return { role: 'worker', primary, backup, owner: 'fake-owner', node: 'fake-node' };
}

/** One retained deps object; each readPoolReach call re-reads both sources. */
function harness(poolConfig: PoolConfig) {
  let backendState = 'Running';
  let now = T0;
  let extraPeers: Record<string, unknown> = {};
  const poolDeps: PoolReachDeps = {
    readConfig: () => poolConfig,
    peers: {
      now: () => new Date(now),
      homeDir: () => HOME,
      exec: () => statusBody(backendState, { ...ONLINE_PEERS, ...extraPeers }),
    } satisfies TailnetPeersDeps,
  };
  return {
    poolDeps,
    setBackend(state: string) { backendState = state; },
    addPeers(map: Record<string, unknown>) { extraPeers = { ...extraPeers, ...map }; },
    advance(ms: number) { now += ms; },
  };
}

function host(result: ReturnType<typeof readPoolReach>, slot: 'primary' | 'backup') {
  return result.hosts.find(entry => entry.slot === slot)!;
}

describe('pool-reach self vs backend state', () => {
  it('primary=self backup=remote: Running -> Stopped -> NeedsLogin -> Running', () => {
    const h = harness(config(SELF, WORKER));

    // Running: self is online by identity, remote peer online via the real parser.
    let result = readPoolReach(h.poolDeps);
    expect(result.self).toBe(SELF);
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: SELF, online: true, isSelf: true,
    });
    expect(host(result, 'backup')).toMatchObject({ matched: WORKER, online: true, isSelf: false });
    expect(result.reasons).toEqual([]);

    // Stopped: self identity stays certain, connectivity is unknown, never online.
    h.setBackend('Stopped');
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(result.asOf).toBe(new Date(T0 + 30_000).toISOString());
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: SELF, online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain('tailscale backend not running: Stopped');
    expect(result.reasons).toContain(
      `primary: ${SELF} names this computer but the tailscale backend is not running; connectivity unknown`,
    );
    // The retained online remote peer is filtered by the parser: unknown, not online.
    expect(host(result, 'backup').online).toBe('unknown');
    expect(host(result, 'backup').online).not.toBe(true);

    // NeedsLogin: same refusal, reason survives with its own state value.
    h.setBackend('NeedsLogin');
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(host(result, 'primary')).toMatchObject({ matched: SELF, online: 'unknown', isSelf: true });
    expect(result.reasons).toContain('tailscale backend not running: NeedsLogin');
    expect(host(result, 'primary').online).not.toBe(true);

    // Running again: fresh read recovers self and remote online evidence.
    h.setBackend('Running');
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(result.asOf).toBe(new Date(T0 + 90_000).toISOString());
    expect(host(result, 'primary')).toMatchObject({ matched: SELF, online: true, isSelf: true });
    expect(host(result, 'backup')).toMatchObject({ matched: WORKER, online: true });
    expect(result.reasons).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(HOME);
  });

  it('backup=self: a stopped backend keeps the self backup unknown, never online', () => {
    const h = harness(config(WORKER, SELF));

    let result = readPoolReach(h.poolDeps);
    expect(host(result, 'backup')).toMatchObject({ matched: SELF, online: true, isSelf: true });
    expect(host(result, 'primary')).toMatchObject({ matched: WORKER, online: true });

    h.setBackend('Stopped');
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(host(result, 'backup')).toMatchObject({
      alias: SELF, matched: SELF, online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain('tailscale backend not running: Stopped');
    expect(result.reasons).toContain(
      `backup: ${SELF} names this computer but the tailscale backend is not running; connectivity unknown`,
    );

    h.setBackend('Running');
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(host(result, 'backup')).toMatchObject({ matched: SELF, online: true, isSelf: true });
    expect(host(result, 'primary')).toMatchObject({ matched: WORKER, online: true });
  });

  it('a competing self-name peer still refuses reachability while the backend runs', () => {
    const h = harness(config(SELF, WORKER));
    h.addPeers({
      'nodekey:self-elsewhere': {
        HostName: `${SELF}.tail-x.ts.net`, OS: 'macOS', Online: true, LastSeen: LAST_SEEN,
      },
    });

    const result = readPoolReach(h.poolDeps);
    // Self plus one peer claiming the alias: identity ambiguous, never online.
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain(`primary: ${SELF} matches this computer and 1 tailnet peers`);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('tail-x.ts.net');
    expect(serialized).not.toContain(HOME);
  });
});
