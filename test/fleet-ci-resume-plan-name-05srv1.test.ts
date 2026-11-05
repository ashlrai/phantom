import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetCiResumePlan } from '../src/cli/fleet-ci-resume-plan.js';
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
  rows = [{ id: 30, name: 'receipt', expired: false, workflow_run: { id: 10 } }];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(mf, { force: true }); });
const args = () => ['--repo', repo, '--run', '10', '--attempt', '2', '--artifact-id', '30', '--manifest', mf, '--base', base, '--head', head, '--json'];
let rows: { id: number; name: string; expired: boolean; workflow_run: { id: number } }[];
const fakeGh = (): GitRunner => async (_bin, a) => {
  calls.push(a);
  const endpoint = a.find((s) => s.startsWith('repos/')) ?? '';
  if (endpoint.endsWith('/runs/10')) return ok({ id: 10, run_attempt: 2, head_sha: base, status: 'completed', repository: { full_name: repo } });
  if (endpoint.endsWith('/artifacts/30')) return ok({ id: 30, name: 'receipt', size_in_bytes: 100, expired: false, workflow_run: { id: 10 } });
  if (endpoint.includes('/jobs?')) return ok([{ total_count: 2, jobs: ['a', 'b'].map((name, i) => ({ id: 20 + i, run_id: 10, run_attempt: 2, name, status: 'completed', conclusion: 'success', head_sha: base })) }]);
  if (endpoint.includes('/artifacts?')) return ok([{ total_count: rows.length, artifacts: rows }]);
  if (a[0] === 'run') { writeFileSync(join(a[a.indexOf('--dir') + 1]!, 'receipts.json'), JSON.stringify(prior)); return ok(''); }
  throw new Error('unexpected request');
};

const namedArgs = () => args().map((v) => v === '--artifact-id' ? '--artifact-name' : v === '30' ? 'receipt' : v);

describe('fleet ci-resume-plan by artifact name', () => {
  it('discovers and binds receipts, then plans using real git input trees', async () => {
    expect(await cmdFleetCiResumePlan(namedArgs(), { cwd: root, gh: fakeGh() })).toBe(0);
    const plan = JSON.parse(out.join('\n'));
    expect(plan.summary).toEqual({ reuse: 1, rerun: 1 });
    expect(plan.jobs[0]).toMatchObject({ job: 'a', decision: 'reuse', reasons: ['inputs_unchanged'] });
    expect(plan.jobs[1]).toMatchObject({ job: 'b', decision: 'rerun', reasons: ['inputs_changed'], changedCoveredPaths: ['b/x'] });
    expect(err.join('')).toContain('resolves to artifact 30');
    expect(err.join('')).toContain('receipts bound');
    expect(calls.some((a) => a[0] === 'run' && a[1] === 'download')).toBe(true);
  });
  it('preserves numeric ID behavior', async () => {
    expect(await cmdFleetCiResumePlan(args(), { cwd: root, gh: fakeGh() })).toBe(0);
    expect(JSON.parse(out.join('\n')).summary).toEqual({ reuse: 1, rerun: 1 });
    expect(err.join('')).toContain('receipts bound');
  });
  it('rejects both or neither selector and name with archive before manifest or transport', async () => {
    const missingManifest = namedArgs().map((v) => v === mf ? join(root, 'missing') : v);
    const noSelector = missingManifest.filter((v) => v !== '--artifact-name' && v !== 'receipt');
    for (const invalid of [noSelector, missingManifest.concat('--artifact-id', '30'), missingManifest.concat('--archive', 'file.zip')]) {
      expect(await cmdFleetCiResumePlan(invalid, { cwd: root, gh: fakeGh() })).toBe(2);
    }
    expect(calls).toHaveLength(0); expect(out).toHaveLength(0);
    expect(err.join('')).toContain('--archive requires --artifact-id');
    expect(err.join('')).not.toContain('manifest file cannot be read');
  });
  it('rejects duplicate and expired name evidence without a plan', async () => {
    rows.push({ id: 31, name: 'receipt', expired: true, workflow_run: { id: 10 } });
    expect(await cmdFleetCiResumePlan(namedArgs(), { cwd: root, gh: fakeGh() })).toBe(1);
    expect(err.join('')).toContain('2 bearers');
    rows = [rows[1]!]; err = [];
    expect(await cmdFleetCiResumePlan(namedArgs(), { cwd: root, gh: fakeGh() })).toBe(1);
    expect(err.join('')).toContain('expired');
    expect(out).toHaveLength(0);
    expect(calls.every((a) => a[0] === 'api')).toBe(true);
  });
});
