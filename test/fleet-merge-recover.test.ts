import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cmdFleetMergeRecover } from '../src/cli/fleet-merge-recover.js';
import type { DirtyLandedPr } from '../src/cli/fleet-dirty-landed.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';

const head = 'a'.repeat(40);
const source: DirtyLandedPr = { number: 42, title: 'bridge: RQ-PHX-EXAMPLE', head, base: 'main', class: 'needs-recut', changedPaths: ['src/example.ts'], landedPaths: [], remainingPaths: ['src/example.ts'] };
function fixture() {
  const calls: string[][] = [], jobs = new Set<string>();
  let title = '', writes = 0, body = '', output = '';
  const state = { sourceState: 'OPEN', moved: false, replacement: false, replacementState: 'OPEN', conflict: false, failMerge: false, auto: false, failWrite: false };
  const gh: CloudGh = async args => {
    calls.push(args);
    if (args[1] === 'merge') {
      if (!state.failMerge) state.auto = true;
      return { ok: !state.failMerge, stdout: '', stderr: 'never expose provider errors' };
    }
    const pr = { number: 42, title: source.title, state: state.sourceState, headRefOid: state.moved ? 'b'.repeat(40) : head, baseRefName: 'main', isDraft: false, mergeStateStatus: 'DIRTY', autoMergeRequest: null };
    const result = args[1] === 'view' ? pr : state.replacement ? [{ ...pr, number: 43, title, state: state.replacementState, mergeStateStatus: state.conflict ? 'DIRTY' : 'CLEAN', autoMergeRequest: state.auto ? {} : null }] : [];
    return { ok: true, stdout: JSON.stringify(result), stderr: '' };
  };
  const run = (apply = false) => cmdFleetMergeRecover([...(apply ? ['--apply'] : []), '--json'], {
    gh, inspect: async () => [source], exists: async (_root, id) => { title = `bridge: RQ-PHX-${id}`; return jobs.has(id); },
    write: async (_root, job) => { if (state.failWrite) throw new Error('write'); writes++; jobs.add(job.id); body = job.body; return { file: 'fake', bytes: 1, at: '' }; },
    output: text => { output = text; },
  });
  return { run, state, calls, get writes() { return writes; }, get body() { return body; }, get report() { return JSON.parse(output); } };
}
describe('fleet merge-recover', () => {
  it('defaults to a mutation-free conflict preview', async () => {
    const f = fixture(); expect(await f.run()).toBe(0);
    expect(f.writes).toBe(0); expect(f.report.dryRun).toBe(true);
    expect(f.report.rows[0].action).toBe('queue-recut');
  });
  it('queues a stable isolated recut once across retries on current main', async () => {
    const f = fixture(); await f.run(true); await f.run(true);
    expect(f.writes).toBe(1); expect(f.report.rows[0].action).toBe('recut-queued');
    expect(f.body).toContain('origin/main'); expect(f.body).toContain(head);
    expect(f.body).toContain('Leave changes uncommitted');
  });
  it('skips already merged and changed source heads', async () => {
    const f = fixture(); f.state.sourceState = 'MERGED'; await f.run(true);
    expect(f.report.rows[0].action).toBe('merged');
    f.state.sourceState = 'OPEN'; f.state.moved = true; await f.run(true);
    expect(f.writes).toBe(0); expect(f.report.rows[0].action).toBe('source-changed');
  });
  it('retries failed auto-merge requests with a head pin and no bypass', async () => {
    const f = fixture(); await f.run(true); f.state.replacement = true; f.state.failMerge = true;
    expect(await f.run(true)).toBe(1); f.state.failMerge = false;
    expect(await f.run(true)).toBe(0); await f.run(true);
    const merges = f.calls.filter(args => args[1] === 'merge');
    expect(merges).toHaveLength(2);
    expect(merges[0]).toEqual(['pr', 'merge', '43', '--repo', 'ashlrai/phantom', '--auto', '--match-head-commit', head]);
    expect(f.writes).toBe(1);
  });
  it('retries a failed recut write without losing the recovery', async () => {
    const f = fixture(); f.state.failWrite = true; expect(await f.run(true)).toBe(1);
    f.state.failWrite = false; expect(await f.run(true)).toBe(0); await f.run(true);
    expect(f.writes).toBe(1);
  });
  it('never requests merge for conflicting or merged replacements', async () => {
    const f = fixture(); await f.run(true); f.state.replacement = true; f.state.conflict = true; await f.run(true);
    f.state.replacementState = 'MERGED'; await f.run(true);
    expect(f.calls.filter(args => args[1] === 'merge')).toHaveLength(0);
    expect(f.writes).toBe(1);
  });
  it('prioritizes the oldest measured queue entry and reports wait and required checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'merge-recover-'));
    const path = join(dir, 'queue.json');
    let output = '';
    try {
      await writeFile(path, JSON.stringify({ prs: [{ number: 42 }, { number: 44 }], queue: [
        { number: 42, enteredAt: '2026-01-02T00:00:00Z', requiredChecks: [{ name: 'Merge Gate', status: 'pending' }] },
        { number: 44, enteredAt: '2026-01-01T00:00:00Z', requiredChecks: [{ name: 'Merge Gate', status: 'failure' }] },
      ] }));
      const result = await cmdFleetMergeRecover(['--queue-input', path, '--json'], {
        inspect: async () => [source, { ...source, number: 44 }],
        gh: async args => ({ ok: true, stdout: JSON.stringify({ number: Number(args[2]), title: source.title, state: 'MERGED', headRefOid: head, baseRefName: 'main', isDraft: false }), stderr: '' }),
        output: text => { output = text; },
      });
      expect(result).toBe(0);
      const report = JSON.parse(output);
      expect(report.rows.map((row: { pr: number }) => row.pr)).toEqual([44, 42]);
      expect(report.queue.entries[0]).toMatchObject({ number: 44, causes: [{ code: 'check_failure' }] });
      expect(report.queue.entries[0].ageSeconds).toBeGreaterThan(0);
      await writeFile(path, '{}');
      expect(await cmdFleetMergeRecover(['--queue-input', path, '--apply'], { inspect: async () => { throw new Error('must not inspect'); }, output: () => {} })).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('requests only ordinary head-pinned auto-merge when required checks block a replacement', async () => {
    // BLOCKED represents host-side review or required-check gates; --auto leaves them in force.
    let output = '', merges = 0;
    const gh: CloudGh = async args => {
      if (args[1] === 'merge') { merges++; expect(args).toEqual(['pr', 'merge', '43', '--repo', 'ashlrai/phantom', '--auto', '--match-head-commit', head]); return { ok: true, stdout: '', stderr: '' }; }
      const base = { number: 42, title: source.title, state: 'OPEN', headRefOid: head, baseRefName: 'main', isDraft: false, mergeStateStatus: 'DIRTY', autoMergeRequest: null };
      return { ok: true, stdout: JSON.stringify(args[1] === 'view' ? base : [{ ...base, number: 43, title: `bridge: RQ-PHX-MR${createHash('sha256').update(`42:${head}`).digest('hex').slice(0, 32).toUpperCase()}`, mergeStateStatus: 'BLOCKED' }]), stderr: '' };
    };
    expect(await cmdFleetMergeRecover(['--apply', '--json'], { gh, inspect: async () => [source], output: text => { output = text; } })).toBe(0);
    expect(JSON.parse(output).rows[0].action).toBe('auto-merge-requested');
    expect(merges).toBe(1);
  });
});
