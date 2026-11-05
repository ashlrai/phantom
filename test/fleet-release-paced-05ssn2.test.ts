import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleasePaced } from '../src/cli/fleet-release-paced.js';
import { advanceReleaseCandidatePaced } from '../src/core/fleet/release-paced.js';
import { advanceReleaseCandidateOnce, type ReleaseAdvanceOnceOptions, type ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'fake-owner/fake-repo';
const TAG = 'v9.9.9';
const CAND = 'a'.repeat(40);
const INPUTS = { ci_run_id: 1, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: 2 };
const MS = 60_000;

let root: string;
let stateDir: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rp-')); stateDir = join(root, 'pace'); });
afterEach(() => vi.restoreAllMocks());
const pacePath = () => join(stateDir, 'fake-owner', 'fake-repo', TAG, 'pace.json');

const base = (patch: Record<string, unknown> = {}): ReleaseAdvanceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome: 'planned', reason: 'eligible', planOutcome: 'ready',
  candidate: { sha: CAND, tree: 'b'.repeat(40) }, master: { branch: 'master', sha: CAND, tree: 'b'.repeat(40) },
  masterMoved: false, treeMatch: true, gateRun: { id: 1, attempt: 1, conclusion: 'success' },
  producerArtifact: { id: 2, name: 'a', expired: false }, attestedRun: null, inFlightRun: null,
  release: { state: 'draft', id: 1 }, blockers: [],
  dispatch: { ref: 'master', inputs: INPUTS, invoked: false, accepted: false, detail: null }, truncated: false, ...patch,
});
const onceReport = (outcome: ReleaseAdvanceOnceReport['outcome'], accepted: boolean): ReleaseAdvanceOnceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: true, outcome, reason: outcome, lock: 'acquired',
  receipt: { state: 'none', record: null },
  advance: base({ outcome: outcome === 'submitted' ? 'submitted' : 'refused', dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted, detail: null } }),
});
const fakeOnce = (seq: ReleaseAdvanceOnceReport['outcome'][]) => {
  const calls: ReleaseAdvanceOnceOptions[] = [];
  let i = 0;
  const once = async (_r: string, _t: string, o: ReleaseAdvanceOnceOptions) => {
    calls.push(o);
    const outcome = seq[Math.min(i++, seq.length - 1)]!;
    return onceReport(outcome, outcome === 'submitted');
  };
  return { once, calls, applies: () => calls.filter(c => c.apply === true).length };
};

