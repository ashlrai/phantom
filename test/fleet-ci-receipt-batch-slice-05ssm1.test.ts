import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
import { awaitCiReceiptBatch } from '../src/core/fleet/ci-receipt-await-batch.js';
import type { awaitCiReceipt } from '../src/core/fleet/ci-receipt-await.js';
import { CiResumeInputsError, parseCiResumePrior, type CiResumePrior } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface T { repo: string; run: number; attempt: number; artifactName: string; art: number }
const T1: T = { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', art: 77 };
const T2: T = { repo: 'ashlrai/phantom', run: 992, attempt: 1, artifactName: 'ci-resume-receipts', art: 78 };
const T3: T = { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', art: 88 };
const T4: T = { repo: 'ashlrai/third', run: 7, attempt: 1, artifactName: 'receipts-pack', art: 99 };
const ALL = [T1, T2, T3, T4];
const TARGETS = ALL.map(({ repo, run, attempt, artifactName }) => ({ repo, run, attempt, artifactName }));
const DOC = JSON.stringify({ version: 1, targets: TARGETS.slice(0, 2) });
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
  /** Per-poll responses for the attempt endpoint; the last entry repeats. */
  attemptQueue?: GitRunResult[];
  /** Per-poll responses for the artifacts listing; the last entry repeats. */
  artifactsQueue?: GitRunResult[];
  onAttemptRead?: () => void;
  onDownload?: () => void;
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null; // written as receipts.json into --dir; null/undefined writes nothing
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
      if (url === attemptUrl(t)) { f.onAttemptRead?.(); return pop(f.attemptQueue) ?? ok(JSON.stringify(attemptMeta(t, 'completed'))); }
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
      dl.onDownload?.();
      if (dl.downloadBody !== undefined && dl.downloadBody !== null) {
        writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), dl.downloadBody);
      }
      return ok('');
    }
    return bad();
  } finally { reads.inFlight -= 1; }
};

/** A clock that only moves when a fake wait or sleep is asked to pass time. */
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
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
interface Deps { input?: AsyncIterable<Uint8Array>; gh: GitRunner;
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal }
const cli = async (args: string[], deps: Deps) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptAwaitBatch(args, deps), out: out.join('\n'), err: err.join('') };
};
const apiCalls = (calls: Call[]) =>
  calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1)!);
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));

/** A synthetic prior stamped with the target it was bound for. */
const prior = (repo: string, run: number): CiResumePrior => ({ version: 1, repo,
  receipts: [{ job: 'job-a', run, attempt: 1, jobId: 7, headSha: SHA, conclusion: 'failure', inputsDigest: DIGEST }] });

interface WaitCall { run: number; timeoutMs: number }
interface WaitAction { advance?: number; error?: Error; abort?: AbortController }
/**
 * An injected single-target wait: records the bound it was handed, optionally
 * passes fake time or aborts, then binds a synthetic prior or throws.
 */
const recordingWait = (calls: WaitCall[], clock: { advance: (ms: number) => void },
    actions: (WaitAction | undefined)[]): typeof awaitCiReceipt => async (opts) => {
  const action = actions[calls.length];
  calls.push({ run: opts.run, timeoutMs: opts.timeoutMs });
  action?.abort?.abort();
  if (action?.advance) clock.advance(action.advance);
  if (action?.error) throw action.error;
  return { prior: prior(opts.repo, opts.run), diagnostics: [`bound run ${opts.run}`] };
};

