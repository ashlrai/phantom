import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
import { cmdFleetCiReceiptBatchReplan } from '../src/cli/fleet-ci-receipt-batch-replan.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { parseCiReceiptAwaitBatchInput } from '../src/core/fleet/ci-receipt-await-batch.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface T { repo: string; run: number; attempt: number; artifactName: string; art: number }
const T1: T = { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', art: 77 };
const T2: T = { repo: 'ashlrai/phantom', run: 992, attempt: 1, artifactName: 'ci-resume-receipts', art: 78 };
const T3: T = { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', art: 88 };
const TARGETS = [T1, T2, T3].map(({ repo, run, attempt, artifactName }) => ({ repo, run, attempt, artifactName }));
const identity = (t: T) => ({ repo: t.repo, run: t.run, attempt: t.attempt, artifactName: t.artifactName });
const DOC = JSON.stringify({ version: 1, targets: TARGETS });
const BATCH_ARGS = ['--stdin', '--timeout-ms', '60000', '--poll-ms', '250', '--json'];

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
  /** Runs inside the gh run-download fake, after receipts.json is written. */
  onDownload?: () => void;
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null;
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
/** Routes every gh call to the target identified by its repos/<repo>/actions/runs/<run> URL. */
const fakeGh = (runs: FakeRun[], calls: Call[]): GitRunner => async (bin, args) => {
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
    dl.onDownload?.();
    return ok('');
  }
  return bad();
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

const awaitBatch = async (args: string[], deps: {
  input?: AsyncIterable<Uint8Array>; gh: GitRunner;
  now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal;
}) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptAwaitBatch(args, deps), out: out.join('\n'), err: err.join('') };
};
const replan = async (args: string[], deps: { input?: AsyncIterable<Uint8Array> }) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptBatchReplan(args, deps), out: out.join('\n'), err: err.join('') };
};

/** Produce a report with the REAL awaitCiReceiptBatch under fake gh reads. */
const genReport = async (runs: FakeRun[], doc: string, args = BATCH_ARGS, extra: { signal?: AbortSignal } = {}) => {
  const calls: Call[] = [];
  const clock = fakeClock();
  const { code, out: report } = await awaitBatch(args,
    { input: streamIn(doc), gh: fakeGh(runs, calls), now: clock.now, sleep: clock.sleep, ...extra });
  return { code, report, calls };
};

