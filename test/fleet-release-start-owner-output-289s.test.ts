// Output boundary of the release-gate-start CLI, qualified at owner PR #5331's head
// (RQ-PHX-RELEASESTARTORIGINAL243S): each invocation prints exactly one JSON report, the
// outcome → exit-code contract holds, and no output claims publication, attestation or
// installation. The handler-level inventory matrix stays in
// test/fleet-release-gate-start-original-243s.test.ts; this file pins the stdout contract.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetReleaseGateStart } from '../src/cli/fleet-release-gate-start.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

// Any real process spawn from the code under test fails the suite.
const spawned = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  const trap = (name: string) => (...a: unknown[]) => { spawned.n++; throw new Error(`real ${name} blocked`); void a; };
  return { ...real, spawn: trap('spawn'), spawnSync: trap('spawnSync'), execFile: trap('execFile'), execFileSync: trap('execFileSync'), exec: trap('exec'), execSync: trap('execSync') };
});

const REPO = 'acme/project';
const SHA = 'a'.repeat(40);
const MOVED = 'b'.repeat(40);
const NOTE = 'Branch movement can race dispatch; check the actual run head and inspect the release candidate before downstream reuse. Submission does not mean published, attested, or installed.';

const ok = (value: unknown): GitRunResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', timedOut: false, truncated: false, missing: false });
const INFLIGHT = { id: 12, head_sha: SHA, path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'in_progress', conclusion: null };

function fixture(options: { moved?: boolean; inventory?: 'empty' | 'inflight' | 'fail' } = {}) {
  const calls: string[][] = []; let heads = 0;
  const gh: GitRunner = async (bin, args) => {
    expect(bin).toBe('gh');
    calls.push([...args]);
    if (args[0] === 'workflow') return ok(null);
    const path = args[1]!;
    if (path === `repos/${REPO}`) return ok({ default_branch: 'master' });
    if (path.includes('/branches/')) return ok({ commit: { sha: options.moved && heads++ > 0 ? MOVED : SHA } });
    if (options.inventory === 'fail') return { ...ok(''), code: 1, stdout: '', stderr: 'boom' };
    return ok(options.inventory === 'inflight' ? { total_count: 1, workflow_runs: [INFLIGHT] } : { total_count: 0, workflow_runs: [] });
  };
  return { gh, calls };
}

async function run(f: ReturnType<typeof fixture>, apply: boolean) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const code = await cmdFleetReleaseGateStart(['--repo', REPO, '--sha', SHA, ...(apply ? ['--apply'] : []), '--json'], { gh: f.gh });
    return { code, logs: log.mock.calls.map(c => String(c[0])), stderr: err.mock.calls.length };
  } finally { log.mockRestore(); err.mockRestore(); }
}

/** The whole stdout contract: one call, one single-line JSON object, nothing else printed. */
function singleJsonReport(logs: string[]) {
  expect(logs).toHaveLength(1);
  const raw = logs[0]!;
  expect(raw.startsWith('{')).toBe(true);
  expect(raw.endsWith('}')).toBe(true);
  expect(raw).not.toContain('\n');
  const report = JSON.parse(raw) as Record<string, unknown>;
  expect(report).not.toBeInstanceOf(Array);
  return report;
}

/** No field anywhere in the report may claim a publish / install / attestation / signature succeeded. */
function expectNoSuccessClaim(report: Record<string, unknown>) {
  expect(report['note']).toBe(NOTE);
  const { note: _note, ...rest } = report;
  expect(JSON.stringify(rest)).not.toMatch(/publish|install|attest|sign/i);
  for (const key of ['published', 'installed', 'attested', 'signed', 'deployed']) {
    expect(report).not.toHaveProperty(key);
    expect(report['dispatch']).not.toHaveProperty(key);
  }
}

const expected = (over: Record<string, unknown>) => ({
  version: 1, repo: REPO, sha: SHA, apply: false, outcome: 'planned', reason: 'eligible',
  branch: 'master', head: SHA, runs: [],
  dispatch: { workflow: 'ci.yml', ref: 'master', inputs: { release_gate: true }, invoked: false, detail: null },
  note: NOTE, ...over,
});
const dispatches = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c[0] === 'workflow');

