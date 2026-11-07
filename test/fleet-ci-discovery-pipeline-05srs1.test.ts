import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cmdFleetCiReceiptDiscover } from '../src/cli/fleet-ci-receipt-discover.js';
import { cmdFleetCiResumeInputs } from '../src/cli/fleet-ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const repoName = 'example/fixture';
const run = 991; const attempt = 2; const artifact = 77; const name = 'ci-resume-receipts';
const manifest = { version: 1, repo: repoName, jobs: [
  { id: 'job-a', command: 'test a', os: 'linux', arch: 'x64', toolchain: 'node', paths: ['src/a'] },
  { id: 'job-b', command: 'test b', os: 'linux', arch: 'x64', toolchain: 'node', paths: ['src/b'] },
] };
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const dirs: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
function commit(cwd: string): string {
  git(cwd, 'add', '-A'); git(cwd, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-discovery-pipeline-')); dirs.push(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  for (const path of ['src/a/file', 'src/b/file']) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), 'initial');
  }
  const base = commit(cwd);
  writeFileSync(join(cwd, 'src/b/file'), 'fixed');
  return { cwd, base, head: commit(cwd) };
}
let stdout: string[]; let stderr: string[];
beforeEach(() => {
  stdout = []; stderr = [];
  vi.spyOn(console, 'log').mockImplementation((s) => { stdout.push(String(s)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { stderr.push(String(s)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const capture = async (fn: () => Promise<number>) => {
  stdout = []; stderr = [];
  const code = await fn();
  return { code, out: stdout.join('\n'), err: stderr.join('') };
};
type Plan = { jobs: Array<{ job: string; baseDigest: string; decision: string }> };
async function plan(cwd: string, base: string, head: string, prior: unknown) {
  const bytes = Buffer.from(JSON.stringify({ manifest, prior, base, head }));
  return capture(() => cmdFleetCiResumeInputs(['--stdin', '--json'], {
    cwd, getInput: () => (async function* () { yield bytes; })(),
  }));
}
const ok = (value: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
type Call = { bin: string; args: string[] };
function github(base: string, receipts: unknown[], calls: Call[], ambiguous = false): GitRunner {
  const row = (id: number, artifactName: string) => ({ id, name: artifactName, expired: false, size_in_bytes: 1234, workflow_run: { id: run } });
  const other = Array.from({ length: 100 }, (_, i) => row(1000 + i, `logs-${i}`));
  const selected = [row(artifact, name), ...(ambiguous ? [row(88, name)] : [])];
  const pages = [other, selected].map((artifacts) => ({ total_count: other.length + selected.length, artifacts }));
  return async (bin, args) => {
    calls.push({ bin, args: [...args] });
    const endpoint = args.find((a) => a.startsWith('repos/'));
    if (bin === 'gh' && args[0] === 'api') {
      if (endpoint === `repos/${repoName}/actions/runs/${run}/artifacts?per_page=100`) return ok(pages);
      if (endpoint === `repos/${repoName}/actions/runs/${run}`) return ok({ id: run, run_attempt: attempt, head_sha: base, status: 'completed', repository: { full_name: repoName } });
      if (endpoint === `repos/${repoName}/actions/artifacts/${artifact}`) return ok(row(artifact, name));
      if (endpoint === `repos/${repoName}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`) return ok([{ total_count: 2, jobs: receipts.map((r, i) => {
        const receipt = r as { conclusion: string };
        return { id: 7000 + i, run_id: run, run_attempt: attempt, name: `job-${i ? 'b' : 'a'}`, status: 'completed', conclusion: receipt.conclusion, head_sha: base };
      }) }]);
    }
    if (bin === 'gh' && args[0] === 'run' && args[1] === 'download') {
      writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), JSON.stringify({ version: 1, repo: repoName, receipts }));
      return ok('');
    }
    throw new Error(`Unexpected GitHub call: ${bin} ${args.join(' ')}`);
  };
}
const discoverArgs = ['--repo', repoName, '--run', String(run), '--attempt', String(attempt), '--artifact-name', name, '--json'];
function assertReadOnly(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const { bin, args } of calls) {
    expect(bin).toBe('gh');
    expect(args.some((a) => ['--method', '-X', 'POST', 'PUT', 'PATCH', 'DELETE', 'dispatch', 'rerun', 'status'].includes(a))).toBe(false);
    expect(args[0] === 'api' || (args[0] === 'run' && args[1] === 'download')).toBe(true);
  }
}
async function seed(cwd: string, base: string, conclusions = ['success', 'success']) {
  const initial = await plan(cwd, base, base, { version: 1, repo: repoName, receipts: [] });
  expect(initial.code).toBe(0); expect(initial.err).toBe('');
  const jobs = (JSON.parse(initial.out) as Plan).jobs;
  return jobs.map(({ job, baseDigest }, i) => ({ job, run, attempt, jobId: 7000 + i, headSha: base,
    conclusion: conclusions[i], inputsDigest: baseDigest }));
}

describe('discovery to real stdin recovery planner', () => {
  it.each(['success', 'failure'])('reuses unchanged passing inputs and reruns a changed %s job', async (conclusion) => {
    const { cwd, base, head } = fixture();
    const receipts = await seed(cwd, base, ['success', conclusion]);
    const calls: Call[] = [];
    const found = await capture(() => cmdFleetCiReceiptDiscover(discoverArgs, { gh: github(base, receipts, calls) }));
    expect(found.code).toBe(0); expect(found.err).toContain('ci-receipt-discover:');
    const prior = JSON.parse(found.out) as { receipts: typeof receipts };
    expect(prior.receipts.map((r) => r.inputsDigest)).toEqual(receipts.map((r) => r.inputsDigest));
    const result = await plan(cwd, base, head, prior);
    expect(result.code).toBe(0); expect(result.err).toBe('');
    expect((JSON.parse(result.out) as Plan).jobs.map(({ job, decision }) => [job, decision]))
      .toEqual([['job-a', 'reuse'], ['job-b', 'rerun']]);
    expect(calls.filter((c) => c.args.at(-1)?.includes('/artifacts?'))).toHaveLength(2);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(true);
    assertReadOnly(calls);
  });

  it('reruns a failed job even when its inputs did not change', async () => {
    const { cwd, base } = fixture(); const receipts = await seed(cwd, base, ['success', 'failure']);
    const calls: Call[] = [];
    const found = await capture(() => cmdFleetCiReceiptDiscover(discoverArgs, { gh: github(base, receipts, calls) }));
    expect(found.code).toBe(0);
    const result = await plan(cwd, base, base, JSON.parse(found.out));
    expect(result.code).toBe(0); expect(result.err).toBe('');
    expect((JSON.parse(result.out) as Plan).jobs.map(({ job, decision }) => [job, decision]))
      .toEqual([['job-a', 'reuse'], ['job-b', 'rerun']]);
    assertReadOnly(calls);
  });

  it.each(['ambiguous', 'attempt mismatch'])('withholds prior and planner handoff on %s', async (failure) => {
    const { cwd, base, head } = fixture(); const receipts = await seed(cwd, base);
    if (failure === 'attempt mismatch') receipts[0]!.attempt = 1;
    const calls: Call[] = [];
    const found = await capture(() => cmdFleetCiReceiptDiscover(discoverArgs, { gh: github(base, receipts, calls, failure === 'ambiguous') }));
    let handoffs = 0;
    if (found.code === 0) { handoffs++; await plan(cwd, base, head, JSON.parse(found.out)); }
    expect(found.code).toBe(1); expect(found.out).toBe(''); expect(handoffs).toBe(0);
    expect(found.err).toContain(failure === 'ambiguous' ? 'bearers' : 'names attempt 1');
    if (failure === 'ambiguous') expect(calls).toHaveLength(1);
    else expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(true);
    assertReadOnly(calls);
  });
});
