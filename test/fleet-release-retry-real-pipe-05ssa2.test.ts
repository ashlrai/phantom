import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetReleaseAdvanceBatch } from '../src/cli/fleet-release-advance-batch.js';
import { cmdFleetReleaseRetryBatch } from '../src/cli/fleet-release-retry-batch.js';
import type { ReleaseAdvanceReport } from '../src/core/fleet/release-advance.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

// Fake identities only: example-org repositories, synthetic SHAs and run ids.
interface Candidate { repo: string; tag: string; sha: string }
const A: Candidate = { repo: 'example-org/repo-alpha', tag: 'v1.0.0', sha: 'a'.repeat(40) };
const B: Candidate = { repo: 'example-org/repo-beta', tag: 'v2.1.0', sha: 'b'.repeat(40) };
const CANDIDATES = [A, B];
const ID = { ci_run_id: 880001, ci_run_attempt: 1, build_artifact_id: 770001 };
// B's blocked reason carries this 3-byte character so a chunk boundary can split it.
const DASH = '—';

let stateDir: string;
let output: string[];
let calls: { repo: string; tag: string; apply: boolean }[];
/** Repos whose apply call was accepted by the fake dispatch boundary (a real submission). */
let accepted: string[];
let inFlight = 0;
let maxInFlight = 0;
let bEligible = false;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'rrp-'));
  output = [];
  calls = [];
  accepted = [];
  inFlight = 0;
  maxInFlight = 0;
  bEligible = false;
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => { output.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});

/** The only faked seam: release evidence and dispatch. The once wrapper, receipts and batch runner are real. */
const advance = async (repo: string, tag: string, opts: { apply?: boolean }): Promise<ReleaseAdvanceReport> => {
  const c = CANDIDATES.find(x => x.repo === repo && x.tag === tag)!;
  const apply = opts.apply === true;
  calls.push({ repo, tag, apply });
  inFlight += 1;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise(resolve => setTimeout(resolve, 0)); // hold the call open so any overlap would show
    const blocked = c === B && !bEligible;
    const submitted = apply && !blocked;
    if (submitted) accepted.push(repo);
    return {
      version: 1, repo, tag, apply,
      outcome: blocked ? 'blocked' : submitted ? 'submitted' : 'planned',
      reason: blocked ? `blocker:ci_gate ${DASH} attest pending` : submitted ? 'dispatch_accepted' : 'eligible',
      planOutcome: 'ready',
      candidate: { sha: c.sha, tree: 'f'.repeat(40) },
      master: { branch: 'main', sha: c.sha, tree: 'f'.repeat(40) },
      masterMoved: false, treeMatch: true,
      gateRun: { id: ID.ci_run_id, attempt: 1, conclusion: 'success' },
      producerArtifact: { id: ID.build_artifact_id, name: 'build', expired: false },
      attestedRun: null, inFlightRun: null, attestOnCandidate: [],
      release: { state: 'draft', id: 1 }, blockers: [],
      dispatch: { ref: 'main', inputs: { ...ID, candidate_sha: c.sha }, invoked: submitted, accepted: submitted, detail: null },
      truncated: false,
    };
  } finally {
    inFlight -= 1;
  }
};
const GH: GitRunner = () => Promise.reject(new Error('git runner must not run: the advance seam is faked'));

const feed = (...chunks: (string | Uint8Array)[]): AsyncIterable<string | Uint8Array> => (async function* () { yield* chunks; })();
const batchDoc = () => feed(JSON.stringify({ version: 1, candidates: CANDIDATES.map(({ repo, tag }) => ({ repo, tag })) }));

/** Real stdout bytes as a pipe delivers them: console.log adds the newline the spy omits, and the first chunk ends inside the em dash. */
function wire(stdout: string): Uint8Array[] {
  const bytes = Buffer.from(`${stdout}\n`, 'utf8');
  const cut = bytes.indexOf(Buffer.from(DASH, 'utf8')) + 1;
  const chunks: Uint8Array[] = [bytes.subarray(0, cut)];
  for (let i = cut; i < bytes.length; i += 40) chunks.push(bytes.subarray(i, i + 40));
  return chunks;
}

/** Runs one CLI invocation and returns its exit code plus the single document it printed. */
async function invoke(run: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  output = [];
  const code = await run();
  expect(output).toHaveLength(1);
  return { code, stdout: output[0]! };
}
const firstPass = (flags = ['--stdin', '--apply', '--json']) =>
  invoke(() => cmdFleetReleaseAdvanceBatch(flags, { input: batchDoc(), gh: GH, advance, stateDir }));
const retry = (stdout: string, flags = ['--stdin', '--apply', '--json']) =>
  invoke(() => cmdFleetReleaseRetryBatch(flags, { input: feed(...wire(stdout)), gh: GH, advance, stateDir }));

const receiptPath = (c: Candidate) => join(stateDir, ...c.repo.split('/'), c.tag, 'receipt.json');
const receiptOf = (c: Candidate) => JSON.parse(readFileSync(receiptPath(c), 'utf8'));
const dispatches = (c: Candidate) => accepted.filter(repo => repo === c.repo).length;

