/** GET /api/verse/fleet/runtime-identity/{tailnet-peers,pool-reach}: fake deps only. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_POOL_REACH_PATH as POOL,
  VERSE_FLEET_TAILNET_PEERS_PATH as PEERS,
  createFleetHostReachApi,
} from '../src/core/verse/fleet-host-reach-api.js';
import {
  VERSE_FLEET_RUNTIME_IDENTITY_PATH as IDENTITY,
  createFleetRuntimeIdentityApi,
} from '../src/core/verse/fleet-runtime-identity-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';
import { narrowTailnetPeers } from '../src/web-ui/routes/verse/fleet-host/tailnet-peers-model.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const HOME = '/Users/fakehome';
const STATUS = JSON.stringify({
  Self: { HostName: 'mac-self', TailscaleIPs: ['100.64.0.9'] },
  Peer: {
    a: { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T09:59:00Z', DNSName: 'mac-primary.tail-x.ts.net.', TailscaleIPs: ['100.64.0.1'] },
    b: { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T08:00:00Z', TailscaleIPs: ['100.64.0.2'] },
  },
});

const tailnetDeps = (exec: TailnetPeersDeps['exec'] = () => STATUS): TailnetPeersDeps =>
  ({ now: () => NOW, homeDir: () => HOME, exec });
const poolDeps = (over: Partial<PoolReachDeps> = {}, exec?: TailnetPeersDeps['exec']): PoolReachDeps => ({
  readConfig: () => ({ role: 'worker', primary: 'mac-primary', backup: 'mac-backup', owner: 'o', node: 'n' }),
  peers: tailnetDeps(exec),
  ...over,
});
const api = (over: Parameters<typeof createFleetHostReachApi>[0] = {}) =>
  createFleetHostReachApi({ tailnetDeps: tailnetDeps(), poolDeps: poolDeps(), now: () => NOW, ...over });

async function call(m: ApiModule, path: string, method = 'GET') {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await m({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}
const leaks = (text: string) => /\b\d{1,3}(\.\d{1,3}){3}\b|100\.|\/Users\//.test(text);

describe('fleet host reach api', () => {
  it('serves tailnet peers at top level and matches the card contract', async () => {
    const r = await call(api(), PEERS);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ v: 1, generatedAt: NOW.toISOString(), asOf: NOW.toISOString(), self: 'mac-self', reasons: [] });
    expect(r.body.peers.map((p: { name: string }) => p.name)).toEqual(['mac-primary', 'mac-backup']);
    const view = narrowTailnetPeers(r.body);
    expect(view).not.toBeNull();
    expect(view?.peers.map((p) => [p.name, p.online])).toEqual([['mac-primary', true], ['mac-backup', false]]);
    expect(leaks(r.text)).toBe(false);
  });

  it('serves pool reach with primary online and backup offline', async () => {
    const r = await call(api(), POOL);
    expect(r.status).toBe(200);
    expect(r.body.v).toBe(1);
    expect(r.body.generatedAt).toBe(NOW.toISOString());
    expect(r.body.reach.hosts.map((h: { slot: string; online: unknown }) => [h.slot, h.online])).toEqual([['primary', true], ['backup', false]]);
    expect(leaks(r.text)).toBe(false);
  });

  it('answers 200 with unknown fields when the tailscale exec throws, without the thrown text', async () => {
    const boom = () => { throw new Error('SECRET-boom at /Users/fakehome 100.64.0.1'); };
    const peers = await call(api({ tailnetDeps: tailnetDeps(boom) }), PEERS);
    expect(peers.status).toBe(200);
    expect(peers.body.self).toBe('unknown');
    expect(peers.body.peers).toEqual([]);
    expect(peers.body.reasons.length).toBeGreaterThan(0);
    const pool = await call(api({ poolDeps: poolDeps({}, boom) }), POOL);
    expect(pool.status).toBe(200);
    expect(pool.body.reach.self).toBe('unknown');
    for (const r of [peers, pool]) { expect(r.text).not.toContain('SECRET-boom'); expect(leaks(r.text)).toBe(false); }
  });

  it('answers 200 with unknown fields when readConfig throws, without the thrown text', async () => {
    const r = await call(api({ poolDeps: poolDeps({ readConfig: () => { throw new Error('SECRET-config /Users/fakehome/x'); } }) }), POOL);
    expect(r.status).toBe(200);
    expect(r.body.reach.role).toBe('unknown');
    expect(r.body.reach.hosts).toEqual([]);
    expect(r.body.reach.reasons).toContain('pool config: pool config unreadable');
    expect(r.text).not.toContain('SECRET-config');
    expect(leaks(r.text)).toBe(false);
  });

  it('answers 200 with fixed unknowns when a reader itself throws', async () => {
    const hostile = { now: () => { throw new Error('SECRET-clock'); }, homeDir: () => HOME, exec: () => STATUS } as TailnetPeersDeps;
    const peers = await call(api({ tailnetDeps: hostile }), PEERS);
    expect(peers.status).toBe(200);
    expect(peers.body.reasons).toEqual(['tailnet peers: reader failed; all fields unknown']);
    // readPoolReach absorbs a throwing peers reader itself: still 200, unknown self.
    const pool = await call(api({ poolDeps: { readConfig: () => null, peers: hostile } }), POOL);
    expect(pool.status).toBe(200);
    expect(pool.body.reach.self).toBe('unknown');
    expect(peers.text + pool.text).not.toContain('SECRET-clock');
  });

  it('405s non-GET and ignores unrelated paths', async () => {
    for (const p of [PEERS, POOL]) {
      const r = await call(api(), p, 'POST');
      expect([r.handled, r.status, r.body]).toEqual([true, 405, { error: 'method not allowed' }]);
    }
    expect((await call(api(), '/api/verse/fleet/other')).handled).toBe(false);
    expect((await call(api(), IDENTITY)).handled).toBe(false);
  });
});

describe('runtime-identity delegation', () => {
  const identityDeps: RuntimeIdentityDeps = {
    hostname: () => 'studio', platform: () => 'darwin', now: () => NOW, homeDir: () => HOME,
    statePath: () => `${HOME}/.ashlr/guardian/state.json`, statMtimeMs: () => NOW.getTime() - 120_000,
    readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }), installedVersion: () => '1.2.2',
    exec: () => JSON.stringify({ Self: { HostName: 'studio-ts' } }),
  };
  const handler = createFleetRuntimeIdentityApi({ identityDeps, now: () => NOW, hostReach: api() });

  it('still returns the identity body for the exact path', async () => {
    const r = await call(handler, IDENTITY);
    expect(r.status).toBe(200);
    expect(r.body.identity.host).toBe('studio');
    expect(leaks(r.text)).toBe(false);
  });

  it('delegates sub-paths to the host-reach module', async () => {
    expect((await call(handler, PEERS)).body.peers).toHaveLength(2);
    expect((await call(handler, POOL)).body.reach.hosts).toHaveLength(2);
    expect((await call(handler, `${IDENTITY}/nope`)).handled).toBe(false);
    expect((await call(handler, '/api/verse/fleet/runtime-identityX')).handled).toBe(false);
  });
});
