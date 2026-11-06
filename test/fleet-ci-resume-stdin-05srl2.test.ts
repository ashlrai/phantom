import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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

// File-mode helper (existing regression)
async function runFile(root: string, m: unknown, p: unknown, base: string, head: string,
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
  const { plan } = await runFile(root, m, prior([]), rev, rev);
  return Object.fromEntries((plan.jobs as Array<{ job: string; baseDigest: string }>).map((j) => [j.job, j.baseDigest]));
};
const job = (plan: Record<string, any>, id: string) => (plan.jobs as Array<Record<string, any>>).find((j) => j.job === id)!;

// stdin helper: build a stdin stream from an envelope
function makeStream(env: unknown): () => AsyncIterable<Uint8Array> {
  const raw = JSON.stringify(env);
  return () => (async function* () { yield new TextEncoder().encode(raw); })();
}

// Oversized envelope: builds a valid JSON > 1 MiB with realistic manifest/prior structure
function oversizedEnvelope(): string {
  const paths = []; for (let i = 0; i < 10000; i++) paths.push('very_long_path_name_directory_' + i + '/deeply_nested_subdirectory_' + i + '/very_deeply_nested_file_' + i + '.ts');
  const shared = []; for (let i = 0; i < 10000; i++) shared.push('shared_dir_' + i + '/very_long_file_name_' + i + '.json');
  return JSON.stringify({
    manifest: { version: 1, repo: 'ashlrai/phantom', shared: shared.slice(0, 5000),
      jobs: [{ id: 'ci-e2e-integration-test-long-name', command: 'npm run test:e2e:integration -- --reporter=json', os: 'ubuntu-24.04-xlarge', arch: 'x64', toolchain: 'node-22.15.0-rolling-patch-final', paths }] },
    prior: { version: 1, repo: 'ashlrai/phantom', receipts: [] },
    base: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  });
}

async function runStdin(root: string, m: unknown, p: unknown, base: string, head: string,
  calls: Array<{ bin: string; args: string[] }> = []): Promise<{ code: number; plan: Record<string, any>; calls: typeof calls }> {
  const env = { manifest: m, prior: p, base, head };
  out = [];
  const code = await cmdFleetCiResumeInputs(
    ['--stdin', '--json'],
    { git: spyingGit(calls), cwd: root, getInput: makeStream(env) });
  return { code, plan: out.length ? JSON.parse(out.join('\n')) : {}, calls };
}

describe('fleet ci-resume-inputs --stdin', () => {
  it('produces identical plans for stdin vs file mode on unchanged base', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    const m = manifest(); const p = prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]);
    const { plan: filePlan } = await runFile(root, m, p, base, base);
    const { plan: stdinPlan } = await runStdin(root, m, p, base, base);
    expect(stdinPlan.jobs).toEqual(filePlan.jobs);
    expect(stdinPlan.summary).toEqual(filePlan.summary);
  });

  it('reuses unchanged successful evidence and reruns a covered change via stdin', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'src/b/y.ts'), 'b changed\n'); const head = commit(root);
    const m = manifest(); const p = prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]);
    const { plan } = await runStdin(root, m, p, base, head);
    expect(job(plan, 'job-a').decision).toBe('reuse');
    expect(job(plan, 'job-a').reasons).toEqual(['inputs_unchanged']);
    expect(job(plan, 'job-b').decision).toBe('rerun');
    expect(job(plan, 'job-b').reasons).toContain('inputs_changed');
  });

  it('refuses mixing --stdin with file arguments', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dir = mkdtempSync(join(tmpdir(), 'ci-resume-mix-')); dirs.push(dir);
    const mf = join(dir, 'manifest.json');
    writeFileSync(mf, JSON.stringify(manifest()));
    const code = await cmdFleetCiResumeInputs(
      ['--stdin', '--manifest', mf, '--prior', mf, '--base', base, '--head', base],
      { getInput: makeStream({ manifest: {}, prior: {}, base: '', head: '' }) });
    expect(code).toBe(2);
    expect(err.join('')).toContain('may not be mixed');
  });

  it('refuses unknown envelope fields', async () => {
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ manifest: {}, prior: {}, base: 'aaaa', head: 'bbbb', orphan: 'x' }));
      })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('unknown envelope field');
  });

  it('refuses malformed JSON on stdin', async () => {
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        yield new TextEncoder().encode('not json at all');
      })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('not valid JSON');
  });

  it('refuses empty stdin', async () => {
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () { /* no chunks */ })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('stdin is empty');
  });

  it('refuses an oversized envelope exceeding 1 MiB', async () => {
    const raw = oversizedEnvelope();
    expect(raw.length).toBeGreaterThan(1024 * 1024);
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        yield new TextEncoder().encode(raw);
      })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('exceeds 1 MiB');
  });

  it('refuses oversized chunked input (multiple chunks exceed 1 MiB)', async () => {
    // Build a single valid JSON > 1 MiB, then split it across multiple chunks
    const raw = oversizedEnvelope();
    expect(raw.length).toBeGreaterThan(1024 * 1024);
    // Split into 15 chunks (each valid JSON fragment, reassembled = raw)
    const chunkSize = Math.floor(raw.length / 15);
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        for (let i = 0; i < 15; i++) {
          yield new TextEncoder().encode(raw.slice(i * chunkSize, (i + 1) * chunkSize));
        }
        yield new TextEncoder().encode(raw.slice(15 * chunkSize));
      })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('exceeds 1 MiB');
  });

  it('refuses missing required envelope fields', async () => {
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ manifest: {}, prior: {} }));
      })() });
    expect(code).toBe(2);
    expect(err.join('')).toContain('requires manifest, prior, base and head');
  });

  it('refuses null/empty base and head values inside envelope', async () => {
    const code = await cmdFleetCiResumeInputs(
      ['--stdin'],
      { getInput: () => (async function* () {
        yield new TextEncoder().encode(JSON.stringify({ manifest: {}, prior: {}, base: '', head: '' }));
      })() });
    expect(code).toBe(2);
  });
});

