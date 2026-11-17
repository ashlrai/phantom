import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPrConflictResolution } from '../src/core/fleet/pr-conflict-run.js';

const mocks = vi.hoisted(() => ({
  defaultGitRunner: vi.fn(),
  resolvePrConflicts: vi.fn(),
}));
vi.mock('../src/core/verse/git-ops.js', () => ({ defaultGitRunner: mocks.defaultGitRunner }));
vi.mock('../src/core/fleet/pr-conflict-resolver.js', () => ({ resolvePrConflicts: mocks.resolvePrConflicts }));

const rows = [
  {
    number: 1, state: 'OPEN', headRefName: 'deleted-fork', headRefOid: 'a'.repeat(40),
    headRepository: null, baseRefName: 'master', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
  },
  {
    number: 2, state: 'CLOSED', headRefName: 'closed', headRefOid: 'b'.repeat(40),
    headRepository: null, baseRefName: 'master', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
  },
  {
    number: 3, state: 'OPEN', headRefName: 'clean', headRefOid: 'c'.repeat(40),
    headRepository: null, baseRefName: 'master', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
  },
  {
    number: 4, state: 'OPEN', headRefName: 'active', headRefOid: 'd'.repeat(40),
    headRepository: { nameWithOwner: 'ashlrai/phantom' }, baseRefName: 'master',
    mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
  },
];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pr-conflict-run-'));
  mkdirSync(join(root, 'queue'));
  writeFileSync(join(root, 'queue', 'hold-list.txt'), '');
  mocks.defaultGitRunner.mockImplementation(async (_command: string, args: string[]) => {
    if (args[0] === 'repo') return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'master' } }), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  });
  mocks.resolvePrConflicts.mockImplementation(async (input: { pr: { number: number } }) => ({
    number: input.pr.number, status: 'would-resolve',
  }));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

it('reports a deleted source repository and continues resolving other conflicting PRs', async () => {
  const result = await runPrConflictResolution({ apply: false, repo: 'ashlrai/phantom', root, limit: 10 }) as {
    prs: Array<{ number: number; status: string; reason?: string }>;
  };

  expect(result.prs).toEqual([
    expect.objectContaining({ number: 1, status: 'head-unavailable' }),
    { number: 4, status: 'would-resolve' },
  ]);
  expect(mocks.resolvePrConflicts).toHaveBeenCalledTimes(1);
  expect(mocks.resolvePrConflicts.mock.calls[0]?.[0].pr).toMatchObject({ number: 4, headRepo: 'ashlrai/phantom' });
});
