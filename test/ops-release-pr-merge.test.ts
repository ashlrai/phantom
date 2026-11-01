import { expect, it, vi } from 'vitest';
import { mergeReleasePr } from '../src/core/verse/ops-release-pr.js';

const REPO = 'ashlrai/phantom';
const MERGE_ARGV = ['pr', 'merge', '1479', '--repo', REPO, '--merge', '--delete-branch=false'];
const VIEW = JSON.stringify({ mergeCommit: { oid: 'a1b2c3d4e5f6' } });
const CHECKS = { pass: [{ name: 'Merge Gate', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  fail: [{ name: 'Dependency audit', status: 'COMPLETED', conclusion: 'FAILURE' }],
  pending: [{ name: 'Merge Gate', status: 'IN_PROGRESS', conclusion: null }] };

function listJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    number: 1479, title: 'chore(master): release 3.30.0', url: 'https://github.com/ashlrai/phantom/pull/1479',
    createdAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z',
    mergeable: 'MERGEABLE', headRefName: 'release-please--master',
    statusCheckRollup: CHECKS.pass, ...over,
  }]);
}

interface RunOpts { list?: string | null; merge?: string | null; view?: string | null }
function fakeRun({ list = listJson(), merge = 'Merged', view = VIEW }: RunOpts = {}) {
  return vi.fn(async (_bin: string, args: readonly string[]): Promise<string | null> => {
    if (args[0] === 'pr' && args[1] === 'list') return list;
    if (args[0] === 'pr' && args[1] === 'merge') return merge;
    if (args[0] === 'pr' && args[1] === 'view') return view;
    return null;
  });
}
const merged = (run: ReturnType<typeof fakeRun>) => run.mock.calls.some(([, args]) => args[1] === 'merge');

it('merges a green release PR with the exact argv and reports the merge sha', async () => {
  const run = fakeRun();
  const result = await mergeReleasePr(REPO, 1479, run);
  expect(result).toEqual({ ok: true, sha: 'a1b2c3d4e5f6' });
  expect(run).toHaveBeenCalledWith('gh', MERGE_ARGV);
  expect(run.mock.calls.map(([, args]) => args[1])).toEqual(['list', 'merge', 'view']);
});

it('reports a null sha when the follow-up view cannot answer', async () => {
  const run = fakeRun({ view: null });
  expect(await mergeReleasePr(REPO, 1479, run)).toEqual({ ok: true, sha: null });
});

it.each([
  ['blocked (a failing check)', { statusCheckRollup: CHECKS.fail }],
  ['pending checks', { statusCheckRollup: CHECKS.pending }],
])('refuses a not-green PR: %s', async (_label, over) => {
  const run = fakeRun({ list: listJson(over) });
  const result = await mergeReleasePr(REPO, 1479, run);
  expect(result).toMatchObject({ ok: false, code: 'not-green' });
  expect(merged(run)).toBe(false);
});

it('refuses a green PR with merge conflicts as blocked', async () => {
  const run = fakeRun({ list: listJson({ mergeable: 'CONFLICTING' }) });
  const result = await mergeReleasePr(REPO, 1479, run);
  expect(result).toMatchObject({ ok: false, code: 'blocked' });
  expect(merged(run)).toBe(false);
});

it.each([
  ['a different open release PR', listJson({ number: 1500 })],
  ['no open release PR', '[]'],
  ['gh offline', null],
])('reports not-found for %s and never merges', async (_label, list) => {
  const run = fakeRun({ list });
  const result = await mergeReleasePr(REPO, 1479, run);
  expect(result).toMatchObject({ ok: false, code: 'not-found' });
  expect(merged(run)).toBe(false);
});

it('reports gh-failed with a scrubbed detail when the merge exits non-zero', async () => {
  const run = fakeRun({ merge: null });
  const result = await mergeReleasePr(REPO, 1479, run);
  expect(result).toMatchObject({ ok: false, code: 'gh-failed', detail: expect.stringContaining('failed') });
});

it.each([
  ['a repo that is not owner/name', 'not a repo', 1479],
  ['a repo with an extra segment', 'a/b/c', 1479],
  ['a dot-segment repo', 'a/../b', 1479],
  ['a non-integer number', REPO, 14.5],
  ['a non-positive number', REPO, 0],
])('refuses %s without calling gh', async (_label, repo, number) => {
  const run = fakeRun();
  const result = await mergeReleasePr(repo, number, run);
  expect(result).toMatchObject({ ok: false, code: 'not-found' });
  expect(run).not.toHaveBeenCalled();
});
