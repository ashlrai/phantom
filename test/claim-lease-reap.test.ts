import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reapExpiredClaims } from '../src/core/fleet/claim-lease-reap.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readReviewPick } from '../src/core/fleet/review-pick.js';
import { takeReview, type ReviewTakeOptions } from '../src/core/fleet/review-take.js';

const now = 10_000;
const row = (expiresAt: number, claimedAt = 1000) => ({ id: 'fake-claim', agent: 'old-agent', claimedAt, expiresAt });

describe('expired lease partition', () => {
  it('releases expired and boundary leases with their original owner without mutating input', () => {
    const records = [row(now - 1), row(now), row(now + 1)];
    const before = structuredClone(records);
    const result = reapExpiredClaims(records, now, 0);
    expect(result.keep).toEqual([records[2]]);
    expect(result.released).toEqual(records.slice(0, 2).map(record => ({
      ...record, owner: 'old-agent', state: 'RELEASED', reason: 'lease-expired',
    })));
    expect(records).toEqual(before);
    expect(reapExpiredClaims(result.keep, now, 0).released).toEqual([]);
  });

  it('honors grace and keeps a lease renewed exactly now', () => {
    const records = [row(now - 100), row(now - 99), row(now + 1000, now)];
    expect(reapExpiredClaims(records, now, 100)).toMatchObject({
      keep: records.slice(1), released: [{ expiresAt: now - 100, owner: 'old-agent' }],
    });
    expect(reapExpiredClaims([], now, 0)).toEqual({ keep: [], released: [] });
  });

  it.each([-1, Number.NaN, 0.5])('rejects invalid grace %s', grace => {
    expect(() => reapExpiredClaims([], now, grace)).toThrow();
  });
});

describe('pick and take expiry recovery on the real ledger', () => {
  it.each([
    { agent: 'new-agent', pickFirst: true }, { agent: 'old-agent', pickFirst: true },
    { agent: 'new-agent', pickFirst: false }, { agent: 'old-agent', pickFirst: false },
  ])('records one release for $agent (pick first: $pickFirst)', async ({ agent, pickFirst }) => {
    const root = mkdtempSync(join(tmpdir(), 'claim-lease-reap-'));
    const path = join(root, 'coordination.jsonl');
    const repo = 'example/phantom';
    const task = `review ${repo}#10 example/review @${'a'.repeat(12)}`;
    try {
      const old = claimFleetWork({ repo, task, agent: 'old-agent', ttlMs: 1000 }, { path, now: now - 1000 });
      if (!old.ok) throw new Error('fixture claim failed');
      const options: ReviewTakeOptions = {
        repo, agent, ledgerPath: path, now: () => now,
        gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
          number: 10, title: 'Fake review', headRefName: 'example/review', headRefOid: 'a'.repeat(40),
          isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
        }]) }),
        readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
        inspectBusWork: () => ({ source: 'available', claims: [] }),
        listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
      };
      const readBoard = () => readFleetBoard({ path, now });
      if (pickFirst) expect((await readReviewPick({ ...options, readBoard })).picked?.pr).toBe(10);
      const released = () => readFileSync(path, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>).filter(event => event['kind'] === 'reap');
      if (!pickFirst) expect(released()).toEqual([]);
      const taken = await takeReview(options);
      expect(released()).toEqual([{
        version: 1, kind: 'reap', at: now, id: old.value.claim.id,
        owner: 'old-agent', state: 'RELEASED', reason: 'lease-expired',
      }]);
      expect(taken).toMatchObject({ outcome: 'claimed', owner: agent });
      expect(taken.claim?.id).not.toBe(old.value.claim.id);
      expect(taken.lease).not.toBe(old.value.lease);
      expect(readBoard().claims).toEqual([expect.objectContaining({ id: taken.claim?.id, agent })]);
      expect(released()).toHaveLength(1);
      expect((await readReviewPick({ ...options, readBoard })).picked).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps a real lease renewed at now and does not append a release', () => {
    const root = mkdtempSync(join(tmpdir(), 'claim-lease-renew-'));
    const path = join(root, 'coordination.jsonl');
    try {
      const old = claimFleetWork({ repo: 'example/phantom', task: 'Review #10', agent: 'old-agent', ttlMs: 1000 }, { path, now: now - 500 });
      if (!old.ok) throw new Error('fixture claim failed');
      expect(handoffFleetClaim({ id: old.value.claim.id, agent: 'old-agent', lease: old.value.lease,
        to: 'old-agent', ttlMs: 1000 }, { path, now }).ok).toBe(true);
      const before = readFileSync(path, 'utf8');
      expect(readFleetBoard({ path, now }).claims).toEqual([expect.objectContaining({ agent: 'old-agent', claimedAt: now })]);
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
