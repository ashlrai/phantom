import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { awaitCiReceiptBatch } from '../src/core/fleet/ci-receipt-await-batch.js';
import { planCiResumeInputs } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const commit = (root: string) => {
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
};
const manifest = (repo: string) => ({ version: 1, repo, shared: ['lockfile'], jobs: [
  { id: 'job-a', command: 'test a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
  { id: 'job-b', command: 'test b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
] });
async function fixture(repo: string, run: number, artifact: number) {
  const root = mkdtempSync(join(tmpdir(), 'batch-planner-')); dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'src/a/a.ts', `${repo} a\n`); put(root, 'src/b/b.ts', `${repo} b\n`);
  const base = commit(root);
  const seed = await planCiResumeInputs({ manifest: manifest(repo), prior: { version: 1, repo, receipts: [] }, base, head: base, cwd: root });
  const jobs = seed.jobs.map((job, index) => ({ job: job.job, jobId: run * 10 + index,
    conclusion: index === 0 ? 'success' : 'failure', inputsDigest: job.baseDigest }));
  return { repo, run, artifact, root, base, jobs, attempt: 1, artifactName: 'ci-resume-receipts' };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Call = { bin: string; args: string[] };
const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (): GitRunResult => ({ code: 1, stdout: '', stderr: 'unexpected fake request', timedOut: false, truncated: false, missing: false });
function fakeGh(fixtures: Fixture[], missing: Fixture, calls: Call[]): GitRunner {
  return async (bin, args) => {
    calls.push({ bin, args: [...args] });
    if (bin !== 'gh') return bad();
    if (args[0] === 'run' && args[1] === 'download') {
      const f = fixtures.find(x => x.repo === args[args.indexOf('--repo') + 1] && String(x.run) === args[2]);
      if (!f || f === missing) return bad();
      const receipts = f.jobs.map(j => ({ ...j, run: f.run, attempt: f.attempt, headSha: f.base }));
      writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), JSON.stringify({ version: 1, repo: f.repo, receipts }));
      return ok('');
    }
    if (args[0] !== 'api') return bad();
    const url = args.find(a => a.startsWith('repos/')) ?? '';
    const f = fixtures.find(x => url.startsWith(`repos/${x.repo}/actions/runs/${x.run}`)
      || url === `repos/${x.repo}/actions/artifacts/${x.artifact}`);
    if (!f) return bad();
    const runUrl = `repos/${f.repo}/actions/runs/${f.run}`;
    const meta = { id: f.run, run_attempt: f.attempt, head_sha: f.base, status: 'completed', conclusion: 'failure', repository: { full_name: f.repo } };
    const art = { id: f.artifact, name: f.artifactName, expired: false, size_in_bytes: 1234, workflow_run: { id: f.run } };
    if (url === `${runUrl}/attempts/${f.attempt}` || url === runUrl) return ok(JSON.stringify(meta));
    if (url === `${runUrl}/artifacts?per_page=100`) return ok(JSON.stringify([{ total_count: f === missing ? 0 : 1, artifacts: f === missing ? [] : [art] }]));
    if (url === `repos/${f.repo}/actions/artifacts/${f.artifact}`) return ok(JSON.stringify(art));
    if (url === `${runUrl}/attempts/${f.attempt}/jobs?per_page=100`) {
      return ok(JSON.stringify([{ total_count: f.jobs.length, jobs: f.jobs.map(j => ({ id: j.jobId, run_id: f.run,
        run_attempt: f.attempt, name: j.job, status: 'completed', conclusion: j.conclusion, head_sha: f.base })) }]));
    }
    return bad();
  };
}

describe('batch receipt priors into the real input-tree planner', () => {
  it('isolates a missing artifact and reuses only matching passing jobs across repositories', async () => {
    const first = await fixture('ashlrai/first', 101, 201);
    const missing = await fixture('ashlrai/missing', 102, 202);
    const last = await fixture('ashlrai/last', 103, 203);
    const fixtures = [first, missing, last];
    const targets = fixtures.map(({ repo, run, attempt, artifactName }) => ({ repo, run, attempt, artifactName }));
    const calls: Call[] = [];
    const { report } = await awaitCiReceiptBatch(targets, { timeoutMs: 60000, pollMs: 250 },
      { gh: fakeGh(fixtures, missing, calls), now: () => 0, sleep: async () => {} });
    expect(report).toMatchObject({ total: 3, bound: 2, failed: 1, notStarted: 0, timedOut: false, aborted: false });
    expect(report.entries.map(e => e.outcome)).toEqual(['bound', 'failed', 'bound']);
    const [a, b, c] = report.entries;
    expect(b).toMatchObject({ ...targets[1], prior: null });
    expect(b!.reason).toContain('completed with no artifact');
    expect(a!.prior).toMatchObject({ repo: first.repo, receipts: [{ run: first.run }, { run: first.run }] });
    expect(c!.prior).toMatchObject({ repo: last.repo, receipts: [{ run: last.run }, { run: last.run }] });
    expect(calls.filter(x => x.args[0] === 'run')).toHaveLength(2);
    for (const call of calls) {
      expect(call.bin).toBe('gh');
      expect(call.args[0] === 'api' || (call.args[0] === 'run' && call.args[1] === 'download')).toBe(true);
      expect(call.args).not.toEqual(expect.arrayContaining(['--method', 'POST']));
      expect(call.args.join(' ')).not.toMatch(/dispatch|checks|statuses|--method| -X /i);
    }
    const plan = (f: Fixture, prior: unknown, head: string) => planCiResumeInputs({ manifest: manifest(f.repo), prior, base: f.base, head, cwd: f.root });
    for (const [f, entry] of [[first, a!], [last, c!]] as const) {
      const initial = await plan(f, entry.prior, f.base);
      expect(initial.summary).toEqual({ reuse: 1, rerun: 1 });
      expect(initial.jobs[0]).toMatchObject({ decision: 'reuse', reasons: ['inputs_unchanged'], prior: { run: f.run } });
      expect(initial.jobs[1]).toMatchObject({ decision: 'rerun', reasons: ['prior_not_success'], prior: { run: f.run } });
    }
    const cross = await plan(first, c!.prior, first.base);
    expect(cross.jobs.every(j => j.decision === 'rerun' && j.reasons.includes('prior_repo_mismatch') && j.prior === null)).toBe(true);
    put(first.root, 'src/b/b.ts', 'unrelated to job-a\n');
    const unrelated = await plan(first, a!.prior, commit(first.root));
    expect(unrelated.jobs[0]).toMatchObject({ decision: 'reuse', reasons: ['inputs_unchanged'], changedCoveredPaths: [] });
    expect(unrelated.jobs[1]).toMatchObject({ decision: 'rerun', reasons: ['prior_not_success', 'inputs_changed'] });
    put(first.root, 'src/a/a.ts', 'covered edit\n');
    const changed = await plan(first, a!.prior, commit(first.root));
    expect(changed.jobs[0]).toMatchObject({ decision: 'rerun', reasons: ['inputs_changed'], changedCoveredPaths: ['src/a/a.ts'] });
  });
});
