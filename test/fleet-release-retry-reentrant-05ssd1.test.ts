import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseRetryBatch } from '../src/cli/fleet-release-retry-batch.js';
import { runReleaseAdvanceBatch, type ReleaseAdvanceBatchOptions } from '../src/core/fleet/release-advance-batch.js';
import { advanceReleaseCandidateOnce, type ReleaseAdvanceOnceOutcome, type ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';
import { MAX_RETRY_INPUT_BYTES, parseReleaseRetryBatchInput, type ReleaseRetryBatchReport } from '../src/core/fleet/release-retry-batch.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const A = 'fixture-org/release-a';
const B = 'fixture-org/release-b';
const C = 'fixture-org/release-c';
const TAG = 'v9.8.7';
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
type Once = NonNullable<ReleaseAdvanceBatchOptions['once']>;
const entry = (repo: string, outcome: ReleaseAdvanceOnceOutcome, apply = true): ReleaseAdvanceOnceReport => ({
  version: 1, repo, tag: TAG, apply, outcome, reason: 'fixture',
  lock: outcome === 'busy' ? 'busy' : 'not-taken', receipt: { state: 'none', record: null }, advance: null,
});
// Use the production serializer, including counts/completed and success partition.
const prior = (spec: [string, ReleaseAdvanceOnceOutcome][]) => runReleaseAdvanceBatch(
  spec.map(([repo]) => ({ repo, tag: TAG })),
  { apply: true, once: async (repo, _tag, opts) => entry(repo, spec.find(([r]) => r === repo)![1], opts.apply) },
);
const feed = (value: unknown) => (async function* () { yield JSON.stringify(value); })();
let output: string[];
let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'retry-reentrant-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(stateDir, { recursive: true, force: true }); });
const latest = (): ReleaseRetryBatchReport => JSON.parse(output.at(-1)!);

/** Only gh transport is fake for A: real evidence, planner, once receipt and dispatch. */
const github = () => {
  const dispatches: string[][] = [];
  const gh = vi.fn<GitRunner>(async (_bin, args) => {
    const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: '',
      timedOut: false, truncated: false, missing: false });
    if (args[0] === 'workflow') { dispatches.push([...args]); return ok(''); }
    const path = args[1];
    const base = `repos/${A}`;
    if (path === base) return ok({ full_name: A, default_branch: 'master' });
    if (path === `${base}/git/ref/tags/${TAG}`) return ok({ object: { type: 'commit', sha: SHA } });
    if (path === `${base}/git/commits/${SHA}`) return ok({ sha: SHA, tree: { sha: TREE } });
    if (path === `${base}/branches/master`) return ok({ commit: { sha: SHA, commit: { tree: { sha: TREE } } } });
    if (path === `${base}/releases?per_page=100&page=1`)
      return ok([{ id: 42, tag_name: TAG, draft: true, prerelease: false, assets: [], target_commitish: SHA }]);
    if (path === `${base}/actions/workflows/ci.yml/runs?head_sha=${SHA}&branch=master&per_page=100`)
      return ok({ total_count: 1, workflow_runs: [{ id: 777001, run_attempt: 1, head_sha: SHA, head_branch: 'master',
        status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
        path: '.github/workflows/ci.yml', repository: { full_name: A } }] });
    if (path === `${base}/actions/workflows/attest-ci-build.yml/runs?branch=master&per_page=100`)
      return ok({ total_count: 0, workflow_runs: [] }); // Dispatch visibility lag.
    if (path === `${base}/actions/runs/777001/artifacts?per_page=100`)
      return ok({ total_count: 1, artifacts: [{ id: 555001, name: 'ashlr-build-777001-1',
        digest: `sha256:${'0'.repeat(64)}`, expired: false }] });
    throw new Error('unexpected fixture request');
  });
  return { gh, dispatches };
};

