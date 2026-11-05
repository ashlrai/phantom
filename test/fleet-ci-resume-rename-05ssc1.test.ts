import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { planCiResumeInputs, type CiResumePlan } from '../src/core/fleet/ci-resume-inputs.js';
import { defaultGitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const GIT_TIMEOUT_MS = 30_000;

// Every git invocation in this suite — fixture setup and the planner's own
// reads — goes through the production runner, so the file keeps no
// child_process surface and no planner output is mocked.
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const r = await defaultGitRunner('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (r.missing || r.timedOut || r.truncated || r.code !== 0) {
    throw new Error(`git ${args[0] ?? ''} failed (code ${String(r.code)}): ${(r.stderr || r.stdout).slice(0, 200)}`);
  }
  return r.stdout;
};

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const put = (root: string, p: string, c: string): void => {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), c);
};

const commit = async (root: string, ...extra: string[]): Promise<string> => {
  await git(root, 'add', '-A');
  await git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c', ...extra);
  return (await git(root, 'rev-parse', 'HEAD')).trim();
};

/** Base tree: three independently covered job dirs, one shared file, one uncovered doc. */
async function makeRepo(): Promise<{ root: string; base: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ci-resume-rename-')); dirs.push(root);
  await git(root, 'init', '-q', '-b', 'main');
  put(root, 'src/a/a.ts', 'a\n');
  put(root, 'src/b/b.ts', 'b\n');
  put(root, 'src/c/c.ts', 'c\n');
  put(root, 'package-lock.json', '{}\n');
  put(root, 'docs/readme.md', 'docs\n');
  return { root, base: await commit(root) };
}

