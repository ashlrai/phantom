import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceOnce } from '../src/cli/fleet-release-advance-once.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.7'; // Fixture SHAs only, not production state.
const CAND = 'a'.repeat(40);
const OTHER = 'e'.repeat(40);
const INPUTS = { ci_run_id: 777001, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: 555001 };

let stateDir: string;
let output: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rao-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const ARGS = ['--repo', REPO, '--tag', TAG, '--json'];
const report = () => JSON.parse(output[output.length - 1]!);
const receiptPath = () => join(stateDir, 'ashlrai', 'phantom', TAG, 'receipt.json');
const lockPath = () => join(stateDir, 'ashlrai', 'phantom', TAG, '.planner-cycle', 'apply.lock');

const base = (patch: Record<string, unknown> = {}): ReleaseAdvanceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome: 'planned', reason: 'eligible',
  planOutcome: 'ready',
  candidate: { sha: CAND, tree: 'b'.repeat(40) },
  master: { branch: 'master', sha: CAND, tree: 'b'.repeat(40) },
  masterMoved: false, treeMatch: true,
  gateRun: { id: INPUTS.ci_run_id, attempt: 1, conclusion: 'success' },
  producerArtifact: { id: INPUTS.build_artifact_id, name: 'a', expired: false },
  attestedRun: null, inFlightRun: null, release: { state: 'draft', id: 1 }, blockers: [],
  dispatch: { ref: 'master', inputs: INPUTS, invoked: false, accepted: false, detail: null },
  truncated: false, ...patch,
});
const submitted = () => base({ apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
  dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: true, detail: null } });
const rejected = () => base({ apply: true, outcome: 'refused', reason: 'dispatch_rejected',
  dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: false, detail: 'denied' } });

