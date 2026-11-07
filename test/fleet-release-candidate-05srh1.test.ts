import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseCandidate } from '../src/cli/fleet-release-candidate.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.7'; // The reported mismatch tag — fixture SHAs only, not production state.
const CAND = 'a'.repeat(40);
const TREE_C = 'b'.repeat(40);
const MASTER = 'c'.repeat(40);
const TREE_M = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const GATE = 777001;
const ART = 555001;
const ATTEST_FAIL = 888001;
const base = `repos/${REPO}`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const notFound = () => res(1, '', 'gh: Not Found (HTTP 404)');
const busted = () => res(1, '', 'gh: boom');
const run = (id: number, sha: string, patch: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed',
  conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: REPO }, ...patch,
});
const runs = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });
const ciRun = (sha: string, patch: Record<string, unknown> = {}) => run(GATE, sha, { path: '.github/workflows/ci.yml', ...patch });
const branch = (sha: string, tree: string) => ok({ name: 'master', commit: { sha, commit: { tree: { sha: tree } } } });
const draft = (assets: unknown[] = []) => ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets, target_commitish: CAND }]);

const routes = (patch: Record<string, GitRunResult> = {}): Record<string, GitRunResult> => ({
  [base]: ok({ full_name: REPO, default_branch: 'master' }),
  [`${base}/git/ref/tags/${TAG}`]: ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } }),
  [`${base}/git/commits/${CAND}`]: ok({ sha: CAND, tree: { sha: TREE_C } }),
  [`${base}/branches/master`]: branch(MASTER, TREE_M),
  [`${base}/releases?per_page=100&page=1`]: draft(),
  [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]: ok(runs([ciRun(CAND)])),
  [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]:
    ok(runs([run(ATTEST_FAIL, MASTER, { path: '.github/workflows/attest-ci-build.yml', conclusion: 'failure', event: 'schedule' })])),
  [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
    ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'f'.repeat(64)}`, expired: false }] }),
  ...patch,
});
function fake(map: Record<string, GitRunResult>) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv) => {
    calls.push([...argv]);
    return argv[0] === 'api' ? map[argv[1]!] ?? busted() : busted();
  };
  return { gh, calls };
}

let output: string[];
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
const args = ['--repo', REPO, '--tag', TAG, '--json'];
const plan = () => JSON.parse(output[output.length - 1]!);
const ids = (p: { blockers: { id: string }[] }) => p.blockers.map(b => b.id);
const masterAt = (sha: string, tree: string) => ({ [`${base}/branches/master`]: branch(sha, tree) });

describe('fleet release-candidate', () => {
  it('reports the master-moved tree mismatch after a green gate (the v3.30.7 handoff)', async () => {
    const f = fake(routes());
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(1);
    const p = plan();
    expect(p).toMatchObject({ outcome: 'blocked', repo: REPO, tag: TAG,
      candidate: { sha: CAND, tree: TREE_C }, master: { sha: MASTER, tree: TREE_M }, masterMoved: true, treeMatch: false });
    expect(ids(p)).toContain('master_tree_mismatch');
    expect(p.gateRun).toMatchObject({ id: GATE, conclusion: 'success', headSha: CAND });
    expect(p.attestOnCandidate).toEqual([]);
    expect(p.attestRecent[0]).toMatchObject({ id: ATTEST_FAIL, headSha: MASTER, conclusion: 'failure' });
    expect(p.nextActions[0].kind).toBe('owner');
    expect(p.nextActions[0].summary).toMatch(/bind the gate and attestation to one immutable candidate/);
    expect(p.nextActions.every((a: { kind: string }) => a.kind !== 'dispatch')).toBe(true);
    expect(f.calls.every(c => c[0] === 'api')).toBe(true); // read-only: never a mutation argv
  });
  it('is ready and prints the evidence-bound attest dispatch when the candidate still matches master', async () => {
    const f = fake(routes(masterAt(CAND, TREE_C)));
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(0);
    const dispatch = plan().nextActions.find((a: { kind: string }) => a.kind === 'dispatch');
    expect(dispatch.command).toBe(`gh workflow run attest-ci-build.yml --repo ${REPO} --ref master -f ci_run_id=${GATE} -f ci_run_attempt=1 -f candidate_sha=${CAND} -f build_artifact_id=${ART}`);
  });
  it('never satisfies candidate evidence with a successful run on another SHA', async () => {
    const f = fake(routes({
      [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]: ok(runs([ciRun(OTHER)])),
      ...masterAt(CAND, TREE_C),
    }));
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(1);
    const p = plan();
    expect(p.gateRun).toBeNull();
    expect(ids(p)).toContain('no_gate_run');
    expect(p.nextActions.every((a: { kind: string }) => a.kind !== 'dispatch')).toBe(true);
  });
  it('reports a missing tag as blocked, not unknown', async () => {
    const f = fake(routes({ [`${base}/git/ref/tags/${TAG}`]: notFound() }));
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(1);
    expect(ids(plan())).toEqual(['tag_missing']);
  });
  it('surfaces an empty-assets draft without inventing assets', async () => {
    const f = fake(routes({ ...masterAt(CAND, TREE_C), [`${base}/releases?per_page=100&page=1`]: draft([]) }));
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(0);
    expect(plan().release).toMatchObject({ state: 'draft', draft: true, assets: 0, id: 42 });
  });
  it('stays unavailable on malformed API data instead of guessing', async () => {
    const f = fake(routes({ [`${base}/git/commits/${CAND}`]: res(0, '{broken') }));
    expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(3);
    expect(plan()).toMatchObject({ outcome: 'unavailable', blockers: [] });
  });
  it('stays unavailable when the runner itself fails', async () => {
    const gh: GitRunner = async () => { throw new Error('spawn failed'); };
    expect(await cmdFleetReleaseCandidate(args, { gh })).toBe(3);
    expect(plan().outcome).toBe('unavailable');
  });
  it('exits 2 on invalid arguments and 0 on help', async () => {
    expect(await cmdFleetReleaseCandidate(['--repo', REPO, '--json'])).toBe(2);
    expect(await cmdFleetReleaseCandidate(['--repo', REPO, '--tag', 'latest', '--json'])).toBe(2);
    expect(await cmdFleetReleaseCandidate(['--repo', 'bad/repo!', '--tag', TAG, '--json'])).toBe(2);
    expect(await cmdFleetReleaseCandidate(['--help'])).toBe(0);
  });
});
