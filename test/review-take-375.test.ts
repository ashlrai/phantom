import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard, releaseFleetClaim, type FleetClaim } from '../src/core/fleet/coordination.js';
import { readReviewPick } from '../src/core/fleet/review-pick.js';
import { takeReview, type ReviewTakeOptions } from '../src/core/fleet/review-take.js';

const repo = 'example/phantom';
const now = Date.parse('2026-11-14T16:00:00Z');
const task = `review ${repo}#10 example/review @${'a'.repeat(12)}`;
let directory: string;
let path: string;
function options(): ReviewTakeOptions {
  return {
    repo, agent: 'agent-one', ledgerPath: path, now: () => now,
    gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
      number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: 'a'.repeat(40),
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
    }]) }),
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
}
function board() { return readFleetBoard({ path, now }); }
function foreign(overrides: Partial<FleetClaim> = {}): FleetClaim {
  return { id: 'foreign-claim', repo, task: 'Review #10 with a different task', agent: 'agent-two', claimedAt: now, expiresAt: now + 1000, ...overrides };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'review-take-375-'));
  path = join(directory, 'coordination.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('advisory review take on the real coordination ledger', () => {
  it('claims the picked PR and returns a durable receipt without persisting the lease', async () => {
    const result = await takeReview({ ...options(), ttlSeconds: 60 });
    expect(result).toMatchObject({
      schema: 'fleet.review-take.v1', outcome: 'claimed', as_of: new Date(now).toISOString(),
      repo, pr: 10, head: 'example/review', head_sha: 'a'.repeat(40), title: 'Example review',
      owner: 'agent-one', claim: { task, expiresAt: now + 60000 }, lease: expect.any(String),
    });
    expect(result.pick_reason).toContain('no live claim');
    expect(board().claims).toEqual([expect.objectContaining({ id: result.claim!.id, task, agent: 'agent-one' })]);
    expect(readFileSync(path, 'utf8')).not.toContain(result.lease!);
    expect(releaseFleetClaim({ id: result.claim!.id, agent: 'agent-one', lease: result.lease! }, { path, now }).ok).toBe(true);
  });

  it('makes review-pick skip the owned PR and a second take return none', async () => {
    await takeReview(options());
    const pick = await readReviewPick({ ...options(), readBoard: board });
    expect(pick.picked).toBeNull();
    expect(pick.skipped).toEqual([expect.objectContaining({ pr: 10, owner: 'agent-one' })]);
    const result = await takeReview({ ...options(), agent: 'agent-two' });
    expect(result).toMatchObject({ outcome: 'none', claim: null, lease: null });
    expect(board().claims).toHaveLength(1);
  });

  it('fences two simultaneous takes forced to pick the same PR', async () => {
    const empty = board();
    const readBoard = () => empty;
    const results = await Promise.all([
      takeReview({ ...options(), readBoard }),
      takeReview({ ...options(), readBoard, agent: 'agent-two' }),
    ]);
    expect(results.map(row => row.outcome)).toEqual(['claimed', 'duplicate']);
    expect(board().claims).toEqual([expect.objectContaining({ task, agent: 'agent-one' })]);
    expect(results[1]!.lease).toBeNull();
  });

  it('releases our claim with its lease when a foreign holder appears after claiming', async () => {
    let ourId: string | undefined;
    const release = vi.fn(releaseFleetClaim);
    const readBoardAfter = vi.fn(() => {
      const current = board();
      ourId = current.claims[0]!.id;
      return { ...current, claims: [...current.claims, foreign()] };
    });
    const result = await takeReview({ ...options(), readBoardAfter, release });
    expect(result).toMatchObject({ outcome: 'conflict', owner: 'agent-two', claim: null, lease: null });
    expect(readBoardAfter).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ id: ourId, agent: 'agent-one', lease: expect.any(String) }, { path, now });
    expect(board().claims.some(row => row.id === ourId)).toBe(false);
  });

  it('refuses unavailable ownership without creating a ledger file', async () => {
    rmSync(path);
    const claim = vi.fn(claimFleetWork);
    const result = await takeReview({ ...options(), claim, readBoard: () => { throw new Error('fake unavailable'); } });
    expect(result.outcome).toBe('unavailable');
    expect(claim).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it('returns unavailable for a failed PR read and none for a clean empty source', async () => {
    expect((await takeReview({ ...options(), gh: async () => ({ ok: false, stdout: '', stderr: '' }) })).outcome).toBe('unavailable');
    expect((await takeReview({ ...options(), gh: async () => ({ ok: true, stdout: '[]', stderr: '' }) })).outcome).toBe('none');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it.each([
    { task: 'Review #100' }, { repo: 'example/other' }, { expiresAt: now },
  ])('ignores foreign claims that do not own this PR: %j', async override => {
    const result = await takeReview({ ...options(), readBoardAfter: () => ({ ...board(), claims: [...board().claims, foreign(override)] }) });
    expect(result.outcome).toBe('claimed');
  });

  it('matches the repository case-insensitively in the race check', async () => {
    const result = await takeReview({ ...options(), readBoardAfter: () => ({ ...board(), claims: [foreign({ repo: 'EXAMPLE/Phantom' })] }) });
    expect(result).toMatchObject({ outcome: 'conflict', owner: 'agent-two' });
    expect(board().claims).toHaveLength(0);
  });

  it.each(['unknown', 'throw'] as const)('releases our claim when the race check is %s', async state => {
    const result = await takeReview({ ...options(), readBoardAfter: () => {
      if (state === 'throw') throw new Error('fake unavailable');
      return { ...board(), state: 'unknown' };
    } });
    expect(result).toMatchObject({ outcome: 'unavailable', claim: null, lease: null });
    expect(board().claims).toHaveLength(0);
  });

  it('keeps the receipt available to the caller when conflict cleanup fails', async () => {
    const result = await takeReview({ ...options(),
      readBoardAfter: () => ({ ...board(), claims: [foreign()] }),
      release: () => ({ ok: false, error: 'unavailable' }),
    });
    expect(result).toMatchObject({ outcome: 'unavailable', reason: 'claim release unavailable', claim: { task }, lease: expect.any(String) });
    expect(board().claims[0]!.id).toBe(result.claim!.id);
  });

  it.each([0, 86401, 1.5])('rejects an invalid core TTL %s before writing', async ttlSeconds => {
    expect((await takeReview({ ...options(), ttlSeconds })).outcome).toBe('invalid-input');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it('maps a ledger write failure honestly', async () => {
    expect((await takeReview({ ...options(), claim: () => ({ ok: false, error: 'unavailable' }) })).outcome).toBe('unavailable');
    expect(board().claims).toHaveLength(0);
  });
});