describe('fleet ci-resume-inputs file-mode regression', () => {
  it('reuses an untouched job and reruns a covered change, with read-only git access', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'src/b/y.ts'), 'b changed\n'); const head = commit(root);
    const { code, plan, calls } = await runFile(root, manifest(), prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]), base, head);
    expect(code).toBe(0);
    expect(job(plan, 'job-a')).toMatchObject({ decision: 'reuse', reasons: ['inputs_unchanged'], baseDigest: dig['job-a'], headDigest: dig['job-a'] });
    expect(job(plan, 'job-b')).toMatchObject({ decision: 'rerun', reasons: expect.any(Array) });
    expect(job(plan, 'job-b').reasons).toContain('inputs_changed');
    expect(calls.every((c) => c.args[0] !== 'gh' && !c.args.some((a) => a.includes('status')))).toBe(true);
  });

  it('reruns a job when a prior receipt lacks a matching base digest', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'src/a/x.ts'), 'a changed\n'); const head = commit(root);
    const { plan } = await runFile(root, manifest(), prior([
      receipt('job-a', 'sha256:'.concat('0'.repeat(64))), receipt('job-b', dig['job-b']!)]), base, head);
    expect(job(plan, 'job-a').decision).toBe('rerun');
    expect(job(plan, 'job-a').reasons).toContain('inputs_changed');
  });

  it('reruns when inputs changed, even with a successful prior', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'src/a/x.ts'), 'a changed\n'); const head = commit(root);
    const { plan } = await runFile(root, manifest(), prior([
      receipt('job-a', dig['job-a']!)]), base, head);
    expect(job(plan, 'job-a').decision).toBe('rerun');
    expect(job(plan, 'job-a').reasons).toContain('inputs_changed');
    // When baseDigest == baseDigest (base hasn't changed for this job's prior),
    // okReceipt succeeds, so reason is just 'inputs_changed' (not 'prior_not_success').
  });

  it('marks shared paths as changed when they differ', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const m = manifest([{ id: 'job-a', command: 'c', os: 'u', arch: 'x64', toolchain: 't', paths: ['src/a', 'src'] }]);
    const dig = await digests(root, base, m);
    writeFileSync(join(root, 'package-lock.json'), '{"changed":true}\n'); const head = commit(root);
    const { plan } = await runFile(root, m, prior([receipt('job-a', dig['job-a']!)]), base, head);
    expect(job(plan, 'job-a').changedSharedPaths).toEqual(['package-lock.json']);
  });

  it('falls back to rerunning all jobs on unmapped changes', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    const dig = await digests(root, base);
    writeFileSync(join(root, 'docs/readme.md'), 'doc\n'); const head = commit(root);
    const { plan } = await runFile(root, manifest(), prior([
      receipt('job-a', dig['job-a']!), receipt('job-b', dig['job-b']!)]), base, head);
    expect(plan.unmappedChangedPaths).toEqual(['docs/readme.md']);
    for (const id of ['job-a', 'job-b']) {
      expect(job(plan, id).decision).toBe('rerun');
      expect(job(plan, id).reasons).toEqual(['unmapped_changes']);
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
    const a = (await runFile(root, m(false), p(false), base, base)).plan;
    const b = (await runFile(root, m(true), p(true), base, base)).plan;
    expect(b.jobs).toEqual(a.jobs);
    expect(b.jobs.every((j: { decision: string }) => j.decision === 'reuse')).toBe(true);
  });

  it('rejects traversal paths, pathspec magic and bad revisions', async () => {
    const root = makeRepo(); const base = git(root, 'rev-parse', 'HEAD').trim();
    for (const paths of [['../x'], ['a/../../b'], ['/abs'], ['src/*.ts'], [':(top)src'], []]) {
      const m = manifest([{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths }]);
      expect((await runFile(root, m, prior([]), base, base)).code).toBe(2);
    }
    expect((await runFile(root, manifest([{ id: 'j', command: 'c', os: 'o', arch: 'a', toolchain: 't', paths: ['ok'] }]), prior([]), base, base)).code).toBe(0);
    expect((await runFile(root, manifest(), prior([]), 'zz', base)).code).toBe(2);
    expect((await runFile(root, manifest(), prior([]), base, 'HEAD~1!')).code).toBe(2);
  });
});
