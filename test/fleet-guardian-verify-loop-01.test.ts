import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (repo: string, digit = 'a'): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
async function setup(entries: DetachedPostMergeRunnerInput[]) {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-test-'));
  const manifest = join(dir, 'manifest.json'); const state = join(dir, 'state.json');
  await writeFile(manifest, JSON.stringify(entries));
  return { manifest, state, maxPasses: 1, intervalMs: 1 };
}
describe('guardian verification loop', () => {
  it('runs serially, persists failure and skips identical entries across restarts while checking new SHAs', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]);
    let active = 0; const seen: string[] = [];
    const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => { expect(++active).toBe(1); seen.push(item.repo); await Promise.resolve(); active--; return result(item.repo.endsWith('a') ? 'fail' : 'pass'); });
    expect(await runGuardianVerifyLoop({ ...opts, run })).toMatchObject({ fail: 1, pass: 1 });
    expect(seen).toEqual(['/fake/a', '/fake/b']);
    expect(await runGuardianVerifyLoop({ ...opts, run })).toMatchObject({ fail: 1, pass: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(opts.state, 'utf8')).entries[0].terminal).toBe('fail');
    await writeFile(opts.manifest, JSON.stringify([input('/fake/a', 'd')]));
    await runGuardianVerifyLoop({ ...opts, run }); expect(run).toHaveBeenCalledTimes(3);
  });
  it('retries unknown only in the next pass and rereads replacement manifest', async () => {
    const opts = await setup([input('/fake/a')]);
    const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => { if (item.repo === '/fake/a') { await writeFile(opts.manifest, JSON.stringify([item, input('/fake/b')])); return result('unknown'); } return result('pass'); });
    expect(await runGuardianVerifyLoop({ ...opts, maxPasses: 2, run })).toMatchObject({ passes: 2, unknown: 1, pass: 1 });
    expect(run.mock.calls.map(c => c[0].repo)).toEqual(['/fake/a', '/fake/a', '/fake/b']);
  });
  it('passes cancellation to runner and prevents further launches', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]); const controller = new AbortController();
    const run = vi.fn(async (_item: DetachedPostMergeRunnerInput, options?: { signal?: AbortSignal }) => { expect(options?.signal).toBe(controller.signal); controller.abort(); return result('pass'); });
    expect(await runGuardianVerifyLoop({ ...opts, signal: controller.signal, run })).toMatchObject({ cancelled: true, unknown: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(opts.state, 'utf8')).entries[0].terminal).toBe('unknown');
  });
  it('rejects invalid bounds, conflicting entries and malformed state before launching', async () => {
    const opts = await setup([input('/fake/a')]); const run = vi.fn(async () => result('pass'));
    await expect(runGuardianVerifyLoop({ ...opts, maxPasses: 0, run })).rejects.toThrow();
    await writeFile(opts.manifest, JSON.stringify([input('/fake/a'), { ...input('/fake/a'), proposalId: 'different' }]));
    await expect(runGuardianVerifyLoop({ ...opts, run })).rejects.toThrow();
    await writeFile(opts.state, '{}'); await expect(runGuardianVerifyLoop({ ...opts, run })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('CLI reaches the loop and returns failure status', async () => {
    const opts = await setup([input('/fake/a')]); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const loop: typeof runGuardianVerifyLoop = options => runGuardianVerifyLoop({ ...options, run: async () => result('fail') });
      expect(await cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--json'], loop)).toBe(1);
      expect(JSON.parse(String(log.mock.calls[0]![0])).fail).toBe(1);
    } finally { log.mockRestore(); }
  });
});
