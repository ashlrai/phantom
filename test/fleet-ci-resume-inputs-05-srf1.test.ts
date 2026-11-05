import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdFleetCiResumeInputs } from '../src/cli/fleet-ci-resume-inputs.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
const spyingGit = (calls: Array<{ bin: string; args: string[] }>): GitRunner => async (bin, args, opts) => {
  calls.push({ bin, args: [...args] });
  try {
    return { code: 0, stdout: execFileSync(bin, [...args], { cwd: opts.cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 << 20 }),
      stderr: '', timedOut: false, truncated: false, missing: false };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '',
      timedOut: false, truncated: false, missing: false };
  }
};

const dirs: string[] = [];
let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const manifest = (jobs?: unknown[], shared = ['package-lock.json']) => ({ version: 1, repo: REPO, shared, jobs: jobs ?? [
  { id: 'job-a', command: 'npm run test:a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
  { id: 'job-b', command: 'npm run test:b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
] });
const receipt = (job: string, digest: string, extra: Record<string, unknown> = {}) =>
  ({ job, run: 991, attempt: 2, jobId: 7000, conclusion: 'success', inputsDigest: digest, ...extra });
const prior = (receipts: unknown[], repo = REPO) => ({ version: 1, repo, receipts });

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ci-resume-repo-')); dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  const put = (p: string, c: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
  put('src/a/x.ts', 'a\n'); put('src/b/y.ts', 'b\n'); put('package-lock.json', '{}\n'); put('docs/readme.md', 'd\n');
  commit(root);
  return root;
}
const commit = (root: string): string => {
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c');
  return git(root, 'rev-parse', 'HEAD').trim();
};

async function run(root: string, m: unknown, p: unknown, base: string, head: string,
  calls: Array<{ bin: string; args: string[] }> = []): Promise<{ code: number; plan: Record<string, any>; calls: typeof calls }> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-resume-in-')); dirs.push(dir);
  const mf = join(dir, 'manifest.json'); const pf = join(dir, 'prior.json');
  writeFileSync(mf, typeof m === 'string' ? m : JSON.stringify(m));
  writeFileSync(pf, typeof p === 'string' ? p : JSON.stringify(p));
  out = [];
  const code = await cmdFleetCiResumeInputs(
    ['--manifest', mf, '--prior', pf, '--base', base, '--head', head, '--json'], { git: spyingGit(calls), cwd: root });
  return { code, plan: out.length ? JSON.parse(out.join('\n')) : {}, calls };
}
const digests = async (root: string, rev: string, m = manifest()): Promise<Record<string, string>> => {
  const { plan } = await run(root, m, prior([]), rev, rev);
  return Object.fromEntries((plan.jobs as Array<{ job: string; baseDigest: string }>).map((j) => [j.job, j.baseDigest]));
};
const job = (plan: Record<string, any>, id: string) => (plan.jobs as Array<Record<string, any>>).find((j) => j.job === id)!;

