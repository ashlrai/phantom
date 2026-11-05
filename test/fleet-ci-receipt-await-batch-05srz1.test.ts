import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { parseCiResumePrior } from '../src/core/fleet/ci-resume-inputs.js';
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
  /** Per-poll responses for the attempt endpoint; the last entry repeats. */
  attemptQueue?: GitRunResult[];
  /** Per-poll responses for the artifacts listing; the last entry repeats. */
  artifactsQueue?: GitRunResult[];
  onAttemptRead?: () => void;
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
const doc = (targets: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, targets, ...extra });

describe('fleet ci-receipt-await-batch', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-receipt-await-batch')).toEqual(
      { module: './fleet-ci-receipt-await-batch.js', exportName: 'cmdFleetCiReceiptAwaitBatch' });
    const { code, out: o } = await cli(['--help'], { gh: fakeGh([], []) });
    expect(code).toBe(0);
    for (const s of ['--stdin', 'targets', 'not-started', 'timeout-ms', 'one read', 'stderr', 'POSTs']) {
      expect(o).toContain(s);
    }
  });

  it('binds present and running-then-present targets through the real awaitCiReceipt binder', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }, // completed + artifact present: binds immediately
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // completed, artifact missing: terminal
      { t: T3, attemptQueue: [ok(JSON.stringify(attemptMeta(T3, 'in_progress'))), ok(JSON.stringify(attemptMeta(T3, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage)), ok(JSON.stringify(presentPage(T3)))],
        downloadBody: JSON.stringify(priorDoc(T3)) }, // pending, then the archive lands and binds
    ], calls, reads);
    const { code, out: o, err: e } = await cli(ARGS, { input: streamIn(DOC), gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1); // partial: T2 failed
    const report = JSON.parse(o);
    expect(report.version).toBe(1);
    expect(report.total).toBe(3); expect(report.bound).toBe(2); expect(report.failed).toBe(1); expect(report.notStarted).toBe(0);
    expect(report.entries.map((en: { run: number }) => en.run)).toEqual([991, 992, 55]); // stable input order
    expect(report.entries.map((en: { outcome: string }) => en.outcome)).toEqual(['bound', 'failed', 'bound']);
    expect(parseCiResumePrior(report.entries[0].prior)).toEqual(priorDoc(T1)); // real binder evidence out
    expect(parseCiResumePrior(report.entries[2].prior)).toEqual(priorDoc(T3));
    expect(report.entries[1].prior).toBeNull(); // a failure never yields a prior
    expect(report.entries[1].reason).toContain('completed');
    expect(report.entries[1].repo).toBe(T2.repo); expect(report.entries[1].attempt).toBe(T2.attempt);
    expect(o).toContain(DIGEST); // producer digest preserved, never recomputed
    expect(e).toContain('ci-receipt-await-batch:');
    expect(apiCalls(calls).filter((u) => u.includes('/runs/992')))
      .toEqual([attemptUrl(T2), artifactsUrl(T2)]); // one observation, no retry
    expect(calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'download')).toHaveLength(2); // bound archives fetched
    expect(reads.max).toBe(1); // at most one read in flight
    expect(mutations(calls)).toEqual([]); // zero mutation calls
  });

  it('exits 0 when every target binds', async () => {
    const calls: Call[] = [];
    const gh = fakeGh([{ t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }], calls);
    const { code, out: o } = await cli(ARGS,
      { input: streamIn(doc([TARGETS[0]])), gh, now: fakeClock().now, sleep: async () => {} });
    expect(code).toBe(0);
    const report = JSON.parse(o);
    expect(report.bound).toBe(1);
    expect(report.timedOut).toBe(false); expect(report.aborted).toBe(false);
    expect(mutations(calls)).toEqual([]);
  });

  it('records an exact attempt mismatch as failure and still binds the next target', async () => {
    const calls: Call[] = [];
    const gh = fakeGh([
      { t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'completed', 9)))] }, // evidence names another attempt
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) },
    ], calls);
    const { code, out: o } = await cli(ARGS,
      { input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh, now: fakeClock().now, sleep: async () => {} });
    expect(code).toBe(1);
    const report = JSON.parse(o);
    expect(report.entries[0].outcome).toBe('failed');
    expect(report.entries[0].reason).toContain('does not match');
    expect(report.entries[1].outcome).toBe('bound');
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download' && c.args[2] === '991')).toBe(false);
    expect(mutations(calls)).toEqual([]);
  });

  it('never renews the batch deadline: target two is not started once target one consumes it', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // pending forever
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) }, // would bind instantly — never reached
    ], calls, reads);
    const { code, out: o } = await cli(
      ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--json'],
      { input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    const report = JSON.parse(o);
    expect(report.timedOut).toBe(true);
    expect(report.entries[0].outcome).toBe('failed');
    expect(report.entries[0].reason).toContain('timed out');
    expect(report.entries[1].outcome).toBe('not-started');
    expect(report.entries[1].prior).toBeNull(); // never a fabricated prior
    expect(report.entries[1].reason).toContain('deadline');
    expect(apiCalls(calls)).toEqual(Array(4).fill([attemptUrl(T1), artifactsUrl(T1)]).flat()); // 1000/250 polls, all target one
    expect(calls.some((c) => c.args.some((a) => a.includes('992')))).toBe(false); // zero reads for target two
    expect(reads.max).toBe(1);
    expect(mutations(calls)).toEqual([]);
  });

  it('marks every target not-started on a pre-aborted signal without reading', async () => {
    const controller = new AbortController(); controller.abort();
    const calls: Call[] = [];
    const { code, out: o } = await cli(ARGS, {
      input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh: fakeGh([], calls),
      now: fakeClock().now, sleep: async () => {}, signal: controller.signal,
    });
    expect(code).toBe(1);
    const report = JSON.parse(o);
    expect(report.aborted).toBe(true);
    expect(report.entries.map((en: { outcome: string }) => en.outcome)).toEqual(['not-started', 'not-started']);
    expect(calls).toHaveLength(0); // nothing was read
  });

  it('rejects malformed input before any read, including a malformed later target', async () => {
    const docs: (string | Buffer)[] = [
      'not json',
      '[]',
      doc([], { version: 2 }),
      doc([], { extra: true }), // unknown top-level key
      doc([]), // empty target list
      doc(Array(17).fill(TARGETS[0])), // beyond the 16-target bound
      doc([{ repo: 'ashlrai/phantom', run: 991, attempt: 2 }]), // missing artifactName
      doc([{ ...TARGETS[0], extra: 1 }]), // unknown target key
      doc([{ ...TARGETS[0], repo: 'bad repo' }]),
      doc([{ ...TARGETS[0], run: 0 }]),
      doc([{ ...TARGETS[0], attempt: 'x' }]),
      doc([{ ...TARGETS[0], artifactName: '' }]),
      doc([{ ...TARGETS[0], artifactName: '-flag' }]),
      doc([{ ...TARGETS[0], artifactName: 'bad\nname' }]),
      doc([{ ...TARGETS[0], artifactName: 'a'.repeat(201) }]),
      doc([TARGETS[0], { ...TARGETS[0], attempt: 'x' }]), // malformed later target: nothing may run
      doc([TARGETS[0], TARGETS[0]]), // duplicate exact identity
      doc([TARGETS[0], { ...TARGETS[0], repo: 'ASHLRAI/PHANTOM' }]), // repo case is still the same identity
      Buffer.from('{"version":1,"targets":[', 'utf8'), // truncated
      Buffer.concat([Buffer.from('{"version":1,"targets":[{"repo":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}]}')]), // bad UTF-8
    ];
    for (const d of docs) {
      const calls: Call[] = [];
      const { code, out: o } = await cli(ARGS, { input: streamIn(d), gh: fakeGh([{ t: T1 }], calls) });
      expect(code).toBe(2);
      expect(o).toBe(''); // no report on invalid input
      expect(calls).toHaveLength(0); // zero reads
    }
  });

  it('rejects oversize input and bad flags before any read', async () => {
    const calls: Call[] = [];
    const big = Buffer.alloc(64 * 1024 + 1, 0x20);
    expect((await cli(ARGS, { input: streamIn(big, 2), gh: fakeGh([], calls) })).code).toBe(2);
    for (const args of [
      ['--timeout-ms', '60000'], // missing --stdin
      ['--stdin'], // missing --timeout-ms
      ['--stdin', '--timeout-ms', '0'], ['--stdin', '--timeout-ms', 'x'], ['--stdin', '--timeout-ms', '3600001'],
      ['--stdin', '--timeout-ms', '60000', '--poll-ms', '100'], // below the sane floor
      ['--stdin', '--timeout-ms', '60000', '--poll-ms', '0'], ['--stdin', '--timeout-ms', '60000', '--poll-ms', 'x'],
      ['--stdin', '--timeout-ms', '60000', '--poll-ms', '3600001'],
      [...ARGS, '--extra'],
      [...ARGS, '--timeout-ms', '60000'], // duplicate flag
      ['--stdin', '--stdin', '--timeout-ms', '60000'],
      ['--stdin', '--timeout-ms'], // flag without a value
      ['--stdin', '--timeout-ms', '--json'], // value that is a flag
    ]) {
      const c2: Call[] = [];
      expect((await cli(args, { input: streamIn(DOC), gh: fakeGh([], c2) })).code).toBe(2);
      expect(c2).toHaveLength(0);
    }
    expect(calls).toHaveLength(0);
  });
});
