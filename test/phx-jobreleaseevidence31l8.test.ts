import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runJobReleaseEvidence, type JobReleaseEvidenceDependencies } from '../examples/agents/job-release-evidence.js';
import { getFleetJobDetail } from '../src/core/fleet/runs-job-detail.js';

let root: string;
let repo: string;
let runs: string;
const first = 'a'.repeat(40);
const later = 'b'.repeat(40);
const tagged = 'c'.repeat(40);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'job-release-evidence-'));
  repo = join(root, 'repo');
  runs = join(root, 'runs');
  await mkdir(repo);
  await mkdir(runs);
  await writeFile(join(runs, 'JOB1.base'), `${first} fake-branch /fake/worktree\n`);
  await writeFile(join(runs, 'JOB1.publish'), 'RESULT PR https://example.invalid/fake/pull/1\nAUTO_MERGE on\n');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function invoke(args: string[], overrides: JobReleaseEvidenceDependencies = {}) {
  let output = '';
  const code = await runJobReleaseEvidence(args, {
    read: job => getFleetJobDetail(job, { runsDir: runs }),
    git: async (_repo, command) => {
      if (command[0] === 'rev-parse' && command[1] === '--is-shallow-repository') return { code: 0, stdout: 'false\n' };
      if (command[0] === 'rev-parse') {
        const ref = command.at(-1)!;
        if (ref === 'refs/tags/v1.2.3^{commit}') return { code: 0, stdout: `${tagged}\n` };
        if (ref === `${first}^{commit}` || ref === `${later}^{commit}`) return { code: 0, stdout: `${ref.slice(0, 40)}\n` };
        return { code: 1, stdout: '' };
      }
      return { code: command[2] === first ? 0 : 1, stdout: '' };
    },
    ...overrides, write: text => { output += text; },
  });
  return { code, body: JSON.parse(output), output };
}
function args(sha?: string) {
  return ['--job', 'JOB1', '--repo', repo, '--tag', 'v1.2.3', ...(sha ? ['--merge-sha', sha] : [])];
}

describe('job release evidence', () => {
  it('includes an explicitly asserted ancestor of the resolved tag', async () => {
    const { code, body, output } = await invoke(args(first));
    expect(code).toBe(0);
    expect(body).toMatchObject({ status: 'included', tagSha: tagged, sources: { base: 'healthy', publish: 'healthy' } });
    expect(output).not.toContain('/fake/worktree');
    expect(output).not.toContain('example.invalid');
  });

  it('reports a later commit as not included', async () => {
    const { code, body } = await invoke(args(later));
    expect(code).toBe(3);
    expect(body).toMatchObject({ status: 'not-included', tagSha: tagged });
  });

  it('cannot infer shipment from a PR URL, auto-merge, or base SHA', async () => {
    const { code, body } = await invoke(args());
    expect(code).toBe(4);
    expect(body).toMatchObject({ status: 'unknown', tagSha: tagged });
    expect(body.reason).toContain('--merge-sha');
  });

  it('reports missing objects and missing or degraded job evidence as unknown', async () => {
    expect((await invoke(args('d'.repeat(40)))).body.status).toBe('unknown');
    await rm(join(runs, 'JOB1.base'));
    await rm(join(runs, 'JOB1.publish'));
    expect((await invoke(args(first))).body.reason).toContain('No readable');
    await symlink(join(root, 'outside'), join(runs, 'JOB1.publish'));
    expect((await invoke(args(first))).body.reason).toContain('degraded');
    const missingTag = args(first); missingTag[5] = 'missing';
    expect((await invoke(missingTag)).body).toMatchObject({ status: 'unknown', tagSha: null });
  });

  it('reports an inconclusive or shallow negative ancestry check as unknown', async () => {
    const fakeGit = vi.fn<NonNullable<JobReleaseEvidenceDependencies['git']>>()
      .mockResolvedValueOnce({ code: 0, stdout: `${first}\n` })
      .mockResolvedValueOnce({ code: 0, stdout: `${later}\n` })
      .mockResolvedValueOnce({ code: 1, stdout: '' })
      .mockResolvedValueOnce({ code: 0, stdout: 'true\n' });
    expect((await invoke(args(later), { git: fakeGit })).body.reason).toContain('incomplete');
    fakeGit.mockReset().mockResolvedValueOnce({ code: 0, stdout: first }).mockResolvedValueOnce({ code: 0, stdout: later }).mockResolvedValueOnce({ code: null, stdout: '' });
    expect((await invoke(args(later), { git: fakeGit })).body.reason).toContain('could not be checked');
  });


  it('uses only validated Git arguments and does not derive commands from job content', async () => {
    const gitCall = vi.fn<NonNullable<JobReleaseEvidenceDependencies['git']>>()
      .mockResolvedValueOnce({ code: 0, stdout: tagged })
      .mockResolvedValueOnce({ code: 0, stdout: first })
      .mockResolvedValueOnce({ code: 0, stdout: '' });
    await writeFile(join(runs, 'JOB1.publish'), 'RESULT PR https://example.invalid/$(fake-command)\n');
    expect((await invoke(args(first), { git: gitCall })).body.status).toBe('included');
    expect(gitCall.mock.calls).toEqual([
      [repo, ['rev-parse', '--verify', '--end-of-options', 'refs/tags/v1.2.3^{commit}']],
      [repo, ['rev-parse', '--verify', '--end-of-options', `${first}^{commit}`]],
      [repo, ['merge-base', '--is-ancestor', first, tagged]],
    ]);
  });

  it('refuses to use stale publish evidence for a running job', async () => {
    const detail = await getFleetJobDetail('JOB1', { runsDir: runs });
    const { body } = await invoke(args(first), { read: async () => ({ ...detail, state: 'running' }) });
    expect(body.status).toBe('unknown');
    expect(body.reason).toContain('earlier attempt');
  });

  it('rejects invalid arguments before any reads or Git calls', async () => {
    const read = vi.fn();
    const gitCall = vi.fn();
    for (const invalid of [[], ['--job', '../bad', '--repo', repo, '--tag', 'v1'], ['--job', 'JOB1', '--repo', repo, '--tag', '--help'], ['--job', 'JOB1', '--repo', repo, '--tag', 'v1\n'], [...args(first), '--tag', 'other'], args('abc'), ['--job', 'JOB1', '--repo', repo, '--tag', 'x/../y']]) {
      expect((await invoke(invalid, { read, git: gitCall })).code).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(gitCall).not.toHaveBeenCalled();
  });

  it('does not expose thrown errors', async () => {
    const { code, output } = await invoke(args(), { read: async () => { throw new Error('fake-private-data'); } });
    expect(code).toBe(1);
    expect(output).not.toContain('fake-private-data');
  });
});
