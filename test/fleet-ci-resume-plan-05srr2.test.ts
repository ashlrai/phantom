import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetCiResumePlan } from '../src/cli/fleet-ci-resume-plan.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { planCiResumeInputs } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const repo = 'example/project';
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const ok = (v: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(v), stderr: '', timedOut: false, truncated: false, missing: false });
const manifest = { version: 1, repo, jobs: ['a', 'b'].map((id) => ({ id, command: `test ${id}`, os: 'linux', arch: 'x64', toolchain: 'node', paths: [id] })) };
let root: string; let base: string; let head: string; let mf: string; let prior: unknown;
let out: string[]; let err: string[]; let calls: string[][];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'resume-plan-'));
  git(root, 'init', '-q');
  for (const p of ['a', 'b']) { mkdirSync(join(root, p)); writeFileSync(join(root, p, 'x'), p); }
  git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'); base = git(root, 'rev-parse', 'HEAD');
  const initial = await planCiResumeInputs({ manifest, prior: { version: 1, repo, receipts: [] }, base, head: base, cwd: root });
  prior = { version: 1, repo, receipts: initial.jobs.map((j, i) => ({ job: j.job, run: 10, attempt: 2, jobId: 20 + i, headSha: base, conclusion: 'success', inputsDigest: j.baseDigest })) };
  writeFileSync(join(root, 'b', 'x'), 'changed'); git(root, 'add', '.'); git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fix'); head = git(root, 'rev-parse', 'HEAD');
  mf = join(tmpdir(), `manifest-${process.pid}-${Math.random()}.json`); writeFileSync(mf, JSON.stringify(manifest));
  out = []; err = []; calls = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(mf, { force: true }); });
const args = () => ['--repo', repo, '--run', '10', '--attempt', '2', '--artifact-id', '30', '--manifest', mf, '--base', base, '--head', head, '--json'];
const fakeGh = (fail = false): GitRunner => async (_bin, a) => {
  calls.push(a);
  const endpoint = a.find((s) => s.startsWith('repos/')) ?? '';
  if (endpoint.endsWith('/runs/10')) return ok({ id: 10, run_attempt: 2, head_sha: base, status: 'completed', repository: { full_name: repo } });
  if (endpoint.endsWith('/artifacts/30')) return fail ? { ...ok(''), code: 1, stderr: 'not found' } : ok({ id: 30, name: 'receipt', size_in_bytes: 100, expired: false, workflow_run: { id: 10 } });
  if (endpoint.includes('/jobs?')) return ok([{ total_count: 2, jobs: ['a', 'b'].map((name, i) => ({ id: 20 + i, run_id: 10, run_attempt: 2, name, status: 'completed', conclusion: 'success', head_sha: base })) }]);
  if (endpoint.includes('/artifacts?')) return ok([{ total_count: 1, artifacts: [{ id: 30, name: 'receipt' }] }]);
  if (a[0] === 'run') { writeFileSync(join(a[a.indexOf('--dir') + 1]!, 'receipts.json'), JSON.stringify(prior)); return ok(''); }
  throw new Error('unexpected request');
};

describe('fleet ci-resume-plan', () => {
  it('fetches bound receipts and plans against real git objects with isolated JSON output', async () => {
    expect(resolveFleetSubcommand('ci-resume-plan')).toEqual({ module: './fleet-ci-resume-plan.js', exportName: 'cmdFleetCiResumePlan' });
    expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh() })).toBe(0);
    const plan = JSON.parse(out.join('\n'));
    expect(plan.summary).toEqual({ reuse: 1, rerun: 1 });
    expect(plan.jobs[0]).toMatchObject({ job: 'a', decision: 'reuse', reasons: ['inputs_unchanged'] });
    expect(plan.jobs[1]).toMatchObject({ job: 'b', decision: 'rerun', reasons: ['inputs_changed'], changedCoveredPaths: ['b/x'] });
    expect(err.join('')).toContain('receipts bound');
    expect(calls.some((a) => a[0] === 'run' && a[1] === 'download')).toBe(true);
  });
  it('prints advisory reasons for people', async () => {
    expect(await cmdFleetCiResumePlan(args().slice(0, -1), { cwd: root, gh: fakeGh() })).toBe(0);
    expect(out.join('\n')).toContain('Advisory'); expect(out.join('\n')).toContain('inputs_changed');
  });
  it('rejects invalid arguments, malformed manifest and mismatched repo before transport', async () => {
    for (const bad of [args().concat('--unknown'), args().concat('--json'), args().map((a) => a === '10' ? '0' : a), args().map((a) => a === base ? 'bad!' : a)]) {
      expect(await cmdFleetCiResumePlan(bad, { cwd: root, gh: fakeGh() })).not.toBe(0);
    }
    writeFileSync(mf, '{'); expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh() })).not.toBe(0);
    writeFileSync(mf, JSON.stringify({ ...manifest, repo: 'other/project' })); expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh() })).not.toBe(0);
    expect(calls).toHaveLength(0); expect(out).toHaveLength(0);
  });
  it('returns no plan for fetch, receipt binding or planner failures', async () => {
    expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh(true) })).not.toBe(0);
    prior = { ...(prior as object), repo: 'other/project' };
    expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh() })).not.toBe(0);
    prior = { ...(prior as object), repo };
    const badHead = args().map((s) => s === head ? 'f'.repeat(40) : s);
    expect(await cmdFleetCiResumePlan(badHead, { cwd: root, gh: fakeGh() })).not.toBe(0);
    expect(out).toHaveLength(0);
  });
});
