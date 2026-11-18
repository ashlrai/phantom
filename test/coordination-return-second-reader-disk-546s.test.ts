import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import { checkReturnPrs } from '../src/core/fleet/return-pr-check.js';

const dirs: string[] = [];
const at = 1_000_000;
const expiry = at + 10_000;
const head = 'abc1234def567890abcdef1234567890abcdef12';
const repo = 'example/disk-reader';
const agent = 'fake-agent';
const task = 'Check "quoted": pr #999 head deadbee then "real"';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'return-reader-546s-'));
  dirs.push(dir);
  const path = join(dir, 'board.jsonl');
  const claim = claimFleetWork({ repo, task, agent }, { path, now: at });
  if (!claim.ok) throw new Error('synthetic claim failed');
  const id = claim.value.claim.id;
  expect(returnFleetClaim({ id, agent, lease: claim.value.lease, pr: 546, head, ttlMs: expiry - at },
    { path, now: at })).toMatchObject({ ok: true, outcome: 'returned' });
  return { path, id, bytes: readFileSync(path) };
}

function reopen(path: string, now: number) {
  const board = readFleetBoard({ path, now, reap: false, includeExpiredReturns: true });
  const projection = projectCoordinationReturns(board, now);
  // Cross the same JSON boundary used by an independent reader.
  const serialized = JSON.parse(JSON.stringify(projection)) as typeof projection;
  return { board, serialized };
}

const merged = () => JSON.stringify({ state: 'closed', merged: true,
  merged_at: '2026-11-12T22:29:00Z', head: { sha: head } });

describe('durable return to independent PR reader (546s)', () => {
  it('reopens writer evidence and checks the exact PR head without changing the ledger', async () => {
    const { path, id, bytes } = fixture();
    const { board, serialized } = reopen(path, at + 1);
    expect(board.claims).toEqual([]);
    expect(board.messages[0]?.body).toContain(`task "${task}": pr #546 head ${head}`);
    expect(serialized).toMatchObject({ state: 'known', unparsed: 0, returns: [{
      claimId: id, repo, from: agent, result: 'VERIFIED', evidenceKind: 'pr', pr: 546, head, temporal: 'current',
    }] });
    const gh = vi.fn(async () => merged());
    const report = await checkReturnPrs(serialized.returns, { gh });
    expect(gh).toHaveBeenCalledExactlyOnceWith(['api', '-H', 'Accept: application/vnd.github+json', 'repos/example/disk-reader/pulls/546']);
    expect(report).toMatchObject({ authority: 'none', skipped: 0, checked: [{ claimId: id, repo, pr: 546, head,
      observedHead: head, mergedAt: '2026-11-12T22:29:00Z', verdict: 'merged-at-head' }] });
    expect(readFileSync(path)).toEqual(bytes);
  });

  it('reopens retained evidence at expiry independently of the PR fact', async () => {
    const { path, id, bytes } = fixture();
    const { board, serialized } = reopen(path, expiry);
    const report = await checkReturnPrs(serialized.returns, { gh: async () => merged() });
    expect(board.claims).toEqual([]);
    expect(readFileSync(path)).toEqual(bytes);
    expect(serialized).toMatchObject({ state: 'known', unparsed: 0, returns: [{ claimId: id, temporal: 'expired' }] });
    expect(report).toMatchObject({ authority: 'none', checked: [{ claimId: id, verdict: 'merged-at-head', observedHead: head }] });
  });

  it('does not treat VERIFIED as a merge when the independent read is open or fails', async () => {
    const { path, id, bytes } = fixture();
    const { board, serialized } = reopen(path, at + 1);
    const open = await checkReturnPrs(serialized.returns, { gh: async () => JSON.stringify({ state: 'open', head: { sha: head } }) });
    const failed = await checkReturnPrs(serialized.returns, { gh: async () => { throw new Error('synthetic private failure detail'); } });
    expect(open).toMatchObject({ authority: 'none', checked: [{ claimId: id, verdict: 'open', observedHead: head, mergedAt: null }] });
    expect(failed).toMatchObject({ authority: 'none', checked: [{ claimId: id, verdict: 'unknown', observedHead: null,
      mergedAt: null, reason: 'read-failed' }] });
    expect(JSON.stringify(failed)).not.toContain('synthetic private failure detail');
    expect(board.claims).toEqual([]);
    expect(readFileSync(path)).toEqual(bytes);
  });
});