describe('fleet release-paced', () => {
  it('dry run delegates without apply and writes no state', async () => {
    const f = fakeOnce(['planned']);
    const r = await advanceReleaseCandidatePaced(REPO, TAG, { stateDir, once: f.once });
    expect(r).toMatchObject({ outcome: 'planned', apply: false });
    expect(f.calls[0]!.apply).toBeUndefined();
    expect(existsSync(stateDir)).toBe(false);
  });

  it('defers an immediate repeat with nextEligibleAt and the prior sha, then delegates at the boundary', async () => {
    let t = 1_000_000;
    const f = fakeOnce(['submitted', 'already-submitted']);
    const o = { stateDir, once: f.once, now: () => t, retryAfterMs: MS, apply: true };
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'submitted', pace: 'recorded' });
    t += MS - 1;
    const d = await advanceReleaseCandidatePaced(REPO, TAG, o);
    expect(d).toMatchObject({ outcome: 'deferred', pace: 'cooling', priorCandidateSha: CAND, once: null });
    expect(d.nextEligibleAt).toBe(new Date(1_000_000 + MS).toISOString());
    expect(f.calls).toHaveLength(1);
    t += 1; // exactly due
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'already-submitted', pace: 'due' });
    expect(f.calls).toHaveLength(2);
    // Non-submitting delegate must not refresh the accepted timestamp.
    expect(JSON.parse(readFileSync(pacePath(), 'utf8')).acceptedAtMs).toBe(1_000_000);
  });

  it('two concurrent calls produce at most one underlying apply', async () => {
    let finish!: (r: ReleaseAdvanceOnceReport) => void;
    const calls: ReleaseAdvanceOnceOptions[] = [];
    const once = (_r: string, _t: string, o: ReleaseAdvanceOnceOptions) => {
      calls.push(o);
      return new Promise<ReleaseAdvanceOnceReport>(res => { finish = res; });
    };
    const o = { stateDir, once, now: () => 5_000_000, apply: true, retryAfterMs: MS };
    const p1 = advanceReleaseCandidatePaced(REPO, TAG, o);
    const second = await advanceReleaseCandidatePaced(REPO, TAG, o);
    expect(second).toMatchObject({ outcome: 'busy', reason: 'pace_lock_contended', once: null });
    finish(onceReport('submitted', true));
    expect(await p1).toMatchObject({ outcome: 'submitted' });
    expect(calls).toHaveLength(1);
  });

  it('a rejected dispatch records nothing and is retryable immediately', async () => {
    const f = fakeOnce(['refused', 'submitted']);
    const o = { stateDir, once: f.once, now: () => 7_000_000, apply: true, retryAfterMs: MS };
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'refused', pace: 'none' });
    expect(existsSync(pacePath())).toBe(false);
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'submitted', pace: 'recorded' });
    expect(f.applies()).toBe(2);
  });

  it('a valid state file survives process-style re-entry via the CLI', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const out: string[] = [];
    (console.log as ReturnType<typeof vi.fn>).mockImplementation((v: unknown) => { out.push(String(v)); });
    const f = fakeOnce(['submitted']);
    const deps = { stateDir, once: f.once, now: () => 9_000_000 };
    const args = ['--repo', REPO, '--tag', TAG, '--apply', '--json', '--retry-after-ms', String(MS)];
    expect(await cmdFleetReleasePaced(args, deps)).toBe(0);
    expect(await cmdFleetReleasePaced(args, deps)).toBe(0);
    expect(JSON.parse(out[1]!)).toMatchObject({ outcome: 'deferred', priorCandidateSha: CAND });
    expect(f.applies()).toBe(1);
    expect(await cmdFleetReleasePaced(['--repo', REPO, '--tag', TAG, '--retry-after-ms', '999'], deps)).toBe(2);
    expect(await cmdFleetReleasePaced(['--repo', REPO, '--tag', TAG, '--retry-after-ms', '3600001'], deps)).toBe(2);
  });

  it('a future timestamp (clock rollback) is ignored and delegates; a corrupt file only disables pacing', async () => {
    const f = fakeOnce(['no-op']);
    const dir = join(stateDir, 'fake-owner', 'fake-repo', TAG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(pacePath(), JSON.stringify({ version: 1, repo: REPO, tag: TAG, candidateSha: CAND, acceptedAtMs: 10 ** 15 }));
    const o = { stateDir, once: f.once, now: () => 1_000, apply: true, retryAfterMs: MS };
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'no-op', pace: 'clock-rollback' });
    writeFileSync(pacePath(), '{not json');
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'no-op', pace: 'unreadable' });
    expect(f.applies()).toBe(2);
  });

  it('never bypasses the real once dedupe', async () => {
    let t = 2_000_000;
    const runs: string[] = [];
    const advance = async (_r: string, _t: string, o: { apply?: boolean }): Promise<ReleaseAdvanceReport> => {
      runs.push(o.apply ? 'apply' : 'probe');
      return o.apply ? base({ apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
        dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: true, detail: null }, attestOnCandidate: [] }) : base();
    };
    const onceDir = join(root, 'once');
    const once = (r: string, tg: string, o: ReleaseAdvanceOnceOptions) =>
      advanceReleaseCandidateOnce(r, tg, { ...o, stateDir: onceDir, advance: advance as never, runner: undefined as unknown as GitRunner });
    const o = { stateDir, once, now: () => t, apply: true, retryAfterMs: MS };
    expect(await advanceReleaseCandidatePaced(REPO, TAG, o)).toMatchObject({ outcome: 'submitted', pace: 'recorded' });
    t += MS; // due: wrapper delegates, the real once still dedupes on the recorded sha
    const second = await advanceReleaseCandidatePaced(REPO, TAG, o);
    expect(second).toMatchObject({ outcome: 'already-submitted', pace: 'due' });
    expect(second.once?.receipt.state).toBe('matched');
    expect(runs.filter(r => r === 'apply')).toHaveLength(1);
    expect(readdirSync(join(onceDir, 'fake-owner', 'fake-repo', TAG))).toContain('receipt.json');
  });
});
