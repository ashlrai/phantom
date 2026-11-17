import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

it('reconnects through clock skew, recovery and receipt expiry without exposing private evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-clock-383s-'));
  try {
    const root = join(home, 'state');
    const ledger = join(home, 'coordination.jsonl');
    mkdirSync(root);
    const file = join(root, 'state.json');
    writeFileSync(file, '{}');
    const initial = Date.parse('2026-11-13T14:00:00.000Z');
    const future = initial + 60_000;
    utimesSync(file, future / 1000, future / 1000);
    const options = { path: ledger, now: future };
    const claimed = claimFleetWork({ repo: 'example/repo', task: 'fake task', agent: 'fake-agent' }, options);
    if (!claimed.ok) throw new Error('fixture claim failed');
    expect(returnFleetClaim({ id: claimed.value.claim.id, agent: 'fake-agent', lease: claimed.value.lease,
      tests: 'fake tests passed', ttlMs: 120_000 }, options)).toMatchObject({ ok: true, outcome: 'returned' });
    const settled = readFileSync(ledger, 'utf8');
    let now = initial;
    const privateError = 'private exception detail';
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => root,
      host: () => { throw new Error(privateError); }, platform: () => 'fakeos', arch: () => 'fakearch',
      pid: () => 123, uptime: () => 10, installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3',
      tailnet: () => 'fake-tailnet', board: input => readFleetBoard({ ...input, path: ledger }),
    };
    const snapshot = async () => {
      const result = await readRuntimeSnapshot(deps);
      const output = JSON.stringify(result);
      expect(output).not.toContain(privateError);
      expect(output).not.toContain(claimed.value.lease);
      expect(output).not.toContain('leaseHash');
      expect(output).not.toContain('VERIFIED');
      expect(readFileSync(ledger, 'utf8')).toBe(settled);
      return result;
    };

    const skewed = await snapshot();
    expect(skewed.asOf).toBe(new Date(initial).toISOString());
    expect(skewed.lastFleetStateRead).toEqual({ mtime: new Date(future).toISOString(), ageSeconds: 'UNKNOWN' });
    expect(skewed.reasons).toContain('lastFleetStateRead: future mtime; clock skew');
    expect(skewed.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'no readable retained return at or before asOf' });

    now = future + 30_000;
    const recovered = await snapshot();
    expect(recovered.asOf).toBe(new Date(now).toISOString());
    expect(recovered.lastFleetStateRead).toEqual({ mtime: new Date(future).toISOString(), ageSeconds: 30 });
    expect(recovered.reasons).not.toContain('lastFleetStateRead: future mtime; clock skew');
    expect(recovered.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 30 });

    now = future + 120_000;
    const expired = await snapshot();
    expect(expired.asOf).toBe(new Date(now).toISOString());
    expect(expired.lastFleetStateRead).toEqual({ mtime: new Date(future).toISOString(), ageSeconds: 120 });
    expect(expired.coordination).toEqual({ state: 'known', activeClaims: 0, newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'no readable retained return at or before asOf' });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
