import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetCiPacket } from '../src/cli/fleet-ci-packet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

afterEach(() => vi.restoreAllMocks());
it('validates all arguments before reads, including with help', async () => {
  const gh = vi.fn() as unknown as CloudGh, runner = vi.fn() as unknown as GitRunner;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const args of [['--repo', '../bad'], ['--repo', 'bad--owner/repo'], ['--hours', '0'], ['--hours', '721'], ['--max-groups', '0'], ['--max-groups', '11'], ['--json', '--json'], ['--help', '--unknown'], ['--help', '-h'], ['--hours', '--json']]) expect(await cmdFleetCiPacket(args, { gh, runner })).toBe(2);
  expect(gh).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
});
it('resolves by convention and reports help and complete empty coverage', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh: CloudGh = async () => ({ ok: true, stdout: '{"total_count":0,"workflow_runs":[]}', stderr: '' });
  expect(resolveFleetSubcommand('ci-packet')).toEqual({ module: './fleet-ci-packet.js', exportName: 'cmdFleetCiPacket' });
  expect(await cmdFleetCiPacket(['--help'], { gh })).toBe(0);
  expect(await cmdFleetCiPacket([], { gh })).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain('No failures observed in the covered interval.');
  expect(await cmdFleetCiPacket(['--json'], { gh })).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ version: 1, complete: true, noFailuresObserved: true });
});
it('returns failure for partial coverage and never prints command stderr', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const gh: CloudGh = async () => ({ ok: false, stdout: '', stderr: 'sensitive stderr' });
  expect(await cmdFleetCiPacket(['--json'], { gh })).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ complete: false });
  expect(log.mock.calls.flat().join('')).not.toContain('sensitive stderr');
});
it('returns 1 for missing selected evidence and prints a compact handoff', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const sha = 'a'.repeat(40);
  const gh: CloudGh = async args => {
    const jobs = args[1]!.includes('/attempts/');
    const row = jobs ? { id: 42, name: 'Tests', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/ashlrai/phantom/actions/runs/10/job/42' } : { id: 10, run_attempt: 1, path: 'ci.yml', event: 'push', head_sha: sha, status: 'completed', conclusion: 'failure', created_at: '2026-11-01T05:00:00Z', updated_at: '2026-11-01T05:01:00Z', html_url: 'https://github.com/ashlrai/phantom/actions/runs/10' };
    return { ok: true, stdout: JSON.stringify(jobs ? { total_count: 1, jobs: [row] } : { total_count: 1, workflow_runs: [row] }), stderr: '' };
  };
  const runner: GitRunner = async (_bin, args) => ({ code: args.includes('--slurp') ? 0 : 1, stdout: args.includes('--slurp') ? JSON.stringify([{ total_count: 1, jobs: [{ id: 42, run_id: 10, name: 'Tests', conclusion: 'failure', head_sha: sha, steps: [{ name: 'Compile', conclusion: 'failure' }] }] }]) : '', stderr: 'private stderr', timedOut: false, truncated: false, missing: false });
  expect(await cmdFleetCiPacket([], { gh, runner })).toBe(1);
  const output = log.mock.calls.flat().join('\n');
  expect(output).toContain('ci.yml / Tests'); expect(output).toContain('Failed steps: Compile'); expect(output).toContain('log_unavailable'); expect(output).not.toContain('private stderr');
});
