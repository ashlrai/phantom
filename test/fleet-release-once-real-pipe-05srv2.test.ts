import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceOnce } from '../src/cli/fleet-release-advance-once.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

/**
 * RQ-PHX-RELEASEONCEREALPIPE05SRV2 — release acceptance coverage for the real
 * pipe: cmdFleetReleaseAdvanceOnce -> advanceReleaseCandidateOnce ->
 * advanceReleaseCandidate -> planReleaseCandidate, with ONLY the `gh`
 * transport faked. `deps.advance` is never provided, so the production
 * planner, wrapper and dispatch path all run. Two supervisors share one
 * stateDir against a fake remote whose attest run listing stays empty after
 * an accepted dispatch (GitHub visibility lag), so the persisted receipt is
 * the only evidence that can stop a second attestation. Fixture repo, SHAs
 * and run ids only — no real GitHub writes.
 */

const REPO = 'acme-fixtures/widget';
const TAG = 'v9.9.9';
const CAND = 'a'.repeat(40);
const TREE_C = 'b'.repeat(40);
const OTHER = 'e'.repeat(40);
const TREE_O = 'f'.repeat(40);
const GATE = 777001;
const ART = 555001;
const GATE2 = 777002;
const ART2 = 555002;
const base = `repos/${REPO}`;
const ATTEST_RUNS = `${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const busted = () => res(1, '', 'gh: boom');

/** Mutable fake GitHub. `dispatches` records every `gh workflow run` argv;
 *  the run listings never learn about them — that gap IS the lag. */
interface World {
  candidate: string;
  trees: Record<string, string>;
  masterSha: string;
  masterTree: string;
  gateId: number;
  artifactId: number;
  rejectDispatch: boolean;
  apiCalls: string[];
  dispatches: string[][];
}

/** Complete eligible evidence: tag -> candidate, matching trees, one green
 *  workflow_dispatch ci.yml gate run with its immutable producer artifact, a
 *  draft release targeting the candidate, and zero attest runs. */
const eligible = (): World => ({
  candidate: CAND,
  trees: { [CAND]: TREE_C, [OTHER]: TREE_O },
  masterSha: CAND,
  masterTree: TREE_C,
  gateId: GATE,
  artifactId: ART,
  rejectDispatch: false,
  apiCalls: [],
  dispatches: [],
});

const gateRun = (w: World) => ({
  id: w.gateId, run_attempt: 1, head_sha: w.candidate, head_branch: 'master',
  status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
  path: '.github/workflows/ci.yml', repository: { full_name: REPO },
});

/** One supervisor's gh handle. Any number of handles share a world; the only
 *  supervisor-local state is the CLI's stateDir. */
const gh = (w: World): GitRunner => async (_bin, argv) => {
  const args = [...argv];
  if (args[0] === 'workflow') {
    w.dispatches.push(args);
    return w.rejectDispatch ? res(1, '', 'gh: workflow dispatch rejected (HTTP 422)') : ok('');
  }
  if (args[0] !== 'api') return busted();
  const path = args[1]!;
  w.apiCalls.push(path);
  if (path === base) return ok({ full_name: REPO, default_branch: 'master' });
  if (path === `${base}/git/ref/tags/${TAG}`) return ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: w.candidate } });
  const commit = path.match(/\/git\/commits\/([0-9a-f]{40})$/)?.[1];
  if (commit !== undefined) {
    const tree = w.trees[commit];
    return tree === undefined ? busted() : ok({ sha: commit, tree: { sha: tree } });
  }
  if (path === `${base}/branches/master`)
    return ok({ name: 'master', commit: { sha: w.masterSha, commit: { tree: { sha: w.masterTree } } } });
  if (path === `${base}/releases?per_page=100&page=1`)
    return ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: w.candidate }]);
  const ci = path.match(/\/ci\.yml\/runs\?head_sha=([0-9a-f]{40})&branch=master&per_page=100$/)?.[1];
  if (ci !== undefined)
    return ok(ci === w.candidate ? { total_count: 1, workflow_runs: [gateRun(w)] } : { total_count: 0, workflow_runs: [] });
  if (path === ATTEST_RUNS) return ok({ total_count: 0, workflow_runs: [] }); // lag: accepted dispatch not yet visible
  if (path === `${base}/actions/runs/${w.gateId}/artifacts?per_page=100`)
    return ok({ total_count: 1, artifacts: [{ id: w.artifactId, name: `ashlr-build-${w.gateId}-1`, digest: `sha256:${'0'.repeat(64)}`, expired: false }] });
  return busted();
};

const APPLY = ['--repo', REPO, '--tag', TAG, '--apply', '--json'];
const inputs = (sha: string, gate: number, art: number) =>
  ({ ci_run_id: gate, ci_run_attempt: 1, candidate_sha: sha, build_artifact_id: art });
const dispatchArgv = (sha: string, gate: number, art: number) => [
  'workflow', 'run', 'attest-ci-build.yml', '--repo', REPO, '--ref', 'master',
  '-f', `ci_run_id=${gate}`, '-f', 'ci_run_attempt=1',
  '-f', `candidate_sha=${sha}`, '-f', `build_artifact_id=${art}`,
];

let stateDir: string;
let output: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rao-pipe-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

const report = () => JSON.parse(output[output.length - 1]!);
const receiptPath = () => join(stateDir, 'acme-fixtures', 'widget', TAG, 'receipt.json');
const receipt = () => JSON.parse(readFileSync(receiptPath(), 'utf8'));

describe('fleet release-advance-once real pipe (gh transport seam only)', () => {
  it('two supervisors sharing stateDir submit one attestation during visibility lag', async () => {
    const world = eligible();
    const supervisorA = gh(world);
    const supervisorB = gh(world); // a second local process: own transport, same remote, same stateDir

    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: supervisorA, stateDir })).toBe(0);
    const first = report();
    expect(first).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted', lock: 'acquired' });
    expect(first.receipt).toMatchObject({ state: 'recorded' });
    expect(first.advance.dispatch).toMatchObject({ invoked: true, accepted: true });
    expect(first.advance.dispatch.inputs).toEqual(inputs(CAND, GATE, ART));
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART)]);
    expect(receipt()).toMatchObject({ version: 1, repo: REPO, tag: TAG, candidateSha: CAND,
      ref: 'master', attempt: 1, inputs: inputs(CAND, GATE, ART), seenRunId: null });

    // GitHub still shows no attest run anywhere: the accepted dispatch is invisible.
    const apiBefore = world.apiCalls.length;
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: supervisorB, stateDir })).toBe(0);
    const second = report();
    expect(second).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded', lock: 'acquired' });
    expect(second.receipt).toMatchObject({ state: 'matched' });
    expect(second.receipt.record).toMatchObject({ candidateSha: CAND, inputs: inputs(CAND, GATE, ART) });
    // The probe ran the real planner and STILL found the candidate eligible
    // with no attest evidence — absent the receipt it would have dispatched.
    expect(world.apiCalls.length).toBeGreaterThan(apiBefore);
    expect(second.advance).toMatchObject({ outcome: 'planned', reason: 'eligible', planOutcome: 'ready' });
    expect(second.advance.attestedRun).toBeNull();
    expect(second.advance.inFlightRun).toBeNull();
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART)]); // exactly one across both supervisors
  });

  it('a rejected dispatch leaves no receipt and a later retry submits through the real path', async () => {
    const world = eligible();
    world.rejectDispatch = true;
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(1);
    expect(report()).toMatchObject({ outcome: 'refused', reason: 'dispatch_rejected',
      receipt: { state: 'none' } });
    expect(existsSync(receiptPath())).toBe(false); // a failed dispatch never records
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART)]);

    world.rejectDispatch = false;
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(0);
    const retried = report();
    expect(retried).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted',
      receipt: { state: 'recorded' } });
    expect(retried.advance.dispatch.inputs).toEqual(inputs(CAND, GATE, ART));
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART), dispatchArgv(CAND, GATE, ART)]);
    expect(receipt()).toMatchObject({ candidateSha: CAND, attempt: 1 });

    // The retried receipt dedupes the next supervisor exactly like a first-try one.
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded' });
    expect(world.dispatches).toHaveLength(2);
  });

  it('a repointed tag never inherits the old receipt', async () => {
    const world = eligible();
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(0);
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART)]);
    expect(receipt()).toMatchObject({ candidateSha: CAND });

    // The tag now names OTHER: fresh gate + artifact evidence on the new sha,
    // master moved with it, and remote attest listings stay empty.
    Object.assign(world, { candidate: OTHER, masterSha: OTHER, masterTree: TREE_O,
      gateId: GATE2, artifactId: ART2 });
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(0);
    const repointed = report();
    expect(repointed).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted',
      receipt: { state: 'recorded' } });
    expect(repointed.advance.dispatch.inputs).toEqual(inputs(OTHER, GATE2, ART2));
    expect(world.dispatches).toEqual([dispatchArgv(CAND, GATE, ART), dispatchArgv(OTHER, GATE2, ART2)]);
    expect(receipt()).toMatchObject({ candidateSha: OTHER, attempt: 1, inputs: inputs(OTHER, GATE2, ART2) });

    // Now the OTHER receipt dedupes; the CAND receipt is gone entirely.
    expect(await cmdFleetReleaseAdvanceOnce(APPLY, { gh: gh(world), stateDir })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'already-submitted', receipt: { state: 'matched' } });
    expect(report().receipt.record.candidateSha).toBe(OTHER);
    expect(world.dispatches).toHaveLength(2);
  });
});
