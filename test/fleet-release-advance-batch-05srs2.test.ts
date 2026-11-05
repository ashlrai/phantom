import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceBatch } from '../src/cli/fleet-release-advance-batch.js';
import { parseReleaseAdvanceBatchInput } from '../src/core/fleet/release-advance-batch.js';
import type { ReleaseAdvanceOnceReport } from '../src/core/fleet/release-advance-once.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const TAG = 'v3.30.9'; // Fixture identities only, not production state.
const OTHER_REPO = 'ashlrai/lexicon';
const OTHER_TAG = 'v1.2.0';
const CAND = 'a'.repeat(40);
const INPUTS = { ci_run_id: 777001, ci_run_attempt: 1, candidate_sha: CAND, build_artifact_id: 555001 };

let stateDir: string;
let output: string[];
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rab-'));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const doc = (candidates: unknown): string => JSON.stringify({ version: 1, candidates });
const pair = (repo = REPO, tag = TAG) => ({ repo, tag });
const feed = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => (async function* () { yield* chunks; })();
const report = () => JSON.parse(output[output.length - 1]!);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const onceReport = (outcome: ReleaseAdvanceOnceReport['outcome'], patch: Partial<ReleaseAdvanceOnceReport> = {}): ReleaseAdvanceOnceReport => ({
  version: 1, repo: REPO, tag: TAG, apply: false, outcome, reason: `${outcome}_reason`,
  lock: 'not-taken', receipt: { state: 'none', record: null }, advance: null, ...patch,
});

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

type Advance = (repo: string, tag: string, opts: { apply?: boolean; runner?: GitRunner }) => Promise<ReleaseAdvanceReport>;