afterEach(() => { expect(spawned.n).toBe(0); vi.restoreAllMocks(); });

describe('fleet release-gate-start owner output boundary (289s)', () => {
  it('planned (dry run): exit 0, one JSON report, dispatch foreseen but not invoked', async () => {
    const f = fixture(); const r = await run(f, false);
    expect(r.code).toBe(0); expect(r.stderr).toBe(0);
    const report = singleJsonReport(r.logs);
    expect(report).toEqual(expected({}));
    expectNoSuccessClaim(report);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(dispatches(f)).toHaveLength(0);
  });
  it('submitted (--apply): exit 0, one JSON report, dispatch invoked once — still not publication', async () => {
    const f = fixture(); const r = await run(f, true);
    expect(r.code).toBe(0); expect(r.stderr).toBe(0);
    const report = singleJsonReport(r.logs);
    expect(report).toEqual(expected({
      apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
      dispatch: { workflow: 'ci.yml', ref: 'master', inputs: { release_gate: true }, invoked: true, detail: null },
    }));
    expectNoSuccessClaim(report);
    expect(dispatches(f)).toEqual([['workflow', 'run', 'ci.yml', '--repo', REPO, '--ref', 'master', '-f', 'release_gate=true']]);
  });
  it('in-flight no-op (--apply): exit 0, one JSON report, observed run carried, dispatch untouched', async () => {
    const f = fixture({ inventory: 'inflight' }); const r = await run(f, true);
    expect(r.code).toBe(0); expect(r.stderr).toBe(0);
    const report = singleJsonReport(r.logs);
    expect(report).toEqual(expected({
      apply: true, outcome: 'no-op', reason: 'run_in_flight',
      runs: [{ id: 12, event: 'workflow_dispatch', status: 'in_progress', conclusion: null }],
      dispatch: { workflow: 'ci.yml', ref: null, inputs: { release_gate: true }, invoked: false, detail: null },
    }));
    expectNoSuccessClaim(report);
    expect(dispatches(f)).toHaveLength(0);
  });
  it('moved head between the fresh reads (--apply): exit 1, one JSON refusal, dispatch untouched', async () => {
    const f = fixture({ moved: true }); const r = await run(f, true);
    expect(r.code).toBe(1); expect(r.stderr).toBe(0);
    const report = singleJsonReport(r.logs);
    expect(report).toEqual(expected({
      apply: true, outcome: 'refused', reason: 'head_mismatch', head: MOVED,
      dispatch: { workflow: 'ci.yml', ref: null, inputs: { release_gate: true }, invoked: false, detail: null },
    }));
    expectNoSuccessClaim(report);
    expect(dispatches(f)).toHaveLength(0);
  });
  it('unavailable inventory (--apply): exit 3, one JSON report, dispatch untouched', async () => {
    const f = fixture({ inventory: 'fail' }); const r = await run(f, true);
    expect(r.code).toBe(3); expect(r.stderr).toBe(0);
    const report = singleJsonReport(r.logs);
    expect(report).toEqual(expected({
      apply: true, outcome: 'unavailable', reason: 'inventory_unavailable',
      dispatch: { workflow: 'ci.yml', ref: null, inputs: { release_gate: true }, invoked: false, detail: null },
    }));
    expectNoSuccessClaim(report);
    expect(dispatches(f)).toHaveLength(0);
  });
  it('--help: exit 0, zero runner calls, usage states submission is not publication', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let code = -1; let text = '';
    try {
      code = await cmdFleetReleaseGateStart(['--help'], { gh: f.gh });
      expect(log.mock.calls).toHaveLength(1);
      expect(err).not.toHaveBeenCalled();
      text = String(log.mock.calls[0]![0]);
    } finally { log.mockRestore(); err.mockRestore(); }
    expect(code).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(text).toContain('usage: ashlr fleet release-gate-start --repo OWNER/REPO --sha FULLSHA [--apply] --json');
    expect(text).toContain('Dry run by default');
    expect(text).toContain('Submission is not publication, attestation, or installation.');
    expect(text.trimStart().startsWith('{')).toBe(false);
    expect(text.replace('Submission is not publication, attestation, or installation.', '')).not.toMatch(/publi|install|attest/i);
  });
});