type Advance = (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;
const seq = (reports: ReleaseAdvanceReport[]): { advance: Advance; calls: { apply?: boolean }[] } => {
  const calls: { apply?: boolean }[] = [];
  let i = 0;
  return { calls, advance: async (r, t, o) => { calls.push(o); return reports[Math.min(i++, reports.length - 1)]!; } };
};

describe('fleet release-advance-once', () => {
  it('dry run delegates read-only and writes no lock or receipt', async () => {
    const f = seq([base()]);
    expect(await cmdFleetReleaseAdvanceOnce(ARGS, { stateDir, advance: f.advance })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ outcome: 'planned', reason: 'eligible', lock: 'not-taken', apply: false });
    expect(r.advance.candidate.sha).toBe(CAND);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.apply).toBeUndefined();
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });
  it('--apply submits, records the receipt, and a later call reports already-submitted', async () => {
    const f = seq([submitted(), base()]);
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], { stateDir, advance: f.advance })).toBe(0);
    let r = report();
    expect(r).toMatchObject({ outcome: 'submitted', lock: 'acquired', receipt: { state: 'recorded' } });
    expect(JSON.parse(readFileSync(receiptPath(), 'utf8'))).toMatchObject({ candidateSha: CAND, repo: REPO, tag: TAG });
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], { stateDir, advance: f.advance })).toBe(0);
    r = report();
    expect(r).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded', receipt: { state: 'matched' } });
    expect(r.receipt.record.candidateSha).toBe(CAND);
    expect(f.calls.filter(c => c.apply === true)).toHaveLength(1); // probe ran read-only
    expect(f.calls).toHaveLength(2);
  });
  it('two concurrent callers produce at most one dispatch', async () => {
    let finish!: (r: ReleaseAdvanceReport) => void;
    const calls: { apply?: boolean }[] = [];
    const advance: Advance = (r, t, o) => {
      calls.push(o);
      return o.apply ? new Promise<ReleaseAdvanceReport>(res => { finish = res; }) : Promise.resolve(base());
    };
    const deps = { stateDir, advance };
    const p1 = cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps); // sync up to first await; holds lock
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(4);
    const busy = report();
    expect(busy).toMatchObject({ outcome: 'busy', reason: 'lock_contended', lock: 'busy', advance: null });
    finish(submitted());
    expect(await p1).toBe(0);
    expect(calls.filter(c => c.apply === true)).toHaveLength(1);
  });
  it('a rejected dispatch records nothing and can retry', async () => {
    const f = seq([rejected(), submitted()]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(1);
    expect(report()).toMatchObject({ outcome: 'refused', reason: 'dispatch_rejected', receipt: { state: 'none' } });
    expect(existsSync(receiptPath())).toBe(false);
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(f.calls.filter(c => c.apply === true)).toHaveLength(2);
  });
  it('a repointed tag never inherits the previous candidate receipt', async () => {
    const other = { ...INPUTS, candidate_sha: OTHER };
    const submittedOther = () => base({ apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
      candidate: { sha: OTHER, tree: 'f'.repeat(40) },
      dispatch: { ref: 'master', inputs: other, invoked: true, accepted: true, detail: null } });
    const f = seq([submitted(), base({ candidate: { sha: OTHER, tree: 'f'.repeat(40) } }), submittedOther(),
      base({ candidate: { sha: OTHER, tree: 'f'.repeat(40) } })]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0); // CAND submitted
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0); // tag moved to OTHER: real apply
    const r = report();
    expect(r).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(r.receipt.record.candidateSha).toBe(OTHER);
    expect(f.calls.filter(c => c.apply === true)).toHaveLength(2);
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0); // now deduped on OTHER
    expect(report()).toMatchObject({ outcome: 'already-submitted' });
  });
  it('the lock is released on an ordinary failure so the next call is not busy', async () => {
    const f = seq([base({ apply: true, outcome: 'blocked', reason: 'blocker:x' }), submitted()]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0);
    expect(report()).toMatchObject({ outcome: 'submitted' });
  });
  it('an advance throw is bounded and the lock still releases', async () => {
    const boom: Advance = () => Promise.reject(new Error(`${'x'.repeat(500)}\nghp_${'s'.repeat(60)}`));
    const deps = { stateDir, advance: boom };
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(3);
    const r = report();
    expect(r.outcome).toBe('unavailable');
    expect(r.reason.length).toBeLessThan(220);
    expect(r.reason).not.toContain('ghp_');
    expect(existsSync(lockPath())).toBe(false);
  });
  it('an unreadable receipt fails closed with no dispatch', async () => {
    const f = seq([submitted()]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(0);
    writeFileSync(receiptPath(), '{torn');
    expect(await cmdFleetReleaseAdvanceOnce([...ARGS, '--apply'], deps)).toBe(3);
    expect(report()).toMatchObject({ outcome: 'unavailable', reason: 'receipt_unreadable', receipt: { state: 'unreadable' } });
    expect(f.calls).toHaveLength(1);
  });
  it('malformed flags exit 2 with zero I/O', async () => {
    const f = seq([]);
    const deps = { stateDir, advance: f.advance };
    expect(await cmdFleetReleaseAdvanceOnce(['--repo', REPO, '--json'], deps)).toBe(2);
    expect(await cmdFleetReleaseAdvanceOnce(['--repo', REPO, '--tag', 'latest', '--json'], deps)).toBe(2);
    expect(await cmdFleetReleaseAdvanceOnce(['--repo', 'bad/repo!', '--tag', TAG, '--json'], deps)).toBe(2);
    expect(await cmdFleetReleaseAdvanceOnce(['--repo', REPO, '--tag', TAG, '--bogus'], deps)).toBe(2);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
    expect(output).toHaveLength(0);
  });
  it('--help exits 0 and never touches state', async () => {
    expect(await cmdFleetReleaseAdvanceOnce(['--help'], { stateDir, advance: seq([]).advance })).toBe(0);
    expect(output.join('\n')).toContain('usage:');
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });
});
