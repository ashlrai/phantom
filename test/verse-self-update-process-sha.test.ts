import { afterEach, describe, expect, it } from 'vitest';
import { readSelfUpdateStatus, resetProcessHeadShaForTests, type SelfUpdateDeps } from '../src/core/verse/self-update-status.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function fixture(head: string): SelfUpdateDeps {
  return {
    repoRoot: () => '/fixture', readPackageVersion: () => '1.2.3',
    readLastApply: () => null, statFetchHead: () => null,
    runGit: async (args) => ({ code: 0, stdout: args[0] === 'status' ? ''
      : args[0] === 'rev-list' ? '0\t0' : args[0] === 'show' ? '2026-10-30T12:00:00Z'
      : args.includes('--abbrev-ref') ? 'master' : head }),
  };
}

describe('self update process HEAD', () => {
  afterEach(resetProcessHeadShaForTests);

  it('retains the first observed HEAD until the process identity is reset', async () => {
    expect(await readSelfUpdateStatus(fixture(SHA_A))).toMatchObject({ headSha: SHA_A, processHeadSha: SHA_A });
    expect(await readSelfUpdateStatus(fixture(SHA_B))).toMatchObject({ headSha: SHA_B, processHeadSha: SHA_A });
    resetProcessHeadShaForTests();
    expect(await readSelfUpdateStatus(fixture(SHA_B))).toMatchObject({ headSha: SHA_B, processHeadSha: SHA_B });
  });

  it('keeps the process HEAD unknown when the repository is unavailable', async () => {
    expect(await readSelfUpdateStatus({ repoRoot: () => null, readLastApply: () => null }))
      .toMatchObject({ sourceState: 'unavailable', headSha: null, processHeadSha: null });
  });

  it('waits for a valid 40-character HEAD and keeps it through later failures', async () => {
    expect(await readSelfUpdateStatus(fixture('not-a-sha'))).toMatchObject({ headSha: null, processHeadSha: null });
    expect(await readSelfUpdateStatus(fixture('a'.repeat(64)))).toMatchObject({ headSha: 'a'.repeat(64), processHeadSha: null });
    expect(await readSelfUpdateStatus(fixture(SHA_A))).toMatchObject({ headSha: SHA_A, processHeadSha: SHA_A });
    expect(await readSelfUpdateStatus({ repoRoot: () => null, readLastApply: () => null }))
      .toMatchObject({ sourceState: 'unavailable', headSha: null, processHeadSha: SHA_A });
  });
});
