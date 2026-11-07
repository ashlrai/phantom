import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceOnce } from '../src/cli/fleet-release-advance-once.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.7'; // Fixture SHAs and run ids only, not production state.
const CAND = 'a'.repeat(40);
const OTHER = 'e'.repeat(40);
const INPUTS = { ci_run_id: 777001, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: 555001 };

let stateDir: string;
let output: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rao-retry-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const ARGS = ['--repo', REPO, '--tag', TAG, '--json'];
const APPLY = [...ARGS, '--apply'];
const report = () => JSON.parse(output[output.length - 1]!);
const candidateDir = () => join(stateDir, 'ashlrai', 'phantom', TAG);
const receiptPath = () => join(candidateDir(), 'receipt.json');
const receipt = () => JSON.parse(readFileSync(receiptPath(), 'utf8'));

const run = (id: number, patch: Record<string, unknown> = {}) => ({
  id, attempt: 1, status: 'completed', conclusion: 'failure',
  headSha: CAND, event: 'workflow_dispatch', ...patch,
});
const failed = (id: number) => run(id);
const success = (id: number) => run(id, { conclusion: 'success' });
const inFlight = (id: number) => run(id, { status: 'in_progress', conclusion: null });

const base = (patch: Record<string, unknown> = {}): ReleaseAdvanceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome: 'planned', reason: 'eligible',
  planOutcome: 'ready',
  candidate: { sha: CAND, tree: 'b'.repeat(40) },
  master: { branch: 'master', sha: CAND, tree: 'b'.repeat(40) },
  masterMoved: false, treeMatch: true,
  gateRun: { id: INPUTS.ci_run_id, attempt: 1, conclusion: 'success' },
  producerArtifact: { id: INPUTS.build_artifact_id, name: 'a', expired: false },
  attestedRun: null, inFlightRun: null, attestOnCandidate: [],
  release: { state: 'draft', id: 1 }, blockers: [],
  dispatch: { ref: 'master', inputs: INPUTS, invoked: false, accepted: false, detail: null },
  truncated: false, ...patch,
});
const submitted = (patch: Record<string, unknown> = {}) => base({
  apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
  dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: true, detail: null }, ...patch,
});
const rejected = () => base({
  apply: true, outcome: 'refused', reason: 'dispatch_rejected',
  dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: false, detail: 'denied' },
});