describe('fleet ci-resume-inputs', () => {
  it('reuses an untouched job and reruns a covered change, with read-only git access', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'src/b/y.ts'), 'b changed\n'); const head = commit(root);
    const { code, plan, calls } = await run(root, manifest(), prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]), base, head);
    expect(code).toBe(0);
    expect(job(plan, 'job-a')).toMatchObject({ decision: 'reuse', reasons: ['inputs_unchanged'], baseDigest: dig['job-a'], headDigest: dig['job-a'] });
    expect(job(plan, 'job-a').prior).toMatchObject({ run: 991, attempt: 2, jobId: 7000, conclusion: 'success' });
    expect(job(plan, 'job-b')).toMatchObject({ decision: 'rerun', changedCoveredPaths: ['src/b/y.ts'] });
    expect(job(plan, 'job-b').reasons).toContain('inputs_changed');
    expect(job(plan, 'job-b').headDigest).not.toBe(dig['job-b']);
    expect(plan.changedPaths).toEqual(['src/b/y.ts']);
    expect(plan.unmappedChangedPaths).toEqual([]);
    expect(plan.summary).toEqual({ reuse: 1, rerun: 1 });
    // Zero GitHub mutation: every child is git, and only read-only plumbing verbs.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.bin === 'git' && ['rev-parse', 'diff-tree', 'ls-tree'].includes(c.args[0]!))).toBe(true);
  });

  it('reruns jobs whose prior conclusion was not success', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    for (const conclusion of ['failure', 'cancelled', 'skipped']) {
      const { plan } = await run(root, manifest(), prior([
        receipt('job-a', dig['job-a']!, { conclusion }), receipt('job-b', dig['job-b']!)]), base, base);
      expect(job(plan, 'job-a').decision).toBe('rerun');
      expect(job(plan, 'job-a').reasons).toContain('prior_not_success');
      expect(job(plan, 'job-b').decision).toBe('reuse');
    }
    const { plan } = await run(root, manifest(), prior([receipt('job-b', dig['job-b']!)]), base, base);
    expect(job(plan, 'job-a').reasons).toEqual(['no_prior_receipt']);
  });

  it('invalidates every consumer when a shared dependency changes', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'package-lock.json'), '{"lock":2}\n'); const head = commit(root);
    const { plan } = await run(root, manifest(), prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]), base, head);
    for (const id of ['job-a', 'job-b']) {
      expect(job(plan, id).decision).toBe('rerun');
      expect(job(plan, id).reasons).toContain('inputs_changed');
      expect(job(plan, id).changedSharedPaths).toEqual(['package-lock.json']);
    }
  });

  it('falls back to rerunning all jobs on unmapped changes', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'docs/readme.md'), 'doc\n'); const head = commit(root);
    const { plan } = await run(root, manifest(), prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]), base, head);
    expect(plan.unmappedChangedPaths).toEqual(['docs/readme.md']);
    for (const id of ['job-a', 'job-b']) {
      expect(job(plan, id).decision).toBe('rerun');
      expect(job(plan, id).reasons).toEqual(['unmapped_changes']);
    }
  });

  it('rename, delete, mode and new directory entries all change fingerprints', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    const ok = () => prior([receipt('job-b', dig['job-b']!)]); // src/b never changes, so its base digest stays valid.
    let prev = base;
    const steps: Array<[() => void, string[]]> = [
      [() => renameSync(join(root, 'src/a/x.ts'), join(root, 'src/a/z.ts')), ['src/a/x.ts', 'src/a/z.ts']],
      [() => { mkdirSync(join(root, 'src/a/new'), { recursive: true }); writeFileSync(join(root, 'src/a/new/deep.ts'), 'n\n'); }, ['src/a/new/deep.ts']],
      [() => { chmodSync(join(root, 'src/a/z.ts'), 0o755); }, ['src/a/z.ts']],
      [() => { symlinkSync('z.ts', join(root, 'src/a/link.ts')); }, ['src/a/link.ts']],
      [() => { unlinkSync(join(root, 'src/a/new/deep.ts')); }, ['src/a/new/deep.ts']],
    ];
    for (const [act, changed] of steps) {
      act(); const head = commit(root);
      const { plan } = await run(root, manifest(), ok(), prev, head);
      expect(job(plan, 'job-a').decision).toBe('rerun');
      expect(job(plan, 'job-a').reasons).toEqual(['no_prior_receipt', 'inputs_changed']);
      expect(job(plan, 'job-a').changedCoveredPaths).toEqual(changed);
      expect(job(plan, 'job-b').decision).toBe('reuse');
      prev = head;
    }
  });

  it('produces identical plans for reordered manifests and receipts', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const m = (swap: boolean) => manifest((swap ? [1, 0] : [0, 1]).map((i) => [
      { id: 'job-a', command: 'npm run test:a', os: 'u', arch: 'x64', toolchain: 't', paths: ['src/a', 'src'] },
      { id: 'job-b', command: 'npm run test:b', os: 'u', arch: 'x64', toolchain: 't', paths: ['src', 'src/b'] },
    ][i] as unknown));
    const dig = await digests(root, base, m(false));
    const p = (swap: boolean) => prior((swap ? [1, 0] : [0, 1]).map((i) => [
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)][i]));
    const a = (await run(root, m(false), p(false), base, base)).plan;
    const b = (await run(root, m(true), p(true), base, base)).plan;
    expect(b.jobs).toEqual(a.jobs);
    expect(b.jobs.every((j: { decision: string }) => j.decision === 'reuse')).toBe(true);
  });

  it('never reuses malformed or foreign receipts', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    const foreign = `sha256:${'0'.repeat(64)}`;
    const { plan } = await run(root, manifest(), prior([
      receipt('job-a', foreign), receipt('job-b', dig['job-b']!)]), base, base);
    expect(job(plan, 'job-a').decision).toBe('rerun');
    expect(job(plan, 'job-a').reasons).toContain('prior_digest_unverified');
    expect(job(plan, 'job-b').decision).toBe('reuse');
    const other = (await run(root, manifest(), prior([receipt('job-a', dig['job-a']!)], 'other/repo'), base, base)).plan;
    expect(job(other, 'job-a').reasons).toContain('prior_repo_mismatch');
    for (const bad of ['not json', '{"version":1,"repo":"ashlrai/phantom","receipts":[{"job":"job-a","conclusion":"success"}]}', '{"version":2,"repo":"x/y","receipts":[]}']) {
      expect((await run(root, manifest(), bad, base, base)).code).toBe(2);
    }
  });

  it('rejects traversal paths, pathspec magic and bad revisions', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    for (const paths of [['../x'], ['a/../../b'], ['/abs'], ['src/*.ts'], [':(top)src'], []]) {
      const m = manifest([{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths }]);
      expect((await run(root, m, prior([]), base, base)).code).toBe(2);
    }
    expect((await run(root, manifest([{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths: ['ok'] }]), prior([]), base, base)).code).toBe(0);
    expect((await run(root, manifest(), prior([]), 'zz', base)).code).toBe(2);
    expect((await run(root, manifest(), prior([]), base, 'HEAD~1!')).code).toBe(2);
    expect(err.join('')).not.toContain('fatal: cannot');
  });
});
