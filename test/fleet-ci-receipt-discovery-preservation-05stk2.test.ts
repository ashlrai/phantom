/**
 * fleet-ci-receipt-discovery-preservation-05stk2 — preservation evidence for
 * retained PR #3648. Its unique merge-base diff is only
 * src/core/fleet/ci-receipt-batch.ts (133 lines, authored 05df3a892, PR head
 * b16e051af): validateBatchCiReceipt + processBatchCiReceipts over
 * discoverCiReceiptPrior. Every requirement of that contract is exercised
 * here against the merged ci-receipt-await-batch path — the same
 * discoverCiReceiptPrior → fetchCiResumeReceipts → parseCiResumePrior binder —
 * through the real CLI and MCP consumers with injected gh and synthetic
 * archives: whole-document validation before any read, bounded count and
 * input, duplicate and unknown-field rejection, exact receipt identity with
 * verbatim producer digests, sequential GET-only acquisition, and ordered
 * mixed available/unavailable results that never invent a prior. The retired
 * {version:1,requests:[{id,...}]} schema, its caller-supplied id and its
 * 'success'|reason status naming have no consumer on master and are asserted
 * refused here. Fake gh responses only — no real GitHub access, no mutations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
import {
  awaitCiReceiptBatch,
  CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES,
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
  parseCiReceiptAwaitBatchInput,
} from '../src/core/fleet/ci-receipt-await-batch.js';
import { parseCiResumePrior } from '../src/core/fleet/ci-resume-inputs.js';
import {
  parseFleetCiReceiptAwaitBatchArgs,
  readFleetCiReceiptAwaitBatch,
} from '../src/mcp/fleet-ci-receipt-await-batch.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface T { repo: string; run: number; attempt: number; artifactName: string; art: number }
const T1: T = { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', art: 77 };
const T2: T = { repo: 'ashlrai/phantom', run: 992, attempt: 1, artifactName: 'ci-resume-receipts', art: 78 };
const T3: T = { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', art: 88 };
const TARGETS = [T1, T2, T3].map(({ repo, run, attempt, artifactName }) => ({ repo, run, attempt, artifactName }));
const DOC = JSON.stringify({ version: 1, targets: TARGETS });
const ARGS = ['--stdin', '--timeout-ms', '60000', '--poll-ms', '250', '--json'];

const jobRow = (t: T, id: number, name: string, conclusion: string) =>
  ({ id, run_id: t.run, run_attempt: t.attempt, name, status: 'completed', conclusion, head_sha: SHA });
const receiptRow = (t: T, job: string, jobId: number, conclusion: string) =>
  ({ job, run: t.run, attempt: t.attempt, jobId, headSha: SHA, conclusion, inputsDigest: DIGEST });
const artifactRow = (t: T, expired = false, runId = t.run) =>
  ({ id: t.art, name: t.artifactName, expired, size_in_bytes: 1234, workflow_run: { id: runId } });
const attemptMeta = (t: T, status: string, attempt = t.attempt) =>
  ({ id: t.run, run_attempt: attempt, head_sha: SHA, status,
    conclusion: status === 'completed' ? 'failure' : null, repository: { full_name: t.repo } });
const runMeta = (t: T) => ({ id: t.run, run_attempt: t.attempt + 1, head_sha: SHA, status: 'completed',
  conclusion: 'failure', repository: { full_name: t.repo } });
const artifactMeta = (t: T) => ({ id: t.art, name: t.artifactName, size_in_bytes: 1234, expired: false,
  workflow_run: { id: t.run } });
const jobsPage = (t: T) =>
  [{ total_count: 2, jobs: [jobRow(t, t.run * 10 + 1, 'job-a', 'success'), jobRow(t, t.run * 10 + 2, 'job-b', 'failure')] }];
const emptyPage = [{ total_count: 0, artifacts: [] }];
const presentPage = (t: T) => [{ total_count: 1, artifacts: [artifactRow(t)] }];
const priorDoc = (t: T) => ({ version: 1, repo: t.repo,
  receipts: [receiptRow(t, 'job-a', t.run * 10 + 1, 'success'), receiptRow(t, 'job-b', t.run * 10 + 2, 'failure')] });
const attemptUrl = (t: T) => `repos/${t.repo}/actions/runs/${t.run}/attempts/${t.attempt}`;
const artifactsUrl = (t: T) => `repos/${t.repo}/actions/runs/${t.run}/artifacts?per_page=100`;

const ok = (stdout: string): GitRunResult =>
  ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
type Call = { bin: string; args: string[] };
interface FakeRun {
  t: T;
  attemptQueue?: GitRunResult[];
  artifactsQueue?: GitRunResult[];
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null;
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
/** Routes every gh call to the target identified by its repos/<repo>/actions/runs/<run> URL. */
const fakeGh = (runs: FakeRun[], calls: Call[], reads = { inFlight: 0, max: 0 }): GitRunner => async (bin, args) => {
  reads.inFlight += 1; reads.max = Math.max(reads.max, reads.inFlight);
  try {
    calls.push({ bin, args: [...args] });
    if (bin !== 'gh') return bad();
    const url = args.find((a) => a.startsWith('repos/')) ?? '';
    const f = runs.find((r) => url.startsWith(`repos/${r.t.repo}/actions/runs/${r.t.run}`)
      || url === `repos/${r.t.repo}/actions/artifacts/${r.t.art}`);
    if (args[0] === 'api') {
      if (!f) return bad();
      const t = f.t;
      if (url === attemptUrl(t)) return pop(f.attemptQueue) ?? ok(JSON.stringify(attemptMeta(t, 'completed')));
      if (url === artifactsUrl(t)) return pop(f.artifactsQueue) ?? ok(JSON.stringify(presentPage(t)));
      if (url === `repos/${t.repo}/actions/runs/${t.run}`) return f.run ?? ok(JSON.stringify(runMeta(t)));
      if (url === `repos/${t.repo}/actions/artifacts/${t.art}`) return f.artifact ?? ok(JSON.stringify(artifactMeta(t)));
      if (url === `repos/${t.repo}/actions/runs/${t.run}/attempts/${t.attempt}/jobs?per_page=100`) {
        return f.jobs ?? ok(JSON.stringify(jobsPage(t)));
      }
      return bad();
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dl = runs.find((r) => r.t.repo === args[args.indexOf('--repo') + 1] && String(r.t.run) === args[2]);
      if (!dl) return bad();
      if (dl.downloadBody !== undefined && dl.downloadBody !== null) {
        writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), dl.downloadBody);
      }
      return ok('');
    }
    return bad();
  } finally { reads.inFlight -= 1; }
};

