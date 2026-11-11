import { describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseGateStart } from '../src/cli/fleet-release-gate-start.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const ok = (value: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
const run = (status = 'queued') => ({ id: 12, head_sha: sha, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status, conclusion: status === 'completed' ? 'success' : null });
function fixture(options: { head?: string; moved?: boolean; branch?: string | null; inventory?: unknown; failure?: boolean; dispatchFailure?: boolean; truncated?: boolean } = {}) {
  const calls: string[][] = []; let heads = 0;
  const gh: GitRunner = async (_bin, args) => {
    calls.push([...args]);
    if (args[0] === 'workflow') return options.dispatchFailure ? { ...ok(null), code: 1, stderr: `failure ${'x'.repeat(300)}` } : ok(null);
    const path = args[1]!;
    if (path === 'repos/acme/project') return ok({ default_branch: options.branch === undefined ? 'master' : options.branch });
    if (path.includes('/branches/')) return ok({ commit: { sha: options.moved && heads++ > 0 ? other : options.head ?? sha } });
    if (options.failure) return { ...ok(null), code: 1 };
    if (options.truncated) return { ...ok(null), truncated: true };
    return ok(options.inventory ?? { total_count: 0, workflow_runs: [] });
  };
  return { gh, calls };
}
async function invoke(f: ReturnType<typeof fixture>, apply = false) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = await cmdFleetReleaseGateStart(['--repo', 'acme/project', '--sha', sha, ...(apply ? ['--apply'] : []), '--json'], { gh: f.gh });
    return { code, report: JSON.parse(String(log.mock.calls[0]![0])) };
  } finally { log.mockRestore(); }
}

describe('fleet release-gate-start', () => {
  it('plans the precise lightweight operation without mutation', async () => {
    const f = fixture(); const { code, report } = await invoke(f);
    expect(code).toBe(0); expect(report.outcome).toBe('planned');
    expect(report.dispatch).toMatchObject({ workflow: 'ci.yml', ref: 'master', inputs: { release_gate: true }, invoked: false });
    expect(f.calls.every(c => c[0] === 'api')).toBe(true);
  });
  it('refreshes and submits only the explicit gate', async () => {
    const f = fixture(); const { code, report } = await invoke(f, true);
    expect(code).toBe(0); expect(report.outcome).toBe('submitted');
    expect(report.note).toMatch(/actual run head/);
    expect(f.calls.filter(c => c[0] === 'workflow')).toEqual([['workflow', 'run', 'ci.yml', '--repo', 'acme/project', '--ref', 'master', '-f', 'release_gate=true']]);
  });
  it.each([
    ['moved head', { moved: true }, 'refused'], ['wrong head', { head: other }, 'refused'],
    ['unknown branch', { branch: null }, 'unavailable'], ['partial inventory', { inventory: { total_count: 2, workflow_runs: [run('completed')] } }, 'unavailable'],
    ['failed inventory', { failure: true }, 'unavailable'], ['truncated inventory', { truncated: true }, 'unavailable'],
    ['in flight', { inventory: { total_count: 1, workflow_runs: [run()] } }, 'no-op'],
    ['ambiguous status', { inventory: { total_count: 1, workflow_runs: [run('mystery')] } }, 'unavailable'],
  ])('%s sends nothing', async (_name, options, outcome) => {
    const f = fixture(options); const result = await invoke(f, true);
    expect(result.report.outcome).toBe(outcome); expect(f.calls.some(c => c[0] === 'workflow')).toBe(false);
  });
  it('reports completed runs without claiming a gate succeeded', async () => {
    const f = fixture({ inventory: { total_count: 1, workflow_runs: [run('completed')] } });
    const { report } = await invoke(f); expect(report.outcome).toBe('planned'); expect(report.runs).toHaveLength(1);
  });
  it('returns nonzero and bounds dispatch errors', async () => {
    const f = fixture({ dispatchFailure: true }); const { code, report } = await invoke(f, true);
    expect(code).toBe(1); expect(report.outcome).toBe('refused'); expect(report.dispatch.detail.length).toBeLessThanOrEqual(200);
  });
  it('documents the race and next inspection', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await cmdFleetReleaseGateStart(['--help'])).toBe(0); expect(log.mock.calls[0]![0]).toMatch(/inspect the release candidate/); } finally { log.mockRestore(); }
  });
});
