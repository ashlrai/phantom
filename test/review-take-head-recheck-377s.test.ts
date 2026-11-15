import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { readFleetBoard, releaseFleetClaim, type FleetClaim } from '../src/core/fleet/coordination.js';
import { takeReview, type ReviewTakeOptions } from '../src/core/fleet/review-take.js';

const repo = 'example/phantom';
const now = Date.parse('2026-11-14T16:00:00Z');
const SHA = 'a'.repeat(40);
const SHA_MOVED = 'b'.repeat(40);
const task = `review ${repo}#10 example/review @${SHA.slice(0, 12)}`;

const prRow = (overrides: Record<string, unknown> = {}) => ({
  number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: SHA,
  isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z', ...overrides,
});
const listed = (...rows: object[]) => ({ ok: true, stderr: '', stdout: JSON.stringify(rows) });

let directory: string;
let path: string;
let ghQueue: Array<{ ok: boolean; stdout: string; stderr: string }>;
let ghCalls: string[][];
const gh: CloudGh = async (args) => {
  ghCalls.push([...args]);
  const next = ghQueue.shift();
  if (next === undefined) throw new Error('unexpected gh call');
  return next;
};
function options(): ReviewTakeOptions {
  return {
    repo, agent: 'agent-one', ledgerPath: path, now: () => now, gh,
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
}
const board = () => readFleetBoard({ path, now });
const foreign = (overrides: Partial<FleetClaim> = {}): FleetClaim => ({
  id: 'foreign-claim', repo, task: 'Review #10 with a different task', agent: 'agent-two',
  claimedAt: now, expiresAt: now + 1000, ...overrides,
});
function expectOpenPrRead(args: string[]) {
  expect(args.slice(0, 2)).toEqual(['pr', 'list']);
  expect(args[args.indexOf('--repo') + 1]).toBe(repo);
  expect(args[args.indexOf('--state') + 1]).toBe('open');
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-take-head-377s-'));
  path = join(directory, 'coordination.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  ghQueue = [];
  ghCalls = [];
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('post-acquisition head recheck on the real coordination ledger', () => {
  it('claims when the re-read still lists the same open non-draft PR at the same head', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ number: 11, headRefName: 'other/head' }), prRow())];
    const result = await takeReview(options());
    expect(result).toMatchObject({
      schema: 'fleet.review-take.v1', outcome: 'claimed', repo, pr: 10,
      head: 'example/review', head_sha: SHA, owner: 'agent-one',
      claim: { task }, lease: expect.any(String), reason: 'review claimed',
    });
    expect(board().claims).toEqual([expect.objectContaining({ id: result.claim!.id, task, agent: 'agent-one' })]);
    expect(ghCalls).toHaveLength(2);
    for (const args of ghCalls) expectOpenPrRead(args);
  });

  it('refuses and releases the acquired claim when the head moved', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ headRefOid: SHA_MOVED }))];
    const release = vi.fn(releaseFleetClaim);
    const result = await takeReview({ ...options(), release });
    expect(result).toMatchObject({ outcome: 'none', owner: null, claim: null, lease: null });
    expect(result.reason).toBe('picked PR head moved during claim');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(
      { id: expect.any(String), agent: 'agent-one', lease: expect.any(String) }, { path, now });
    expect(board().claims).toHaveLength(0);
  });

  it('refuses and releases when the picked PR left the open list (closed or merged)', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ number: 11, headRefName: 'other/head', headRefOid: SHA_MOVED }))];
    const result = await takeReview(options());
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(result.reason).toBe('picked PR is no longer listed open');
    expect(board().claims).toHaveLength(0);
  });

  it('refuses and releases when the picked PR became a draft', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ isDraft: true }))];
    const result = await takeReview(options());
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(result.reason).toBe('picked PR became a draft during claim');
    expect(board().claims).toHaveLength(0);
  });

  it.each([
    { name: 'gh failure', recheck: { ok: false, stdout: '', stderr: 'boom' } },
    { name: 'non-JSON', recheck: { ok: true, stdout: 'not json', stderr: '' } },
    { name: 'non-array', recheck: { ok: true, stdout: '{}', stderr: '' } },
    { name: 'malformed row', recheck: listed({ number: 'ten' }) },
  ])('refuses and releases when the re-read is unreadable or proofless: $name', async ({ recheck }) => {
    ghQueue = [listed(prRow()), recheck];
    const result = await takeReview(options());
    expect(result).not.toMatchObject({ outcome: 'claimed' });
    expect(result).toMatchObject({ claim: null, lease: null });
    expect(board().claims).toHaveLength(0);
  });

  it('reports unavailable when the re-read fails outright', async () => {
    ghQueue = [listed(prRow()), { ok: false, stdout: '', stderr: 'boom' }];
    const result = await takeReview(options());
    expect(result).toMatchObject({ outcome: 'unavailable', claim: null, lease: null, reason: 'picked PR recheck unavailable' });
  });

  it('keeps the caller recovery receipt and lease when stale-head cleanup fails', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ headRefOid: SHA_MOVED }))];
    const result = await takeReview({ ...options(), release: () => ({ ok: false, error: 'unavailable' }) });
    expect(result).toMatchObject({
      outcome: 'unavailable', reason: 'claim release unavailable', owner: 'agent-one',
      claim: { task }, lease: expect.any(String),
    });
    expect(board().claims[0]!.id).toBe(result.claim!.id);
    expect(releaseFleetClaim({ id: result.claim!.id, agent: 'agent-one', lease: result.lease! }, { path, now }).ok).toBe(true);
  });

  it('keeps the recovery receipt when re-read failure cleanup fails', async () => {
    ghQueue = [listed(prRow()), { ok: false, stdout: '', stderr: 'boom' }];
    const result = await takeReview({ ...options(), release: () => ({ ok: false, error: 'unavailable' }) });
    expect(result).toMatchObject({
      outcome: 'unavailable', reason: 'claim release unavailable',
      claim: { task }, lease: expect.any(String),
    });
    expect(board().claims[0]!.id).toBe(result.claim!.id);
  });

  it('releases only our own lease on a foreign conflict and never reaches the re-read', async () => {
    ghQueue = [listed(prRow()), listed(prRow({ headRefOid: SHA_MOVED }))];
    const release = vi.fn(releaseFleetClaim);
    const readBoardAfter = vi.fn(() => ({ ...board(), claims: [...board().claims, foreign()] }));
    const result = await takeReview({ ...options(), release, readBoardAfter });
    expect(result).toMatchObject({ outcome: 'conflict', owner: 'agent-two', claim: null, lease: null });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toMatchObject({ agent: 'agent-one' });
    expect(release.mock.calls[0]![0].id).not.toBe('foreign-claim');
    expect(ghCalls).toHaveLength(1);
    expect(board().claims).toHaveLength(0);
  });
});