describe('fleet release batch -> retry over the real CLI pipe', () => {
  it('feeds the actual batch stdout into retry and recovers only the blocked candidate', async () => {
    const first = await firstPass();
    expect(first.code).toBe(1);
    expect(first.stdout).toContain(DASH);
    expect(JSON.parse(first.stdout)).toMatchObject({ version: 1, apply: true, total: 2, succeeded: 1, unsuccessful: 1 });
    expect(JSON.parse(first.stdout).entries.map((e: { outcome: string }) => e.outcome)).toEqual(['submitted', 'blocked']);
    expect(existsSync(receiptPath(B))).toBe(false);

    bEligible = true;
    const second = await retry(first.stdout);
    expect(second.code).toBe(0);
    const r2 = JSON.parse(second.stdout);
    expect(r2).toMatchObject({
      version: 1, apply: true, input: 2,
      retried: [{ repo: B.repo, tag: B.tag, previousOutcome: 'blocked' }],
      skipped: [{ repo: A.repo, tag: A.tag, previousOutcome: 'submitted' }],
    });
    expect(r2.batch).toMatchObject({ total: 1, succeeded: 1, unsuccessful: 0 });
    expect(r2.batch.entries[0]).toMatchObject({ repo: B.repo, tag: B.tag, outcome: 'submitted', receipt: { state: 'recorded' } });
    expect(dispatches(A)).toBe(1);
    expect(dispatches(B)).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(receiptOf(B)).toMatchObject({ version: 1, repo: B.repo, tag: B.tag, candidateSha: B.sha });
    expect(r2.batch.entries[0].advance.candidate.sha).toBe(B.sha);
    expect(existsSync(receiptPath(A))).toBe(true);
    expect(receiptOf(A)).toMatchObject({ candidateSha: A.sha });

    // The original first-pass report, replayed: B dedupes through its real receipt, A is never retried.
    const callsBefore = calls.length;
    const third = await retry(first.stdout);
    expect(third.code).toBe(0);
    const r3 = JSON.parse(third.stdout);
    expect(r3.retried.map((e: { repo: string }) => e.repo)).toEqual([B.repo]);
    expect(r3.batch.entries[0]).toMatchObject({ outcome: 'already-submitted', receipt: { state: 'matched' } });
    expect(calls.slice(callsBefore)).toEqual([{ repo: B.repo, tag: B.tag, apply: false }]);
    expect(dispatches(A)).toBe(1);
    expect(dispatches(B)).toBe(1);
  });

  it('renders accepted retry dispatches as submissions, never as publication', async () => {
    const first = await firstPass();
    bEligible = true;
    const second = await invoke(() => cmdFleetReleaseRetryBatch(['--stdin', '--apply'], {
      input: feed(...wire(first.stdout)), gh: GH, advance, stateDir,
    }));
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`${B.repo}@${B.tag}: submitted`);
    expect(second.stdout).toContain('Accepted dispatches are submissions only; nothing is published, installed or notified.');
  });

  it('a dry-run first report cannot enable apply in the retry command', async () => {
    const dry = await firstPass(['--stdin', '--json']);
    expect(dry.code).toBe(1);
    expect(JSON.parse(dry.stdout)).toMatchObject({ apply: false, unsuccessful: 1 });

    bEligible = true;
    const retried = await retry(dry.stdout, ['--stdin', '--json']);
    expect(retried.code).toBe(0);
    expect(JSON.parse(retried.stdout)).toMatchObject({ apply: false, batch: { apply: false, entries: [{ outcome: 'planned' }] } });
    expect(calls.some(c => c.apply)).toBe(false);
    expect(readdirSync(stateDir)).toEqual([]);
  });

  it('rejects a cancelled partial report before any retry calls', async () => {
    const first = await firstPass(['--stdin', '--json']);
    const doc = JSON.parse(first.stdout);
    doc.cancelled = true;
    const before = calls.length;
    const result = await retry(JSON.stringify(doc), ['--stdin', '--json']);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toEqual({ version: 1, outcome: 'invalid', reason: 'batch_cancelled' });
    expect(calls).toHaveLength(before);
  });

  it.each([
    ['unknown outcome', (e: Record<string, unknown>) => { e.outcome = 'published'; }],
    ['stray field', (e: Record<string, unknown>) => { e.notes = 'extra'; }],
  ])('rejects a corrupt later entry (%s) before any evidence or dispatch call', async (_label, corrupt) => {
    const dry = await firstPass(['--stdin', '--json']);
    const doc = JSON.parse(dry.stdout);
    corrupt(doc.entries[1]);
    const before = calls.length;

    const bad = await retry(JSON.stringify(doc), ['--stdin', '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)).toEqual({ version: 1, outcome: 'invalid', reason: 'entry_invalid' });
    expect(calls).toHaveLength(before);
    expect(readdirSync(stateDir)).toEqual([]);
  });
});
