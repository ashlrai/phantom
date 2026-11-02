import { expect, it, vi } from 'vitest';
import { probeReleasePr } from '../src/core/verse/ops-release-pr.js';

const fixture = (statusCheckRollup: unknown[] = []) => ({
  number: 1479, title: 'chore(master): release 3.30.0', headRefName: 'release-please--branches--master',
  url: 'https://github.com/ashlrai/phantom/pull/1479', createdAt: '2026-10-30T00:00:00Z',
  updatedAt: '2026-10-31T00:00:00Z', mergeable: 'MERGEABLE', statusCheckRollup,
});
it('release PR exposes failed, skipped and pending checks and parsed version', async () => {
  const run = vi.fn(async () => JSON.stringify([fixture([
    { name: 'Dependency audit (root + Raycast)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'Optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'Build', status: 'IN_PROGRESS', conclusion: '' },
  ])]));
  const pr = await probeReleasePr('ashlrai/phantom', run);
  expect(pr).toMatchObject({ version: '3.30.0', failing: ['Dependency audit (root + Raycast)'], pending: 1,
    blocked: true, summary: '3.30.0 blocked by Dependency audit (root + Raycast)' });
  expect(pr?.checks.map((c) => c.state)).toEqual(['fail', 'skipped', 'pending']);
  expect(run).toHaveBeenCalledWith('gh', ['pr', 'list', '-R', 'ashlrai/phantom', '--state', 'open', '--search',
    'release in:title', '--json', 'number,title,url,createdAt,updatedAt,mergeable,headRefName,statusCheckRollup', '-L', '10']);
});
it('release PR reports green and strips foreign URLs', async () => {
  const pr = await probeReleasePr('a/b', async () => JSON.stringify([{ ...fixture([
    { context: 'CI', state: 'SUCCESS', targetUrl: 'https://example.com' },
  ]), url: 'https://example.com/pr' }]));
  expect(pr).toMatchObject({ url: null, summary: '3.30.0 green, waiting for merge', blocked: false, checks: [{ name: 'CI', state: 'pass', url: null }] });
});
it('release PR selects only release-please branches with matching titles', async () => {
  expect(await probeReleasePr('a/b', async () => JSON.stringify([{ ...fixture(), headRefName: 'other' }]))).toBeNull();
  expect(await probeReleasePr('a/b', async () => JSON.stringify([{ ...fixture(), title: 'release notes' }]))).toBeNull();
});
it('release PR tolerates unavailable, malformed and throwing runners', async () => {
  for (const raw of [null, 'garbage', '{}', '[]', '[null]']) {
    expect(await probeReleasePr('a/b', async () => raw)).toBeNull();
  }
  expect(await probeReleasePr('a/b', async () => { throw new Error('offline'); })).toBeNull();
});
it('release PR maps legacy states, terminal failures and pending summaries', async () => {
  const pr = await probeReleasePr('a/b', async () => JSON.stringify([fixture([
    ...['ERROR', 'FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].map((state) => ({ context: state, state })),
    { context: 'queued', state: 'EXPECTED' }, { context: 'neutral', conclusion: 'NEUTRAL', status: 'COMPLETED' },
  ])]));
  expect(pr?.failing).toHaveLength(5);
  expect(pr?.pending).toBe(1);
  const waiting = await probeReleasePr('a/b', async () => JSON.stringify([fixture([{ state: 'PENDING' }, { status: 'QUEUED' }])]));
  expect(waiting?.summary).toBe('3.30.0 waiting on 2 checks');
});
