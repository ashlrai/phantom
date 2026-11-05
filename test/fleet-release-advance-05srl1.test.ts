import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseAdvance } from '../src/cli/fleet-release-advance.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.7'; // Fixture SHAs only, not production state.
const CAND = 'a'.repeat(40);
const TREE_C = 'b'.repeat(40);
const MASTER = 'c'.repeat(40);
const TREE_M = 'd'.repeat(40);
const OTHER = 'e'.repeat(40);
const GATE = 777001;
const ART = 555001;
const ATTEST = 888001;
const base = `repos/${REPO}`;

const res = (code: number, stdout: unknown, stderr = ''): GitRunResult =>
  ({ code, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr, timedOut: false, truncated: false, missing: false });
const ok = (body: unknown) => res(0, body);
const busted = () => res(1, '', 'gh: boom');
const run = (id: number, sha: string, patch: Record<string, unknown> = {}) => ({
  id, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed',
  conclusion: 'success', event: 'workflow_dispatch', repository: { full_name: REPO }, ...patch,
});
const runs = (rows: unknown[]) => ({ total_count: rows.length, workflow_runs: rows });
const ciRun = (sha: string, patch: Record<string, unknown> = {}) => run(GATE, sha, { path: '.github/workflows/ci.yml', ...patch });
const attestRun = (sha: string, patch: Record<string, unknown> = {}) => run(ATTEST, sha, { path: '.github/workflows/attest-ci-build.yml', ...patch });
const branch = (sha: string, tree: string) => ok({ name: 'master', commit: { sha, commit: { tree: { sha: tree } } } });
const draft = () => ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: CAND }]);

const routes = (patch: Record<string, GitRunResult> = {}): Record<string, GitRunResult> => ({
  [base]: ok({ full_name: REPO, default_branch: 'master' }),
  [`${base}/git/ref/tags/${TAG}`]: ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } }),
  [`${base}/git/commits/${CAND}`]: ok({ sha: CAND, tree: { sha: TREE_C } }),
  [`${base}/branches/master`]: branch(CAND, TREE_C), // master head IS the candidate: ready
  [`${base}/releases?per_page=100&page=1`]: draft(),
  [`${base}/actions/workflows/ci.yml/runs?head_sha=${CAND}&branch=master&per_page=100`]: ok(runs([ciRun(CAND)])),
  [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]: ok(runs([])),
  [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
    ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: `sha256:${'f'.repeat(64)}`, expired: false }] }),
  ...patch,
});
function fake(map: Record<string, GitRunResult> | ((argv: string[]) => GitRunResult), send: GitRunResult = ok('')) {
  const calls: string[][] = [];
  const gh: GitRunner = async (bin, argv) => {
    const args = [...argv];
    calls.push(args);
    if (args[0] === 'api') return typeof map === 'function' ? map(args) : map[args[1]!] ?? busted();
    if (args[0] === 'workflow') return send;
    return busted();
  };
  return { gh, calls, dispatches: () => calls.filter(c => c[0] === 'workflow') };
}

