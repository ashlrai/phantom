import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { probeRepoRelease, type OpsRunner } from '../src/core/verse/ops-releases.js';

const path = join(tmpdir(), 'release-probe-fixture');

it('uses the injected runner to count local commits without fetching', async () => {
  const run = vi.fn<OpsRunner>(async (_bin, args) => args.includes('describe') ? 'v3.29.15' : args.includes('rev-list') ? '620\n' : null);
  expect((await probeRepoRelease(path, { run, identity: () => null })).commitsSinceTag).toBe(620);
  expect(run).toHaveBeenCalledWith('git', ['-C', path, 'rev-list', '--count', 'v3.29.15..HEAD']);
  expect(run.mock.calls.every(([, args]) => !args.includes('fetch'))).toBe(true);
});

it.each([null, '', 'garbage', '-1', '1.5'])('returns unknown when git returns %s', async output => {
  const run: OpsRunner = async (_bin, args) => args.includes('describe') ? 'v1' : output;
  expect((await probeRepoRelease(path, { run, identity: () => null })).commitsSinceTag).toBeNull();
});

it('returns unknown when the count runner throws', async () => {
  const run: OpsRunner = async (_bin, args) => {
    if (args.includes('describe')) return 'v1';
    throw new Error('git unavailable');
  };
  expect((await probeRepoRelease(path, { run, identity: () => null })).commitsSinceTag).toBeNull();
});

it('does not count without a tag', async () => {
  const run = vi.fn<OpsRunner>(async () => null);
  expect((await probeRepoRelease(path, { run, identity: () => null })).commitsSinceTag).toBeNull();
  expect(run.mock.calls.some(([, args]) => args.includes('rev-list'))).toBe(false);
});