describe('fleet ci-receipt-batch-replan', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-receipt-batch-replan')).toEqual(
      { module: './fleet-ci-receipt-batch-replan.js', exportName: 'cmdFleetCiReceiptBatchReplan' });
    const { code, out: o } = await replan(['--help'], {});
    expect(code).toBe(0);
    for (const s of ['--stdin', 'report', 'targets', 'bound', 'not-started', 'terminal', 'stderr', 'retry']) {
      expect(o).toContain(s);
    }
  });

  it('replans a deadline-split report: failed and not-started retry in input order, bound never does', async () => {
    // T1 binds instantly; T2 stays pending until the shared deadline fails it;
    // T3 is never reached and lands an explicit not-started entry.
    const { code, report, calls } = await genReport([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) },
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'in_progress')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { t: T3, downloadBody: JSON.stringify(priorDoc(T3)) },
    ], DOC, ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--json']);
    expect(code).toBe(1);
    const parsed = JSON.parse(report);
    expect(parsed.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'failed', 'not-started']);
    expect(parsed.timedOut).toBe(true);

    const { code: rc, out: ro, err: re } = await replan(['--stdin', '--json'], { input: streamIn(report) });
    expect(rc).toBe(0);
    expect(JSON.parse(ro)).toEqual({ version: 1, targets: [identity(T2), identity(T3)] });
    // Nonempty output is await-batch stdin verbatim — same validator accepts it.
    const roundTrip = parseCiReceiptAwaitBatchInput(ro);
    expect(roundTrip).toEqual({ ok: true, targets: [identity(T2), identity(T3)] });
    // Exact identities survive; the bound target is absent; no prior, no reason text.
    expect(ro).not.toContain(String(T1.run));
    expect(ro).not.toContain(DIGEST);
    expect(ro).not.toContain('timed out');
    expect(re).toContain('ci-receipt-batch-replan: 2 of 3');
    expect(calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'download')).toHaveLength(1); // only T1 bound
  });

  it('replans an aborted batch: cancellation not-started entries retry too', async () => {
    const controller = new AbortController();
    // T1 binds; the abort lands inside its archive download so T2 and T3 are
    // explicit not-started entries on an aborted report.
    const { code, report } = await genReport([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)), onDownload: () => controller.abort() },
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) },
      { t: T3, downloadBody: JSON.stringify(priorDoc(T3)) },
    ], DOC, BATCH_ARGS, { signal: controller.signal });
    expect(code).toBe(1);
    const parsed = JSON.parse(report);
    expect(parsed.aborted).toBe(true);
    expect(parsed.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'not-started', 'not-started']);

    const { code: rc, out: ro } = await replan(['--stdin', '--json'], { input: streamIn(report) });
    expect(rc).toBe(0);
    expect(parseCiReceiptAwaitBatchInput(ro)).toEqual({ ok: true, targets: [identity(T2), identity(T3)] });
    expect(JSON.parse(ro).targets).toHaveLength(2);
  });

  it('replans a clean partial report: only the failed entry comes back', async () => {
    // No deadline, no abort: T2 completed with the artifact never produced.
    const { code, report } = await genReport([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) },
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { t: T3, downloadBody: JSON.stringify(priorDoc(T3)) },
    ], DOC);
    expect(code).toBe(1);
    const parsed = JSON.parse(report);
    expect(parsed.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'failed', 'bound']);
    expect(parsed.timedOut).toBe(false); expect(parsed.aborted).toBe(false);

    const { code: rc, out: ro } = await replan(['--stdin'], { input: streamIn(report) }); // pretty JSON still parses
    expect(rc).toBe(0);
    expect(JSON.parse(ro)).toEqual({ version: 1, targets: [identity(T2)] });
    expect(parseCiReceiptAwaitBatchInput(ro)).toEqual({ ok: true, targets: [identity(T2)] });
    expect(ro).not.toContain('no artifact'); // reason text never echoes
  });

  it('treats an all-bound report as terminal: same envelope, empty targets, exit 0', async () => {
    const { code, report } = await genReport(
      [{ t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }],
      JSON.stringify({ version: 1, targets: [TARGETS[0]] }));
    expect(code).toBe(0);
    const { code: rc, out: ro, err: re } = await replan(['--stdin', '--json'], { input: streamIn(report) });
    expect(rc).toBe(0);
    expect(JSON.parse(ro)).toEqual({ version: 1, targets: [] });
    expect(re).toContain('terminal'); // documented no-retry state, not await-batch input
  });

  it('rejects malformed or inconsistent reports with no manifest', async () => {
    const { report: validJson } = await genReport([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) },
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { t: T3, downloadBody: JSON.stringify(priorDoc(T3)) },
    ], DOC);
    const mutate = (fn: (r: Record<string, unknown>) => void): string => {
      const r = JSON.parse(validJson) as Record<string, unknown>;
      fn(r);
      return JSON.stringify(r);
    };
    const entries = (r: Record<string, unknown>) => r.entries as Record<string, unknown>[];
    const docs: (string | Buffer)[] = [
      'not json',
      '[]',
      Buffer.from(validJson.slice(0, -10), 'utf8'), // truncated
      Buffer.concat([Buffer.from('{"version":1,"entries":[', 'utf8'), Buffer.from([0xff, 0xfe]), Buffer.from(']}')]), // bad UTF-8
      mutate((r) => { r.version = 2; }),
      mutate((r) => { r.extra = true; }), // unknown top-level key
      mutate((r) => { delete r.timedOut; }), // missing top-level key
      mutate((r) => { r.total = 'x'; }),
      mutate((r) => { r.timedOut = 'no'; }),
      mutate((r) => { r.entries = {}; }),
      mutate((r) => { r.total = 99; }), // entries.length !== total
      mutate((r) => { r.bound = 0; }), // counts disagree with outcomes
      mutate((r) => { r.notStarted = 1; }), // counts disagree with outcomes
      mutate((r) => { entries(r)[0]!.outcome = 'lost'; }),
      mutate((r) => { entries(r)[0]!.extra = 1; }), // unknown entry key
      mutate((r) => { delete entries(r)[0]!.attempt; }), // missing entry key
      mutate((r) => { entries(r)[0]!.prior = null; }), // bound without a prior
      mutate((r) => { entries(r)[0]!.reason = 'kept'; }), // bound with a reason
      mutate((r) => { entries(r)[0]!.prior = { version: 2, repo: T1.repo, receipts: [] }; }), // malformed prior
      mutate((r) => { entries(r)[0]!.prior = { version: 1, repo: 'other/repo', receipts: [] }; }), // prior names another repo
      mutate((r) => { entries(r)[1]!.prior = { version: 1, repo: T2.repo, receipts: [] }; }), // failed carrying a prior
      mutate((r) => { entries(r)[1]!.reason = 42; }), // non-string reason
      mutate((r) => { entries(r)[1]!.run = 0; }), // malformed identity, caught by the shared validator
      mutate((r) => { entries(r)[1]!.artifactName = 'bad\nname'; }),
      mutate((r) => { // duplicate exact identity with internally consistent counts
        const copy = { ...entries(r)[1]! };
        entries(r).push(copy); r.total = 4; r.failed = 2;
      }),
      mutate((r) => { r.timedOut = true; }), // flag with no not-started entries
      mutate((r) => { r.timedOut = true; r.aborted = true; }), // both stop flags
      mutate((r) => { // not-started entries with no stop flag
        entries(r)[1]!.outcome = 'not-started'; r.failed = 0; r.notStarted = 1;
      }),
      JSON.stringify({ version: 1, total: 0, bound: 0, failed: 0, notStarted: 0, timedOut: true, aborted: false, entries: [] }),
    ];
    for (const d of docs) {
      const { code, out: o } = await replan(['--stdin', '--json'], { input: streamIn(d) });
      expect(code, JSON.stringify(d).slice(0, 120)).toBe(2);
      expect(o).toBe(''); // invalid input never emits a manifest
    }
    // 17 entries is beyond the report bound even with consistent counts.
    const seventeen = JSON.parse(validJson) as Record<string, unknown>;
    const list = seventeen.entries as Record<string, unknown>[];
    for (let i = 0; i < 14; i++) list.push({ ...list[1]!, run: 5000 + i });
    seventeen.total = 17; seventeen.failed = 15;
    const { code: big } = await replan(['--stdin', '--json'], { input: streamIn(JSON.stringify(seventeen)) });
    expect(big).toBe(2);
  });

  it('rejects oversize input and bad flags before reading the report', async () => {
    const big = Buffer.alloc(64 * 1024 + 1, 0x20);
    expect((await replan(['--stdin', '--json'], { input: streamIn(big, 2) })).code).toBe(2);
    for (const args of [
      [] as string[], // missing --stdin
      ['--json'],
      ['--stdin', '--stdin'],
      ['--json', '--json', '--stdin'],
      ['--stdin', '--timeout-ms', '60000'],
      ['--stdin', 'extra'],
    ]) {
      expect((await replan(args, { input: streamIn(DOC) })).code).toBe(2);
    }
  });
});
