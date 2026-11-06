import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runJobReleaseEvidence, type JobReleaseEvidenceDependencies } from '../examples/agents/job-release-evidence.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

const exec = promisify(execFile);
let root: string;
let repo: string;
let runs: string;
let merge: string;
let candidate: string;
let later: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'user.name=Fake User', '-c', 'user.email=fake@example.invalid', ...args], {
    cwd: repo,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fake-candidate-evidence-'));
  repo = join(root, 'repo');
  runs = join(root, 'runs');
  await mkdir(repo);
  await mkdir(runs);
  const templates = join(root, 'templates');
  await mkdir(templates);
  await git('init', '--quiet', '--template', templates);
  await git('commit', '--quiet', '--allow-empty', '-m', 'Fake verified merge');
  merge = await git('rev-parse', 'HEAD');
  await git('commit', '--quiet', '--allow-empty', '-m', 'Fake release candidate');
  candidate = await git('rev-parse', 'HEAD');
  await git('update-ref', 'refs/heads/fake-release', candidate);
  await git('update-ref', 'refs/remotes/fake-origin/fake-release', candidate);
  await git('tag', 'fake-v1', candidate);
  await git('commit', '--quiet', '--allow-empty', '-m', 'Fake later merge');
  later = await git('rev-parse', 'HEAD');
  await writeFile(join(runs, 'JOB1.base'), `${merge} fake-branch /fake/worktree\n`);
  await writeFile(join(runs, 'JOB1.publish'), 'RESULT PR https://example.invalid/fake/pull/1\n');
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function args(ref = 'refs/heads/fake-release', sha = merge): string[] {
  return ['--job', 'JOB1', '--repo', repo, '--candidate-ref', ref, '--merge-sha', sha];
}

async function invoke(argv: string[], overrides: JobReleaseEvidenceDependencies = {}) {
  let output = '';
  const code = await runJobReleaseEvidence(argv, {
    read: job => getFleetJobDetail(job, { runsDir: runs }),
    ...overrides,
    write: text => { output += text; },
  });
  return { code, body: JSON.parse(output) };
}

describe('job release candidate evidence', () => {
  it.each(['refs/heads/fake-release', 'refs/remotes/fake-origin/fake-release'])(
    'finds an ancestor of the local ref %s', async ref => {
      const { code, body } = await invoke(args(ref));
      expect(code).toBe(0);
      expect(body).toMatchObject({ status: 'included', target: { kind: 'candidate-ref', ref, sha: candidate } });
    },
  );

  it('reports a commit after the candidate as not included', async () => {
    const { code, body } = await invoke(args('refs/heads/fake-release', later));
    expect(code).toBe(3);
    expect(body).toMatchObject({ status: 'not-included', target: { kind: 'candidate-ref', ref: 'refs/heads/fake-release', sha: candidate } });
  });

  it('reports a missing local candidate ref as unknown', async () => {
    const { code, body } = await invoke(args('refs/remotes/fake-origin/missing'));
    expect(code).toBe(4);
    expect(body).toMatchObject({ status: 'unknown', target: { kind: 'candidate-ref', ref: 'refs/remotes/fake-origin/missing', sha: null } });
  });

  it('does not resolve an absent candidate through another namespace', async () => {
    await git('update-ref', 'refs/tags/refs/heads/fake-missing', candidate);
    const { code, body } = await invoke(args('refs/heads/fake-missing'));
    expect(code).toBe(4);
    expect(body).toMatchObject({ status: 'unknown', target: { ref: 'refs/heads/fake-missing', sha: null } });
  });

  it('rejects hostile and non-exact refs before reading or running Git', async () => {
    const read = vi.fn();
    const gitCall = vi.fn();
    for (const ref of ['--help', 'HEAD', 'refs/tags/fake-v1', 'refs/heads/fake-release^{commit}',
      'refs/heads/../fake', 'refs/heads/fake@{1}', 'refs/heads/fake.lock', 'refs/heads/fake\noption',
      'refs/heads/fake:other', 'refs/heads/fake\\other', 'refs/heads/']) {
      expect((await invoke(args(ref), { read, git: gitCall })).code).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(gitCall).not.toHaveBeenCalled();
  });

  it('rejects both target options before reading or running Git', async () => {
    const read = vi.fn();
    const gitCall = vi.fn();
    expect((await invoke([...args(), '--tag', 'fake-v1'], { read, git: gitCall })).code).toBe(2);
    expect((await invoke([...args().slice(0, -2), '--tag', 'fake-v1'], { read, git: gitCall })).code).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(gitCall).not.toHaveBeenCalled();
  });

  it('retains tag behavior and exposes the resolved target', async () => {
    const { code, body } = await invoke(['--job', 'JOB1', '--repo', repo, '--tag', 'fake-v1', '--merge-sha', merge]);
    expect(code).toBe(0);
    expect(body).toMatchObject({ status: 'included', tagSha: candidate, target: { kind: 'tag', ref: 'refs/tags/fake-v1', sha: candidate } });
    expect(body.reason).toBe('The supplied merge commit is an ancestor of the tag.');
  });

  it('keeps missing verified merges and running jobs unknown', async () => {
    const withoutMerge = args().slice(0, -2);
    expect((await invoke(withoutMerge)).body.status).toBe('unknown');
    expect((await invoke(args('refs/heads/fake-release', 'a'.repeat(40)))).body.status).toBe('unknown');
    const detail = await getFleetJobDetail('JOB1', { runsDir: runs });
    const running = await invoke(args(), { read: async () => ({ ...detail, state: 'running' }) });
    expect(running.code).toBe(4);
    expect(running.body.status).toBe('unknown');
  });
});
