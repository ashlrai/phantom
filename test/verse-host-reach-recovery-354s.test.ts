/** Fresh GETs through ONE retained runtime-identity handler across a tailscale
 * reader outage and recovery, then a pool-config outage and a changed config:
 * proves every response is re-read through the real delegation, never assembled
 * from a cached fixture. Real createFleetRuntimeIdentityApi + real
 * createFleetHostReachApi with injected fake exec/config/clock seams only; no
 * module mocks, no real tailscale, no real home. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  VERSE_FLEET_POOL_REACH_PATH as POOL,
  VERSE_FLEET_TAILNET_PEERS_PATH as PEERS,
  createFleetHostReachApi,
} from '../src/core/verse/fleet-host-reach-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { TailnetPeersDeps } from '../src/core/fleet/tailnet-peers.js';
import type { PoolReachDeps } from '../src/core/fleet/pool-reach.js';
import type { PoolConfig } from '../src/core/drive/nodes/pool-host.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const HOME = '/Users/fakehome';
const SECRET_EXEC = 'SECRET-exec /Users/fakehome/bin 100.64.0.7';
const SECRET_CONFIG = 'SECRET-config /Users/fakehome/pool.json 100.64.0.8';

const statusA = JSON.stringify({
  Self: { HostName: 'mac-self', TailscaleIPs: ['100.64.0.9'] },
  Peer: {
    a: { HostName: 'mac-primary', OS: 'macOS', Online: true, LastSeen: '2026-11-14T09:59:00Z', TailscaleIPs: ['100.64.0.1'] },
    b: { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T08:00:00Z', TailscaleIPs: ['100.64.0.2'] },
  },
});
const statusB = JSON.stringify({
  Self: { HostName: 'mac-self', TailscaleIPs: ['100.64.0.9'] },
  Peer: {
    a: { HostName: 'mac-primary', OS: 'macOS', Online: false, LastSeen: '2026-11-14T10:05:00Z', TailscaleIPs: ['100.64.0.1'] },
    b: { HostName: 'mac-backup', OS: 'macOS', Online: false, LastSeen: '2026-11-14T10:05:30Z', TailscaleIPs: ['100.64.0.2'] },
    c: { HostName: 'mac-gamma', OS: 'macOS', Online: true, LastSeen: '2026-11-14T10:06:00Z', TailscaleIPs: ['100.64.0.3'] },
  },
});
const configA: PoolConfig = { role: 'worker', primary: 'mac-primary', backup: 'mac-backup', owner: 'o', node: 'n' };
const configB: PoolConfig = { role: 'backup', primary: 'mac-gamma', backup: 'mac-backup', owner: 'o', node: 'n' };

// Mutable seams: the test advances phases by flipping these, never by
// rebuilding the handler — one retained ApiModule serves every request.
let execCalls = 0;
let configCalls = 0;
let execMode: 'ok-a' | 'throw' | 'ok-b' = 'ok-a';
let configMode: 'a' | 'throw' | 'b' = 'a';
let apiNow = new Date('2026-11-14T10:00:00.000Z');
let peersNow = new Date('2026-11-14T10:00:01.000Z');

const exec: TailnetPeersDeps['exec'] = (cmd, args) => {
  execCalls += 1;
  expect([cmd, ...args]).toEqual(['tailscale', 'status', '--json']);
  if (execMode === 'throw') throw new Error(SECRET_EXEC);
  return execMode === 'ok-a' ? statusA : statusB;
};
const tailnetDeps: TailnetPeersDeps = { now: () => peersNow, homeDir: () => HOME, exec };
const poolDeps: PoolReachDeps = {
  peers: tailnetDeps,
  readConfig: () => {
    configCalls += 1;
    if (configMode === 'throw') throw new Error(SECRET_CONFIG);
    return configMode === 'a' ? configA : configB;
  },
};
const identityDeps: RuntimeIdentityDeps = {
  hostname: () => 'studio', platform: () => 'darwin', now: () => apiNow, homeDir: () => HOME,
  statePath: () => `${HOME}/.ashlr/guardian/state.json`, statMtimeMs: () => apiNow.getTime() - 120_000,
  readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }), installedVersion: () => '1.2.2',
  exec: () => JSON.stringify({ Self: { HostName: 'studio-ts' } }),
};
// Real delegation: createFleetRuntimeIdentityApi routes sub-paths to the real
// createFleetHostReachApi module built on the fake seams above.
const handler: ApiModule = createFleetRuntimeIdentityApi({
  identityDeps,
  now: () => apiNow,
  hostReach: createFleetHostReachApi({ tailnetDeps, poolDeps, now: () => apiNow }),
});

async function get(path: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await handler({ cfg: {}, allowDispatch: true } as VerseApiContext, {} as IncomingMessage, res, path, 'GET');
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}
const leaks = (text: string) => /\b\d{1,3}(\.\d{1,3}){3}\b|100\.|\/Users\//.test(text) || text.includes('SECRET');
const peer = (body: any, name: string) => body.peers.find((p: any) => p.name === name);
const host = (body: any, slot: string) => body.reach.hosts.find((h: any) => h.slot === slot);

function setPhase(minute: number, exec: typeof execMode, config: typeof configMode) {
  apiNow = new Date(`2026-11-14T10:0${minute}:00.000Z`);
  peersNow = new Date(apiNow.getTime() + 1_000);
  execMode = exec;
  configMode = config;
}

describe('fleet host reach recovery through one retained handler', () => {
  it('re-reads tailscale and config evidence on every fresh GET', async () => {
    // T0: online host. generatedAt (API clock) and asOf (reader clock) are
    // distinct stamps; both must appear and advance independently.
    setPhase(0, 'ok-a', 'a');
    let before = { exec: execCalls, config: configCalls };
    let peers = await get(PEERS);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 0]);
    expect(peers.status).toBe(200);
    expect(peers.body.generatedAt).toBe('2026-11-14T10:00:00.000Z');
    expect(peers.body.asOf).toBe('2026-11-14T10:00:01.000Z');
    expect(peer(peers.body, 'mac-primary')).toMatchObject({ online: true });
    expect(leaks(peers.text)).toBe(false);

    before = { exec: execCalls, config: configCalls };
    let pool = await get(POOL);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 1]);
    expect(pool.body.reach.asOf).toBe('2026-11-14T10:00:01.000Z');
    expect(host(pool.body, 'primary')).toMatchObject({ matched: 'mac-primary', online: true });
    expect(host(pool.body, 'backup')).toMatchObject({ matched: 'mac-backup', online: false });
    expect(leaks(pool.text)).toBe(false);

    // T1: tailscale read throws. No retained online peer may survive: both
    // sub-paths must degrade to unknown, stamped at T1, with no thrown text.
    setPhase(1, 'throw', 'a');
    before = { exec: execCalls, config: configCalls };
    peers = await get(PEERS);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 0]);
    expect(peers.status).toBe(200);
    expect(peers.body.self).toBe('unknown');
    expect(peers.body.peers).toEqual([]);
    expect(peers.body.asOf).toBe('2026-11-14T10:01:01.000Z');
    expect(peers.body.generatedAt).toBe('2026-11-14T10:01:00.000Z');
    expect(leaks(peers.text)).toBe(false);

    before = { exec: execCalls, config: configCalls };
    pool = await get(POOL);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 1]);
    expect(pool.body.reach.self).toBe('unknown');
    expect(pool.body.reach.role).toBe('worker'); // config still readable
    for (const h of pool.body.reach.hosts) expect(h.online).toBe('unknown');
    expect(leaks(pool.text)).toBe(false);

    // T2: tailscale recovers with a changed host set. Values and observation
    // timestamps must advance; nothing from T0 may be served from cache.
    setPhase(2, 'ok-b', 'a');
    before = { exec: execCalls, config: configCalls };
    peers = await get(PEERS);
    expect(execCalls - before.exec).toBe(1);
    expect(peers.body.asOf).toBe('2026-11-14T10:02:01.000Z');
    expect(peer(peers.body, 'mac-primary')).toMatchObject({ online: false });
    expect(peer(peers.body, 'mac-gamma')).toMatchObject({ online: true });
    expect(leaks(peers.text)).toBe(false);

    before = { exec: execCalls, config: configCalls };
    pool = await get(POOL);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 1]);
    expect(pool.body.reach.asOf).toBe('2026-11-14T10:02:01.000Z');
    expect(host(pool.body, 'primary')).toMatchObject({ matched: 'mac-primary', online: false });
    expect(leaks(pool.text)).toBe(false);

    // T3: config read throws (tailscale still fine). Fixed sanitized reason,
    // no thrown path/IP/errno text; role and hosts degrade to unknown/empty.
    setPhase(3, 'ok-b', 'throw');
    before = { exec: execCalls, config: configCalls };
    pool = await get(POOL);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 1]);
    expect(pool.body.reach.role).toBe('unknown');
    expect(pool.body.reach.hosts).toEqual([]);
    expect(pool.body.reach.reasons).toContain('pool config: pool config unreadable');
    expect(leaks(pool.text)).toBe(false);

    // T4: config changes. The next GET must serve the NEW config, not the
    // cached role/aliases from T0-T2.
    setPhase(4, 'ok-b', 'b');
    before = { exec: execCalls, config: configCalls };
    pool = await get(POOL);
    expect([execCalls - before.exec, configCalls - before.config]).toEqual([1, 1]);
    expect(pool.body.reach.role).toBe('backup');
    expect(host(pool.body, 'primary')).toMatchObject({ alias: 'mac-gamma', matched: 'mac-gamma', online: true });
    expect(host(pool.body, 'backup')).toMatchObject({ alias: 'mac-backup', matched: 'mac-backup', online: false });
    expect(leaks(pool.text)).toBe(false);

    // Six reader-backed GETs => exactly six tailscale execs and five config
    // reads; a cached-fixture response could not satisfy these counts.
    expect(execCalls).toBe(8);
    expect(configCalls).toBe(5);
  });
});
