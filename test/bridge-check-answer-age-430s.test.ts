/** RQ-PHX-BRIDGEANSWERAGE430S — the bridge-check verdict qualifies freshness
 * and live claims at the answer's completion instant, not the clock sampled
 * before the readers ran. A deferred peer reader holds the call open while the
 * fake clock advances: runtime evidence crossing STALE_AFTER_SECONDS during
 * the wait is BLOCKED, a claim expiring during the wait is not counted live,
 * and the top-level asOf names the completion observation while every
 * producer asOf/source/mtime stays intact. All readers and the clock are
 * fake; deferred promises replace real waits. */
import { describe, expect, it } from 'vitest';
import { STALE_AFTER_SECONDS } from '../src/core/fleet/runtime-identity.js';
import { readFleetBridgeCheck, type FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

const T0 = Date.parse('2026-11-15T00:00:00.000Z');
const T0_ISO = '2026-11-15T00:00:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Producer-shaped runtime snapshot: state mtime 890s before T0, so the
 * producer's floored ageSeconds is 890 — fresh at entry, stale after a 15s
 * wait. */
const RUNTIME_MTIME = {
  lastFleetStateRead: { mtime: iso(T0 - 890_000), ageSeconds: 890 },
  asOf: T0_ISO,
};
/** Same age evidence without a parseable mtime: freshness advances by the
 * elapsed-read bound from the producer asOf instead. */
const RUNTIME_AGE_ONLY = {
  lastFleetStateRead: { ageSeconds: 890 },
  asOf: T0_ISO,
};

const FRESH_RUNTIME = {
  lastFleetStateRead: { mtime: iso(T0 - 30_000), ageSeconds: 30 },
  asOf: T0_ISO,
};

const PEERS = { v: 1, authority: 'none', status: 'ok', asOf: T0_ISO, liveRows: 0 };

function claimRow(id: string, claimedAtMs: number, expiresAtMs: number): Record<string, unknown> {
  return {
    id, repo: 'fake/repo', task: `fake task ${id}`, agent: 'fake-agent',
    claimedAt: iso(claimedAtMs), expiresAt: iso(expiresAtMs),
    expiresInSeconds: Math.max(0, Math.round((expiresAtMs - T0) / 1000)),
  };
}

function claimsProjection(claims: unknown[]): Record<string, unknown> {
  return { v: 1, source: 'coordination-ledger', asOf: T0_ISO, state: 'known', claims, expiredClaims: 0 };
}

const CLAIMS = claimsProjection([
  claimRow('claim-live', T0 - 60_000, T0 + 3_600_000),
]);

interface HeldRead {
  deps: FleetBridgeCheckDeps;
  peers: ReturnType<typeof deferred<unknown>>;
  setNow: (ms: number) => void;
}

/** Start a check whose peer reader stays pending until released, with a
 * settable verdict clock. entryMs is sampled at call time; doneMs is sampled
 * after the deferred peer read resolves. */
function heldCheck(over: Partial<FleetBridgeCheckDeps> = {}): HeldRead {
  let now = T0;
  const peers = deferred<unknown>();
  const deps: FleetBridgeCheckDeps = {
    runtime: async () => structuredClone(RUNTIME_MTIME),
    claims: () => structuredClone(CLAIMS),
    peers: () => peers.promise,
    now: () => now,
    ...over,
  };
  return { deps, peers, setNow: ms => { now = ms; } };
}

describe('fleet_bridge_check answer-time freshness', () => {
  it('keeps fresh evidence READY while a peer reader waits, with asOf at completion', async () => {
    const held = heldCheck();
    const pending = readFleetBridgeCheck(held.deps);
    held.setNow(T0 + 5_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    expect(check.verdict).toBe('READY');
    expect(check.missing).toEqual([]);
    // The answer instant is the completion clock; producer timestamps survive.
    expect(check.asOf).toBe(iso(T0 + 5_000));
    expect(check.runtime).toMatchObject({ status: 'ok', source: 'fleet-runtime', asOf: T0_ISO,
      lastFleetStateRead: { mtime: iso(T0 - 890_000), ageSeconds: 895 } });
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 1,
      newestAgeSec: 65, source: 'coordination-ledger', asOf: T0_ISO });
    expect(check.peers).toMatchObject({ status: 'ok', source: 'peer-ledger', asOf: T0_ISO });
  });

  it('BLOCKS runtime evidence that crosses the staleness bound during the wait (mtime path)', async () => {
    const held = heldCheck();
    const pending = readFleetBridgeCheck(held.deps);
    held.setNow(T0 + STALE_AFTER_SECONDS * 1000 - 890_000 + 1_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    // done - mtime = 901s > STALE_AFTER_SECONDS even though the producer's
    // own ageSeconds (890) was fresh at entry.
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toEqual(['runtime.fleet-state-stale']);
    expect(check.asOf).toBe(iso(T0 + STALE_AFTER_SECONDS * 1000 - 890_000 + 1_000));
    expect(check.runtime).toMatchObject({ status: 'ok', reason: 'fleet-state-stale', asOf: T0_ISO,
      lastFleetStateRead: { mtime: iso(T0 - 890_000), ageSeconds: STALE_AFTER_SECONDS + 1 } });
    // The other sections still report their own evidence.
    expect(check.claims).toMatchObject({ status: 'ok', live: 1 });
    expect(check.peers).toMatchObject({ status: 'ok' });
  });

  it('BLOCKS runtime evidence that crosses the staleness bound during the wait (age-only path)', async () => {
    const held = heldCheck({ runtime: async () => structuredClone(RUNTIME_AGE_ONLY) });
    const pending = readFleetBridgeCheck(held.deps);
    held.setNow(T0 + 15_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    // Without a parseable mtime the floored age advances by the elapsed-read
    // bound from the producer asOf: 890 + 15 = 905 > 900.
    expect(check.verdict).toBe('BLOCKED');
    expect(check.missing).toEqual(['runtime.fleet-state-stale']);
    expect(check.runtime).toMatchObject({ reason: 'fleet-state-stale',
      lastFleetStateRead: { ageSeconds: 905 } });
  });

  it('does not count a claim that expires during the wait as live', async () => {
    const held = heldCheck({
      runtime: async () => structuredClone(FRESH_RUNTIME),
      claims: () => structuredClone(claimsProjection([
        claimRow('claim-expiring', T0 - 60_000, T0 + 10_000),
        claimRow('claim-lasting', T0 - 30_000, T0 + 60_000),
      ])),
    });
    const pending = readFleetBridgeCheck(held.deps);
    held.setNow(T0 + 12_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    expect(check.verdict).toBe('READY');
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 1,
      newestAgeSec: 42, asOf: T0_ISO });
  });

  it('reports an empty live count, not unreadable claims, when every claim expires during the wait', async () => {
    const held = heldCheck({
      runtime: async () => structuredClone(FRESH_RUNTIME),
      claims: () => structuredClone(claimsProjection([
        // expiresAt exactly at the completion instant is expired, matching
        // the ledger's own expiresAt > now liveness rule.
        claimRow('claim-boundary', T0 - 60_000, T0 + 12_000),
      ])),
    });
    const pending = readFleetBridgeCheck(held.deps);
    held.setNow(T0 + 12_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    expect(check.verdict).toBe('READY');
    expect(check.claims).toMatchObject({ status: 'ok', state: 'known', live: 0, newestAgeSec: null });
  });

  it('never rewinds evidence when the verdict clock steps backward during the wait', async () => {
    const held = heldCheck();
    const pending = readFleetBridgeCheck(held.deps);
    // The clock at entry was T0; it reads 30s earlier at completion. The
    // runtime age must not shrink below what the producer reported at T0.
    held.setNow(T0 - 30_000);
    held.peers.resolve(structuredClone(PEERS));
    const check = await pending;

    expect(check.asOf).toBe(iso(T0 - 30_000));
    expect(check.runtime).toMatchObject({ status: 'ok',
      lastFleetStateRead: { mtime: iso(T0 - 890_000), ageSeconds: 890 } });
    expect(check.claims).toMatchObject({ status: 'ok', live: 1 });
  });

  it('rejects on a broken completion clock so callers fail closed, never promoting', async () => {
    let calls = 0;
    const held = heldCheck({
      // Entry sample is T0; the completion sample is NaN — the same fail-closed
      // contract the CLI's missing:bridge-check path has always relied on.
      now: () => (calls++ === 0 ? T0 : Number.NaN),
      peers: () => structuredClone(PEERS),
      runtime: async () => ({ lastFleetStateRead: { mtime: iso(T0 - 3_600_000_000), ageSeconds: 3_600_000 }, asOf: T0_ISO }),
    });
    await expect(readFleetBridgeCheck(held.deps)).rejects.toThrow(RangeError);
  });
});
