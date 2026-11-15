import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRunResult } from '../src/core/verse/git-ops.js';

// Drives `ashlr fleet release-gate-start` through the real fleet dispatcher
// (cmdFleet -> generated registry -> cmdFleetReleaseGateStart). The default gh
// runner is replaced so no real `gh` process or network call ever happens.
const calls = vi.hoisted(() => [] as string[][]);
const state = vi.hoisted(() => ({ head: 'c'.repeat(40), dispatchCode: 0 }));

vi.mock('../src/core/verse/git-ops.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/verse/git-ops.js')>();
  const ok = (value: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
  return {
    ...actual,
    defaultGitRunner: async (bin: string, args: readonly string[]): Promise<GitRunResult> => {
      calls.push([bin, ...args]);
      if (args[0] === 'workflow') return { ...ok(null), code: state.dispatchCode, stderr: state.dispatchCode ? 'HTTP 403' : '' };
      const path = args[1]!;
      if (path === 'repos/acme/project') return ok({ default_branch: 'main' });
      if (path === 'repos/acme/project/branches/main') return ok({ commit: { sha: state.head } });
      if (path.startsWith('repos/acme/project/actions/workflows/ci.yml/runs?')) return ok({ total_count: 0, workflow_runs: [] });
      return { ...ok(null), code: 1 };
    },
  };
});

const { cmdFleet } = await import('../src/cli/fleet-entry.js');
const { FLEET_SUBCOMMAND_LOADERS } = await import('../src/cli/fleet-subcommand-registry.js');

const sha = 'c'.repeat(40);
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)![0]));

beforeEach(() => {
  calls.length = 0; state.head = sha; state.dispatchCode = 0;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { log.mockRestore(); err.mockRestore(); });

describe('fleet release-gate-start via cmdFleet (recut of #3640)', () => {
  it('is registered as a fleet verb', () => {
    expect(Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'release-gate-start')).toBe(true);
  });

  it('dry-run plans the dispatch against the default branch and sends nothing', async () => {
    expect(await cmdFleet(['release-gate-start', '--repo', 'acme/project', '--sha', sha, '--json'])).toBe(0);
    const report = lastJson();
    expect(report).toMatchObject({ outcome: 'planned', branch: 'main', head: sha, apply: false });
    expect(report.dispatch).toMatchObject({ ref: 'main', invoked: false, inputs: { release_gate: true } });
    expect(calls.every(c => c[0] === 'gh' && c[1] === 'api')).toBe(true);
  });

  it('--apply re-reads state and dispatches exactly one release gate run', async () => {
    expect(await cmdFleet(['release-gate-start', '--repo', 'acme/project', '--sha', sha, '--apply', '--json'])).toBe(0);
    expect(lastJson()).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted' });
    expect(calls.filter(c => c[1] === 'workflow')).toEqual([
      ['gh', 'workflow', 'run', 'ci.yml', '--repo', 'acme/project', '--ref', 'main', '-f', 'release_gate=true'],
    ]);
    // Two full reads (repo, branch, runs) precede the single POST.
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(6);
  });

  it('refuses a SHA that is not the default branch head and never dispatches', async () => {
    state.head = 'd'.repeat(40);
    expect(await cmdFleet(['release-gate-start', '--repo', 'acme/project', '--sha', sha, '--apply', '--json'])).toBe(1);
    expect(lastJson()).toMatchObject({ outcome: 'refused', reason: 'head_mismatch' });
    expect(calls.some(c => c[1] === 'workflow')).toBe(false);
  });

  it('reports a failed dispatch as refused with exit 1', async () => {
    state.dispatchCode = 1;
    expect(await cmdFleet(['release-gate-start', '--repo', 'acme/project', '--sha', sha, '--apply', '--json'])).toBe(1);
    expect(lastJson()).toMatchObject({ outcome: 'refused', reason: 'dispatch_failed', dispatch: { invoked: true, detail: 'HTTP 403' } });
  });

  it.each([
    [['--repo', 'acme/project', '--sha', sha]],
    [['--repo', 'acme/project', '--sha', 'abc', '--json']],
    [['--repo', 'acme/../x', '--sha', sha, '--json']],
    [['--repo', 'acme/project', '--sha', sha, '--json', '--bogus']],
  ])('rejects invalid input %j with exit 2 before any gh call', async (args) => {
    expect(await cmdFleet(['release-gate-start', ...args])).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('--help prints usage and acts on nothing', async () => {
    expect(await cmdFleet(['release-gate-start', '--help'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/usage: ashlr fleet release-gate-start/);
    expect(calls).toHaveLength(0);
  });
});
