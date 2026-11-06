import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseCandidate } from '../src/cli/fleet-release-candidate.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const repo = 'ashlrai/phantom';
const sha = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const other = 'c'.repeat(40);
const base = `repos/${repo}`;
const result = (body: unknown, code = 0): GitRunResult => ({ code, stdout: JSON.stringify(body), stderr: code ? 'HTTP 404' : '', timedOut: false, truncated: false, missing: false });
const branch = (s = sha, t = tree) => result({ commit: { sha: s, commit: { tree: { sha: t } } } });
const run = { id: 10, run_attempt: 1, head_sha: sha, head_branch: 'master', status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/ci.yml' };
const routes = (): Record<string, GitRunResult> => ({
  [base]: result({ full_name: repo, default_branch: 'master' }),
  [`${base}/git/commits/${sha}`]: result({ sha, tree: { sha: tree } }),
  [`${base}/branches/master`]: branch(),
  [`${base}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=master&per_page=100`]: result({ total_count: 1, workflow_runs: [run] }),
  [`${base}/actions/workflows/attest-ci-build.yml/runs?head_sha=${sha}&branch=master&per_page=100`]: result({ total_count: 0, workflow_runs: [] }),
  [`${base}/actions/runs/10/artifacts?per_page=100`]: result({ total_count: 1, artifacts: [{ id: 11, name: 'ashlr-build-10-1', expired: false }] }),
});
let output: string[];
beforeEach(() => { output = []; vi.spyOn(console, 'log').mockImplementation(v => { output.push(String(v)); }); vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });
afterEach(() => vi.restoreAllMocks());
function fake(map = routes(), moved = false) {
  const calls: string[][] = []; let branches = 0;
  const gh: GitRunner = async (_bin, argv) => { calls.push(argv); if (argv[1] === `${base}/branches/master` && ++branches === 2 && moved) return branch(other, other); return map[argv[1]!] ?? result({}, 1); };
  return { gh, calls };
}
const args = ['--repo', repo, '--sha', sha, '--json'];
const plan = () => JSON.parse(output.at(-1)!);

describe('release candidate SHA inspection', () => {
  it('binds evidence to the requested commit and never invents a release', async () => {
    const f = fake(); expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(0);
    expect(plan()).toMatchObject({ outcome: 'ready', candidate: { sha, tree }, release: { state: 'not_selected' }, gateRun: { headSha: sha }, producerArtifact: { id: 11 } });
    expect(f.calls.every(c => c[0] === 'api')).toBe(true);
    expect(f.calls.some(c => c[1]?.includes('/releases'))).toBe(false);
    expect(plan().nextActions.map((a: { command?: string }) => a.command ?? '').join(' ')).not.toMatch(/--tag|v3\./);
  });
  it('blocks when master moves while evidence is read', async () => {
    const f = fake(routes(), true); expect(await cmdFleetReleaseCandidate(args, { gh: f.gh })).toBe(1);
    expect(plan()).toMatchObject({ outcome: 'blocked', master: { sha: other }, treeMatch: false });
    expect(plan().blockers.map((b: { id: string }) => b.id)).toContain('master_tree_mismatch');
  });
  it.each([result({ sha: other, tree: { sha: tree } }), result({}, 1)])('does not accept an invalid commit response (%#)', async response => {
    const map = routes(); map[`${base}/git/commits/${sha}`] = response;
    expect(await cmdFleetReleaseCandidate(args, { gh: fake(map).gh })).toBe(3);
    expect(plan().outcome).toBe('unavailable');
  });
  it('rejects malformed, missing, or conflicting selectors without calls', async () => {
    const f = fake();
    for (const a of [['--repo', repo, '--sha', 'abc'], ['--repo', repo], ['--repo', repo, '--sha', sha, '--tag', 'v1.2.3']]) expect(await cmdFleetReleaseCandidate(a, { gh: f.gh })).toBe(2);
    expect(f.calls).toEqual([]);
  });
});