describe('awaitCiReceiptBatch targetTimeoutMs', () => {
  it('omitted: each wait is handed the entire remaining shared deadline', async () => {
    const clock = fakeClock();
    const calls: WaitCall[] = [];
    const { report } = await awaitCiReceiptBatch(TARGETS.slice(0, 2),
      { timeoutMs: 1000, pollMs: 250 },
      { now: clock.now, wait: recordingWait(calls, clock, [{ advance: 400 }, undefined]) });
    expect(calls.map((c) => c.timeoutMs)).toEqual([1000, 600]); // full share, then what remains
    expect(report.bound).toBe(2);
    expect(report.timedOut).toBe(false);
  });

  it('caps each wait at min(targetTimeoutMs, remaining); a local timeout fails one entry and the next binds', async () => {
    const clock = fakeClock();
    const calls: WaitCall[] = [];
    const { report, diagnostics } = await awaitCiReceiptBatch(TARGETS,
      { timeoutMs: 1000, pollMs: 250, targetTimeoutMs: 300 },
      { now: clock.now, wait: recordingWait(calls, clock, [
        { advance: 300, error: new CiResumeInputsError('await timed out after 300ms') }, // T1 exhausts its local share
        { advance: 500 }, // T2 binds, t=800
        { advance: 200 }, // T3 gets only the 200ms of global budget left and binds inside it
      ]) });
    expect(calls.map((c) => c.timeoutMs)).toEqual([300, 300, 200]); // never more than the shared remainder
    expect(report.entries.map((e: { outcome: string }) => e.outcome))
      .toEqual(['failed', 'bound', 'bound', 'not-started']);
    expect(report.entries.map((e: { run: number }) => e.run)).toEqual([991, 992, 55, 7]); // input order
    expect(report.bound).toBe(2); expect(report.failed).toBe(1); expect(report.notStarted).toBe(1);
    expect(report.timedOut).toBe(true); // the shared deadline, not a local one, stopped the batch
    expect(report.aborted).toBe(false);
    expect(report.entries[0].prior).toBeNull(); // a timed-out target never fabricates a prior
    expect(report.entries[0].reason).toContain('timed out');
    expect(report.entries[3].reason).toContain('deadline');
    expect(parseCiResumePrior(report.entries[1].prior)).toEqual(prior(T2.repo, T2.run));
    expect(diagnostics.some((l) => l.includes('run 992'))).toBe(true);
  });

  it('moves on to the next target only while global time remains', async () => {
    const clock = fakeClock();
    const calls: WaitCall[] = [];
    const { report } = await awaitCiReceiptBatch(TARGETS.slice(0, 2),
      { timeoutMs: 500, pollMs: 250, targetTimeoutMs: 400 },
      { now: clock.now, wait: recordingWait(calls, clock, [
        { advance: 400, error: new CiResumeInputsError('await timed out after 400ms') }, // T1 local bound
      ]) });
    expect(calls.map((c) => c.timeoutMs)).toEqual([400, 100]); // T2 got min(400, remaining 100)
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['failed', 'bound']);
    expect(report.timedOut).toBe(false); // T2 was reached and bound inside the global budget
  });

  it('rejects an out-of-domain targetTimeoutMs before any wait runs', async () => {
    const calls: WaitCall[] = [];
    const wait = recordingWait(calls, fakeClock(), []);
    for (const badValue of [0, -5, 250.5, 3_600_001, Number.NaN, '500', Number.MAX_SAFE_INTEGER]) {
      await expect(awaitCiReceiptBatch(TARGETS.slice(0, 1),
        { timeoutMs: 1000, targetTimeoutMs: badValue as number },
        { now: fakeClock().now, wait })).rejects.toThrow(RangeError);
    }
    expect(calls).toHaveLength(0);
  });

  it('a pre-aborted signal starts nothing', async () => {
    const controller = new AbortController(); controller.abort();
    const calls: WaitCall[] = [];
    const { report } = await awaitCiReceiptBatch(TARGETS.slice(0, 2),
      { timeoutMs: 1000, targetTimeoutMs: 300, signal: controller.signal },
      { now: fakeClock().now, wait: recordingWait(calls, fakeClock(), []) });
    expect(calls).toHaveLength(0);
    expect(report.aborted).toBe(true);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['not-started', 'not-started']);
  });

  it('an abort between entries prevents the next wait', async () => {
    const controller = new AbortController();
    const calls: WaitCall[] = [];
    const { report } = await awaitCiReceiptBatch(TARGETS.slice(0, 2),
      { timeoutMs: 1000, targetTimeoutMs: 300, signal: controller.signal },
      { now: fakeClock().now, wait: recordingWait(calls, fakeClock(), [{ abort: controller }]) });
    expect(calls).toHaveLength(1); // T2's wait was never invoked
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'not-started']);
    expect(report.entries[1].reason).toContain('aborted');
    expect(report.aborted).toBe(true);
  });
});

