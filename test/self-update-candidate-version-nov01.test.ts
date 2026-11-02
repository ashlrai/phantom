import { describe, expect, it, vi } from 'vitest';
import { readSelfUpdateStatus, type SelfUpdateDeps } from '../src/core/verse/self-update-status.js';

function fixture(behind = 12, originPackage = '{"version":"3.30.0"}', failure?: 'exit' | 'reject'): SelfUpdateDeps {
  return {
    repoRoot: () => '/fixture', readPackageVersion: () => '3.29.15', statFetchHead: () => null,
    readLastApply: () => null,
    runGit: vi.fn(async (args: string[], cwd: string) => {
      expect(cwd).toBe('/fixture');
      if (args.join(' ') === 'show origin/master:package.json') {
        if (failure === 'reject') throw new Error('probe failed');
        return { code: failure === 'exit' ? 1 : 0, stdout: originPackage };
      }
      const stdout = args[0] === 'status' ? '' : args[0] === 'rev-list' ? `0\t${behind}`
        : args[0] === 'show' ? '2026-11-01T12:00:00Z'
        : args.includes('--abbrev-ref') ? 'master' : 'a'.repeat(40);
      return { code: 0, stdout };
    }),
  };
}

describe('self-update candidate version', () => {
  it('reports the fetched origin version when behind 12 commits', async () => {
    const deps = fixture();
    expect(await readSelfUpdateStatus(deps)).toMatchObject({
      candidateVersion: '3.30.0', installedVersion: '3.29.15', behind: 12,
      sourceState: 'healthy', canFastForward: true,
    });
    expect(deps.runGit).toHaveBeenCalledWith(['show', 'origin/master:package.json'], '/fixture');
  });

  it('reports no candidate when the checkout is current', async () => {
    expect(await readSelfUpdateStatus(fixture(0))).toMatchObject({ candidateVersion: null, sourceState: 'healthy' });
  });

  it.each(['exit', 'reject'] as const)('isolates a failed candidate probe (%s)', async (failure) => {
    const baseline = await readSelfUpdateStatus(fixture());
    const status = await readSelfUpdateStatus(fixture(12, '', failure));
    expect(status.candidateVersion).toBeNull();
    expect(status.sourceState).toBe(baseline.sourceState);
    expect(status.canFastForward).toBe(true);
  });

  it.each(['{', 'null', '{}', '{"version":330}', '{"version":"3.30.0;$(touch /tmp/untrusted)"}'])(
    'rejects invalid origin package metadata: %s', async (originPackage) => {
      expect(await readSelfUpdateStatus(fixture(12, originPackage))).toMatchObject({
        candidateVersion: null, sourceState: 'healthy', behind: 12,
      });
    },
  );

  it('initializes the candidate to null when the repository is unavailable', async () => {
    const deps = fixture();
    expect(await readSelfUpdateStatus({ ...deps, repoRoot: () => null })).toMatchObject({
      candidateVersion: null, sourceState: 'unavailable',
    });
    expect(deps.runGit).not.toHaveBeenCalled();
  });
});
