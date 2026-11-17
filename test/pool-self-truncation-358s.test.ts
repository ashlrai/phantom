/**
 * RQ-PHX-POOLSELFTRUNCATION358S - a bounded tailnet read cannot prove a self
 * alias is unique: when the peer list is truncated, a peer past the cap may
 * claim the same name. The self match stays as evidence (isSelf) but matched
 * and online must remain unknown until a complete read confirms the alias.
 * Evidence only: fake hosts, injected deps, the real reader/parser, and no
 * real tailscale or home directory.
 */
import { describe, expect, it } from 'vitest';
import { readPoolReach, type PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import { TAILNET_PEER_LIMIT, type TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';

const HOME = '/Users/fakeuser';
const T0 = Date.parse('2026-11-14T12:00:00.000Z');
const SELF = 'mac-self';
const WORKER = 'mac-worker';
const LAST_SEEN = '2026-11-14T11:59:00.000Z';
const TRUNCATED_SELF_REASON =
  `primary: ${SELF} names this computer but the peer list is truncated; identity not proven unique`;
const TRUNCATION_REASON = `peers: truncated to ${TAILNET_PEER_LIMIT} of ${TAILNET_PEER_LIMIT + 1}`;

function statusBody(peers: Record<string, unknown>, self: unknown = SELF): string {
  return JSON.stringify({ BackendState: 'Running', Self: { HostName: self }, Peer: peers });
}

function peer(hostName: string, online = true): Record<string, unknown> {
  return { HostName: hostName, OS: 'macOS', Online: online, LastSeen: LAST_SEEN };
}

/**
 * Online filler records. With the default `aaa-filler` prefix they sort ahead
 * of every `mac-*` name; `zzz-filler` sorts behind them, which keeps a
 * lower-named competitor inside the retained window.
 */
function fillers(count: number, prefix = 'aaa-filler'): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    const name = `${prefix}-${String(i).padStart(3, '0')}`;
    map[`nodekey:${name}`] = peer(name);
  }
  return map;
}

function config(primary: string, backup: string): PoolConfig {
  return { role: 'worker', primary, backup, owner: 'fake-owner', node: 'fake-node' };
}

/** Retained deps; every readPoolReach call re-reads config and raw status. */
function harness(poolConfig: PoolConfig, peers: Record<string, unknown>) {
  let now = T0;
  let raw = statusBody(peers);
  const poolDeps: PoolReachDeps = {
    readConfig: () => poolConfig,
    peers: {
      now: () => new Date(now),
      homeDir: () => HOME,
      exec: () => raw,
    } satisfies TailnetPeersDeps,
  };
  return {
    poolDeps,
    setPeers(next: Record<string, unknown>) { raw = statusBody(next); },
    advance(ms: number) { now += ms; },
  };
}

function host(result: ReturnType<typeof readPoolReach>, slot: 'primary' | 'backup') {
  return result.hosts.find(entry => entry.slot === slot)!;
}

