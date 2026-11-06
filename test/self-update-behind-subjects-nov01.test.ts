import { describe, expect, it, vi } from 'vitest';
import { readSelfUpdateStatus, type SelfUpdateDeps } from '../src/core/verse/self-update-status.js';

function fixture(behind: number | null = 12, subjects = 'one\ntwo\nthree\nfour\nfive\nsix', failure?: 'exit' | 'reject') {
  const runGit = vi.fn(async (args: string[]) => {
    if (args[0] === 'log') {
      if (failure === 'reject') throw new Error('fake failure');
      return { code: failure === 'exit' ? 1 : 0, stdout: subjects };
    }
    const stdout = args[0] === 'status' ? '' : args[0] === 'rev-list' ? behind === null ? 'unknown' : `0 ${behind}`
      : args.join(' ') === 'show origin/master:package.json' ? '{"version":"1.0.1"}'
      : args[0] === 'show' ? '2026-11-01T12:00:00Z'
      : args.includes('--abbrev-ref') ? 'master' : 'a'.repeat(40);
    return { code: 0, stdout };
  });
  const deps: SelfUpdateDeps = { runGit, repoRoot: () => '/fake-repo', readPackageVersion: () => '1.0.0',
    statFetchHead: () => null, readLastApply: () => null };
  return { deps, runGit };
}

describe('behind commit subjects', () => {
  it('reads at most five subjects with one extra git call', async () => {
    const { deps, runGit } = fixture();
    expect((await readSelfUpdateStatus(deps)).behindSubjects).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(runGit).toHaveBeenCalledTimes(8);
    expect(runGit).toHaveBeenCalledWith(['log', '--format=%s', '-n', '5', 'HEAD..origin/master'], '/fake-repo');
  });
  it.each([0, null])('skips the log probe when behind is %s', async (behind) => {
    const { deps, runGit } = fixture(behind);
    expect((await readSelfUpdateStatus(deps)).behindSubjects).toBeNull();
    expect(runGit).toHaveBeenCalledTimes(7);
    expect(runGit.mock.calls.some(([args]) => args[0] === 'log')).toBe(false);
  });
  it.each(['exit', 'reject'] as const)('isolates log failure (%s)', async (failure) => {
    expect(await readSelfUpdateStatus(fixture(12, '', failure).deps)).toMatchObject({
      behindSubjects: null, sourceState: 'healthy', canFastForward: true,
    });
  });
  it.each(['', ' \n\t\r\n'])('returns null for empty subjects', async (subjects) => {
    expect((await readSelfUpdateStatus(fixture(12, subjects).deps)).behindSubjects).toBeNull();
  });
  it('strips controls, trims and bounds long subjects', async () => {
    const subjects = `  bridge: \u0000a\t\u007fb\u0085\u202ec  \r\n${'x'.repeat(150)}\nthree\nfour\nfive`;
    const status = await readSelfUpdateStatus(fixture(12, subjects).deps);
    expect(status.behindSubjects).toEqual(['bridge: abc', 'x'.repeat(120), 'three', 'four', 'five']);
  });
});
