/** Disk qualification only: receipt-backed fake leases confer no dispatch/completion authority. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetClaimDrift } from '../src/cli/fleet-claim-drift.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import type { ClaimStoreDrift } from '../src/core/fleet/claim-store-drift.js';

const NOW = Date.parse('2026-11-13T18:13:00.000Z'), LEASE = NOW + 60_000;
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Include every directory (including empty lock directories) and hash every file's bytes.
function snapshot(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => [entry.name, entry.isDirectory() ? snapshot(join(root, entry.name))
      : createHash('sha256').update(readFileSync(join(root, entry.name))).digest('hex')]);
}

it.each(['bus', 'coordination'] as const)('recovers from a malformed %s table on the same root', async source => {
  const root = mkdtempSync(join(tmpdir(), 'claim-drift-537s-'));
  roots.push(root);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const id = 'fake-disk-return-537s', owner = 'fake-agent-alpha';
  const receipt = appendBusInbox({ id, from: 'fake-leader', to: 'fake-worker', priority: 'P1',
    ttl: 600_000, body: { kind: 'work', text: 'fake qualification' } }, { root, now: () => NOW });
  expect(receipt.status).toBe('posted');
  if (receipt.status !== 'posted') throw new Error('Fake receipt setup failed');
  const claim = mutateBusWorkClaim({ root, action: 'acquire', id, owner, leaseMs: LEASE - NOW });
  expect(claim.status).toBe('acquired');
  expect(claim.leaseUntil).toBe(LEASE);
  const out: string[] = [], err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args) => { err.push(args.join(' ')); });

  async function probe(now: number, state: ClaimStoreDrift['state'], code: number, matched: number) {
    const before = snapshot(root);
    out.length = 0;
    expect(await cmdFleetClaimDrift(['--json'], { root, now })).toBe(code);
    const json = out.join('\n');
    const report = JSON.parse(json) as ClaimStoreDrift;
    expect(report).toMatchObject({ schema: 'fleet.claim-drift.v1', asOf: new Date(now).toISOString(),
      state, matched, busOnly: [], coordOnly: [], missing: state === 'UNKNOWN' ? [source] : [] });
    expect(report.bus).toBe(state === 'UNKNOWN' && source === 'bus' ? 'unavailable' : 'available');
    expect(report.coordination).toBe(state === 'UNKNOWN' && source === 'coordination' ? 'unavailable' : 'available');
    expect(report.ownerMismatch).toHaveLength(state === 'DRIFT' ? 1 : 0);
    expect(snapshot(root)).toEqual(before);
    out.length = 0;
    expect(await cmdFleetClaimDrift([], { root, now })).toBe(code);
    const row = `owner-mismatch id=${id} cursor=${receipt.cursor} received-at=${new Date(NOW).toISOString()}`
      + ` lease-until=${new Date(LEASE).toISOString()} bus-owner=${owner} coord-owner=fake-agent-beta`;
    expect(out).toEqual([...(state === 'DRIFT' ? [row] : []),
      `state: ${report.state}${report.missing.length ? ` missing=${report.missing.join(',')}` : ''}`]);
    expect(`${json}\n${out.join('\n')}`).not.toMatch(/[a-f0-9]{64}|"token"/);
    expect(err).toEqual([]);
    expect(snapshot(root)).toEqual(before);
    return report;
  }

  await probe(NOW, 'VERIFIED', 0, 1);
  const file = join(root, source === 'bus' ? 'bus-work-claims' : 'coordination', 'claims.json');
  const healthy = readFileSync(file);
  writeFileSync(file, '{broken');
  await probe(NOW, 'UNKNOWN', 2, 0);
  writeFileSync(file, healthy);
  await probe(NOW, 'VERIFIED', 0, 1);
  // A divergent on-disk owner is the drift a crashed dual-write leaves behind.
  // The supported writer now refuses to mint it — a different owner presenting
  // the same live sourceId conflicts — so the fixture edits the stored row.
  const coordFile = join(root, 'coordination', 'claims.json');
  const store = JSON.parse(readFileSync(coordFile, 'utf8')) as { claims: { owner: string; sourceId: string }[] };
  expect(store.claims).toHaveLength(1);
  expect(store.claims[0]!.sourceId).toBe(`${id}:${receipt.cursor}:${NOW}`);
  expect(store.claims[0]!.owner).toBe(owner);
  store.claims[0]!.owner = 'fake-agent-beta';
  writeFileSync(coordFile, JSON.stringify(store));
  const drift = await probe(NOW, 'DRIFT', 1, 0);
  expect(drift.ownerMismatch[0]).toEqual({ id, cursor: receipt.cursor,
    receivedAt: new Date(NOW).toISOString(), leaseUntil: new Date(LEASE).toISOString(),
    owner, busOwner: owner, coordOwner: 'fake-agent-beta' });
  await probe(LEASE - 1, 'DRIFT', 1, 0);
  await probe(LEASE, 'VERIFIED', 0, 0);
});
