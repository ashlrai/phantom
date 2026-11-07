import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseRetryBatch } from '../src/cli/fleet-release-retry-batch.js';
import { parseReleaseRetryBatchInput } from '../src/core/fleet/release-retry-batch.js';
import type { ReleaseAdvanceOnceOutcome, ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.9'; // Fixture identities only, not production state.
const OTHER_REPO = 'ashlrai/lexicon';
const OTHER_TAG = 'v1.2.0';
const THIRD_REPO = 'ashlrai/stack';
const THIRD_TAG = 'v0.4.1';
const CAND = 'a'.repeat(40);
const INPUTS = { ci_run_id: 777001, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: 555001 };
const SUCCESS = new Set(['planned', 'submitted', 'no-op', 'already-submitted']);

let stateDir: string;
let output: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rrb-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const entry = (repo: string, tag: string, outcome: ReleaseAdvanceOnceOutcome, apply = false): ReleaseAdvanceOnceReport => ({
  version: 1, repo, tag, apply, outcome, reason: `${outcome}_reason`,
  lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null,
});
/** Synthetic prior batch report, matching runReleaseAdvanceBatch's shape exactly. */
const priorObj = (specs: [string, string, ReleaseAdvanceOnceOutcome][], apply = false) => {
  const entries = specs.map(([repo, tag, outcome]) => entry(repo, tag, outcome, apply));
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  const succeeded = entries.filter(e => SUCCESS.has(e.outcome)).length;
  return {
    version: 1, apply, total: entries.length, succeeded, unsuccessful: entries.length - succeeded,
    counts, completed: entries.map(e => `${e.repo}@${e.tag}`), remaining: [] as string[], entries,
  };
};
const prior = (specs: [string, string, ReleaseAdvanceOnceOutcome][], apply = false) =>
  JSON.stringify(priorObj(specs, apply));
const feed = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => (async function* () { yield* chunks; })();
const report = () => JSON.parse(output[output.length - 1]!);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

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
const submitted = (repo = REPO, tag = TAG) => base({ repo, tag, apply: true, outcome: 'submitted', reason: 'dispatch_accepted',
  dispatch: { ref: 'master', inputs: INPUTS, invoked: true, accepted: true, detail: null } });

type Advance = (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;

describe('fleet release-retry-batch', () => {
  it('retries only unsuccessful entries in supplied order, keeping old outcomes beside fresh evidence', async () => {
    const once = vi.fn(async (repo: string, tag: string, o: { apply?: boolean }) =>
      entry(repo, tag, o.apply === true ? 'submitted' : 'planned', o.apply === true));
    const doc = prior([[REPO, TAG, 'submitted'], [OTHER_REPO, OTHER_TAG, 'busy'],
      [THIRD_REPO, THIRD_TAG, 'planned'], [REPO, 'v3.30.10', 'blocked']]);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'], { input: feed(doc), once })).toBe(0);
    expect(once.mock.calls.map(c => `${c[0]}@${c[1]}`)).toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
    const r = report();
    expect(r).toMatchObject({ version: 1, apply: false, input: 4 });
    expect(r.retried).toEqual([
      { repo: OTHER_REPO, tag: OTHER_TAG, previousOutcome: 'busy' },
      { repo: REPO, tag: 'v3.30.10', previousOutcome: 'blocked' },
    ]);
    expect(r.skipped).toEqual([
      { repo: REPO, tag: TAG, previousOutcome: 'submitted' },
      { repo: THIRD_REPO, tag: THIRD_TAG, previousOutcome: 'planned' },
    ]);
    expect(r.batch.entries.map((e: ReleaseAdvanceOnceReport) => e.outcome)).toEqual(['planned', 'planned']);
    expect(r.batch.entries.map((e: ReleaseAdvanceOnceReport) => `${e.repo}@${e.tag}`))
      .toEqual([`${OTHER_REPO}@${OTHER_TAG}`, `${REPO}@v3.30.10`]);
  });

  it('is strictly serial: the next retried candidate never starts before the current report', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(() => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })));
    const doc = prior([[REPO, TAG, 'busy'], [OTHER_REPO, OTHER_TAG, 'unavailable'], [THIRD_REPO, THIRD_TAG, 'refused']]);
    const pending = cmdFleetReleaseRetryBatch(['--stdin', '--json'], { input: feed(doc), once });
    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    deferreds[0]!.resolve(entry(REPO, TAG, 'planned'));
    await tick();
    expect(once).toHaveBeenCalledTimes(2);
    deferreds[1]!.resolve(entry(OTHER_REPO, OTHER_TAG, 'blocked'));
    await tick();
    expect(once).toHaveBeenCalledTimes(3);
    deferreds[2]!.resolve(entry(THIRD_REPO, THIRD_TAG, 'planned'));
    expect(await pending).toBe(1);
    expect(report().batch.counts).toEqual({ planned: 2, blocked: 1 });
  });

  it('never inherits apply: a report produced under --apply stays read-only without the flag', async () => {
    const calls: { apply?: boolean }[] = [];
    const advance = vi.fn<Advance>(async (_r, _t, o) => { calls.push(o); return base(); });
    const doc = prior([[REPO, TAG, 'busy'], [OTHER_REPO, OTHER_TAG, 'blocked']], true);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'], { input: feed(doc), stateDir, advance })).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every(c => c.apply === undefined)).toBe(true);
    expect(report().apply).toBe(false);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it('passes --apply to the fresh batch, submits and records the existing receipt', async () => {
    const advance = vi.fn<Advance>(async (repo, tag) => submitted(repo, tag));
    const doc = prior([[REPO, TAG, 'blocked']]);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), stateDir, advance })).toBe(0);
    const r = report();
    expect(r.retried[0].previousOutcome).toBe('blocked'); // old outcome…
    expect(r.batch.entries[0]).toMatchObject({ outcome: 'submitted', receipt: { state: 'recorded' } }); // …vs fresh evidence
    const receiptPath = join(stateDir, 'ashlrai', 'phantom', TAG, 'receipt.json');
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ candidateSha: CAND, repo: REPO, tag: TAG });
  });

  it('a re-fed stale report is still governed by the existing receipt, not its own old outcome', async () => {
    const calls: { apply?: boolean }[] = [];
    let i = 0;
    const script = [submitted(), base()]; // first run dispatches; the rerun's dedupe probe
    const advance: Advance = async (_r, _t, o) => { calls.push(o); return script[Math.min(i++, script.length - 1)]!; };
    const doc = prior([[REPO, TAG, 'blocked']]); // the same stale report drives both runs
    const deps = { stateDir, advance };
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), ...deps })).toBe(0);
    expect(report().batch.entries[0].outcome).toBe('submitted');
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), ...deps })).toBe(0);
    expect(report().batch.entries[0]).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded' });
    expect(calls.filter(c => c.apply === true)).toHaveLength(1); // the rerun only probed read-only
    expect(calls).toHaveLength(2);
  });

  it('returns an explicit no-work report and invokes nothing when every entry succeeded', async () => {
    const once = vi.fn();
    const doc = prior([[REPO, TAG, 'submitted'], [OTHER_REPO, OTHER_TAG, 'no-op'], [THIRD_REPO, THIRD_TAG, 'already-submitted']]);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), once, stateDir })).toBe(0);
    expect(once).not.toHaveBeenCalled();
    const r = report();
    expect(r).toMatchObject({ input: 3, retried: [], batch: null });
    expect(r.skipped.map((e: { previousOutcome: string }) => e.previousOutcome)).toEqual(['submitted', 'no-op', 'already-submitted']);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it.each([
    ['not json', '{'],
    ['not an object', '[]'],
    ['unknown top field', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), extra: 1 })],
    ['missing entries', JSON.stringify({ version: 1, apply: false, total: 0 })],
    ['version 2', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), version: 2 })],
    ['zero entries', JSON.stringify(priorObj([]))],
    ['17 entries', prior(Array.from({ length: 17 }, (_, i): [string, string, ReleaseAdvanceOnceOutcome] => [REPO, `v1.0.${i}`, 'busy']))],
    ['total underreports entries', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy'], [OTHER_REPO, OTHER_TAG, 'blocked']]), total: 1 })],
    ['tally mismatch', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), unsuccessful: 0 })],
    ['unknown counts key', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), counts: { melted: 1 } })],
    ['counts wrong sum', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), counts: { busy: 2 } })],
    ['completed mismatch', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), completed: ['other/repo@v9.9.9'] })],
    ['completed too long', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), completed: [`${REPO}@${TAG}`, 'x/y@v1.0.0'] })],
    ['entry missing key', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ repo: REPO, tag: TAG, outcome: 'busy' }] })],
    ['entry extra key', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ ...entry(REPO, TAG, 'busy'), extra: 1 }] })],
    ['unknown outcome', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ ...entry(REPO, TAG, 'busy'), outcome: 'exploded' }] })],
    ['unknown counts key', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), counts: { melted: 1 } })],
    ['bad repo', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ ...entry('bad/repo!', TAG, 'busy') }], completed: ['bad/repo!@' + TAG] })],
    ['bad tag', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ ...entry(REPO, 'latest', 'busy') }], completed: [`${REPO}@latest`] })],
    ['duplicate identities', prior([[REPO, TAG, 'busy'], [REPO, TAG, 'submitted']])],
    ['entry apply disagrees', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']], true), entries: [entry(REPO, TAG, 'busy', false)] })],
    ['non-boolean apply', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), apply: 'yes' })],
    ['non-string remaining', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), remaining: [7] })],
    ['bad receipt state', JSON.stringify({ ...priorObj([[REPO, TAG, 'busy']]), entries: [{ ...entry(REPO, TAG, 'busy'), receipt: { state: 'weird', record: null } }] })],
  ])('rejects %s with exit 2 and zero action calls (%#)', async (_label, doc) => {
    const once = vi.fn();
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--apply', '--json'], { input: feed(doc), once, stateDir })).toBe(2);
    expect(once).not.toHaveBeenCalled();
    expect(report()).toMatchObject({ version: 1, outcome: 'invalid' });
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it('rejects oversize input, bad flags and missing --stdin before reading or acting', async () => {
    const once = vi.fn();
    let iterated = false;
    const poison = (async function* () { iterated = true; yield prior([[REPO, TAG, 'busy']]); })();
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json', '--bogus'], { input: poison, once })).toBe(2);
    expect(iterated).toBe(false); // flag rejection happens before stdin is read
    expect(await cmdFleetReleaseRetryBatch(['--json'], { input: feed(prior([[REPO, TAG, 'busy']])), once })).toBe(2);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--stdin', '--json'], { input: feed(prior([[REPO, TAG, 'busy']])), once })).toBe(2);
    const big = Buffer.alloc(1024 * 1024 + 1, 0x7b);
    expect(await cmdFleetReleaseRetryBatch(['--stdin', '--json'], { input: feed(big), once })).toBe(2);
    expect(report()).toMatchObject({ outcome: 'invalid', reason: 'input_too_large' });
    expect(once).not.toHaveBeenCalled();
  });

  it('emits no stdout on invalid input without --json and explains usage on --help', async () => {
    const once = vi.fn();
    expect(await cmdFleetReleaseRetryBatch(['--stdin'], { input: feed('{'), once })).toBe(2);
    expect(output).toHaveLength(0);
    expect(await cmdFleetReleaseRetryBatch(['--help'], { once })).toBe(0);
    const help = output.join('\n');
    expect(help).toContain('usage: ashlr fleet release-retry-batch');
    expect(help).toMatch(/[Dd]ry run/);
    expect(help).toContain('submission only');
    expect(help).toContain('published');
    expect(help).toContain('per-repo/tag');
    expect(help).toContain('exit:');
    expect(once).not.toHaveBeenCalled();
  });

  it('parseReleaseRetryBatchInput separates retried from skipped without running anything', () => {
    const parsed = parseReleaseRetryBatchInput(prior([[REPO, TAG, 'busy'], [OTHER_REPO, OTHER_TAG, 'submitted']]));
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.selection.retried).toEqual([{ repo: REPO, tag: TAG, previousOutcome: 'busy' }]);
      expect(parsed.selection.skipped).toEqual([{ repo: OTHER_REPO, tag: OTHER_TAG, previousOutcome: 'submitted' }]);
    }
  });
});
