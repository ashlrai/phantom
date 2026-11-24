import { expect, it, vi } from 'vitest';
import { armSweep, ARM_SWEEP_REPOS } from '../src/core/fleet/pr-arm-sweep.js';
import { cmdPrsArmSweep } from '../src/cli/prs-arm-sweep.js';
import { cmdPrs } from '../src/cli/prs.js';

const now = Date.parse('2026-11-21T12:00:00Z');
const pr = (number = 1, extra = {}) => ({ number, title: 'Ready', body: '', updatedAt: '2026-11-21T11:00:00Z', isDraft: false, mergeable: 'MERGEABLE', autoMergeRequest: null, statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...extra });
it.each([
  [{}, undefined], [{ statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, undefined], [{ statusCheckRollup: [{ state: 'FAILURE' }] }, 'Failing checks'], [{ isDraft: true }, 'Draft'],
  [{ mergeable: 'CONFLICTING' }, 'Conflicting'], [{ autoMergeRequest: {} }, 'Already armed'], [{ mergeable: 'UNKNOWN' }, 'Mergeability unknown'],
  [{ statusCheckRollup: null }, 'Checks unknown'], [{ statusCheckRollup: [{}] }, 'Checks unknown'], [{ statusCheckRollup: [{ state: 'odd' }] }, 'Checks unknown'],
  [{ updatedAt: '2026-11-19T11:00:00Z' }, 'Updated before the time window'], [{ number: 197 }, 'Owner hold'],
])('applies eligibility and exact merge arguments %#', async (extra, reason) => {
  const gh = vi.fn(async () => JSON.stringify([pr(1, extra)]));
  const report = await armSweep({ repos: ['phantom'], now, apply: true, gh });
  expect(report.rows[0]).toMatchObject(reason ? { action: 'skipped', reason } : { action: 'armed' });
  expect(gh.mock.calls).toHaveLength(reason ? 1 : 2);
  if (!reason) expect(gh.mock.calls[1]).toEqual([['pr', 'merge', '1', '--auto', '-R', 'ashlrai/phantom']]);
});
it('previews all seven repos and reports older superseded targets without closing', async () => {
  const gh = vi.fn(async () => JSON.stringify([pr(1, { body: 'Supersedes #2. Supersedes #2. Supersedes #9' }), pr(2, { updatedAt: '2026-11-18T11:00:00Z' })]));
  const report = await armSweep({ now, gh });
  expect(gh.mock.calls).toHaveLength(7);
  expect(report.rows.filter(r => r.action === 'would arm').map(r => r.repo)).toEqual(ARM_SWEEP_REPOS);
  expect(report.closeCandidates).toEqual(ARM_SWEEP_REPOS.map(repo => ({ repo, number: 2, title: 'Ready', supersededBy: 1 })));
});
it('continues after read and merge failures and returns a failing CLI exit', async () => {
  const gh = vi.fn(async (args: string[]) => { if (args.includes('ashlrai/locus') || args[1] === 'merge') throw new Error('Unavailable'); return JSON.stringify([pr()]); });
  const output = vi.fn();
  expect(await cmdPrsArmSweep(['--repos', 'locus,phantom,phantom', '--apply', '--json'], { gh, now, output })).toBe(1);
  expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ counts: { armed: 0, skipped: { 'Auto-merge request failed': 1 } }, errors: [{ repo: 'ashlrai/locus' }] });
});
it.each(['{}', '[{}]', 'bad', JSON.stringify(Array(10000).fill(pr()))])('refuses incomplete lists %#', async response => {
  const gh = vi.fn(async () => response);
  expect((await armSweep({ repos: ['phantom'], apply: true, gh, now })).errors).toHaveLength(1);
  expect(gh.mock.calls).toHaveLength(1);
});
it('routes help through prs and honors the CLI time window in plain output', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { expect(await cmdPrs(['arm-sweep', '--help'])).toBe(0); expect(log).toHaveBeenCalledWith(expect.stringContaining('phm prs arm-sweep')); } finally { log.mockRestore(); }
  const output = vi.fn(), gh = vi.fn(async () => JSON.stringify([pr()]));
  expect(await cmdPrsArmSweep(['--repos', 'phantom', '--since', '30m'], { gh, now, output })).toBe(0);
  expect(output).toHaveBeenCalledWith(expect.stringContaining('skipped — Updated before the time window'));
});
it.each([['--repos', 'other/repo'], ['--since', '0h'], ['--since', 'bad'], ['--apply', '--apply'], ['--repos'], ['--unknown']])('rejects bad CLI arguments %#', async args => {
  const gh = vi.fn(); expect(await cmdPrsArmSweep(args, { gh, error: () => {} })).toBe(2); expect(gh).not.toHaveBeenCalled();
});
