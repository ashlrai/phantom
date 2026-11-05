import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwaitBatch } from '../src/cli/fleet-ci-receipt-await-batch.js';
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

const doc = (targets: unknown[]) => JSON.stringify({ version: 1, targets });
const ndargs = ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--ndjson'];
const events = (lines: string[]) => lines.map(line => JSON.parse(line));
const sink = (lines: string[]) => new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } });

describe('batch progress', () => {
  it('emits bound evidence before the second wait settles, with unchanged digest', async () => {
    const calls: Call[] = []; const lines: string[] = [];
    let release!: () => void; let entered!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    const base = fakeGh([{ t: T1, downloadBody: JSON.stringify(priorDoc(T1)) },
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) }], calls);
    const gh: GitRunner = async (bin, args, opts) => {
      if (args.includes(attemptUrl(T2))) { entered(); await pending; }
      return base(bin, args, opts);
    };
    const run = cmdFleetCiReceiptAwaitBatch(ndargs, { input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh,
      now: () => 0, sleep: async () => {}, output: sink(lines) });
    await started;
    expect(events(lines)).toHaveLength(1);
    expect(events(lines)[0].entry.prior).toEqual(priorDoc(T1));
    release(); expect(await run).toBe(0);
    expect(events(lines).map(e => e.type)).toEqual(['entry', 'entry', 'summary']);
    expect(events(lines)[1].entry.prior).toEqual(priorDoc(T2));
    expect(events(lines)[2]).not.toHaveProperty('entries');
  });

  it('reports failure then success and retains legacy json shape', async () => {
    const runs = [{ t: T1, artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) }];
    const input = doc([TARGETS[0], TARGETS[1]]); const lines: string[] = [];
    expect(await cmdFleetCiReceiptAwaitBatch(ndargs, { input: streamIn(input), gh: fakeGh(runs, []),
      now: () => 0, output: sink(lines) })).toBe(1);
    expect(events(lines).map(e => e.entry?.outcome ?? e.type)).toEqual(['failed', 'bound', 'summary']);
    expect(await cmdFleetCiReceiptAwaitBatch(ARGS, { input: streamIn(input), gh: fakeGh(runs, []), now: () => 0 })).toBe(1);
    const report = JSON.parse(out[0]!);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['failed', 'bound']);
    expect(report.entries[1].prior).toEqual(priorDoc(T2));
  });

  it('emits not-started entries when the shared deadline expires', async () => {
    const clock = fakeClock(); const lines: string[] = []; const calls: Call[] = [];
    const gh = fakeGh([{ t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
      artifactsQueue: [ok(JSON.stringify(emptyPage))] }, { t: T2 }], calls);
    expect(await cmdFleetCiReceiptAwaitBatch(ndargs, { input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh,
      now: clock.now, sleep: clock.sleep, output: sink(lines) })).toBe(1);
    expect(events(lines).map(e => e.entry?.outcome ?? e.type)).toEqual(['failed', 'not-started', 'summary']);
    expect(events(lines)[2].timedOut).toBe(true);
    expect(calls.some(c => c.args.some(a => a.includes('/992')))).toBe(false);
  });

  it('waits for output before querying the next target and stops on close', async () => {
    const calls: Call[] = []; const lines: string[] = []; let done!: (error?: Error | null) => void;
    let written!: () => void; const ready = new Promise<void>(r => { written = r; });
    const output = new Writable({ highWaterMark: 1, write(chunk, _enc, cb) { lines.push(String(chunk)); done = cb; written(); } });
    const gh = fakeGh([{ t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }, { t: T2 }], calls);
    const run = cmdFleetCiReceiptAwaitBatch(ndargs, { input: streamIn(doc([TARGETS[0], TARGETS[1]])), gh, now: () => 0, output });
    await ready;
    expect(calls.some(c => c.args.some(a => a.includes('/992')))).toBe(false);
    output.destroy(); done();
    await expect(run).rejects.toThrow();
    expect(calls.some(c => c.args.some(a => a.includes('/992')))).toBe(false);
  });

  it('rejects conflicting formats before network access', async () => {
    const calls: Call[] = [];
    expect(await cmdFleetCiReceiptAwaitBatch([...ndargs, '--json'], { input: streamIn(DOC), gh: fakeGh([], calls) })).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