let output: string[];
beforeEach(() => {
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
const args = ['--repo', REPO, '--tag', TAG, '--json'];
const report = () => JSON.parse(output[output.length - 1]!);
const DISPATCH_ARGV = ['workflow', 'run', 'attest-ci-build.yml', '--repo', REPO, '--ref', 'master',
  '-f', `ci_run_id=${GATE}`, '-f', 'ci_run_attempt=1', '-f', `candidate_sha=${CAND}`, '-f', `build_artifact_id=${ART}`];

describe('fleet release-advance', () => {
  it('dry-run proposes the typed dispatch and mutates nothing', async () => {
    const f = fake(routes());
    expect(await cmdFleetReleaseAdvance(args, { gh: f.gh })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ outcome: 'planned', reason: 'eligible', apply: false, planOutcome: 'ready' });
    expect(r.dispatch).toMatchObject({ ref: 'master', invoked: false, accepted: false,
      inputs: { ci_run_id: GATE, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: ART } });
    expect(f.dispatches()).toEqual([]); // only bounded `gh api` reads ran
    expect(f.calls.every(c => c[0] === 'api')).toBe(true);
  });
  it('--apply sends exactly the existing workflow inputs once', async () => {
    const f = fake(routes());
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted',
      dispatch: { invoked: true, accepted: true } });
    expect(f.dispatches()).toEqual([DISPATCH_ARGV]);
  });
  it('refresh under --apply refuses a master that moved after the first read', async () => {
    let branchReads = 0;
    const f = fake(argv => {
      if (argv[1] === `${base}/branches/master`) {
        branchReads += 1;
        return branchReads === 1 ? branch(CAND, TREE_C) : branch(MASTER, TREE_M); // master moved on refresh
      }
      return routes()[argv[1]!] ?? busted();
    });
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(1);
    const r = report();
    expect(r).toMatchObject({ outcome: 'blocked', reason: 'blocker:master_tree_mismatch', planOutcome: 'blocked' });
    expect(r.blockers.map((b: { id: string }) => b.id)).toContain('master_tree_mismatch');
    expect(f.dispatches()).toEqual([]);
  });
  it('a pending attest on the candidate is a no-op, even under --apply', async () => {
    const f = fake(routes({
      [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]:
        ok(runs([attestRun(CAND, { status: 'in_progress', conclusion: null })])),
    }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ outcome: 'no-op', reason: 'attest_in_flight' });
    expect(r.inFlightRun).toMatchObject({ id: ATTEST, status: 'in_progress' });
    expect(f.dispatches()).toEqual([]);
  });
  it('terminal states are no-ops: successful attest or published release', async () => {
    const attest = fake(routes({
      [`${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`]:
        ok(runs([attestRun(CAND)])),
    }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: attest.gh })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'no-op', reason: 'already_attested', attestedRun: { id: ATTEST } });
    const published = fake(routes({
      [`${base}/releases?per_page=100&page=1`]:
        ok([{ id: 42, tag_name: TAG, draft: false, prerelease: false, assets: [], target_commitish: CAND }]),
    }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: published.gh })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'no-op', reason: 'already_published' });
    expect(attest.dispatches()).toEqual([]);
    expect(published.dispatches()).toEqual([]);
  });
  it('a repeated apply observes the pending attest and never double-submits', async () => {
    const calls: string[][] = [];
    const gh: GitRunner = async (bin, argv) => {
      const a = [...argv];
      calls.push(a);
      if (a[0] === 'api' && a[1] === `${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`
        && calls.some(c => c[0] === 'workflow')) {
        return ok(runs([attestRun(CAND, { status: 'queued', conclusion: null })])); // the dispatch just sent
      }
      if (a[0] === 'api') return routes()[a[1]!] ?? busted();
      return a[0] === 'workflow' ? ok('') : busted();
    };
    const dispatches = () => calls.filter(c => c[0] === 'workflow');
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh })).toBe(0);
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh })).toBe(0);
    expect(report()).toMatchObject({ outcome: 'no-op', reason: 'attest_in_flight' });
    expect(dispatches()).toEqual([DISPATCH_ARGV]); // exactly one dispatch across both invocations
  });
  it('an expired or missing producer artifact blocks the dispatch', async () => {
    const expired = fake(routes({
      [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]:
        ok({ total_count: 1, artifacts: [{ id: ART, name: `ashlr-build-${GATE}-1`, digest: null, expired: true }] }),
    }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: expired.gh })).toBe(1);
    expect(report().blockers.map((b: { id: string }) => b.id)).toContain('producer_artifact_expired');
    const missing = fake(routes({
      [`${base}/actions/runs/${GATE}/artifacts?per_page=100`]: ok({ total_count: 0, artifacts: [] }),
    }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: missing.gh })).toBe(1);
    expect(report().blockers.map((b: { id: string }) => b.id)).toContain('producer_artifact_missing');
    expect(expired.dispatches()).toEqual([]);
    expect(missing.dispatches()).toEqual([]);
  });
  it('a dispatch rejection is refused with bounded scrubbed detail', async () => {
    const noise = `${'x'.repeat(400)}\nghp_${'s'.repeat(60)}\n\x1b[31m`;
    const f = fake(routes(), res(1, '', noise));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(1);
    const r = report();
    expect(r).toMatchObject({ outcome: 'refused', reason: 'dispatch_rejected',
      dispatch: { invoked: true, accepted: false } });
    expect(r.dispatch.detail.length).toBeLessThanOrEqual(200);
    expect(r.dispatch.detail).not.toContain('ghp_');
    expect(r.dispatch.detail.includes('\n')).toBe(false);
    expect(r.dispatch.detail.includes(String.fromCharCode(27))).toBe(false);
    expect(f.dispatches()).toEqual([DISPATCH_ARGV]);
  });
  it('a repointed tag between reads refuses changed_before_apply', async () => {
    let tagReads = 0;
    const f = fake(argv => {
      if (argv[1] === `${base}/git/ref/tags/${TAG}`) {
        tagReads += 1;
        return tagReads === 1
          ? ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: CAND } })
          : ok({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: OTHER } });
      }
      return routes()[argv[1]!] ?? busted();
    });
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(1);
    expect(report()).toMatchObject({ outcome: 'refused', reason: 'changed_before_apply' });
    expect(f.dispatches()).toEqual([]);
  });
  it('malformed evidence stays unavailable and dispatches nothing', async () => {
    const f = fake(routes({ [`${base}/git/commits/${CAND}`]: res(0, '{broken') }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(3);
    expect(report()).toMatchObject({ outcome: 'unavailable', planOutcome: 'unavailable' });
    expect(f.dispatches()).toEqual([]);
  });
  it('a blocked candidate never dispatches, including the v3.30.7 master-moved handoff', async () => {
    const f = fake(routes({ [`${base}/branches/master`]: branch(MASTER, TREE_M) }));
    expect(await cmdFleetReleaseAdvance([...args, '--apply'], { gh: f.gh })).toBe(1);
    expect(report().blockers.map((b: { id: string }) => b.id)).toContain('master_tree_mismatch');
    expect(f.dispatches()).toEqual([]);
  });
  it('exits 2 on invalid arguments and 0 on help', async () => {
    expect(await cmdFleetReleaseAdvance(['--repo', REPO, '--json'])).toBe(2);
    expect(await cmdFleetReleaseAdvance(['--repo', REPO, '--tag', 'latest', '--json'])).toBe(2);
    expect(await cmdFleetReleaseAdvance(['--repo', 'bad/repo!', '--tag', TAG, '--json'])).toBe(2);
    expect(await cmdFleetReleaseAdvance(['--help'])).toBe(0);
  });
});
