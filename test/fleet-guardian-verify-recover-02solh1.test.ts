import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import { drainGuardianInfraRetries } from '../src/core/fleet/guardian-retry-drain.js';
import { runGuardianVerifyLoop, type GuardianOptions } from '../src/core/fleet/guardian-verify-loop.js';
import type { GuardianVerifyExclusiveResult } from '../src/core/fleet/guardian-verify-exclusive.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const input = (repo: string, digit: string): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
const key = (i: DetachedPostMergeRunnerInput) => createHash('sha256').update(JSON.stringify([i.repo, i.cohortId, i.proposalId, i.baseBranch, i.baseHead, i.candidateHead, i.mergeCommit, null, null, null])).digest('hex');
const result = (terminal: 'pass' | 'fail'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const base = { terminal: 'fail', reason: 'verification-infrastructure', failureCategory: 'infra', cleanup: 'removed' };
const entry = (i: DetachedPostMergeRunnerInput, extra: object = {}) => ({ key: key(i), repo: i.repo, sha: i.mergeCommit, checkedAt: '2024-01-01T00:00:00.000Z', ...base, ...extra });
const RAN: GuardianVerifyExclusiveResult = { state: 'ran', summary: { passes: 1, pass: 1, fail: 1, unknown: 0, cancelled: false, deadlineExceeded: false } };

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

// Default fixture: a is an eligible infra failure, b verified, plus an unrelated
// record bound to no manifest input that must pass through untouched and never count.
async function seed(inputs = [input('/fake/a', 'a'), input('/fake/b', 'b')], entries?: object[]) {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-verify-recover-')); dirs.push(dir);
  const manifest = join(dir, 'manifest.json'); const state = join(dir, 'state.json'); const outDir = join(dir, 'out');
  await mkdir(outDir);
  await writeFile(manifest, JSON.stringify(inputs));
  await writeFile(state, JSON.stringify({ version: 1, entries: entries ?? [
    entry(inputs[0]!), entry(inputs[1]!, { terminal: 'pass', reason: 'verified', failureCategory: null }),
    { key: 'f'.repeat(64), repo: '/fake/z', sha: 'f'.repeat(40), checkedAt: '2020-01-01T00:00:00.000Z', ...base },
  ] }));
  return { dir, manifest, state, outDir };
}
const argv = (o: Awaited<ReturnType<typeof seed>>, extra: string[] = []) =>
  ['--manifest', o.manifest, '--state', o.state, '--timeout-ms', '60000', '--retry-infra', '5', '--retry-output-dir', o.outDir, '--json', ...extra];
const viaLoop = (detached: NonNullable<GuardianOptions['run']>) => (options: GuardianOptions) => runGuardianVerifyLoop({ ...options, run: detached });
async function invoke(args: string[], detached: NonNullable<GuardianOptions['run']>, deps: Parameters<typeof cmdFleetGuardianVerify>[2] = {}) {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((v?: unknown) => { lines.push(String(v)); });
  try { return { code: await cmdFleetGuardianVerify(args, viaLoop(detached), deps), json: lines.map(l => JSON.parse(l) as Record<string, unknown>) }; }
  finally { spy.mockRestore(); }
}
// Detached verifier that blocks until the run's signal aborts; started() fires on entry.
const blocker = () => {
  let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const detached = vi.fn((_i: DetachedPostMergeRunnerInput, opts?: { signal?: AbortSignal }) => {
    started();
    return new Promise<DetachedPostMergeRunnerResult>((_res, rej) => opts?.signal?.addEventListener('abort', () => rej(new Error('interrupted')), { once: true }));
  });
  return { detached, begun };
};
const byRepo = async (path: string) => Object.fromEntries((JSON.parse(await readFile(path, 'utf8')).entries as { repo: string; terminal: string; failureCategory: string | null }[]).map(e => [e.repo, e]));

describe('guardian-verify --retry-infra recovery', () => {
  it('verifies main, then drains the eligible infra failure through the real selector/prepare/verify flow', async () => {
    const o = await seed();
    const bytes = await readFile(o.state, 'utf8');
    const detached = vi.fn(async () => result('pass'));
    const { code, json: [out] } = await invoke(argv(o), detached);
    expect(code).toBe(0);
    expect(out.verify).toMatchObject({ state: 'ran', summary: { pass: 1, fail: 1, unknown: 0 } });
    expect(out.retry).toMatchObject({ mode: 'apply', termination: 'drained', attempts: 1, verified: 1, refused: 0,
      attempted: [{ repo: '/fake/a', sha: 'a'.repeat(40) }] });
    expect(out.latestState).toBe(join(o.outDir, 'guardian-drain-attempt-1.json'));
    expect(out.recovered).toBe(1);
    expect(out.final).toMatchObject({ pass: 2, fail: 0, unknown: 0 }); // unrelated z never counted
    expect(detached).toHaveBeenCalledTimes(1); // only the retried identity re-verified
    expect(await readFile(o.state, 'utf8')).toBe(bytes); // source never overwritten
    const entries = await byRepo(join(o.outDir, 'guardian-drain-attempt-1.json'));
    expect([entries['/fake/a']!.terminal, entries['/fake/b']!.terminal, entries['/fake/z']!.terminal]).toEqual(['pass', 'pass', 'fail']);
  });

  it('keeps code failures red with zero retries and an untouched state', async () => {
    const c = input('/fake/c', 'c');
    const o = await seed([c], [entry(c, { reason: 'code-failure', failureCategory: 'code' })]);
    const bytes = await readFile(o.state, 'utf8');
    const detached = vi.fn(async () => result('pass'));
    const { code, json: [out] } = await invoke(argv(o), detached);
    expect(code).toBe(1);
    expect(out.retry).toMatchObject({ termination: 'no-work', attempts: 0, verified: 0, attempted: [] });
    expect(out).toMatchObject({ recovered: 0, latestState: o.state, final: { fail: 1 } });
    expect(detached).not.toHaveBeenCalled();
    expect(await readdir(o.outDir)).toEqual([]);
    expect(await readFile(o.state, 'utf8')).toBe(bytes);
  });

  it('shares one deadline across both phases and admits only the remaining budget', async () => {
    const d = input('/fake/d', 'd'); // absent from state: phase 1 verifies it and spends budget
    const o = await seed([input('/fake/a', 'a'), input('/fake/b', 'b'), d]);
    let t = 1_000;
    const drain = vi.fn(drainGuardianInfraRetries);
    const detached = vi.fn(async () => { t += 30_000; return result('pass'); });
    const { code, json: [out] } = await invoke(argv(o), detached, { drain, now: () => t });
    expect(code).toBe(4);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(drain.mock.calls[0]![0]).toMatchObject({ sourceState: o.state, apply: true, timeoutMs: 30_000 });
    expect(out.retry).toMatchObject({ termination: 'deadline', attempts: 1, verified: 1 });
    expect(out.latestState).toBe(join(o.outDir, 'guardian-drain-attempt-1.json'));
    expect(out.recovered).toBe(1);
    expect(detached).toHaveBeenCalledTimes(2); // phase 1 verifies d, drain verifies a
  });

  it('a refused first phase exits 5 and never starts recovery', async () => {
    const o = await seed();
    const drain = vi.fn(drainGuardianInfraRetries);
    const verify = vi.fn(async (): Promise<GuardianVerifyExclusiveResult> => ({ state: 'refused', reason: 'already-running' }));
    const { code, json: [out] } = await invoke(argv(o), vi.fn(), { drain, verify });
    expect(code).toBe(5);
    expect(out).toMatchObject({ verify: { state: 'refused', reason: 'already-running', ran: false },
      retry: null, retrySkipped: 'refused', latestState: null, recovered: 0 });
    expect(drain).not.toHaveBeenCalled();
  });

  it('a refused drain attempt exits 5 and never adopts the prepared attempt state', async () => {
    const o = await seed();
    const bytes = await readFile(o.state, 'utf8');
    const verify = vi.fn()
      .mockResolvedValueOnce(RAN)
      .mockResolvedValue({ state: 'refused', reason: 'lock-unavailable' } as GuardianVerifyExclusiveResult);
    const { code, json: [out] } = await invoke(argv(o), vi.fn(), { verify });
    expect(code).toBe(5);
    expect(out.retry).toMatchObject({ termination: 'refused', attempts: 1, verified: 0, refused: 1 });
    expect(out.recovered).toBe(0);
    expect(out.latestState).toBe(o.state); // prepared attempt never adopted
    expect(await readFile(o.state, 'utf8')).toBe(bytes);
  });

  it('cancelled or deadline-exhausted first phases exit 3/4 and never start recovery', async () => {
    const d = input('/fake/d', 'd');
    const drain = vi.fn(drainGuardianInfraRetries);
    const first = blocker();
    const cancelled = invoke(argv(await seed([d], [])), first.detached, { drain });
    await first.begun;
    process.emit('SIGINT');
    const doneCancelled = await cancelled;
    expect(doneCancelled.code).toBe(3);
    expect(doneCancelled.json[0]).toMatchObject({ retry: null, retrySkipped: 'cancelled' });

    vi.useFakeTimers();
    const second = blocker();
    const deadline = invoke(argv(await seed([d], [])), second.detached, { drain });
    await second.begun;
    await vi.advanceTimersByTimeAsync(60_000);
    const doneDeadline = await deadline;
    expect(doneDeadline.code).toBe(4);
    expect(doneDeadline.json[0]).toMatchObject({ retry: null, retrySkipped: 'deadline' });
    expect(drain).not.toHaveBeenCalled();
  });

  it('an existing attempt file stays a collision refusal and is never overwritten', async () => {
    const o = await seed();
    const attempt = join(o.outDir, 'guardian-drain-attempt-1.json');
    await writeFile(attempt, 'keep');
    const detached = vi.fn(async () => result('pass'));
    const { code, json: [out] } = await invoke(argv(o), detached);
    expect(code).toBe(3);
    expect(out.retry).toMatchObject({ termination: 'collision', attempts: 0, verified: 0 });
    expect(await readFile(attempt, 'utf8')).toBe('keep');
    expect(detached).not.toHaveBeenCalled();
  });

  it('rejects incomplete or invalid retry combinations before any work', async () => {
    const o = await seed();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const detached = vi.fn(async () => result('pass'));
    const T = ['--timeout-ms', '60000'];
    for (const extra of [
      ['--retry-infra', '2'],
      ['--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '2'],
      [...T, '--retry-output-dir', o.outDir],
      ['--retry-infra', '2', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '0', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '21', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', 'abc', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '2', '--retry-output-dir', 'relative/dir'],
      [...T, '--retry-infra', '2', '--retry-infra', '3', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '--json', '--retry-output-dir', o.outDir],
      [...T, '--retry-infra', '2', '--retry-output-dir', o.outDir, '--bogus'],
    ]) {
      expect(await cmdFleetGuardianVerify(['--manifest', o.manifest, '--state', o.state, ...extra], viaLoop(detached)), extra.join(' ')).toBe(2);
    }
    expect(detached).not.toHaveBeenCalled();
    expect(await readdir(o.outDir)).toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it('keeps legacy single-phase behavior and the injected run seam when retry flags are absent', async () => {
    const o = await seed();
    const detached = vi.fn(async () => result('pass'));
    const { code, json } = await invoke(['--manifest', o.manifest, '--state', o.state, '--json'], detached);
    expect(code).toBe(1);
    expect(json).toHaveLength(1);
    expect(json[0]).toMatchObject({ pass: 1, fail: 1, unknown: 0, cancelled: false, deadlineExceeded: false });
    expect(json[0]).not.toHaveProperty('retry');
    expect(await cmdFleetGuardianVerify(['--manifest', o.manifest, '--state', o.state, '--timeout-ms', '60000'], viaLoop(detached))).toBe(1);
    expect(detached).not.toHaveBeenCalled();
    expect(await readdir(o.outDir)).toEqual([]);
  });
});
