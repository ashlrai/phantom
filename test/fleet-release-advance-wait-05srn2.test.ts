import { describe, expect, it, vi } from 'vitest';
import { waitForReleaseAdvance, type WaitOptions } from '../src/core/fleet/release-advance-wait.js';
import { cmdFleetReleaseAdvanceWait } from '../src/cli/fleet-release-advance-wait.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const repo = 'ashlrai/phantom';
const tag = 'v3.30.8';
const report = (patch: Partial<ReleaseAdvanceReport> = {}): ReleaseAdvanceReport => ({
  version: 1, repo, tag, apply: false, outcome: 'no-op', reason: 'attest_in_flight', planOutcome: 'ready',
  candidate: { sha: null, tree: null }, master: { branch: null, sha: null, tree: null }, masterMoved: null,
  treeMatch: null, gateRun: null, producerArtifact: null, attestedRun: null,
  inFlightRun: { id: 1, attempt: 1, status: 'queued' }, release: { state: 'draft', id: 1 }, blockers: [],
  dispatch: { ref: null, inputs: null, invoked: false, accepted: false, detail: null }, truncated: false, ...patch,
});
function harness(reports: ReleaseAdvanceReport[]) {
  let time = 0;
  const action = vi.fn(async () => reports.shift() ?? report());
  const sleep = vi.fn(async (ms: number) => { time += ms; });
  const opts: WaitOptions = { action, sleep, now: () => time, timeoutMs: 10, pollMs: 3 };
  return { opts, action, sleep };
}
describe('release advance wait', () => {
  it('observes pending immediately and waits for attestation without overlapping reads', async () => {
    const h = harness([report(), report({ attestedRun: { id: 2, attempt: 1 }, inFlightRun: null })]);
    const result = await waitForReleaseAdvance(repo, tag, h.opts);
    expect(result).toMatchObject({ stopReason: 'attested', observations: 2, latest: { attestedRun: { id: 2 } } });
    expect(h.sleep).toHaveBeenCalledTimes(1);
  });
  it('stops for a published release', async () => {
    const h = harness([report({ release: { state: 'published', id: 2 } })]);
    expect(await waitForReleaseAdvance(repo, tag, h.opts)).toMatchObject({ stopReason: 'published', observations: 1 });
    expect(h.sleep).not.toHaveBeenCalled();
  });
  it('delegates apply only once even if subsequent evidence is planned', async () => {
    const h = harness([report({ outcome: 'submitted', inFlightRun: null }), report({ outcome: 'planned', inFlightRun: null }), report({ attestedRun: { id: 2, attempt: 1 } })]);
    expect((await waitForReleaseAdvance(repo, tag, { ...h.opts, apply: true })).stopReason).toBe('attested');
    expect(h.action.mock.calls.map(call => (call as unknown as [string, string, { apply: boolean }])[2].apply)).toEqual([true, false, false]);
  });
  it.each(['blocked', 'refused', 'unavailable'] as const)('preserves %s and its reason', async outcome => {
    const h = harness([report({ outcome, reason: 'original_reason' })]);
    expect(await waitForReleaseAdvance(repo, tag, h.opts)).toMatchObject({ stopReason: outcome, observations: 1, latest: { reason: 'original_reason' } });
  });
  it('distinguishes a plan from a pending timeout', async () => {
    expect((await waitForReleaseAdvance(repo, tag, harness([report({ outcome: 'planned' })]).opts)).stopReason).toBe('planned');
    const h = harness([report()]);
    expect(await waitForReleaseAdvance(repo, tag, h.opts)).toMatchObject({ stopReason: 'timeout', observations: 4, latest: { reason: 'attest_in_flight' } });
  });
  it('stops on abort and cleans up CLI signal handlers', async () => {
    const controller = new AbortController();
    const h = harness([report()]);
    h.opts.sleep = async () => { controller.abort(); };
    const listeners = process.listenerCount('SIGINT');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdFleetReleaseAdvanceWait(['--repo', repo, '--tag', tag, '--json'], { ...h.opts, signal: controller.signal })).toBe(130);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ stopReason: 'aborted', observations: 1 });
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    } finally { log.mockRestore(); }
  });
  it('reports an unfinished action on deadline without starting another', async () => {
    const action = vi.fn(() => new Promise<ReleaseAdvanceReport>(() => {}));
    const result = await waitForReleaseAdvance(repo, tag, { action, timeoutMs: 5 });
    expect(result).toMatchObject({ stopReason: 'timeout', observations: 0, latest: null, actionInFlight: true });
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid bounds before observing', async () => {
    const h = harness([]);
    await expect(waitForReleaseAdvance(repo, tag, { ...h.opts, timeoutMs: 0 })).rejects.toThrow(RangeError);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try { expect(await cmdFleetReleaseAdvanceWait(['--repo', repo, '--tag', tag, '--poll-ms', '1.5'], h.opts)).toBe(2); }
    finally { err.mockRestore(); }
    expect(h.action).not.toHaveBeenCalled();
  });
  it('uses the real adapter with a read-only fake GitRunner', async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (_bin, argv) => {
      calls.push([...argv]);
      return { code: 1, stdout: '', stderr: 'unavailable', timedOut: false, truncated: false, missing: false };
    };
    const result = await waitForReleaseAdvance(repo, tag, { runner, timeoutMs: 1000 });
    expect(result).toMatchObject({ stopReason: 'unavailable', observations: 1 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c[0] === 'api')).toBe(true);
  });
});
