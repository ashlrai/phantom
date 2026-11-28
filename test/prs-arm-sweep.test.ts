import { expect, it, vi } from 'vitest';
import { armSweep, ARM_SWEEP_REPOS } from '../src/core/fleet/pr-arm-sweep.js';
import { cmdPrsArmSweep } from '../src/cli/prs-arm-sweep.js';
import { cmdPrs } from '../src/cli/prs.js';

const now = Date.parse('2026-11-21T12:00:00Z');
const head = 'a'.repeat(40);
const defaultBranch = JSON.stringify({ defaultBranchRef: { name: 'master' } });
const pr = (number = 1, extra = {}) => ({ number, title: 'Ready', body: '', updatedAt: '2026-11-21T11:00:00Z', isDraft: false, mergeable: 'MERGEABLE', headRefOid: head, baseRefName: 'master', autoMergeRequest: null, statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...extra });
const list = (response: string) => vi.fn(async (args: string[]) => args[0] === 'repo' ? defaultBranch : response);

it.each([
  [{}, undefined], [{ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, undefined], [{ statusCheckRollup: [{ state: 'FAILURE' }] }, 'Failing checks'], [{ isDraft: true }, 'Draft'],
  [{ mergeable: 'CONFLICTING' }, 'Conflicting'], [{ autoMergeRequest: {} }, 'Already armed'], [{ mergeable: 'UNKNOWN' }, 'Mergeability unknown'],
  [{ statusCheckRollup: null }, 'Checks unknown'], [{ statusCheckRollup: [] }, 'Checks unknown'], [{ statusCheckRollup: [{}] }, 'Checks unknown'], [{ statusCheckRollup: [{ state: 'odd' }] }, 'Checks unknown'],
  [{ baseRefName: 'release' }, 'Base is not the default branch'], [{ baseRefName: undefined }, 'Base is not the default branch'],
  [{ headRefOid: 'abcdef' }, 'Head unknown'], [{ headRefOid: undefined }, 'Head unknown'],
  [{ updatedAt: '2026-11-19T11:00:00Z' }, 'Updated before the time window'], [{ number: 197 }, 'Owner hold'],
])('applies eligibility and exact merge arguments %#', async (extra, reason) => {
  const gh = list(JSON.stringify([pr(1, extra)]));
  const report = await armSweep({ repos: ['phantom'], now, apply: true, gh });
  expect(report.rows[0]).toMatchObject(reason ? { action: 'skipped', reason } : { action: 'armed' });
  expect(gh.mock.calls).toHaveLength(reason ? 2 : 3);
  if (!reason) expect(gh.mock.calls[2]).toEqual([['pr', 'merge', '1', '--repo', 'ashlrai/phantom', '--squash', '--auto', '--match-head-commit', head]]);
});
it('previews all seven repos and reports older superseded targets without closing', async () => {
  const gh = list(JSON.stringify([pr(1, { body: 'Supersedes #2. Supersedes #2. Supersedes #9' }), pr(2, { updatedAt: '2026-11-18T11:00:00Z' })]));
  const report = await armSweep({ now, gh });
  expect(gh.mock.calls).toHaveLength(14);
  expect(report.rows.filter(r => r.action === 'would arm').map(r => r.repo)).toEqual(ARM_SWEEP_REPOS);
  expect(report.closeCandidates).toEqual(ARM_SWEEP_REPOS.map(repo => ({ repo, number: 2, title: 'Ready', supersededBy: 1 })));
});
it('continues after read and merge failures and returns a failing CLI exit', async () => {
  const gh = vi.fn(async (args: string[]) => { if (args.includes('ashlrai/locus') || args[1] === 'merge') throw new Error('Unavailable'); return args[0] === 'repo' ? defaultBranch : JSON.stringify([pr()]); });
  const output = vi.fn();
  expect(await cmdPrsArmSweep(['--repos', 'locus,phantom,phantom', '--apply', '--json'], { gh, now, output })).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ counts: { armed: 0, skipped: { 'Auto-merge request failed': 1 } }, errors: [{ repo: 'ashlrai/locus' }] });
});
it('never retries an exact-head rejection against a newer head', async () => {
  const gh = vi.fn(async (args: string[]) => {
    if (args[0] === 'repo') return defaultBranch;
    if (args[1] === 'list') return JSON.stringify([pr()]);
    throw new Error('Head SHA changed');
  });
  const report = await armSweep({ repos: ['phantom'], apply: true, gh, now });
  expect(report.rows).toMatchObject([{ number: 1, action: 'skipped', reason: 'Auto-merge request failed' }]);
  expect(gh.mock.calls.filter(([args]) => args[1] === 'merge').map(([args]) => args.at(-1))).toEqual([head]);
});
it('does not inspect or arm PRs without verified default-branch evidence', async () => {
  const gh = vi.fn(async () => JSON.stringify({ defaultBranchRef: null }));
  expect((await armSweep({ repos: ['phantom'], apply: true, gh, now })).errors).toHaveLength(1);
  expect(gh.mock.calls).toHaveLength(1);
});
it.each(['{}', '[{}]', 'bad', JSON.stringify(Array(10000).fill(pr()))])('refuses incomplete lists %#', async response => {
  const gh = list(response);
  expect((await armSweep({ repos: ['phantom'], apply: true, gh, now })).errors).toHaveLength(1);
  expect(gh.mock.calls).toHaveLength(2);
});
it('routes help through prs and honors the CLI time window in plain output', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { expect(await cmdPrs(['arm-sweep', '--help'])).toBe(0); expect(log).toHaveBeenCalledWith(expect.stringContaining('phm prs arm-sweep')); } finally { log.mockRestore(); }
  const output = vi.fn(), gh = list(JSON.stringify([pr()]));
  expect(await cmdPrsArmSweep(['--repos', 'phantom', '--since', '30m'], { gh, now, output })).toBe(0);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('skipped — Updated before the time window'));
});
it.each([['--repos', 'other/repo'], ['--since', '0h'], ['--since', 'bad'], ['--apply', '--apply'], ['--repos'], ['--unknown']].map(args => ({ args })))('rejects bad CLI arguments %#', async ({ args }) => {
  const gh = vi.fn(); expect(await cmdPrsArmSweep(args, { gh, error: () => {} })).toBe(2); expect(gh).not.toHaveBeenCalled();
});