describe('fleet ci-receipt-await-batch --target-timeout-ms', () => {
  it('documents the flag in --help', async () => {
    const { code, out: o } = await cli(['--help'], { gh: fakeGh([], []) });
    expect(code).toBe(0);
    expect(o).toContain('--target-timeout-ms');
    for (const s of ['--stdin', 'targets', 'not-started', 'timeout-ms', 'one read', 'stderr', 'POSTs']) {
      expect(o).toContain(s);
    }
  });

  it('rejects invalid and duplicate values with exit 2 before any network read', async () => {
    for (const args of [
      [...ARGS, '--target-timeout-ms', '0'],
      [...ARGS, '--target-timeout-ms', 'x'],
      [...ARGS, '--target-timeout-ms', '3600001'],
      [...ARGS, '--target-timeout-ms', '250.5'],
      [...ARGS, '--target-timeout-ms', '-5'],
      [...ARGS, '--target-timeout-ms', '500', '--target-timeout-ms', '600'],
      [...ARGS, '--target-timeout-ms'], // missing value
      [...ARGS, '--target-timeout-ms', '--json'], // value is a flag
    ]) {
      const calls: Call[] = [];
      const { code, out: o } = await cli(args, { input: streamIn(DOC), gh: fakeGh([], calls) });
      expect(code).toBe(2);
      expect(o).toBe('');
      expect(calls).toHaveLength(0); // nothing touched the network
    }
  });

  it('forwards the bound: a still-running target fails inside its share and the next target binds', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // pending forever
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) }, // already available
    ], calls, reads);
    const { code, out: o } = await cli(
      ['--stdin', '--timeout-ms', '60000', '--poll-ms', '250', '--target-timeout-ms', '500', '--json'],
      { input: streamIn(DOC), gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1); // partial batch
    const report = JSON.parse(o);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['failed', 'bound']);
    expect(report.entries.map((e: { run: number }) => e.run)).toEqual([991, 992]);
    expect(report.bound).toBe(1); expect(report.failed).toBe(1); expect(report.notStarted).toBe(0);
    expect(report.timedOut).toBe(false); // T2 was reached inside the original global budget
    expect(report.entries[0].reason).toContain('timed out after 500ms'); // its local share, not the 60s batch bound
    expect(report.entries[0].prior).toBeNull();
    expect(parseCiResumePrior(report.entries[1].prior)).toEqual(priorDoc(T2));
    expect(apiCalls(calls).filter((u) => u.includes('/runs/992'))).toHaveLength(6); // observed once, then bound through discovery
    expect(reads.max).toBe(1); // still one read in flight
    expect(mutations(calls)).toEqual([]); // evidence stayed GET-only
  });

  it('omitted flag keeps the shared-deadline behavior: target one consumes the whole budget', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) },
    ], calls, reads);
    const { code, out: o } = await cli(
      ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--json'],
      { input: streamIn(DOC), gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    const report = JSON.parse(o);
    expect(report.timedOut).toBe(true);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['failed', 'not-started']);
    expect(report.entries[0].reason).toContain('timed out after 1000ms'); // the entire batch bound, uncapped
    expect(apiCalls(calls).filter((u) => u.includes('/runs/992'))).toHaveLength(0);
    expect(reads.max).toBe(1);
    expect(mutations(calls)).toEqual([]);
  });

  it('an abort between CLI entries stops the batch after the bound target', async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)), onDownload: () => controller.abort() },
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) },
    ], calls);
    const { code, out: o } = await cli(
      ['--stdin', '--timeout-ms', '60000', '--poll-ms', '250', '--target-timeout-ms', '500', '--json'],
      { input: streamIn(DOC), gh, now: clock.now, sleep: clock.sleep, signal: controller.signal });
    expect(code).toBe(1);
    const report = JSON.parse(o);
    expect(report.aborted).toBe(true);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'not-started']);
    expect(report.entries[1].reason).toContain('aborted');
    expect(apiCalls(calls).filter((u) => u.includes('/runs/992'))).toHaveLength(0); // T2 never read
    expect(mutations(calls)).toEqual([]);
  });
});
