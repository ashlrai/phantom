import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianDrain } from '../src/cli/fleet-guardian-drain.js';
import { runGuardianVerifyExclusive, type GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import { runGuardianVerifyLoop, GUARDIAN_VERIFY_MAX_TIMEOUT_MS, type GuardianOptions } from '../src/core/fleet/guardian-verify-loop.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const input = (repo: string, digit: string): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
const key = (i: DetachedPostMergeRunnerInput) => createHash('sha256').update(JSON.stringify([i.repo, i.cohortId, i.proposalId, i.baseBranch, i.baseHead, i.candidateHead, i.mergeCommit, null, null, null])).digest('hex');
const result = (terminal: 'pass' | 'fail'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const base = { terminal: 'fail', reason: 'verification-infrastructure', failureCategory: 'infra', cleanup: 'removed' };

// Manifest a..d: a and b fail on infrastructure (eligible, oldest first), c is a
// code failure, d passes. One unrelated record (key f…f, repo /fake/z) shares
// the state but binds to no manifest input and must survive untouched.
async function seed() {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-drain-'));
  const manifest = join(dir, 'manifest.json'); const source = join(dir, 'state.json'); const outDir = join(dir, 'out');
  const [a, b, c, d] = [input('/fake/a', 'a'), input('/fake/b', 'b'), input('/fake/c', 'c'), input('/fake/d', 'd')];
  const entry = (i: DetachedPostMergeRunnerInput, checkedAt: string, extra: object = {}) => ({ key: key(i), repo: i.repo, sha: i.mergeCommit, checkedAt, ...base, ...extra });
  const entries = [
    entry(a, '2021-01-01T00:00:00.000Z'), entry(b, '2022-01-01T00:00:00.000Z', { cleanup: 'not-created' }),
    entry(c, '2023-01-01T00:00:00.000Z', { reason: 'code-failure', failureCategory: 'code' }),
    entry(d, '2024-01-01T00:00:00.000Z', { terminal: 'pass', reason: 'verified', failureCategory: null }),
    { key: 'f'.repeat(64), repo: '/fake/z', sha: 'f'.repeat(40), checkedAt: '2020-01-01T00:00:00.000Z', ...base },
  ];
  await mkdir(outDir);
  await writeFile(manifest, JSON.stringify([a, b, c, d]));
  await writeFile(source, JSON.stringify({ version: 1, entries }));
  return { dir, manifest, source, outDir };
}
const argv = (o: Awaited<ReturnType<typeof seed>>, extra: string[] = []) => ['--manifest', o.manifest, '--source-state', o.source, '--output-dir', o.outDir, '--max-retries', '5', '--timeout-ms', '60000', '--json', ...extra];
const exclusive = (run: (i: DetachedPostMergeRunnerInput) => Promise<DetachedPostMergeRunnerResult>) => (options: GuardianOptions) => runGuardianVerifyExclusive(options, { run: o => runGuardianVerifyLoop({ ...o, run }) });
const mute = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
const byRepo = async (path: string) => Object.fromEntries((JSON.parse(await readFile(path, 'utf8')).entries as { repo: string; terminal: string; failureCategory: string | null }[]).map(e => [e.repo, e]));
async function run(args: string[], deps: Parameters<typeof cmdFleetGuardianDrain>[1] = {}) { // stdout captured; returns exit + parsed summaries
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { lines.push(String(v)); });
  try { return { code: await cmdFleetGuardianDrain(args, deps), json: lines.map(l => JSON.parse(l) as Record<string, unknown>) }; }
  finally { spy.mockRestore(); }
}

describe('guardian-drain bounded retry set', () => {
  it('attempts each distinct infra failure once even when the first stays infra-red', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    const verify = exclusive(vi.fn(async () => result('fail')));
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { verify });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ mode: 'apply', termination: 'exhausted', attempts: 2, verified: 2, refused: 0 });
    expect(summary.attempted).toEqual([{ repo: '/fake/a', sha: 'a'.repeat(40) }, { repo: '/fake/b', sha: 'b'.repeat(40) }]);
    expect(summary.latestOutput).toBe(join(o.outDir, 'guardian-drain-attempt-2.json'));
    expect(await readFile(o.source, 'utf8')).toBe(bytes); // source state byte-identical
    const entries = await byRepo(join(o.outDir, 'guardian-drain-attempt-2.json'));
    // still-red records stay; code-failure, pass and unrelated records survive
    expect([entries['/fake/a']!.failureCategory, entries['/fake/b']!.failureCategory,
      entries['/fake/c']!.failureCategory, entries['/fake/d']!.terminal, entries['/fake/z']!.terminal])
      .toEqual(['infra', 'infra', 'code', 'pass', 'fail']);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('drains every eligible failure and carries the latest complete verified state forward', async () => {
    const o = await seed();
    const run0 = vi.fn(async () => result('pass'));
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { verify: exclusive(run0) });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ termination: 'drained', attempts: 2, verified: 2 });
    // attempt-2's state is built on attempt-1's verified output: a is pass there.
    const entries = await byRepo(join(o.outDir, 'guardian-drain-attempt-2.json'));
    expect([entries['/fake/a']!.terminal, entries['/fake/b']!.terminal]).toEqual(['pass', 'pass']);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('plans read-only by default: writes nothing, verifies nothing', async () => {
    const o = await seed();
    const verify = vi.fn();
    const { code, json } = await run(argv(o), { verify });
    expect(code).toBe(0);
    expect(json[0]).toMatchObject({ mode: 'preview', termination: 'planned', attempts: 0, verified: 0, latestOutput: null,
      planned: [{ repo: '/fake/a', sha: 'a'.repeat(40) }] });
    await writeFile(o.source, JSON.stringify({ version: 1, entries: [] }));
    const second = await run(argv(o), { verify });
    expect(second.json[0]).toMatchObject({ termination: 'no-work', planned: [] });
    expect(verify).not.toHaveBeenCalled();
    expect(existsSync(join(o.outDir, 'guardian-drain-attempt-1.json'))).toBe(false);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('refuses to overwrite an existing per-attempt output', async () => {
    const o = await seed();
    const attempt = join(o.outDir, 'guardian-drain-attempt-1.json');
    await writeFile(attempt, 'keep');
    const verify = vi.fn();
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { verify });
    expect(code).toBe(3);
    expect(summary).toMatchObject({ termination: 'collision', attempts: 0 });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(attempt, 'utf8')).toBe('keep');
    await rm(o.dir, { recursive: true, force: true });
  });
  it('stops admitting work at the total deadline and never invokes the next verification', async () => {
    const o = await seed();
    let t = 1_000;
    const run0 = vi.fn(async () => { t += 61_000; return result('pass'); }); // consumes the whole 60s budget
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { now: () => t, verify: exclusive(run0) });
    expect(code).toBe(4);
    expect(summary).toMatchObject({ termination: 'deadline', attempts: 1, verified: 1 });
    expect(run0).toHaveBeenCalledTimes(1);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('stops on exclusive-verification refusal and never carries unverified output', async () => {
    const o = await seed();
    const verify = vi.fn(async (): Promise<GuardianVerifyExclusiveResult> => ({ state: 'refused', reason: 'already-running' }));
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { verify });
    expect(code).toBe(5);
    expect(summary).toMatchObject({ termination: 'refused', attempts: 1, verified: 0, refused: 1, latestOutput: null });
    expect(verify).toHaveBeenCalledTimes(1);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('validates malformed input before any verification and writes nothing', async () => {
    const o = await seed();
    await writeFile(o.manifest, '{');
    const verify = vi.fn();
    const { code, json: [summary] } = await run(argv(o, ['--apply']), { verify });
    expect(code).toBe(3);
    expect(summary).toMatchObject({ termination: 'unsafe', attempts: 0 });
    expect(verify).not.toHaveBeenCalled();
    expect(existsSync(join(o.outDir, 'guardian-drain-attempt-1.json'))).toBe(false);
    await rm(o.dir, { recursive: true, force: true });
  });
  it('rejects invalid, duplicated and out-of-range arguments before any work', async () => {
    const o = await seed();
    const bytes = await readFile(o.source, 'utf8');
    const verify = vi.fn(); const err = mute();
    const bound = (flag: string, value: string) =>
      ['--manifest', o.manifest, '--source-state', o.source, '--output-dir', o.outDir,
        flag === '--max-retries' ? '--timeout-ms' : '--max-retries', flag === '--max-retries' ? '60000' : '5', flag, value, '--apply'];
    try {
      for (const args of [
        bound('--max-retries', '0'), bound('--max-retries', '21'), bound('--max-retries', 'abc'), bound('--max-retries', '1.5'),
        bound('--timeout-ms', '0'), bound('--timeout-ms', '-5'), bound('--timeout-ms', String(GUARDIAN_VERIFY_MAX_TIMEOUT_MS + 1)),
        [...argv(o), '--bogus'], [...argv(o), '--apply', '--apply'], [...argv(o), '--json', '--json'],
        [...argv(o, ['--apply']), '--manifest'], // trailing flag without a value
        ['--manifest', 'relative.json', ...argv(o).slice(2)], // non-absolute --manifest
        argv(o).slice(2), // missing --manifest
      ]) {
        expect(await cmdFleetGuardianDrain(args, { verify }), args.join(' ')).toBe(2);
      }
      expect(await readFile(o.source, 'utf8')).toBe(bytes);
      expect(existsSync(join(o.outDir, 'guardian-drain-attempt-1.json'))).toBe(false);
    } finally { err.mockRestore(); await rm(o.dir, { recursive: true, force: true }); }
    expect(verify).not.toHaveBeenCalled();
  });
});
