import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cmdFleetMergeRecover } from '../src/cli/fleet-merge-recover.js';
import type { DirtyLandedPr } from '../src/cli/fleet-dirty-landed.js';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import { reserveMergeRecoveryAttempt } from '../src/core/fleet/merge-recovery-budget.js';

let runsDir: string;
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'merge-recovery-budget-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

const head = 'a'.repeat(40);
const source: DirtyLandedPr = { number: 42, title: 'bridge: RQ-PHX-EXAMPLE', head, base: 'main', class: 'needs-recut', changedPaths: ['src/example.ts'], landedPaths: [], remainingPaths: ['src/example.ts'] };
function fixture(remainingPaths = source.remainingPaths) {
  const calls: string[][] = [], jobs = new Set<string>();
  const title = `bridge: RQ-PHX-MR${createHash('sha256').update(`42:${head}`).digest('hex').slice(0, 32).toUpperCase()}`;
  let writes = 0, body = '', output = '';
  const liveReplacement: Record<string, unknown> = {};
  const liveSource: Record<string, unknown> = {};
  const inspected = { ...source, remainingPaths };
  let afterSearch = () => {};
  const state = { sourceState: 'OPEN', moved: false, replacement: false, replacementState: 'OPEN', conflict: false, failMerge: false, auto: false, failWrite: false, failView: false, replacementNumber: 43, replacementCount: 1, unrelated: false };
  const gh: CloudGh = async args => {
    calls.push(args);
    if (args[1] === 'merge') {
      if (!state.failMerge) state.auto = true;
      return { ok: !state.failMerge, stdout: '', stderr: 'never expose provider errors' };
    }
    const pr = { number: 42, title: source.title, state: state.sourceState, headRefOid: state.moved ? 'b'.repeat(40) : head, baseRefName: 'main', isDraft: false, mergeStateStatus: 'DIRTY', autoMergeRequest: null, ...liveSource };
    const replacement = { ...pr, number: state.replacementNumber, title, state: state.replacementState, mergeStateStatus: state.conflict ? 'DIRTY' : 'CLEAN', autoMergeRequest: state.auto ? {} : null };
    if (args[1] === 'view' && args[2] !== '42' && state.failView) return { ok: false, stdout: '', stderr: 'withheld' };
    const result = args[1] === 'view' ? args[2] === '42' ? pr : { ...replacement, ...liveReplacement }
      : state.replacement ? Array.from({ length: state.replacementCount }, (_, i) => ({ ...replacement, number: replacement.number + i, title: state.unrelated ? 'unrelated search hit' : title })) : [];
    if (args[1] === 'list') afterSearch();
    return { ok: true, stdout: JSON.stringify(result), stderr: '' };
  };
  const run = (apply = false) => cmdFleetMergeRecover([...(apply ? ['--apply'] : []), '--json', '--runs-dir', runsDir], {
    gh, inspect: async () => [inspected], exists: async (_root, id) => jobs.has(id),
    write: async (_root, job) => { if (state.failWrite) throw new Error('write'); writes++; jobs.add(job.id); body = job.body; return { file: 'fake', bytes: 1, at: '' }; },
    output: text => { output = text; },
  });
  return { run, state, inspected, liveSource, liveReplacement, calls, onSearch(fn: () => void) { afterSearch = fn; }, get writes() { return writes; }, get body() { return body; }, get report() { return JSON.parse(output); } };
}
describe('fleet merge-recover', () => {
  it.each(['--help', '-h'])('prints usage and exits 0 for %s without calling gh', async flag => {
    let text = '';
    const gh: CloudGh = async () => { throw new Error('help must not call gh'); };
    expect(await cmdFleetMergeRecover([flag], { gh, output: t => { text = t; } })).toBe(0);
    expect(text).toContain('Usage: phm fleet merge-recover');
  });

  it.each([
    { mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' },
    { mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' },
    { mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' },
  ])('queues one recut per source head for either conflict signal: %j', async patch => {
    const f = fixture(); Object.assign(f.liveSource, patch);
    expect(await f.run(true)).toBe(0);
    const firstBody = f.body;
    expect(f.report.rows[0].action).toBe('recut-queued');
    expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe('recut-queued');
    expect(f.writes).toBe(1);
    expect(f.body).toBe(firstBody);
    expect(f.calls.filter(args => args[1] === 'view').every(args => args.at(-1)?.includes('mergeable'))).toBe(true);
    // A new conflicting head must have its own request, with the new head pinned.
    f.state.moved = true; f.inspected.head = 'b'.repeat(40);
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.writes).toBe(2);
    expect(f.body).not.toBe(firstBody);
    expect(f.body).toContain('b'.repeat(40));
    expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
  });

  it.each([
    [{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, 'source-changed'],
    [{ state: 'CLOSED', mergeable: 'CONFLICTING' }, 'closed'],
    [{ state: 'MERGED', mergeable: 'CONFLICTING' }, 'merged'],
  ])('leaves clean or inactive sources alone: %j', async (patch, action) => {
    const f = fixture(); Object.assign(f.liveSource, patch);
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe(action);
    expect(f.writes).toBe(0);
    expect(f.calls.some(args => ['list', 'merge'].includes(args[1]!))).toBe(false);
    expect(await readdir(runsDir)).toEqual([]);
  });

  it.each(['CLEAN', 'BLOCKED', 'UNKNOWN'])('never arms a CONFLICTING replacement reporting %s', async mergeStateStatus => {
    const f = fixture(); f.state.replacement = true;
    Object.assign(f.liveReplacement, { mergeable: 'CONFLICTING', mergeStateStatus });
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe('replacement-conflict');
    expect(f.writes).toBe(0);
    expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
    expect(await readdir(runsDir)).toEqual([]);
  });

  it('rechecks both conflict signals before reserving a recut', async () => {
    const f = fixture();
    Object.assign(f.liveSource, { mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' });
    f.onSearch(() => { f.liveSource.mergeable = 'MERGEABLE'; });
    expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe('source-changed');
    expect(f.writes).toBe(0); expect(await readdir(runsDir)).toEqual([]);
  });

  it('takes a CONFLICTING source through one recut and head-pinned auto-merge', async () => {
    const f = fixture();
    Object.assign(f.liveSource, { mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' });
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.writes).toBe(1);
    expect(f.body).toContain('Never bypass required checks or the merge queue.');
    f.state.replacement = true;
    Object.assign(f.liveReplacement, { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', headRefOid: 'c'.repeat(40) });
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.calls.filter(args => args[1] === 'merge')).toEqual([
      ['pr', 'merge', '43', '--repo', 'ashlrai/phantom', '--auto', '--match-head-commit', 'c'.repeat(40)],
    ]);
    f.state.replacementState = 'CLOSED';
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('replacement-closed');
    expect(f.writes).toBe(1);
  });

  it('carries an automatic recut through publication and re-arms its replacement without bypassing checks', async () => {
    const f = fixture();
    expect(await f.run(true)).toBe(0); expect(await f.run(true)).toBe(0);
    expect(f.writes).toBe(1);
    expect(f.body).toContain('Never bypass required checks or the merge queue.');
    f.state.replacement = true;
    f.liveReplacement.headRefOid = 'c'.repeat(40);
    f.liveReplacement.mergeStateStatus = 'BLOCKED';
    expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe('auto-merge-requested');
    expect(await f.run(true)).toBe(0);
    // GitHub evicts the replacement and disarms auto-merge while checks rerun.
    f.state.auto = false;
    expect(await f.run(true)).toBe(0);
    expect(f.calls.filter(args => args[1] === 'merge')).toEqual(Array.from({ length: 2 }, () =>
      ['pr', 'merge', '43', '--repo', 'ashlrai/phantom', '--auto', '--match-head-commit', 'c'.repeat(40)]));
    f.state.replacementState = 'MERGED';
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('replacement-merged');
    expect(f.writes).toBe(1);
  });

  it('recovers a non-PHX agent PR once and explains unresolved conflicts in plain words', async () => {
    const f = fixture(); f.inspected.title = 'bridge: RQ-CL-DOCS-1795103686';
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('recut-queued');
    expect(await f.run(true)).toBe(0); expect(f.writes).toBe(1);
    f.state.replacement = true; f.state.conflict = true;
    expect(await f.run(true)).toBe(0);
    const row = f.report.rows[0];
    expect(row.action).toBe('replacement-conflict');
    expect(row.reason).toMatch(/original PR stays open/);
    expect(f.writes).toBe(1);
    expect(f.calls.some(args => args[1] === 'merge' || args[1] === 'close')).toBe(false);
  });

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
  it('keeps exact allowed paths when queueing a recut against main', async () => {
    const f = fixture(['src/master-state.ts']);
    expect(await f.run(true)).toBe(0);
    expect(f.body).toContain('"src/master-state.ts"');
    expect(f.body).toContain('fresh branch from origin/main');
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
    expect(f.report.rows[0].action).toBe('replacement-conflict');
    f.state.replacementState = 'MERGED'; await f.run(true);
    expect(f.calls.filter(args => args[1] === 'merge')).toHaveLength(0);
    expect(f.writes).toBe(1);
  });
  it.each([
    [{ state: 'MERGED' }, 'replacement-merged'],
    [{ state: 'CLOSED' }, 'replacement-closed'],
    [{ mergeStateStatus: 'DIRTY' }, 'replacement-conflict'],
    [{ isDraft: true }, 'replacement-open'],
    [{ title: 'renamed' }, 'replacement-changed'],
    [{ baseRefName: 'release' }, 'replacement-changed'],
    [{ autoMergeRequest: {} }, 'auto-merge-requested'],
  ])('uses live replacement state after stale search: %j', async (patch, action) => {
    const f = fixture(); f.state.replacement = true; Object.assign(f.liveReplacement, patch);
    for (let retry = 0; retry < 3; retry++) {
      expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe(action);
    }
    expect(f.writes).toBe(0);
    expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
  });
  it('re-arms a published replacement on its live head without recreating the recut', async () => {
    const f = fixture(); f.state.replacement = true;
    f.liveReplacement.headRefOid = 'c'.repeat(40);
    f.liveReplacement.mergeStateStatus = 'BLOCKED';
    expect(await f.run()).toBe(0); expect(f.report.rows[0].action).toBe('request-auto-merge');
    expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
    await f.run(true); await f.run(true);
    expect(f.calls.filter(args => args[1] === 'merge')).toEqual([
      ['pr', 'merge', '43', '--repo', 'ashlrai/phantom', '--auto', '--match-head-commit', 'c'.repeat(40)],
    ]);
    expect(f.writes).toBe(0);
  });
  it.each([2, 100])('refuses ambiguous or truncated replacement discovery (%i rows)', async count => {
    const f = fixture(); f.state.replacement = true; f.state.replacementCount = count;
    f.state.unrelated = count === 100; // The exact replacement may be beyond the page.
    expect(await f.run(true)).toBe(1);
    expect(f.writes).toBe(0); expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
  });
  it('retries an unavailable direct replacement read without creating another job', async () => {
    const f = fixture(); f.state.replacement = true; f.state.failView = true;
    expect(await f.run(true)).toBe(1); expect(await f.run(true)).toBe(1);
    f.state.failView = false; await f.run(true); await f.run(true);
    expect(f.writes).toBe(0);
    expect(f.calls.filter(args => args[1] === 'merge')).toHaveLength(1);
  });
  it('preserves the hold list for replacement PRs', async () => {
    const f = fixture(); f.state.replacement = true; f.state.replacementNumber = 197;
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('held');
    expect(f.writes).toBe(0); expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
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
      const replacement = { ...base, number: 43, title: `bridge: RQ-PHX-MR${createHash('sha256').update(`42:${head}`).digest('hex').slice(0, 32).toUpperCase()}`, mergeStateStatus: 'BLOCKED' };
      return { ok: true, stdout: JSON.stringify(args[1] === 'view' ? args[2] === '42' ? base : replacement : [replacement]), stderr: '' };
    };
    expect(await cmdFleetMergeRecover(['--apply', '--json', '--runs-dir', runsDir], { gh, inspect: async () => [source], output: text => { output = text; } })).toBe(0);
    expect(JSON.parse(output).rows[0].action).toBe('auto-merge-requested');
    expect(merges).toBe(1);
  });
  it.each(['recut', 'merge'] as const)('bounds failed %s submissions across fresh invocations and head changes', async action => {
    for (let i = 0; i < 3; i++) {
      const f = fixture(); f.state.replacement = action === 'merge';
      f.state.failMerge = true; f.state.failWrite = true;
      f.liveReplacement.headRefOid = String(i).repeat(40);
      expect(await f.run(true)).toBe(1);
    }
    const f = fixture(); f.state.replacement = action === 'merge';
    if (action === 'recut') { f.state.moved = true; f.inspected.head = 'b'.repeat(40); }
    expect(await f.run()).toBe(0); expect(f.report.rows[0].action).toBe('retry-limit');
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('retry-limit');
    expect(f.writes).toBe(0); expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
  });
  it.each([false, true])('refuses a source merged during replacement discovery (replacement=%s)', async replacement => {
    const f = fixture(); f.state.replacement = replacement;
    f.onSearch(() => { f.state.sourceState = 'MERGED'; });
    expect(await f.run(true)).toBe(0); expect(f.report.rows[0].action).toBe('source-changed');
    expect(f.writes).toBe(0); expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
    expect(await readdir(runsDir)).toEqual([]);
  });
  it('reports work already present on the base without another recut or merge', async () => {
    const f = fixture(); f.inspected.class = 'landed';
    expect(await f.run(true)).toBe(0);
    expect(f.report.rows[0].action).toBe('already-present-on-base');
    expect(f.calls).toEqual([]); expect(f.writes).toBe(0);
  });
  it('previews without writes and atomically caps concurrent reservations independently per action', async () => {
    expect(await reserveMergeRecoveryAttempt(runsDir, 42, 'merge', false)).toBe(true);
    expect(await readdir(runsDir)).toEqual([]);
    const attempts = await Promise.all(Array.from({ length: 8 }, () => reserveMergeRecoveryAttempt(runsDir, 42, 'merge', true)));
    expect(attempts.filter(Boolean)).toHaveLength(3);
    expect(await reserveMergeRecoveryAttempt(runsDir, 42, 'merge', false)).toBe(false);
    expect(await reserveMergeRecoveryAttempt(runsDir, 42, 'recut', true)).toBe(true);
    expect(await reserveMergeRecoveryAttempt(runsDir, 43, 'merge', true)).toBe(true);
  });
  it('fails closed before effects when the budget store is unavailable or redirected', async () => {
    const f = fixture(); f.state.replacement = true;
    await writeFile(join(runsDir, 'queue'), 'not a directory');
    expect(await f.run(true)).toBe(1);
    await rm(join(runsDir, 'queue'));
    await symlink(runsDir, join(runsDir, 'queue'), 'dir');
    expect(await f.run(true)).toBe(1);
    expect(f.calls.some(args => args[1] === 'merge')).toBe(false);
  });
  it('does not spend recut attempts while the drop queue is full', async () => {
    const dir = join(runsDir, 'queue', 'prompts');
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(join(dir, `RQ-PHX-JOB${i}.md`), 'queued')));
    let reserved = false;
    const result = await cmdFleetMergeRecover(['--apply', '--json', '--runs-dir', runsDir], {
      inspect: async () => [source], output: () => {},
      gh: async args => ({ ok: true, stderr: '', stdout: JSON.stringify(args[1] === 'list' ? [] : {
        number: 42, title: source.title, state: 'OPEN', headRefOid: head, baseRefName: 'main', isDraft: false, mergeStateStatus: 'DIRTY',
      }) }),
      reserve: async () => { reserved = true; return true; },
    });
    expect(result).toBe(1); expect(reserved).toBe(false);
  });
});