describe('release-retry-batch reentrant CLI', () => {
  it('feeds captured stdout back verbatim, retrying only latest failures and retaining once dedupe', async () => {
    const { gh, dispatches } = github();
    const once = vi.fn<Once>(async (repo, tag, opts) => repo === B
      ? entry(repo, 'busy', opts.apply) : advanceReleaseCandidateOnce(repo, tag, opts));
    const doc = await prior([[A, 'blocked'], [B, 'busy'], [C, 'submitted']]);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), gh, once, stateDir })).toBe(1);
    expect(latest().batch?.entries.map(e => e.outcome)).toEqual(['submitted', 'busy']);
    expect(dispatches).toHaveLength(1);
    const firstStdout = output.at(-1)!;
    once.mockClear(); gh.mockClear();
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], {
      input: (async function* () { yield firstStdout; })(), gh, once, stateDir,
    })).toBe(1);
    expect(once.mock.calls.map(([repo]) => repo)).toEqual([B]);
    expect(gh).not.toHaveBeenCalled();
    expect(latest()).toMatchObject({ input: 2, retried: [{ repo: B, previousOutcome: 'busy' }],
      skipped: [{ repo: A, previousOutcome: 'submitted' }] });
    expect(dispatches).toHaveLength(1); // Neither earlier success dispatches twice.
    // Replaying the original stale report still goes through the existing once receipt.
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), gh, once, stateDir })).toBe(1);
    expect(latest().batch?.entries[0]?.outcome).toBe('already-submitted');
    expect(dispatches).toHaveLength(1);
  });

  it.each([false, true])('requires explicit apply on each iteration (first apply=%s)', async firstApply => {
    const doc = await prior([[A, 'blocked']]); // Historical apply=true.
    const once = vi.fn<Once>(async (repo, _tag, opts) => entry(repo, 'busy', opts.apply));
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json', ...(firstApply ? ['--apply'] : [])],
      { input: feed(doc), once })).toBe(1);
    expect(once.mock.calls[0]?.[2].apply).toBe(firstApply);
    const first = output.at(-1)!;
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'],
      { input: (async function* () { yield first; })(), once })).toBe(1);
    expect(once.mock.calls[1]?.[2].apply).toBe(false);
    expect(latest().apply).toBe(false);
  });

  it('treats all-success nested batches and repeated null batches as no-ops', async () => {
    const once = vi.fn<Once>(async (repo, _tag, opts) => entry(repo, 'no-op', opts.apply));
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'],
      { input: feed(await prior([[A, 'blocked']])), once })).toBe(0);
    const successful = latest();
    once.mockClear();
    const gh = vi.fn();
    for (const args of [['--stdin', '--json'], ['--stdin', '--apply', '--json'], ['--stdin', '--json']]) {
      expect(await cmdFleetReleaseRetryBatch(args, { input: feed(latest()), once, gh })).toBe(0);
      expect(latest()).toMatchObject({ retried: [], batch: null });
    }
    expect(once).not.toHaveBeenCalled(); expect(gh).not.toHaveBeenCalled();
    expect(successful.batch?.counts).toEqual({ 'no-op': 1 });
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'],
      { input: feed(await prior([[C, 'submitted']])), once, gh })).toBe(0);
    expect(latest().batch).toBeNull();
  });

  const mutations: [string, (r: ReleaseRetryBatchReport) => void][] = [
    ['extra wrapper field', r => { Object.assign(r, { extra: true }); }],
    ['missing field', r => { Reflect.deleteProperty(r, 'input'); }],
    ['version', r => { Object.assign(r, { version: 2 }); }],
    ['apply type', r => { Object.assign(r, { apply: 'yes' }); }],
    ['apply disagreement', r => { r.apply = !r.apply; }],
    ['input tally', r => { r.input++; }],
    ['candidate cap', r => { r.input = 17; }],
    ['fractional input', r => { r.input = 1.5; }],
    ['null with retries', r => { r.batch = null; }],
    ['retry partition', r => { r.retried[0]!.previousOutcome = 'submitted'; }],
    ['skip partition', r => { r.skipped[0]!.previousOutcome = 'busy'; }],
    ['unknown outcome', r => { Object.assign(r.retried[0]!, { previousOutcome: 'published' }); }],
    ['extra entry field', r => { Object.assign(r.skipped[0]!, { extra: true }); }],
    ['invalid skipped identity', r => { r.skipped[0]!.repo = 'bad!'; }],
    ['overlap', r => { r.skipped[0]!.repo = A; }],
    ['wrong retry identity', r => { r.retried[0]!.repo = 'fixture-org/other'; }],
    ['wrong tag', r => { r.retried[0]!.tag = 'v1.0.0'; }],
    ['reordered retries', r => { r.retried.reverse(); }],
    ['nested count', r => { r.batch!.total++; }],
    ['nested outcome counts', r => { r.batch!.counts = { refused: 2 }; }],
    ['nested remaining', r => { r.batch!.remaining = [`${C}@${TAG}`]; }],
    ['nested unknown field', r => { Object.assign(r.batch!, { extra: true }); }],
    ['nested completed', r => { r.batch!.completed.reverse(); }],
    ['recursive wrapper', r => { Object.assign(r, { batch: structuredClone(r) }); }],
  ];
  it.each(mutations)('rejects %s before evidence/once calls', async (_label, mutate) => {
    const once = vi.fn<Once>(async (repo, _tag, opts) => entry(repo, 'busy', opts.apply));
    await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], {
      input: feed(await prior([[A, 'blocked'], [B, 'busy'], [C, 'submitted']])), once,
    });
    const report = latest();
    mutate(report); once.mockClear();
    const gh = vi.fn();
    expect(parseReleaseRetryBatchInput(JSON.stringify(report)).ok).toBe(false);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'],
      { input: feed(report), once, gh })).toBe(2);
    expect(once).not.toHaveBeenCalled(); expect(gh).not.toHaveBeenCalled();
  });

  it('preserves the 1 MiB bound and legacy batch acceptance', async () => {
    const doc = await prior([[A, 'busy']]);
    // Existing legacy parsing accepts a summed tally and string remaining list.
    doc.counts = { refused: 1 }; doc.remaining = ['historical'];
    expect(parseReleaseRetryBatchInput(JSON.stringify(doc)).ok).toBe(true);
    const text = JSON.stringify(doc);
    expect(parseReleaseRetryBatchInput(text.padEnd(MAX_RETRY_INPUT_BYTES, ' ')).ok).toBe(true);
    expect(parseReleaseRetryBatchInput(text.padEnd(MAX_RETRY_INPUT_BYTES + 1, ' ')))
      .toEqual({ ok: false, reason: 'input_too_large' });
    const gh = vi.fn();
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'], {
      input: feed('é'.repeat(MAX_RETRY_INPUT_BYTES)), gh,
    })).toBe(2);
    expect(gh).not.toHaveBeenCalled();
  });

  it('documents two explicit submission attempts', async () => {
    expect(await cmdFleetReleaseRetryBatch(['--help'])).toBe(0);
    expect(output.at(-1)).toContain('< retry-1.json > retry-2.json');
    expect(output.at(-1)).toContain('submission only');
  });
});
