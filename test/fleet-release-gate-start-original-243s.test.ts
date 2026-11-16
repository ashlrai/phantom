// Preservation of PR #4883's still-missing release-gate-start handler regression suite. Source commit:
// de8acceb4bee55948c3be43525080dfca0f84aa4 (test/fleet-release-gate-start-recovery-102.test.ts, 163 lines).
// Source-PR cases are already covered by test/fleet-release-gate-start-05srq2.test.ts; this file keeps the
// handler-level cases that add unique evidence: no real spawn, plan-only reads, fresh re-reads, honest errors.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseGateStart } from '../src/cli/fleet-release-gate-start.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

// Any real process spawn from the code under test fails the suite.
const spawned = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const trap = (name: string) => (...a: unknown[]) => { spawned.n++; throw new Error(`real ${name} blocked`); void a; };
  return { ...real, spawn: trap('spawn'), spawnSync: trap('spawnSync'), execFile: trap('execFile'), execFileSync: trap('execFileSync'), exec: trap('exec'), execSync: trap('execSync') };
});

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const ok = (value: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
const run = (status = 'queued', extra: Record<string, unknown> = {}) => ({ id: 12, head_sha: sha, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status, conclusion: status === 'completed' ? 'success' : null, ...extra });
function fixture(options: { head?: string; moved?: boolean; branch?: string | null; inventory?: unknown; failure?: boolean; dispatchFailure?: boolean; dispatchStderr?: string; truncated?: boolean; throwDispatch?: boolean } = {}) {
  const calls: string[][] = []; let heads = 0;
  const gh: GitRunner = async (bin, args) => {
    expect(bin).toBe('gh');
    calls.push([...args]);
    if (args[0] === 'workflow') {
      if (options.throwDispatch) throw new Error('spawn exploded');
      return options.dispatchFailure ? { ...ok(null), code: 1, stderr: options.dispatchStderr ?? `failure ${'x'.repeat(300)}` } : ok(null);
    }
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
const dispatches = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[0] === 'workflow');

afterEach(() => { expect(spawned.n).toBe(0); vi.restoreAllMocks(); });

describe('fleet release-gate-start original-243s (handler-level, fake runner)', () => {
  it('dry run (plan) issues only GET api reads and never a workflow call', async () => {
    const f = fixture(); const { report } = await invoke(f);
    expect(report).toMatchObject({ apply: false, outcome: 'planned', reason: 'eligible' });
    expect(f.calls.length).toBeGreaterThan(0);
    for (const c of f.calls) { expect(c[0]).toBe('api'); expect(c).not.toContain('--method'); expect(c).not.toContain('-X'); }
  });
  it('apply reads head twice (fresh) and dispatches exactly once, last', async () => {
    const f = fixture(); const { report } = await invoke(f, true);
    expect(report).toMatchObject({ outcome: 'submitted', reason: 'dispatch_accepted' });
    expect(f.calls.filter(c => c[1]?.includes('/branches/'))).toHaveLength(2);
    expect(f.calls.filter(c => c[1]?.includes('/runs?head_sha=' + sha))).toHaveLength(2);
    expect(f.calls[f.calls.length - 1]![0]).toBe('workflow');
    expect(dispatches(f)).toHaveLength(1);
  });
  it('in-flight dispatch/schedule run suppresses a duplicate; completed or push runs do not', async () => {
    const inflight = fixture({ inventory: { total_count: 1, workflow_runs: [run('in_progress')] } });
    const r = await invoke(inflight, true);
    expect(r).toMatchObject({ code: 0, report: { outcome: 'no-op', reason: 'run_in_flight' } }); expect(dispatches(inflight)).toHaveLength(0);
    const sched = fixture({ inventory: { total_count: 1, workflow_runs: [run('queued', { event: 'schedule' })] } });
    expect((await invoke(sched, true)).report.outcome).toBe('no-op');
    const push = fixture({ inventory: { total_count: 1, workflow_runs: [run('queued', { event: 'push' })] } });
    expect((await invoke(push, true)).report.outcome).toBe('submitted');
  });
  it('changed head between plan and dispatch refuses with nonzero exit', async () => {
    const f = fixture({ moved: true }); const { code, report } = await invoke(f, true);
    expect(code).toBe(1); expect(report).toMatchObject({ outcome: 'refused', reason: 'head_mismatch', dispatch: { invoked: false, ref: null } });
    expect(dispatches(f)).toHaveLength(0);
  });
  it('dispatch failure is bounded, control-stripped, and never reported as submitted', async () => {
    const f = fixture({ dispatchFailure: true, dispatchStderr: `[31mboom[0m\n${'y'.repeat(500)}` });
    const { code, report } = await invoke(f, true);
    expect(code).toBe(1); expect(report).toMatchObject({ outcome: 'refused', reason: 'dispatch_failed', dispatch: { invoked: true } });
    expect(report.dispatch.detail.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(report.dispatch.detail).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
  it('a throwing runner during dispatch is contained as dispatch_failed', async () => {
    const f = fixture({ throwDispatch: true }); const { code, report } = await invoke(f, true);
    expect(code).toBe(1); expect(report).toMatchObject({ outcome: 'refused', reason: 'dispatch_failed' });
  });
  it.each([
    ['foreign head_sha', run('completed', { head_sha: other })],
    ['foreign workflow path', run('completed', { path: '.github/workflows/other.yml' })],
    ['bad id', run('completed', { id: 0 })],
    ['missing event', run('completed', { event: '' })],
    ['malformed row', 'nope'],
  ])('malformed inventory row (%s) does not authorize dispatch', async (_n, row) => {
    const f = fixture({ inventory: { total_count: 1, workflow_runs: [row] } });
    const { code, report } = await invoke(f, true);
    expect(code).toBe(3); expect(report).toMatchObject({ outcome: 'unavailable', reason: 'inventory_unavailable' }); expect(dispatches(f)).toHaveLength(0);
  });
  it('non-object / total_count mismatch inventories are unavailable', async () => {
    for (const inventory of [{ workflow_runs: [] }, { total_count: 0, workflow_runs: 'x' }, { total_count: 1, workflow_runs: [] }]) {
      const f = fixture({ inventory }); expect((await invoke(f, true)).report.outcome).toBe('unavailable'); expect(dispatches(f)).toHaveLength(0);
    }
  });
  it('output never claims published, signed or installed', async () => {
    for (const apply of [false, true]) {
      const f = fixture(); const { report } = await invoke(f, apply);
      expect(report.note).toMatch(/does not mean published, attested, or installed/);
      expect(['planned', 'submitted', 'no-op', 'refused', 'unavailable']).toContain(report.outcome);
    }
  });
  it.each([
    [['--sha', sha, '--json']], [['--repo', 'acme/project', '--sha', 'abc', '--json']],
    [['--repo', 'acme/project', '--sha', sha]], [['--repo', '../x', '--sha', sha, '--json']],
    [['--repo', 'acme/project', '--sha', sha, '--json', '--bogus']], [['--repo', 'acme/project', '--repo', 'acme/other', '--sha', sha, '--json']],
  ])('rejects invalid arguments %j with exit 2 and no runner call', async (args) => {
    const f = fixture(); const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetReleaseGateStart(args as string[], { gh: f.gh })).toBe(2);
    expect(err).toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
  });
  it('is registered as a fleet verb exporting cmdFleetReleaseGateStart', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['release-gate-start']!();
    expect(mod['cmdFleetReleaseGateStart']).toBe(cmdFleetReleaseGateStart);
  });
});
