import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARDIAN_VERIFY_DEADLINE, runGuardianVerifyLoop, type GuardianOptions, type GuardianSummary } from '../src/core/fleet/guardian-verify-loop.js';
import { cmdFleetGuardianVerify } from '../src/cli/fleet-guardian-verify.js';
import type { DetachedPostMergeRunnerInput, DetachedPostMergeRunnerResult } from '../src/core/fleet/detached-post-merge-runner.js';

const result = (terminal: 'pass' | 'fail' | 'unknown'): DetachedPostMergeRunnerResult => ({ schemaVersion: 1, authority: 'observation-only', policyEligible: false, mergePermitted: false, rollbackPermitted: false, deployPermitted: false, terminal, reason: terminal === 'pass' ? 'verified' : terminal === 'fail' ? 'code-failure' : 'verification-infrastructure', verifierManifestDigest: null, requiredCommandCount: 1, commandsRun: 1, failureCategory: terminal === 'fail' ? 'code' : terminal === 'unknown' ? 'infra' : null, cleanup: 'removed', recordDisposition: 'recorded' });
const input = (repo: string, digit = 'a'): DetachedPostMergeRunnerInput => ({ repo, cohortId: 'cohort', proposalId: 'proposal', baseBranch: 'master', baseHead: 'b'.repeat(40), candidateHead: 'c'.repeat(40), mergeCommit: digit.repeat(40) });
async function setup(entries: DetachedPostMergeRunnerInput[]) {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-deadline-'));
  const manifest = join(dir, 'manifest.json'); const state = join(dir, 'state.json');
  await writeFile(manifest, JSON.stringify(entries));
  return { manifest, state };
}
const viaLoop = (run: NonNullable<GuardianOptions['run']>): ((options: GuardianOptions) => Promise<GuardianSummary>) => options => runGuardianVerifyLoop({ ...options, run });
async function recorded(state: string): Promise<{ terminal: string; reason: string; failureCategory: string | null }[]> {
  return (JSON.parse(await readFile(state, 'utf8')) as { entries: { terminal: string; reason: string; failureCategory: string | null }[] }).entries;
}
function blocker(signals: (AbortSignal | undefined)[], started: () => void) {
  return vi.fn((_item: DetachedPostMergeRunnerInput, options?: { signal?: AbortSignal }) => {
    signals.push(options?.signal); started();
    return new Promise<DetachedPostMergeRunnerResult>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
    });
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('guardian-verify total deadline', () => {
  it('aborts an in-flight verification at the deadline and reports exhaustion without claiming verified or code failure', async () => {
    const opts = await setup([input('/fake/a'), input('/fake/b')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signals: (AbortSignal | undefined)[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const run = blocker(signals, started);
    const deadline = cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--timeout-ms', '1000', '--json'], viaLoop(run));
    await inFlight;
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await deadline).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe(GUARDIAN_VERIFY_DEADLINE);
    expect(JSON.parse(String(log.mock.calls[0]![0])) as GuardianSummary)
      .toMatchObject({ passes: 1, pass: 0, fail: 0, unknown: 1, cancelled: false, deadlineExceeded: true });
    expect(await recorded(opts.state)).toEqual([expect.objectContaining({ terminal: 'unknown', reason: 'verification-timeout', failureCategory: 'timeout' })]);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires while waiting between passes and never launches another verification', async () => {
    const opts = await setup([input('/fake/a')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    let started!: () => void;
    const first = new Promise<void>(resolve => { started = resolve; });
    const run = vi.fn(async () => { started(); return result('unknown'); });
    const deadline = cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--max-passes', '2', '--interval-ms', '5000', '--timeout-ms', '2000', '--json'], viaLoop(run));
    await first;
    await vi.waitFor(async () => { expect(await recorded(opts.state)).toHaveLength(1); }, { interval: 5, timeout: 400 });
    await Promise.resolve(); await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await deadline).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])) as GuardianSummary)
      .toMatchObject({ passes: 1, unknown: 1, cancelled: false, deadlineExceeded: true });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('completes normally with a deadline armed, clears timer and listeners, and stays compatible when the flag is omitted', async () => {
    const opts = await setup([input('/fake/a')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const run = vi.fn(async () => result('pass'));
    expect(await cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--timeout-ms', '86400000'], viaLoop(run))).toBe(0);
    expect(log.mock.calls[0]![0]).toBe('guardian-verify: pass=1 fail=0 unknown=0 cancelled=false');
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
    expect(await cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--json'], viaLoop(run))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]![0])) as GuardianSummary).toMatchObject({ pass: 1, cancelled: false, deadlineExceeded: false });
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps user cancellation distinct from deadline exhaustion', async () => {
    const opts = await setup([input('/fake/a')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const signals: (AbortSignal | undefined)[] = [];
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const run = blocker(signals, started);
    const cancelled = cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, '--timeout-ms', '60000', '--json'], viaLoop(run));
    await inFlight;
    expect(process.listenerCount('SIGINT')).toBe(counts[0]! + 1);
    process.emit('SIGINT');
    expect(await cancelled).toBe(3);
    expect(signals[0]?.reason).not.toBe(GUARDIAN_VERIFY_DEADLINE);
    expect(JSON.parse(String(log.mock.calls[0]![0])) as GuardianSummary)
      .toMatchObject({ pass: 0, fail: 0, unknown: 1, cancelled: true, deadlineExceeded: false });
    expect(await recorded(opts.state)).toEqual([expect.objectContaining({ terminal: 'unknown', reason: 'verification-infrastructure', failureCategory: 'cancelled' })]);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBeLessThanOrEqual(counts[0]!);
    expect(process.listenerCount('SIGTERM')).toBe(counts[1]);
  });

  it('rejects malformed or duplicated --timeout-ms with exit 2 before any work starts', async () => {
    const opts = await setup([input('/fake/a')]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const counts = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const loop = vi.fn(viaLoop(async () => result('pass')));
    for (const extra of [
      ['--timeout-ms'],
      ['--timeout-ms', '--json'],
      ['--timeout-ms', 'abc'],
      ['--timeout-ms', '0'],
      ['--timeout-ms', '-1'],
      ['--timeout-ms', '1.5'],
      ['--timeout-ms', '86400001'],
      ['--timeout-ms', '99999999999999999999'],
      ['--timeout-ms', '10', '--timeout-ms', '20'],
    ]) {
      expect(await cmdFleetGuardianVerify(['--manifest', opts.manifest, '--state', opts.state, ...extra], loop), extra.join(' ')).toBe(2);
    }
    expect(loop).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(counts);
  });
});
