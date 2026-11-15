import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

it('keeps honest host and claim evidence through resolver failures, then recovers without caching UNKNOWN', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'runtime-path-385s-'));
  try {
    const home = join(temporary, 'home');
    const root = join(home, 'state');
    const ledger = join(temporary, 'coordination.jsonl');
    mkdirSync(root, { recursive: true });
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, '{}');
    // A newer decoy outside the state root proves the failure path scans nothing unintended.
    const decoy = join(home, 'decoy.json');
    writeFileSync(decoy, '{}');

    let now = Date.parse('2026-11-14T20:00:00.000Z');
    const stateTime = Math.floor((now - 30_000) / 1000);
    const decoyTime = Math.floor((now - 5_000) / 1000);
    utimesSync(stateFile, stateTime, stateTime);
    utimesSync(decoy, decoyTime, decoyTime);

    const claimed = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' },
      { path: ledger, now });
    if (!claimed.ok) throw new Error('fixture claim failed');
    const settled = readFileSync(ledger, 'utf8');

    const privateState = 'private stateRoot resolver detail';
    const privateHome = 'private home resolver detail';
    let stateRootFails = true;
    let homeFails = false;
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => {
        if (homeFails) throw new Error(privateHome);
        return home;
      },
      stateRoot: () => {
        if (stateRootFails) throw new Error(privateState);
        return root;
      },
      host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
      pid: () => 123, uptime: () => 10, installedVersion: () => '1.2.3',
      sourceVersion: () => '1.2.4', tailnet: () => 'fake-tailnet',
      board: input => readFleetBoard({ ...input, path: ledger }),
    };
    const snapshot = async () => {
      const result = await readRuntimeSnapshot(deps);
      const output = JSON.stringify(result);
      for (const privateText of [privateState, privateHome, claimed.value.lease, 'leaseHash',
        temporary, root, home, decoy]) {
        expect(output).not.toContain(privateText);
      }
      expect(readFileSync(ledger, 'utf8')).toBe(settled);
      return result;
    };

    // A throwing stateRoot resolver degrades only the path and freshness fields;
    // the live claim count and host identity still read through.
    const rootDown = await snapshot();
    expect(rootDown.asOf).toBe(new Date(now).toISOString());
    expect(rootDown.stateRoot).toBe('UNKNOWN');
    expect(rootDown.lastFleetStateRead).toEqual({ mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' });
    expect(rootDown.reasons).toEqual(['stateRoot: path resolution failed',
      'lastFleetStateRead: state root unresolved']);
    expect(rootDown.coordination).toEqual({ state: 'known', activeClaims: 1,
      newestReturnAgeSeconds: 'UNKNOWN', reason: 'no readable retained return at or before asOf' });
    expect(rootDown.host).toBe('fake-host');
    expect(rootDown.tailnetName).toBe('fake-tailnet');

    // With the state root resolved again, a throwing home resolver withholds only
    // the home-relative label; the real state scan still reports fresh evidence.
    stateRootFails = false;
    homeFails = true;
    now += 15_000;
    const homeDown = await snapshot();
    expect(homeDown.asOf).toBe(new Date(now).toISOString());
    expect(homeDown.stateRoot).toBe('UNKNOWN');
    expect(homeDown.lastFleetStateRead).toEqual({ mtime: new Date(stateTime * 1000).toISOString(),
      ageSeconds: Math.floor((now - stateTime * 1000) / 1000) });
    expect(homeDown.reasons).toEqual(['home: path resolution failed']);
    expect(homeDown.coordination).toEqual({ state: 'known', activeClaims: 1,
      newestReturnAgeSeconds: 'UNKNOWN', reason: 'no readable retained return at or before asOf' });

    // Both resolvers recovered: real path metadata returns with a fresh asOf —
    // nothing caches the earlier UNKNOWN.
    homeFails = false;
    now += 45_000;
    const recovered = await snapshot();
    expect(recovered.asOf).toBe(new Date(now).toISOString());
    expect(recovered.stateRoot).toBe('~/state');
    expect(recovered.lastFleetStateRead).toEqual({ mtime: new Date(stateTime * 1000).toISOString(),
      ageSeconds: Math.floor((now - stateTime * 1000) / 1000) });
    expect(recovered.reasons).toEqual([]);
    expect(recovered.coordination).toEqual({ state: 'known', activeClaims: 1,
      newestReturnAgeSeconds: 'UNKNOWN', reason: 'no readable retained return at or before asOf' });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
