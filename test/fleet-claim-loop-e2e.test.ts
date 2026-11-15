import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import { readReviewPick } from '../src/core/fleet/review-pick.js';
import { takeReview, type ReviewTakeOptions } from '../src/core/fleet/review-take.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('completes one cloud-independent pick, durable claim, owner refusal and idempotent verified return', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fleet-claim-loop-e2e-'));
  directories.push(directory);
  const path = join(directory, 'coordination.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  let now = Date.parse('2026-11-14T16:00:00Z');
  const repo = 'example/phantom';
  // Same gh page shape as the merged review-pick / review-take fixtures.
  const candidate = {
    number: 900378, title: 'bridge: RQ-FAKE-378', headRefName: 'codex-bridge/RQ-FAKE-378',
    headRefOid: 'a'.repeat(40), isDraft: false, mergeStateStatus: 'CLEAN',
    updatedAt: '2026-11-14T09:00:00Z',
  };
  const board = () => readFleetBoard({ path, now });
  const options: ReviewTakeOptions = {
    repo, agent: 'agent-a', ledgerPath: path, now: () => now, ttlSeconds: 60,
    // Only external observations are fixtures; picking, fencing, disk writes and returns are real.
    gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([candidate]) }),
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    listWorkers: async () => ({ v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy',
      workers: [], leaders: [], orchestratorAgents: 0 }),
  };

  // RECEIVED: offer exactly the seeded, unowned task.
  const offered = await readReviewPick({ ...options, readBoard: board });
  expect(offered).toMatchObject({ source: { prs: 'read', unavailable: [] },
    picked: { repo, pr: candidate.number, head: candidate.headRefName, head_sha: candidate.headRefOid, owner: 'none' } });
  expect(readFileSync(path, 'utf8')).toBe('');

  // ASSIGNED / RUNNING: a real take survives a fresh read with a lease fence on disk.
  const taken = await takeReview(options);
  expect(taken).toMatchObject({ outcome: 'claimed', owner: 'agent-a', repo,
    pr: candidate.number, head: candidate.headRefName, head_sha: candidate.headRefOid,
    claim: { expiresAt: now + 60_000 }, lease: expect.any(String) });
  if (!taken.claim || !taken.lease) throw new Error('take did not return a claim and lease');
  const claimedAt = now;
  const claimedDisk = readFileSync(path, 'utf8');
  expect(JSON.parse(claimedDisk)).toMatchObject({ kind: 'claim', claim: {
    id: taken.claim.id, repo, agent: 'agent-a', claimedAt, expiresAt: claimedAt + 60_000,
    task: `review ${repo}#${candidate.number} ${candidate.headRefName} @${candidate.headRefOid.slice(0, 12)}`,
    leaseHash: createHash('sha256').update(taken.lease).digest('hex'),
  } });
  expect(claimedDisk).not.toContain(taken.lease);
  now += 1000;
  expect(board()).toMatchObject({ state: 'known', claims: [{ id: taken.claim.id, agent: 'agent-a',
    task: taken.claim.task, expiresAt: claimedAt + 60_000 }] });

  // BLOCKED: the other agent receives no offer or lease, and learns the current owner.
  const secondOptions = { ...options, agent: 'agent-b' };
  const secondPick = await readReviewPick({ ...secondOptions, readBoard: board });
  expect(secondPick.picked).toBeNull();
  expect(secondPick.skipped).toEqual([expect.objectContaining({ pr: candidate.number, owner: 'agent-a' })]);
  expect(await takeReview(secondOptions)).toMatchObject({ outcome: 'none', owner: 'agent-a', claim: null, lease: null });
  expect(readFileSync(path, 'utf8')).toBe(claimedDisk);

  // VERIFIED is the agent's recorded evidence, not independent validation of a live PR.
  now += 1000;
  const tests = `PR #${candidate.number} head ${candidate.headRefOid}; fake focused test: 1 passed`;
  const input = { id: taken.claim.id, agent: 'agent-a', lease: taken.lease, tests };
  const returned = returnFleetClaim(input, { path, now });
  expect(returned).toMatchObject({ ok: true, outcome: 'returned', claimId: taken.claim.id });
  const returns = projectCoordinationReturns(board(), now);
  expect(returns).toMatchObject({ state: 'known', asOf: new Date(now).toISOString(), unparsed: 0 });
  expect(returns.returns).toEqual([expect.objectContaining({ claimId: taken.claim.id, repo,
    result: 'VERIFIED', from: 'agent-a', at: new Date(now).toISOString(), evidenceKind: 'tests', evidence: `tests ${tests}` })]);
  expect(board().claims).toEqual([]);
  const returnedDisk = readFileSync(path, 'utf8');
  expect(returnedDisk.trim().split('\n').map(line => JSON.parse(line).kind)).toEqual(['claim', 'release', 'post']);

  now += 1000;
  expect(returnFleetClaim(input, { path, now })).toEqual({ ok: true, outcome: 'already-returned',
    claimId: taken.claim.id, message: returned.message });
  expect(readFileSync(path, 'utf8')).toBe(returnedDisk);
  expect(board().messages).toEqual([returned.message]);
  expect(projectCoordinationReturns(board(), now).returns).toEqual(returns.returns);
});
