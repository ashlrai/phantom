import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForReleaseAdvance } from '../src/core/fleet/release-advance-wait.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.9'; // Fixture SHAs only, not production state.
const CAND = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const GATE = 777001;
const ART = 555001;
const ATTEST = 888001;
const INPUTS = { ci_run_id: GATE, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: ART };
const base = `repos/${REPO}`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const busted = () => res(1, '', 'gh: boom');
const run = (id: number, sha: string, patch: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed',
  conclusion: 'success', event: 'workflow_dispatch', ...patch,
});
const runs = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'raw-ser-')); });
const candidateDir = () => join(stateDir, 'ashlrai', 'phantom', TAG);
const receiptPath = () => join(candidateDir(), 'receipt.json');

/**
 * The whole production composition — real waitForReleaseAdvance, real
 * advanceReleaseCandidateOnce, real advanceReleaseCandidate — over a fake gh.
 * `runVisible` models GitHub's run-list lag: an accepted dispatch only appears
 * in the attest runs list once it flips. The attest run reports in_progress
 * for the first read after becoming visible, then success.
 */
function world() {
  const state = { runVisible: false, attestReads: 0 };
  const calls: string[][] = [];
  const hooks: { onDispatch: (() => GitRunResult | Promise<GitRunResult>) | undefined } = { onDispatch: undefined };
  const routes = (): Record<string, GitRunResult> => ({
    [base]: ok({ full_name: REPO, default_branch: 'master' }),
    [`${base}/git/ref/tags/${TAG}`]: ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } }),
    [`${base}/git/commits/${CAND}`]: ok({ sha: CAND, tree: { sha: TREE } }),
    [`${base}/branches/master`]: ok({ name: 'master', commit: { sha: CAND, commit: { tree: { sha: TREE } } } }),
    [`${base}/releases?per_page=100&page=1`]: ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: CAND }]),
    [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]:
      ok(runs([run(GATE, CAND, { path: '.github/workflows/ci.yml' })])),
    [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
      ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'f'.repeat(64)}`, expired: false }] }),
  });
  const attestRuns = (): unknown => {
    if (!state.runVisible) return runs([]);
    state.attestReads += 1;
    const done = state.attestReads >= 2;
    return runs([run(ATTEST, CAND, { path: '.github/workflows/attest-ci-build.yml', ...(done ? {} : { status: 'in_progress', conclusion: null }) })]);
  };
  const ATTEST_ROUTE = `${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`;
  const gh: GitRunner = async (_bin, argv) => {
    const args = [...argv];
    calls.push(args);
    // The attest inventory is counted lazily: evaluating it for every gh call
    // would fake reads the planner never made.
    if (args[0] === 'api') return args[1] === ATTEST_ROUTE ? ok(attestRuns()) : (routes()[args[1]!] ?? busted());
    if (args[0] === 'workflow') return hooks.onDispatch ? hooks.onDispatch() : ok('');
    return busted();
  };
  return { gh, state, hooks, calls, dispatches: () => calls.filter(c => c[0] === 'workflow') };
}

describe('fleet release-advance-wait serialization', () => {
  it('two concurrent --apply waiters submit at most once during run-list lag', async () => {
    const w = world();
    let entered!: () => void;
    let release!: () => void;
    const enteredP = new Promise<void>(r => { entered = r; });
    const releaseP = new Promise<void>(r => { release = r; });
    w.hooks.onDispatch = () => { entered(); return releaseP.then(() => { w.state.runVisible = true; return ok(''); }); };
    const waiterA = waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, timeoutMs: 4000, pollMs: 25 });
    await enteredP; // A holds the per-candidate lock, suspended mid-dispatch.
    const waiterB = waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, timeoutMs: 3000, pollMs: 25 });
    await delay(60); // B's first observation hits the busy lock, then it only watches.
    release(); // GitHub accepts A's dispatch; the run finally becomes visible.
    const [reportA, reportB] = await Promise.all([waiterA, waiterB]);
    expect(reportA).toMatchObject({ stopReason: 'attested', actionInFlight: false,
      serialization: { outcome: 'submitted', lock: 'acquired', receipt: { state: 'recorded' } } });
    expect(reportA.observations).toBeGreaterThan(1); // an accepted dispatch is not treated as published
    expect(reportB).toMatchObject({ stopReason: 'attested',
      serialization: { outcome: 'busy', lock: 'busy', reason: 'lock_contended' } });
    expect(w.dispatches()).toHaveLength(1); // exactly one dispatch across both supervisors
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8'))).toMatchObject({ candidateSha: CAND, repo: REPO, tag: TAG });
  });
  it('a recorded submission is observed without a second dispatch', async () => {
    const w = world();
    w.state.runVisible = true;
    mkdirSync(candidateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath(), `${JSON.stringify({ version: 1, repo: REPO, tag: TAG, candidateSha: CAND, submittedAt: new Date().toISOString(), ref: 'master', inputs: INPUTS })}\n`, { mode: 0o600 });
    const report = await waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, timeoutMs: 3000, pollMs: 25 });
    expect(report).toMatchObject({ stopReason: 'attested',
      serialization: { outcome: 'already-submitted', reason: 'dispatch_recorded', lock: 'acquired', receipt: { state: 'matched', record: { candidateSha: CAND } } } });
    expect(report.observations).toBeGreaterThan(1); // kept watching real attestation progress
    expect(w.dispatches()).toHaveLength(0);
  });
  it('a malformed receipt fails closed and dispatches nothing', async () => {
    const w = world();
    mkdirSync(candidateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath(), '{torn');
    const report = await waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, timeoutMs: 1000, pollMs: 25 });
    expect(report).toMatchObject({ stopReason: 'unavailable', observations: 1,
      serialization: { outcome: 'unavailable', reason: 'receipt_unreadable', receipt: { state: 'unreadable' } } });
    expect(w.dispatches()).toHaveLength(0);
  });
  it('a dry run creates no once state', async () => {
    const w = world();
    const report = await waitForReleaseAdvance(REPO, TAG, { runner: w.gh, stateDir, timeoutMs: 1000, pollMs: 25 });
    expect(report).toMatchObject({ stopReason: 'planned', observations: 1, serialization: null });
    expect(w.dispatches()).toHaveLength(0);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });
  it('reports an unfinished serialized dispatch on deadline', async () => {
    const w = world();
    let release!: (r: GitRunResult) => void;
    const releaseP = new Promise<GitRunResult>(r => { release = r; });
    w.hooks.onDispatch = () => releaseP;
    const report = await waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, timeoutMs: 60, pollMs: 20 });
    expect(report).toMatchObject({ stopReason: 'timeout', observations: 0, latest: null, actionInFlight: true });
    release(ok('')); // the orphaned serialized call may still finish — and records honestly
    await delay(150);
    expect(existsSync(receiptPath())).toBe(true);
  });
  it('reports an unfinished serialized dispatch on abort', async () => {
    const w = world();
    const controller = new AbortController();
    let release!: (r: GitRunResult) => void;
    const releaseP = new Promise<GitRunResult>(r => { release = r; });
    w.hooks.onDispatch = () => { controller.abort(); return releaseP; };
    const report = await waitForReleaseAdvance(REPO, TAG, { apply: true, runner: w.gh, stateDir, signal: controller.signal, timeoutMs: 4000, pollMs: 20 });
    expect(report).toMatchObject({ stopReason: 'aborted', observations: 0, actionInFlight: true });
    release(ok(''));
    await delay(150);
  });
});