const manifest = () => ({
  version: 1, repo: REPO, shared: ['package-lock.json'],
  jobs: [
    { id: 'job-a', command: 'npm run test:a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
    { id: 'job-b', command: 'npm run test:b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
    { id: 'job-c', command: 'npm run test:c', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/c'] },
  ],
});
const emptyPrior = () => ({ version: 1, repo: REPO, receipts: [] as unknown[] });

/** Genuine per-job input digests, computed by the planner from real git objects at base. */
const baseDigests = async (root: string, base: string): Promise<Record<string, string>> => {
  const seed = await planCiResumeInputs({ manifest: manifest(), prior: emptyPrior(), base, head: base, cwd: root });
  return Object.fromEntries(seed.jobs.map((j) => [j.job, j.baseDigest]));
};

/** Fake successful receipts bound to the digests the planner just proved at base. */
const okPrior = (digests: Record<string, string>, headSha: string): unknown => ({
  version: 1, repo: REPO,
  receipts: ['job-a', 'job-b', 'job-c'].map((job, i) => ({
    job, run: 100 + i, attempt: 1, jobId: 5000 + i, headSha,
    conclusion: 'success', inputsDigest: digests[job]!,
  })),
});

const plan = (root: string, prior: unknown, base: string, head: string): Promise<CiResumePlan> =>
  planCiResumeInputs({ manifest: manifest(), prior, base, head, cwd: root });
const job = (p: CiResumePlan, id: string) => p.jobs.find((j) => j.job === id)!;
const reused = (p: CiResumePlan, id: string, digest: string): void => {
  expect(job(p, id)).toMatchObject({ decision: 'reuse', reasons: ['inputs_unchanged'], baseDigest: digest, headDigest: digest });
};

describe('fleet ci-resume rename coverage', () => {
  it('reruns both endpoint jobs when a covered file moves across job directories', async () => {
    const { root, base } = await makeRepo();
    const digests = await baseDigests(root, base);
    renameSync(join(root, 'src/a/a.ts'), join(root, 'src/b/a.ts'));
    const head = await commit(root);
    const p = await plan(root, okPrior(digests, base), base, head);
    expect(p.base).toBe(base);
    expect(p.head).toBe(head);
    // diff-tree --no-renames reports the move as a delete+add pair, so both
    // covered directories changed even though the blob content is identical.
    expect(p.changedPaths).toEqual(['src/a/a.ts', 'src/b/a.ts']);
    expect(p.unmappedChangedPaths).toEqual([]);
    for (const id of ['job-a', 'job-b']) {
      expect(job(p, id).decision).toBe('rerun');
      expect(job(p, id).reasons).toEqual(['inputs_changed']);
      expect(job(p, id).headDigest).not.toBe(digests[id]);
    }
    expect(job(p, 'job-a').changedCoveredPaths).toEqual(['src/a/a.ts']);
    expect(job(p, 'job-b').changedCoveredPaths).toEqual(['src/b/a.ts']);
    reused(p, 'job-c', digests['job-c']!);
    expect(job(p, 'job-c').prior).toMatchObject({ job: 'job-c', conclusion: 'success', run: 102, jobId: 5002, headSha: base });
    expect(p.summary).toEqual({ reuse: 1, rerun: 2 });
  });

  it('reruns only the owning job when a file moves within one covered directory', async () => {
    const { root, base } = await makeRepo();
    const digests = await baseDigests(root, base);
    renameSync(join(root, 'src/a/a.ts'), join(root, 'src/a/moved.ts'));
    const head = await commit(root);
    const p = await plan(root, okPrior(digests, base), base, head);
    expect(p.changedPaths).toEqual(['src/a/a.ts', 'src/a/moved.ts']);
    expect(p.unmappedChangedPaths).toEqual([]);
    expect(job(p, 'job-a')).toMatchObject({ decision: 'rerun', reasons: ['inputs_changed'],
      changedCoveredPaths: ['src/a/a.ts', 'src/a/moved.ts'] });
    expect(job(p, 'job-a').headDigest).not.toBe(digests['job-a']);
    // The untouched third job — and the other untouched job — keep their verified receipts.
    for (const id of ['job-b', 'job-c']) reused(p, id, digests[id]!);
    expect(p.summary).toEqual({ reuse: 2, rerun: 1 });
  });

  it('forces every job to rerun when a covered file moves into an unmapped directory', async () => {
    const { root, base } = await makeRepo();
    const digests = await baseDigests(root, base);
    mkdirSync(join(root, 'vendor/lib'), { recursive: true });
    renameSync(join(root, 'src/b/b.ts'), join(root, 'vendor/lib/b.ts'));
    const head = await commit(root);
    const p = await plan(root, okPrior(digests, base), base, head);
    expect(p.changedPaths).toEqual(['src/b/b.ts', 'vendor/lib/b.ts']);
    expect(p.unmappedChangedPaths).toEqual(['vendor/lib/b.ts']);
    // job-a and job-c have unchanged digests and verified receipts; unmapped
    // coverage alone must still force a rerun rather than claim reuse.
    for (const id of ['job-a', 'job-c']) {
      expect(job(p, id)).toMatchObject({ decision: 'rerun', reasons: ['unmapped_changes'],
        baseDigest: digests[id], headDigest: digests[id] });
    }
    expect(job(p, 'job-b').decision).toBe('rerun');
    expect(job(p, 'job-b').reasons).toEqual(['inputs_changed', 'unmapped_changes']);
    expect(p.summary).toEqual({ reuse: 0, rerun: 3 });
  });

  it('reruns only the owning job when a covered file is deleted', async () => {
    const { root, base } = await makeRepo();
    const digests = await baseDigests(root, base);
    unlinkSync(join(root, 'src/c/c.ts'));
    const head = await commit(root);
    const p = await plan(root, okPrior(digests, base), base, head);
    expect(p.changedPaths).toEqual(['src/c/c.ts']);
    expect(p.unmappedChangedPaths).toEqual([]);
    expect(job(p, 'job-c')).toMatchObject({ decision: 'rerun', reasons: ['inputs_changed'],
      changedCoveredPaths: ['src/c/c.ts'], baseDigest: digests['job-c'] });
    expect(job(p, 'job-c').headDigest).not.toBe(digests['job-c']);
    for (const id of ['job-a', 'job-b']) reused(p, id, digests[id]!);
    expect(p.summary).toEqual({ reuse: 2, rerun: 1 });
  });

  it('reuses every job when the fix commit leaves all covered inputs unchanged', async () => {
    const { root, base } = await makeRepo();
    const digests = await baseDigests(root, base);
    const head = await commit(root, '--allow-empty');
    const p = await plan(root, okPrior(digests, base), base, head);
    expect(p.changedPaths).toEqual([]);
    expect(p.unmappedChangedPaths).toEqual([]);
    for (const id of ['job-a', 'job-b', 'job-c']) reused(p, id, digests[id]!);
    expect(p.summary).toEqual({ reuse: 3, rerun: 0 });
  });
});