type Advance = (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;
const seq = (reports: ReleaseAdvanceReport[]): { advance: Advance; calls: { apply?: boolean }[] } => {
  const calls: { apply?: boolean }[] = [];
  let i = 0;
  return { calls, advance: async (r, t, o) => { calls.push(o); return reports[Math.min(i++, reports.length - 1)]!; } };
};
const applies = (calls: { apply?: boolean }[]) => calls.filter(c => c.apply === true).length;

describe('fleet release-advance-once terminal recovery', () => {
  it('retries a terminally failed recorded dispatch once, then dedupes during visibility lag', async () => {
    const f = seq([
      submitted(),                                      // apply 1: no attest runs visible yet
      base({ attestOnCandidate: [failed(900)] }),       // probe: R1 failed, postdates the dispatch
      submitted({ attestOnCandidate: [failed(900)] }),  // apply 2: R1 becomes the new frontier
      base({ attestOnCandidate: [failed(900)] }),       // probe: R1 at frontier — lag, not a new failure
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(receipt()).toMatchObject({ candidateSha: CAND, attempt: 1, seenRunId: null });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted', receipt: { state: 'recorded' } });
    expect(receipt()).toMatchObject({ candidateSha: CAND, attempt: 2, seenRunId: 900 });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded', receipt: { state: 'matched' } });
    expect(applies(f.calls)).toBe(2);
    expect(f.calls).toHaveLength(4);
  });
  it('a newer terminal failure after a retry unlocks another attempt', async () => {
    const f = seq([
      submitted(),
      base({ attestOnCandidate: [failed(900)] }),
      submitted({ attestOnCandidate: [failed(900)] }),
      base({ attestOnCandidate: [failed(901), failed(900)] }),   // retry's own run now failed too
      submitted({ attestOnCandidate: [failed(901), failed(900)] }),
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted' });
    expect(receipt()).toMatchObject({ attempt: 3, seenRunId: 901 });
    expect(applies(f.calls)).toBe(3);
  });
  it('an older failed attempt at or below the frontier never unlocks', async () => {
    const f = seq([
      submitted({ attestOnCandidate: [inFlight(950)] }),        // frontier 950 recorded at acceptance
      base({ attestOnCandidate: [failed(900), inFlight(950)] }),// failed run predates the dispatch
      base({ attestOnCandidate: [failed(950)] }),               // the frontier run itself failed
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(receipt()).toMatchObject({ candidateSha: CAND, attempt: 1, seenRunId: 950 });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', receipt: { state: 'matched' } });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
    expect(applies(f.calls)).toBe(1);
  });
  it('in-flight or successful evidence still never dispatches again', async () => {
    const f = seq([
      submitted(),
      base({ attestOnCandidate: [inFlight(900)], inFlightRun: { id: 900, attempt: 1, status: 'in_progress' } }),
      base({ attestOnCandidate: [success(900)], attestedRun: { id: 900, attempt: 1 } }),
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded' });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
    expect(applies(f.calls)).toBe(1);
  });
  it('a receipt with no visible remote run stays deduped', async () => {
    const f = seq([submitted(), base({ attestOnCandidate: [] })]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(receipt()).toMatchObject({ seenRunId: null });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded' });
    expect(applies(f.calls)).toBe(1);
  });
  it('a receipt written before the run frontier existed stays deduped', async () => {
    mkdirSync(candidateDir(), { recursive: true });
    writeFileSync(receiptPath(), JSON.stringify({
      version: 1, repo: REPO, tag: TAG, candidateSha: CAND,
      submittedAt: '2026-11-05T02:37:00.000Z', ref: 'master', inputs: INPUTS,
    }));
    const f = seq([base({ attestOnCandidate: [failed(900)] })]);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { stateDir, advance: f.advance })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded' });
    expect(f.calls).toHaveLength(1); // probe only — ambiguity never unlocks
  });
  it('a non-dispatch run or mismatched gate inputs never unlock', async () => {
    const f = seq([
      submitted(),
      base({ attestOnCandidate: [run(900, { event: 'schedule' })] }),   // scheduled failure is not the dispatch's run
      base({ attestOnCandidate: [run(900, { headSha: OTHER })] }),      // failure on another sha
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
    expect(applies(f.calls)).toBe(1);
    // A recorded dispatch whose inputs disagree with its candidate cannot bind.
    writeFileSync(receiptPath(), JSON.stringify({
      version: 1, repo: REPO, tag: TAG, candidateSha: CAND, submittedAt: '2026-11-05T02:37:00.000Z',
      ref: 'master', inputs: { ...INPUTS, candidate_sha: OTHER }, attempt: 1, seenRunId: null,
    }));
    const g = seq([base({ attestOnCandidate: [failed(900)] })]);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { stateDir, advance: g.advance })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
    expect(g.calls).toHaveLength(1);
  });
  it('a recovery retry under lock contention reports busy without dispatching', async () => {
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { stateDir, advance: seq([submitted()]).advance })).toBe(0);
    let finish!: (r: ReleaseAdvanceReport) => void;
    const calls: { apply?: boolean }[] = [];
    const advance: Advance = (r, t, o) => {
      calls.push(o);
      return o.apply ? new Promise<ReleaseAdvanceReport>(res => { finish = res; })
        : Promise.resolve(base({ attestOnCandidate: [failed(900)] }));
    };
    const p1 = cmdFleetReleaseAdvanceOnce(APPLY, { stateDir, advance }); // holds the lock in a pending apply
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { stateDir, advance })).toBe(4);
    expect(report()).toMatchObject({ outcome: 'busy', reason: 'lock_contended', lock: 'busy', advance: null });
    finish(submitted({ attestOnCandidate: [failed(900)] }));
    expect(await p1).toBe(0);
    expect(applies(calls)).toBe(1);
  });
  it('a rejected retry keeps the recorded receipt intact and retryable', async () => {
    const f = seq([
      submitted(),
      base({ attestOnCandidate: [failed(900)] }),
      rejected(),                                       // retry dispatch refused by gh
      base({ attestOnCandidate: [failed(900)] }),
      submitted({ attestOnCandidate: [failed(900)] }),
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    const before = readFileSync(receiptPath(), 'utf8');
    expect(JSON.parse(before)).toMatchObject({ attempt: 1, seenRunId: null });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(1);
    expect(report()).toMatchObject({ outcome: 'refused', reason: 'dispatch_rejected', receipt: { state: 'terminal-failed' } });
    expect(readFileSync(receiptPath(), 'utf8')).toBe(before); // prior receipt preserved verbatim
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(receipt()).toMatchObject({ attempt: 2, seenRunId: 900 });
    expect(applies(f.calls)).toBe(3);
  });
  it('an unlocked retry still yields to the refreshed eligibility decision', async () => {
    const f = seq([
      submitted(),
      base({ attestOnCandidate: [failed(900)] }),       // bound failure unlocks
      base({ apply: true, outcome: 'no-op', reason: 'attest_in_flight',
        inFlightRun: { id: 901, attempt: 1, status: 'in_progress' },
        attestOnCandidate: [inFlight(901), failed(900)] }), // fresher evidence wins: nothing sent
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    const before = readFileSync(receiptPath(), 'utf8');
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'no-op', reason: 'attest_in_flight', receipt: { state: 'terminal-failed' } });
    expect(readFileSync(receiptPath(), 'utf8')).toBe(before);
    expect(applies(f.calls)).toBe(2);
  });
  it('a repointed tag still never inherits the receipt or its frontier', async () => {
    const otherInputs = { ...INPUTS, candidate_sha: OTHER };
    const other = { candidate: { sha: OTHER, tree: 'f'.repeat(40) } };
    const f = seq([
      submitted({ attestOnCandidate: [inFlight(950)] }),   // frontier 950 on CAND
      base(other),                                          // probe: tag now names OTHER
      submitted({ ...other,
        dispatch: { ref: 'master', inputs: otherInputs, invoked: true, accepted: true, detail: null } }),
      base(other),                                          // probe: dedupe on OTHER
    ]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(receipt()).toMatchObject({ candidateSha: OTHER, attempt: 1, seenRunId: null });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
  });
  it('a dry run with failure evidence delegates read-only and writes nothing', async () => {
    const f = seq([base({ attestOnCandidate: [failed(900)] })]);
    expect(await cmdFleetReleaseAdvanceOnce(ARGS, { stateDir, advance: f.advance })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'planned', lock: 'not-taken', apply: false });
    expect(f.calls[0]!.apply).toBeUndefined();
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });
});