describe('pool-reach self alias under peer-list truncation', () => {
  it('refuses online/unique self when a same-name competitor sorts past the cap', () => {
    // 64 retained online records plus one offline `mac-self.*` competitor:
    // offline sorts last, so the competitor lands past the cap and is dropped.
    // Retained evidence shows zero matches for the alias while a real claimant
    // exists, which is exactly what the truncated read cannot disprove.
    const h = harness(config(SELF, WORKER), {
      ...fillers(TAILNET_PEER_LIMIT - 1),
      'nodekey:worker': peer(WORKER),
      'nodekey:hidden-self': peer(`${SELF}.tail-zz.ts.net`, false),
    });

    const result = readPoolReach(h.poolDeps);
    expect(result.self).toBe(SELF);
    expect(result.reasons).toContain(TRUNCATION_REASON);
    const primary = host(result, 'primary');
    expect(primary).toMatchObject({
      alias: SELF, matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(primary.online).not.toBe(true);
    expect(result.reasons).toContain(TRUNCATED_SELF_REASON);
    // The hidden competitor name must never surface in sanitized output.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('tail-zz.ts.net');
    expect(serialized).not.toContain(HOME);
    // The backup's single retained match is equally unprovable under truncation.
    expect(host(result, 'backup')).toMatchObject({
      matched: 'unknown', online: 'unknown', isSelf: false,
    });
    expect(result.reasons).toContain(
      `backup: ${WORKER} matches a tailnet peer but the peer list is truncated; identity not proven unique`,
    );
  });

  it('refuses self uniqueness under truncation even with no visible competitor', () => {
    // 65 online records, none named like self: the cap still hides whatever
    // sorts last, so zero retained matches cannot prove the alias is unique.
    const h = harness(config(SELF, WORKER), {
      ...fillers(TAILNET_PEER_LIMIT - 1),
      'nodekey:worker': peer(WORKER),
      'nodekey:extra': peer('zzz-extra'),
    });

    const result = readPoolReach(h.poolDeps);
    expect(result.reasons).toContain(TRUNCATION_REASON);
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain(TRUNCATED_SELF_REASON);
    expect(result.reasons).not.toContain(`primary: no tailnet peer named ${SELF}`);
  });

  it('keeps untruncated self reporting and leaves a certain backup untouched', () => {
    const h = harness(config(SELF, WORKER), { 'nodekey:worker': peer(WORKER) });

    const result = readPoolReach(h.poolDeps);
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: SELF, online: true, isSelf: true,
    });
    expect(host(result, 'backup')).toMatchObject({ matched: WORKER, online: true, isSelf: false });
    expect(result.reasons).toEqual([]);
  });

  it('keeps a visible self/peer collision unknown, truncated or not', () => {
    const h = harness(config(SELF, WORKER), {
      'nodekey:collide': peer(`${SELF}.tail-x.ts.net`),
      'nodekey:worker': peer(WORKER),
    });

    let result = readPoolReach(h.poolDeps);
    expect(host(result, 'primary')).toMatchObject({
      alias: SELF, matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain(`primary: ${SELF} matches this computer and 1 tailnet peers`);

    // Same collision retained inside a truncated list (`mac-self.aaa` sorts
    // ahead of `zzz-filler`): the reason must admit more claimants may hide
    // past the cap.
    h.setPeers({
      'nodekey:collide': peer(`${SELF}.aaa.ts.net`),
      ...fillers(TAILNET_PEER_LIMIT, 'zzz-filler'),
    });
    result = readPoolReach(h.poolDeps);
    expect(result.reasons).toContain(TRUNCATION_REASON);
    expect(host(result, 'primary')).toMatchObject({
      matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain(
      `primary: ${SELF} matches this computer and 1 tailnet peers; peer list truncated, more matches may be hidden`,
    );
  });

  it('recovers on the next complete read; no sticky unknown', () => {
    const h = harness(config(SELF, WORKER), {
      ...fillers(TAILNET_PEER_LIMIT - 1),
      'nodekey:worker': peer(WORKER),
      'nodekey:hidden-self': peer(`${SELF}.tail-zz.ts.net`, false),
    });

    let result = readPoolReach(h.poolDeps);
    expect(host(result, 'primary')).toMatchObject({
      matched: 'unknown', online: 'unknown', isSelf: true,
    });
    expect(result.reasons).toContain(TRUNCATED_SELF_REASON);

    // Complete evidence returns: a fresh read resolves both slots normally.
    h.setPeers({ 'nodekey:worker': peer(WORKER) });
    h.advance(30_000);
    result = readPoolReach(h.poolDeps);
    expect(result.asOf).toBe(new Date(T0 + 30_000).toISOString());
    expect(host(result, 'primary')).toMatchObject({ matched: SELF, online: true, isSelf: true });
    expect(host(result, 'backup')).toMatchObject({ matched: WORKER, online: true });
    expect(result.reasons).toEqual([]);
  });
});