describe('fleet release-advance-batch', () => {
  it('reads a document split across stdin chunks and reports per candidate in order', async () => {
    const once = vi.fn(async (repo: string, tag: string, o: { apply?: boolean }) =>
      onceReport(o.apply === true ? 'submitted' : 'planned', { repo, tag }));
    const text = doc([pair(), pair(OTHER_REPO, OTHER_TAG)]);
    const chunks = [text.slice(0, 7), text.slice(7, 31), text.slice(31, 60), text.slice(60)];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(...chunks), once })).toBe(0);
    const r = report();
    expect(r).toMatchObject({ total: 2, succeeded: 2, unsuccessful: 0, counts: { planned: 2 } });
    expect(r.entries.map((e: ReleaseAdvanceOnceReport) => `${e.repo}@${e.tag}`))
      .toEqual([`${REPO}@${TAG}`, `${OTHER_REPO}@${OTHER_TAG}`]);
    expect(r.completed).toEqual([`${REPO}@${TAG}`, `${OTHER_REPO}@${OTHER_TAG}`]);
    expect(r.remaining).toEqual([]);
    expect(once).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['not json', '{'],
    ['not an object', '[{"repo":"a/b","tag":"v1.2.3"}]'],
    ['unknown top field', JSON.stringify({ version: 1, candidates: [pair()], extra: 1 })],
    ['missing version', doc([pair()]).replace('"version":1,', '')],
    ['version 2', JSON.stringify({ version: 2, candidates: [pair()] })],
    ['zero candidates', doc([])],
    ['17 candidates', doc(Array.from({ length: 17 }, (_, i) => pair(REPO, `v1.0.${i}`)))],
    ['duplicate candidates', doc([pair(), pair()])],
    ['bad repo', doc([{ repo: 'bad/repo!', tag: TAG }])],
    ['dot name', doc([{ repo: 'ashlrai/..', tag: TAG }])],
    ['bad tag', doc([{ repo: REPO, tag: 'latest' }])],
    ['extra entry field', doc([{ repo: REPO, tag: TAG, apply: true }])],
    ['non-object entry', doc(['x'])],
  ])('rejects %s with exit 2 and zero action calls', async (_label, text) => {
    const once = vi.fn();
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(text), once, stateDir })).toBe(2);
    expect(once).not.toHaveBeenCalled();
    const r = report();
    expect(r).toMatchObject({ version: 1, outcome: 'invalid' });
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it('rejects oversize input, bad flags and missing --stdin before reading or acting', async () => {
    const once = vi.fn();
    let iterated = false;
    const poison = (async function* () { iterated = true; yield doc([pair()]); })();
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json', '--bogus'], { input: poison, once })).toBe(2);
    expect(iterated).toBe(false); // flag rejection happens before stdin is read
    expect(await cmdFleetReleaseAdvanceBatch(['--json'], { input: feed(doc([pair()])), once })).toBe(2);
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--stdin', '--json'], { input: feed(doc([pair()])), once })).toBe(2);
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json', '--json'], { input: feed(doc([pair()])), once })).toBe(2);
    const big = Buffer.alloc(64 * 1024 + 1, 0x7b);
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(big), once })).toBe(2);
    expect(report()).toMatchObject({ outcome: 'invalid', reason: 'input_too_large' });
    expect(once).not.toHaveBeenCalled();
  });

  it('dry run delegates read-only and mutates no state', async () => {
    const advance = vi.fn<Advance>(async () => base());
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'],
      { input: feed(doc([pair()])), stateDir, advance })).toBe(0);
    expect(report().entries[0]).toMatchObject({ outcome: 'planned', lock: 'not-taken' });
    expect(advance.mock.calls.every(c => c[2].apply === undefined)).toBe(true);
    expect(existsSync(join(stateDir, 'ashlrai'))).toBe(false);
  });

  it('--apply delegates exactly once per candidate with apply set', async () => {
    const seen: { repo: string; tag: string; apply?: boolean }[] = [];
    const once = vi.fn(async (repo: string, tag: string, o: { apply?: boolean }) => {
      seen.push({ repo, tag, apply: o.apply });
      return onceReport('submitted', { repo, tag, apply: true });
    });
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'], { input: feed(doc(candidates)), once })).toBe(0);
    expect(seen).toEqual(candidates.map(c => ({ ...c, apply: true })));
  });

  it('is strictly serial: the next candidate never starts before the current report', async () => {
    const deferreds: { resolve: (r: ReleaseAdvanceOnceReport) => void }[] = [];
    const once = vi.fn(() => new Promise<ReleaseAdvanceOnceReport>(resolve => deferreds.push({ resolve })));
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];
    const pending = cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(doc(candidates)), once });
    await tick();
    expect(once).toHaveBeenCalledTimes(1);
    deferreds[0]!.resolve(onceReport('planned'));
    await tick();
    expect(once).toHaveBeenCalledTimes(2);
    deferreds[1]!.resolve(onceReport('blocked', { repo: OTHER_REPO, tag: OTHER_TAG }));
    await tick();
    expect(once).toHaveBeenCalledTimes(3);
    deferreds[2]!.resolve(onceReport('planned', { repo: REPO, tag: 'v3.30.10' }));
    expect(await pending).toBe(1); // blocked is unsuccessful
    expect(report().counts).toEqual({ planned: 2, blocked: 1 });
  });

  it('keeps order and a truthful summary across mixed blocked and submitted entries', async () => {
    const outcomes = ['submitted', 'blocked', 'already-submitted'] as const;
    let i = 0;
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG), pair(REPO, 'v3.30.10')];
    const once = vi.fn(async (repo: string, tag: string, o: { apply?: boolean }) =>
      onceReport(outcomes[i++]!, { repo, tag, apply: o.apply === true }));
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'], { input: feed(doc(candidates)), once })).toBe(1);
    const r = report();
    expect(r.entries.map((e: ReleaseAdvanceOnceReport) => e.outcome)).toEqual([...outcomes]);
    expect(r.entries.map((e: ReleaseAdvanceOnceReport) => e.reason)).toEqual(outcomes.map(o => `${o}_reason`));
    expect(r).toMatchObject({ total: 3, succeeded: 2, unsuccessful: 1, counts: { submitted: 1, blocked: 1, 'already-submitted': 1 } });
    expect(r.completed).toEqual(candidates.map(c => `${c.repo}@${c.tag}`));
  });

  it('turns a thrown error into a sanitized unavailable and still runs later candidates', async () => {
    const once = vi.fn(async (repo: string) => {
      if (repo === REPO) throw new Error(`${'x'.repeat(500)}\nghp_${'s'.repeat(60)}`);
      return onceReport('planned', { repo, tag: OTHER_TAG });
    });
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--json'], { input: feed(doc(candidates)), once })).toBe(1);
    const r = report();
    expect(r.entries[0]).toMatchObject({ repo: REPO, outcome: 'unavailable', advance: null });
    expect(r.entries[0].reason.length).toBeLessThan(220);
    expect(r.entries[0].reason).not.toContain('ghp_');
    expect(r.entries[0].reason).not.toContain('\n');
    expect(r.entries[1]).toMatchObject({ repo: OTHER_REPO, outcome: 'planned' });
    expect(once).toHaveBeenCalledTimes(2);
  });

  it('exercises the real serialized core: a receipt-matched rerun never re-dispatches', async () => {
    const calls: { apply?: boolean }[] = [];
    let i = 0;
    const script = [submitted(), base()]; // apply dispatch, then the dedupe probe
    const advance: Advance = async (_r, _t, o) => { calls.push(o); return script[Math.min(i++, script.length - 1)]!; };
    const deps = { stateDir, advance };
    const input = () => feed(doc([pair()]));
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'], { input: input(), ...deps })).toBe(0);
    expect(report().entries[0]).toMatchObject({ outcome: 'submitted', lock: 'acquired', receipt: { state: 'recorded' } });
    const receiptPath = join(stateDir, 'ashlrai', 'phantom', TAG, 'receipt.json');
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ candidateSha: CAND, repo: REPO, tag: TAG });
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'], { input: input(), ...deps })).toBe(0);
    expect(report().entries[0]).toMatchObject({ outcome: 'already-submitted', reason: 'dispatch_recorded', receipt: { state: 'matched' } });
    expect(calls.filter(c => c.apply === true)).toHaveLength(1); // the rerun probed read-only
    expect(calls).toHaveLength(2);
  });

  it('runs the real once inside a mixed batch so unrelated repos still advance', async () => {
    const calls: { repo: string }[] = [];
    const advance: Advance = async (repo) => {
      calls.push({ repo });
      return repo === REPO ? base({ outcome: 'blocked', reason: 'blocker:gate' }) : submitted();
    };
    const candidates = [pair(), pair(OTHER_REPO, OTHER_TAG)];
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin', '--apply', '--json'],
      { input: feed(doc(candidates)), stateDir, advance })).toBe(1);
    const r = report();
    expect(r.entries.map((e: ReleaseAdvanceOnceReport) => e.outcome)).toEqual(['blocked', 'submitted']);
    expect(calls.map(c => c.repo)).toEqual([REPO, OTHER_REPO]);
  });

  it('emits no stdout on invalid input without --json and explains usage on --help', async () => {
    const once = vi.fn();
    expect(await cmdFleetReleaseAdvanceBatch(['--stdin'], { input: feed('{'), once })).toBe(2);
    expect(output).toHaveLength(0);
    expect(await cmdFleetReleaseAdvanceBatch(['--help'], { once })).toBe(0);
    const help = output.join('\n');
    expect(help).toContain('usage: ashlr fleet release-advance-batch');
    expect(help).toMatch(/[Dd]ry run/);
    expect(help).toContain('per-repo/tag');
    expect(help).toContain('exit:');
    expect(help).toContain('never a global exactly-once');
    expect(once).not.toHaveBeenCalled();
  });

  it('parseReleaseAdvanceBatchInput rejects duplicates that only differ per repo', () => {
    const same = parseReleaseAdvanceBatchInput(doc([pair(), pair()]));
    expect(same.ok).toBe(false);
    const distinctTags = parseReleaseAdvanceBatchInput(doc([pair(), pair(REPO, 'v3.30.10')]));
    expect(distinctTags).toMatchObject({ ok: true });
    const distinctRepos = parseReleaseAdvanceBatchInput(doc([pair(), pair(OTHER_REPO, TAG)]));
    expect(distinctRepos).toMatchObject({ ok: true });
  });
});
