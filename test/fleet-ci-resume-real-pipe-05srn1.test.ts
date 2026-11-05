import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cmdFleetCiResumeInputs } from '../src/cli/fleet-ci-resume-inputs.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const moduleUrl = pathToFileURL(resolve('src/cli/fleet-ci-resume-inputs.ts')).href;
const loaderUrl = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
const script = `import { cmdFleetCiResumeInputs } from ${JSON.stringify(moduleUrl)}; process.exitCode = await cmdFleetCiResumeInputs(['--stdin', '--json']);`;
function pipe(cwd: string, chunks: Uint8Array[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--import', loaderUrl, '--input-type=module', '-e', script], { cwd, env, stdio: 'pipe' });
    let out = ''; let err = '';
    child.stdout.setEncoding('utf8').on('data', (s: string) => { out += s; });
    child.stderr.setEncoding('utf8').on('data', (s: string) => { err += s; });
    child.on('error', reject);
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (code) => resolveResult({ code, out, err }));
    for (const chunk of chunks) child.stdin.write(chunk);
    child.stdin.end();
  });
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const repoName = 'ashlrai/phantom';
const manifest = { version: 1, repo: repoName, jobs: [
  { id: 'job-a', command: 'test café', os: 'linux', arch: 'x64', toolchain: 'node', paths: ['src/a'] },
  { id: 'job-b', command: 'test b', os: 'linux', arch: 'x64', toolchain: 'node', paths: ['src/b'] },
] };
const prior = (receipts: unknown[]) => ({ version: 1, repo: repoName, receipts });
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'resume-pipe-')); dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  for (const file of ['src/a/file', 'src/b/file']) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), 'initial'); }
  commit(root); return root;
}
function commit(root: string): string {
  git(root, 'add', '-A'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture'); return git(root, 'rev-parse', 'HEAD');
}

describe('ci-resume-inputs real stdin pipe', () => {
  it('reaches planner validation without a cwd stdin file', async () => {
    const root = repo();
    const result = await pipe(root, [encode({ manifest: {}, prior: {}, base: 'a', head: 'b' })]);
    expect(result.code).toBe(2); expect(result.err).toContain('manifest'); expect(result.err).not.toContain('ENOENT');
  });

  it('plans reuse and rerun with split UTF-8, ignoring a decoy stdin file', async () => {
    const root = repo(); const base = git(root, 'rev-parse', 'HEAD');
    const initial = await pipe(root, [encode({ manifest, prior: prior([]), base, head: base })]);
    expect(initial.code).toBe(0);
    const initialPlan = JSON.parse(initial.out) as { jobs: Array<{ job: string; baseDigest: string }> };
    const receipts = initialPlan.jobs.map(({ job, baseDigest }) => ({ job, run: 1, attempt: 1, jobId: 1, conclusion: 'success', inputsDigest: baseDigest }));
    writeFileSync(join(root, 'src/b/file'), 'changed'); const head = commit(root);
    writeFileSync(join(root, 'stdin'), 'decoy');
    const bytes = encode({ manifest, prior: prior(receipts), base, head });
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const result = await pipe(root, [bytes.subarray(0, split), bytes.subarray(split)]);
    expect(result.code).toBe(0); expect(result.err).toBe('');
    const plan = JSON.parse(result.out) as { jobs: Array<{ job: string; decision: string }> };
    expect(plan.jobs.map(({ job, decision }) => [job, decision])).toEqual([['job-a', 'reuse'], ['job-b', 'rerun']]);
  });

  it('accepts a large input within the cap and rejects over-cap input through the pipe', async () => {
    const root = repo();
    const large = Buffer.from(`{"padding":"${'x'.repeat(900_000)}"}`);
    const result = await pipe(root, [large]);
    expect(result.code).toBe(2); expect(result.err).toContain('unknown envelope field');
    const oversized = await pipe(root, [Buffer.alloc(1024 * 1024 + 1, 32)]);
    expect(oversized.code).toBe(2); expect(oversized.err).toContain('exceeds 1 MiB');
  });

  it('handles one large injected byte chunk without argument overflow', async () => {
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const chunk = Buffer.from(`{"padding":"${'x'.repeat(900_000)}"}`);
    const code = await cmdFleetCiResumeInputs(['--stdin'], { getInput: () => (async function* () { yield chunk; })() });
    expect(code).toBe(2); expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown envelope field'));
  });
});