/** A clock that only moves when the fake sleep is asked to wait. */
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};

/** Streamed stdin: the document arrives in bounded pieces, not one write. */
const streamIn = (doc: string | Buffer, pieces = 5): AsyncIterable<Uint8Array> => (async function* () {
  const buf = Buffer.isBuffer(doc) ? doc : Buffer.from(doc, 'utf8');
  const step = Math.max(1, Math.ceil(buf.length / pieces));
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
})();

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const cli = async (args: string[], deps: { input?: AsyncIterable<Uint8Array>; gh: GitRunner;
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal }) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptAwaitBatch(args, deps), out: out.join('\n'), err: err.join('') };
};
const apiCalls = (calls: Call[]) =>
  calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1)!);
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));
/** Every gh invocation is a GET api read or the bounded archive download — nothing else exists. */
const getOnly = (calls: Call[]) => calls.every((c) => c.bin === 'gh'
  && (c.args[0] === 'api' || (c.args[0] === 'run' && c.args[1] === 'download')));
const doc = (targets: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, targets, ...extra });

describe('PR #3648 batch contract preservation', () => {
  it('maps old validateBatchCiReceipt: whole-input rejection before any read, bounded count/input, duplicates and unknown fields', async () => {
    // Parser-level reason pins for the cases the old validator collapsed to null.
    expect(parseCiReceiptAwaitBatchInput('not json')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseCiReceiptAwaitBatchInput('[]')).toEqual({ ok: false, reason: 'not_object' });
    // The retired PR #3648 schema — {version:1,requests:[{id,repo,run,attempt,artifactName}]} —
    // is not a valid batch document under the merged contract.
    const retiredSchema = JSON.stringify({ version: 1, requests: [
      { id: 'r1', repo: T1.repo, run: T1.run, attempt: T1.attempt, artifactName: T1.artifactName }] });
    expect(parseCiReceiptAwaitBatchInput(retiredSchema)).toEqual({ ok: false, reason: 'unknown_or_missing_fields' });
    expect(parseCiReceiptAwaitBatchInput(doc([TARGETS[0], TARGETS[0]])))
      .toEqual({ ok: false, reason: 'duplicate_target' });
    expect(parseCiReceiptAwaitBatchInput(doc([TARGETS[0], { ...TARGETS[0], repo: 'ASHLRAI/PHANTOM' }])))
      .toEqual({ ok: false, reason: 'duplicate_target' }); // repo case is still one identity

    const cases: { input: string | Buffer; reason: string }[] = [
      { input: 'not json', reason: 'not_json' },
      { input: '[]', reason: 'not_object' },
      { input: doc([], { version: 2 }), reason: 'unsupported_version' },
      { input: doc([], { extra: true }), reason: 'unknown_or_missing_fields' }, // unknown top-level key
      { input: retiredSchema, reason: 'unknown_or_missing_fields' }, // old requests/id schema refused
      { input: doc([]), reason: 'target_count' }, // empty list
      { input: doc(Array(CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS + 1).fill(TARGETS[0])), reason: 'target_count' },
      { input: doc([{ repo: 'ashlrai/phantom', run: 991, attempt: 2 }]), reason: 'target_invalid' }, // missing field
      { input: doc([{ ...TARGETS[0], extra: 1 }]), reason: 'target_invalid' }, // unknown target key
      { input: doc([{ ...TARGETS[0], id: 'legacy-label' }]), reason: 'target_invalid' }, // old caller id refused
      { input: doc([{ ...TARGETS[0], repo: 'bad repo' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], repo: 'owner-/name' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], run: 0 }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], attempt: 'x' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], artifactName: '' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], artifactName: '-flag' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], artifactName: 'bad\nname' }]), reason: 'target_invalid' },
      { input: doc([{ ...TARGETS[0], artifactName: 'a'.repeat(201) }]), reason: 'target_invalid' },
      // A malformed LATER row still refuses the whole document: zero network.
      { input: doc([TARGETS[0], { ...TARGETS[1], attempt: 'x' }]), reason: 'target_invalid' },
      { input: doc([TARGETS[0], TARGETS[0]]), reason: 'duplicate_target' },
      { input: doc([TARGETS[0], { ...TARGETS[0], repo: 'ASHLRAI/PHANTOM' }]), reason: 'duplicate_target' },
      { input: Buffer.from('{"version":1,"targets":[', 'utf8'), reason: 'not_json' }, // truncated
    ];
    for (const { input, reason } of cases) {
      const calls: Call[] = [];
      const { code, out: o, err: e } = await cli(ARGS,
        { input: streamIn(input), gh: fakeGh([{ t: T1 }], calls) });
      expect(code).toBe(2);
      expect(o).toBe(''); // no report on invalid input
      expect(e).toContain(`Invalid input: ${reason}`);
      expect(calls).toHaveLength(0); // whole-input validation before any read
    }
    // Undecodable bytes and oversize input are refused before parsing too.
    for (const input of [
      Buffer.concat([Buffer.from('{"version":1,"targets":[{"repo":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}]}')]),
      Buffer.alloc(CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES + 1, 0x20),
    ]) {
      const calls: Call[] = [];
      expect((await cli(ARGS, { input: streamIn(input, 2), gh: fakeGh([], calls) })).code).toBe(2);
      expect(calls).toHaveLength(0);
    }
  });

  it('maps old processBatchCiReceipts: ordered mixed available/unavailable results, exact identity, verbatim digests, sequential GET-only', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }, // artifact already present: binds on first observation
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // completed, artifact absent: terminal unavailable
      { t: T3, attemptQueue: [ok(JSON.stringify(attemptMeta(T3, 'in_progress'))), ok(JSON.stringify(attemptMeta(T3, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage)), ok(JSON.stringify(presentPage(T3)))],
        downloadBody: JSON.stringify(priorDoc(T3)) }, // pending, then the archive lands and binds
    ], calls, reads);
    const { code, out: o, err: e } = await cli(ARGS, { input: streamIn(DOC), gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1); // partial: T2 unavailable
    const report = JSON.parse(o);
    expect(report.version).toBe(1);
    expect(report.total).toBe(3); expect(report.bound).toBe(2); expect(report.failed).toBe(1); expect(report.notStarted).toBe(0);
    expect(report.timedOut).toBe(false); expect(report.aborted).toBe(false);
    // Ordered results in input order; each entry carries the exact target identity —
    // the merged contract's replacement for the old caller-supplied id — and no id field.
    expect(report.entries.map((en: { run: number }) => en.run)).toEqual([991, 992, 55]);
    expect(report.entries.map((en: { outcome: string }) => en.outcome)).toEqual(['bound', 'failed', 'bound']);
    for (const [i, t] of [T1, T2, T3].entries()) {
      const en = report.entries[i];
      expect(en).not.toHaveProperty('id'); // the retired caller label is gone
      expect(en.repo).toBe(t.repo); expect(en.run).toBe(t.run);
      expect(en.attempt).toBe(t.attempt); expect(en.artifactName).toBe(t.artifactName);
    }
    // Bound entries return the same validated CiResumePrior document with producer
    // inputsDigests verbatim; a failure never yields a prior.
    expect(parseCiResumePrior(report.entries[0].prior)).toEqual(priorDoc(T1));
    expect(parseCiResumePrior(report.entries[2].prior)).toEqual(priorDoc(T3));
    expect(JSON.stringify(report)).toContain(DIGEST);
    expect(report.entries[1].prior).toBeNull();
    expect(report.entries[1].reason).toContain('completed'); // sanitized terminal reason, old status slot
    // The unavailable artifact got exactly one observation — the old single-shot
    // discovery semantics — while the pending one waited through the same binder.
    expect(apiCalls(calls).filter((u) => u.includes('/runs/992')))
      .toEqual([attemptUrl(T2), artifactsUrl(T2)]);
    expect(calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'download')).toHaveLength(2); // bound archives only
    expect(reads.max).toBe(1); // sequential: at most one read in flight
    expect(getOnly(calls)).toBe(true); // GET metadata/listing reads plus bounded downloads only
    expect(mutations(calls)).toEqual([]); // zero mutation calls
    expect(e).toContain('ci-receipt-await-batch:');
  });

  it('re-validates at the batch entry point: callers that skip the parser cannot queue malformed or duplicate targets', async () => {
    const calls: Call[] = [];
    const gh = fakeGh([], calls);
    const opts = { timeoutMs: 60000, pollMs: 250 };
    const malformed = JSON.parse('{"repo":"ashlrai/phantom","run":991,"attempt":2,"artifactName":"ci-resume-receipts","extra":1}');
    await expect(awaitCiReceiptBatch([TARGETS[0], TARGETS[0]], opts, { gh })).rejects.toThrow(RangeError);
    await expect(awaitCiReceiptBatch([malformed], opts, { gh })).rejects.toThrow(RangeError);
    await expect(awaitCiReceiptBatch([], opts, { gh })).rejects.toThrow(RangeError);
    await expect(awaitCiReceiptBatch([TARGETS[0]], { timeoutMs: 0, pollMs: 250 }, { gh }))
      .rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0); // rejection happens before any read
  });

  it('drives the identical merged path through the MCP consumer: same parser, same bounds, same report', async () => {
    const args = { targets: [TARGETS[0], TARGETS[1]], timeoutMs: 60000, pollMs: 250 };
    const parsed = parseFleetCiReceiptAwaitBatchArgs(args);
    expect(parsed).not.toBeNull();
    expect(parsed!.targets).toHaveLength(2);
    // The MCP consumer refuses the same classes the CLI parser refuses.
    expect(parseFleetCiReceiptAwaitBatchArgs({ ...args, targets: [TARGETS[0], TARGETS[0]] })).toBeNull();
    expect(parseFleetCiReceiptAwaitBatchArgs({ ...args, cwd: '/tmp' })).toBeNull(); // no caller paths
    expect(parseFleetCiReceiptAwaitBatchArgs({ ...args, timeoutMs: 3_600_001 })).toBeNull();
    expect(parseFleetCiReceiptAwaitBatchArgs({ ...args,
      targets: [{ repo: 'a/b', run: 1, attempt: 1, artifactName: 'x'.repeat(70 * 1024) }] })).toBeNull(); // serialized doc over the byte cap

    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) },
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] },
    ], calls, reads);
    const out = await readFleetCiReceiptAwaitBatch(parsed!, undefined, { gh, now: clock.now, sleep: clock.sleep });
    expect(out.schemaVersion).toBe(1); expect(out.authority).toBe('none');
    const report = out.report;
    expect(report.total).toBe(2); expect(report.bound).toBe(1); expect(report.failed).toBe(1);
    expect(report.entries.map((en) => en.outcome)).toEqual(['bound', 'failed']);
    expect(report.entries[0]).not.toHaveProperty('id');
    expect(parseCiResumePrior(report.entries[0].prior)).toEqual(priorDoc(T1)); // digest survives the public-JSON scrub
    expect(JSON.stringify(report.entries[0].prior)).toContain(DIGEST);
    expect(report.entries[1].prior).toBeNull();
    expect(report.entries[1].reason).toContain('completed');
    expect(reads.max).toBe(1);
    expect(getOnly(calls)).toBe(true);
    expect(mutations(calls)).toEqual([]);
  });
});
