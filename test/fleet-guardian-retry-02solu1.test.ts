import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runGuardianVerifyLoop } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianRetry } from '../src/cli/fleet-guardian-retry.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (repo: string, digit: string): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });

// Manifest: /fake/a fails (selected for retry), /fake/b passes (skipped),
// /fake/d fails (unrelated failure, must be retained). All local fake repos.
async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-retry-'));
  const manifest = join(dir, 'manifest.json'); const source = join(dir, 'state.json'); const output = join(dir, 'retry.json');
  await writeFile(manifest, JSON.stringify([input('/fake/a', 'a'), input('/fake/b', 'b'), input('/fake/d', 'd')]));
  const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => result(item.repo.endsWith('b') ? 'pass' : 'fail'));
  await runGuardianVerifyLoop({ manifest, state: source, maxPasses: 1, intervalMs: 1, run });
  return { dir, manifest, source, output };
}
const retry = (o: Awaited<ReturnType<typeof seed>>, extra: string[] = []) =>
  cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', o.source, '--output-state', o.output, '--repo', '/fake/a', '--sha', 'a'.repeat(40), ...extra]);

describe('guardian-retry state preparation', () => {
  it('removes only the selected failure, then the real loop reruns it once and skips the rest', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    let printed = '';
    const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { printed = String(value); });
    let code: number;
    try { code = await retry(o, ['--json']); } finally { log.mockRestore(); }
    expect(code).toBe(0);
    const summary = JSON.parse(printed);
    expect(summary).toMatchObject({ removed: 1, retained: 2 });
    expect(summary.nextAction).toContain('guardian-verify');
    expect(await readFile(o.source, 'utf8')).toBe(bytes); // source never mutated
    expect(JSON.parse(await readFile(o.output, 'utf8')).entries.map((e: { repo: string }) => e.repo).sort()).toEqual(['/fake/b', '/fake/d']);

    const run = vi.fn(async (item: DetachedPostMergeRunnerInput) => { expect(item.repo).toBe('/fake/a'); return result('pass'); });
    expect(await runGuardianVerifyLoop({ manifest: o.manifest, state: o.output, maxPasses: 1, intervalMs: 1, run })).toMatchObject({ pass: 2, fail: 1, unknown: 0 });
    expect(run).toHaveBeenCalledTimes(1); // success /fake/b and unrelated fail /fake/d skipped
    const entries = JSON.parse(await readFile(o.output, 'utf8')).entries as { repo: string; terminal: string }[];
    expect(Object.fromEntries(entries.map(e => [e.repo, e.terminal]))).toEqual({ '/fake/a': 'pass', '/fake/b': 'pass', '/fake/d': 'fail' });
  });
  it('rejects bad argv, missing identity and existing output with zero mutation', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await cmdFleetGuardianRetry(['--bogus'])).toBe(2); // invalid args
      expect(await cmdFleetGuardianRetry([])).toBe(3); // missing flags fail core validation, like guardian-verify
      expect(await cmdFleetGuardianRetry(['--manifest', '--json'])).toBe(2); // flag-shaped value rejected
      await writeFile(o.output, 'keep');
      expect(await retry(o)).toBe(3); // existing output: never overwritten
      expect(await readFile(o.output, 'utf8')).toBe('keep');
      expect(existsSync(join(o.dir, 'other.json'))).toBe(false);
      expect(await cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', o.source, '--output-state', o.output, '--repo', '/fake/a', '--sha', 'abc'])).toBe(3); // bad sha
      expect(await cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', o.source, '--output-state', join(o.dir, 'x.json'), '--repo', 'fake/a', '--sha', 'a'.repeat(40)])).toBe(3); // repo not absolute
      expect(await cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', o.source, '--output-state', join(o.dir, 'x.json'), '--repo', '/fake/a', '--sha', 'b'.repeat(40)])).toBe(3); // pass entry, not a failure
      expect(await cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', o.source, '--output-state', join(o.dir, 'x.json'), '--repo', '/fake/zz', '--sha', 'e'.repeat(40)])).toBe(3); // no manifest identity
      expect(existsSync(join(o.dir, 'x.json'))).toBe(false); // no output materialized
    } finally { err.mockRestore(); }
    expect(await readFile(o.source, 'utf8')).toBe(bytes);
  });
  it('rejects duplicate manifest identities, malformed input and a missing source', async () => {
    const o = await seed();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await writeFile(o.manifest, JSON.stringify([input('/fake/a', 'a'), { ...input('/fake/a', 'a'), proposalId: 'other' }]));
      expect(await retry(o)).toBe(3); // conflicting duplicate identities
      await writeFile(o.manifest, '{not json');
      expect(await retry(o)).toBe(3); // malformed manifest
      await writeFile(o.manifest, JSON.stringify([input('/fake/a', 'a')]));
      await writeFile(o.source, '{"version":2,"entries":[]}');
      expect(await retry(o)).toBe(3); // invalid state schema
      expect(await cmdFleetGuardianRetry(['--manifest', o.manifest, '--source-state', join(o.dir, 'gone.json'), '--output-state', join(o.dir, 'x.json'), '--repo', '/fake/a', '--sha', 'a'.repeat(40)])).toBe(3); // missing source
      expect(existsSync(join(o.dir, 'x.json'))).toBe(false);
    } finally { err.mockRestore(); }
  });
});
