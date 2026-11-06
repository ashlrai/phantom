import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptAwait } from '../src/cli/fleet-ci-receipt-await.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { parseCiResumePrior } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const SHA = 'a'.repeat(40);
const RUN = 991; const ATTEMPT = 2; const ART = 77; const NAME = 'ci-resume-receipts';
const DIGEST = `sha256:${'b'.repeat(64)}`;

const jobRow = (id: number, name: string, conclusion: string) =>
  ({ id, run_id: RUN, run_attempt: ATTEMPT, name, status: 'completed', conclusion, head_sha: SHA });
const receiptRow = (job: string, jobId: number, conclusion: string) =>
  ({ job, run: RUN, attempt: ATTEMPT, jobId, headSha: SHA, conclusion, inputsDigest: DIGEST });
const artifactRow = (id: number, name: string, expired: boolean, runId: number = RUN) =>
  ({ id, name, expired, size_in_bytes: 1234, workflow_run: { id: runId } });
const attemptMeta = (status: string, attempt: number = ATTEMPT) =>
  ({ id: RUN, run_attempt: attempt, head_sha: SHA, status, conclusion: status === 'completed' ? 'failure' : null,
    repository: { full_name: REPO } });
const runMeta = { id: RUN, run_attempt: 3, head_sha: SHA, status: 'completed', conclusion: 'failure',
  repository: { full_name: REPO } };
const artifactMeta = { id: ART, name: NAME, size_in_bytes: 1234, expired: false, workflow_run: { id: RUN } };
const jobsPage = [{ total_count: 2, jobs: [jobRow(7000, 'job-a', 'success'), jobRow(7001, 'job-b', 'failure')] }];
const emptyPage = [{ total_count: 0, artifacts: [] }];
const presentPage = [{ total_count: 1, artifacts: [artifactRow(ART, NAME, false)] }];
const priorDoc = { version: 1, repo: REPO,
  receipts: [receiptRow('job-a', 7000, 'success'), receiptRow('job-b', 7001, 'failure')] };
const ARGS = ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT), '--artifact-name', NAME,
  '--timeout-ms', '60000', '--poll-ms', '500', '--json'];

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
type Call = { bin: string; args: string[] };
interface FakeGh {
  /** Per-poll responses for the attempt endpoint; the last entry repeats. */
  attemptQueue?: GitRunResult[];
  /** Per-poll responses for the artifacts listing; the last entry repeats. */
  artifactsQueue?: GitRunResult[];
  onAttemptRead?: () => void; // runs inside the attempt read (e.g. advance the fake clock)
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null; // written as receipts.json into --dir; null/undefined writes nothing
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
const fakeGh = (f: FakeGh, calls: Call[]): GitRunner => async (bin, args) => {
  calls.push({ bin, args: [...args] });
  const url = args.find((a) => a.startsWith('repos/'));
  if (bin !== 'gh') return bad();
  if (args[0] === 'api') {
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`) {
      f.onAttemptRead?.();
      return pop(f.attemptQueue) ?? ok(JSON.stringify(attemptMeta('completed')));
    }
    if (url === `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`) {
      return pop(f.artifactsQueue) ?? ok(JSON.stringify(presentPage));
    }
    if (url === `repos/${REPO}/actions/runs/${RUN}`) return f.run ?? ok(JSON.stringify(runMeta));
    if (url === `repos/${REPO}/actions/artifacts/${ART}`) return f.artifact ?? ok(JSON.stringify(artifactMeta));
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`) return f.jobs ?? ok(JSON.stringify(jobsPage));
    return bad();
  }
  if (args[0] === 'run' && args[1] === 'download') {
    if (f.downloadBody !== undefined && f.downloadBody !== null) {
      writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), f.downloadBody);
    }
    return ok('');
  }
  return bad();
};

/** A clock that only moves when the fake sleep is asked to wait. */
const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
};

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
interface Deps { gh: GitRunner; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal }
const cli = async (args: string[], deps: Deps) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptAwait(args, deps), out: out.join('\n'), err: err.join('') };
};
const apiCalls = (calls: Call[]) => calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1));
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));
const ATTEMPT_URL = `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`;
const ARTIFACTS_URL = `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`;

describe('fleet ci-receipt-await', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-receipt-await')).toEqual(
      { module: './fleet-ci-receipt-await.js', exportName: 'cmdFleetCiReceiptAwait' });
    const { code, out: o } = await cli(['--help'], { gh: fakeGh({}, []) });
    expect(code).toBe(0);
    for (const s of ['ci-resume-inputs', 'running/queued', 'absent', 'timeout-ms', 'poll-ms', 'stderr', 'POSTs']) {
      expect(o).toContain(s);
    }
  });

  it('waits through pending polls, then binds the uploaded artifact into a prior document', async () => {
    const calls: Call[] = [];
    const clock = fakeClock();
    const gh = fakeGh({
      attemptQueue: [ok(JSON.stringify(attemptMeta('in_progress'))), ok(JSON.stringify(attemptMeta('in_progress'))),
        ok(JSON.stringify(attemptMeta('completed')))],
      artifactsQueue: [ok(JSON.stringify(emptyPage)), ok(JSON.stringify(emptyPage)), ok(JSON.stringify(presentPage))],
      downloadBody: JSON.stringify(priorDoc),
    }, calls);
    const { code, out: o, err: e } = await cli(ARGS, { gh, now: clock.now, sleep: clock.sleep });
    expect(code).toBe(0);
    expect(parseCiResumePrior(JSON.parse(o))).toEqual(priorDoc); // stdout is the document alone
    expect(o).toContain(DIGEST); // producer digest preserved, never recomputed
    expect(e).toContain('ci-receipt-await:');
    expect(e).toContain('in_progress');
    expect(apiCalls(calls)).toEqual([
      ATTEMPT_URL, ARTIFACTS_URL, // poll 1: pending
      ATTEMPT_URL, ARTIFACTS_URL, // poll 2: pending
      ATTEMPT_URL, ARTIFACTS_URL, // poll 3: artifact observed
      ARTIFACTS_URL, // discovery: name-to-id listing
      `repos/${REPO}/actions/runs/${RUN}`, // binder: run metadata
      `repos/${REPO}/actions/artifacts/${ART}`, // binder: artifact metadata by id
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`, // binder: attempt jobs
      ARTIFACTS_URL, // binder: name-uniqueness listing
    ]);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(true);
    expect(mutations(calls)).toEqual([]); // zero mutation calls
  });

  it('binds immediately when the artifact already exists — no sleeps', async () => {
    const calls: Call[] = [];
    let slept = 0;
    const { code, out: o } = await cli(ARGS, {
      gh: fakeGh({ downloadBody: JSON.stringify(priorDoc) }, calls),
      sleep: async () => { slept += 1; },
    });
    expect(code).toBe(0);
    expect(parseCiResumePrior(JSON.parse(o))).toEqual(priorDoc);
    expect(slept).toBe(0);
    expect(mutations(calls)).toEqual([]);
  });

  it('ends unavailable on a completed attempt with no artifact, without retrying', async () => {
    const calls: Call[] = [];
    const { code, out: o, err: e } = await cli(ARGS, {
      gh: fakeGh({ attemptQueue: [ok(JSON.stringify(attemptMeta('completed')))], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls),
      now: fakeClock().now, sleep: async () => { throw new Error('sleep must not run'); },
    });
    expect(code).toBe(1);
    expect(o).not.toContain('"receipts"');
    expect(e).toContain('completed');
    expect(apiCalls(calls)).toEqual([ATTEMPT_URL, ARTIFACTS_URL]); // one observation, no retry
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
    expect(mutations(calls)).toEqual([]);
  });

  it('fails on a wrong or missing attempt rather than substituting another', async () => {
    for (const attempt of [
      bad(), // attempt endpoint 404
      ok(JSON.stringify(attemptMeta('completed', 1))), // evidence names a different attempt
      ok(JSON.stringify({ ...attemptMeta('completed'), id: 55 })), // evidence names a different run
      ok(JSON.stringify({ ...attemptMeta('completed'), repository: { full_name: 'other/repo' } })),
      ok(JSON.stringify({ ...attemptMeta('completed'), status: 'mysterious' })),
    ]) {
      const calls: Call[] = [];
      const { code, out: o } = await cli(ARGS, {
        gh: fakeGh({ attemptQueue: [attempt] }, calls), now: fakeClock().now, sleep: async () => {},
      });
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('keeps duplicate or expired named artifacts terminal even while the attempt runs', async () => {
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    for (const artifacts of [
      [artifactRow(ART, NAME, false), artifactRow(88, NAME, false)], // two live bearers
      [artifactRow(ART, NAME, false), artifactRow(88, NAME, true)], // live + expired sibling
      [artifactRow(88, NAME, true)], // only an expired bearer
      [{ ...artifactRow(ART, NAME, false), workflow_run: { id: 55 } }], // bearer belongs to another run
    ]) {
      const calls: Call[] = [];
      const page = [{ total_count: artifacts.length, artifacts }];
      const { code, out: o } = await cli(ARGS, {
        gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(page))] }, calls),
        now: fakeClock().now, sleep: async () => {},
      });
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('fails on malformed or unavailable evidence instead of retrying', async () => {
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    for (const f of [
      { attemptQueue: [bad({ code: 0, stdout: 'not json' })] },
      { attemptQueue: [bad({ timedOut: true, code: null })] },
      { attemptQueue: [bad({ missing: true, code: null })] },
      { artifactsQueue: [bad()] }, // listing transport failure
      { artifactsQueue: [bad({ code: 0, stdout: 'not json' })] },
      { artifactsQueue: [ok(JSON.stringify([{ total_count: 3, artifacts: [] }]))] }, // count/rows drift
      { artifactsQueue: [ok(JSON.stringify([{ artifacts: [] }]))] }, // missing total_count
      { artifactsQueue: [{ ...ok(''), truncated: true }] },
    ] satisfies FakeGh[]) {
      const calls: Call[] = [];
      const { code, out: o } = await cli(ARGS, {
        gh: fakeGh({ attemptQueue: [running], ...f }, calls), now: fakeClock().now, sleep: async () => {},
      });
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('times out with empty stdout while an active attempt stays pending', async () => {
    const calls: Call[] = [];
    const clock = fakeClock();
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    const args = ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT), '--artifact-name', NAME,
      '--timeout-ms', '1000', '--poll-ms', '250'];
    const { code, out: o, err: e } = await cli(args, {
      gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls),
      now: clock.now, sleep: clock.sleep,
    });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(e).toContain('timed out');
    expect(apiCalls(calls)).toEqual(Array(4).fill([ATTEMPT_URL, ARTIFACTS_URL]).flat()); // 1000/250 polls
    expect(mutations(calls)).toEqual([]);
  });

  it('reports the read that outlived the deadline instead of starting another', async () => {
    const calls: Call[] = [];
    const clock = fakeClock();
    const { code, out: o, err: e } = await cli(
      ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT), '--artifact-name', NAME,
        '--timeout-ms', '400', '--poll-ms', '250'],
      { gh: fakeGh({ onAttemptRead: () => clock.advance(600) }, calls), now: clock.now, sleep: clock.sleep });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(e).toContain('attempt metadata');
    expect(apiCalls(calls)).toEqual([ATTEMPT_URL]); // no second read was started
  });

  it('aborts with empty stdout before and during the wait', async () => {
    const pre = new AbortController(); pre.abort();
    const calls: Call[] = [];
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    const { code, out: o } = await cli(ARGS, {
      gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls),
      now: fakeClock().now, sleep: async () => {}, signal: pre.signal,
    });
    expect(code).toBe(1);
    expect(o).toBe('');
    expect(calls).toHaveLength(0); // nothing was read

    const mid = new AbortController();
    const calls2: Call[] = [];
    const { code: c2, out: o2 } = await cli(ARGS, {
      gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls2),
      now: fakeClock().now, sleep: async () => { mid.abort(); }, signal: mid.signal,
    });
    expect(c2).toBe(1);
    expect(o2).toBe('');
    expect(apiCalls(calls2)).toEqual([ATTEMPT_URL, ARTIFACTS_URL]); // one observation, then cancelled
  });

  it('validates arguments before touching gh', async () => {
    for (const args of [
      ['--run', '1'],
      ['--repo', 'bad repo', '--run', '1', '--attempt', '1', '--artifact-name', NAME],
      ['--repo', REPO, '--run', '0', '--attempt', '1', '--artifact-name', NAME],
      ['--repo', REPO, '--run', '1', '--attempt', 'x', '--artifact-name', NAME],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', ''],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', '-flag'],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', 'bad\nname'],
      [...ARGS, '--extra'],
      [...ARGS, '--run'], // flag without a value
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', 'a'.repeat(201)],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--timeout-ms', '0'],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--timeout-ms', 'x'],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--timeout-ms', '3600001'], // one-hour bound
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--poll-ms', '0'],
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--poll-ms', '100'], // below the sane floor
      ['--repo', REPO, '--run', '1', '--attempt', '1', '--artifact-name', NAME, '--poll-ms', '3600001'],
    ]) {
      const calls: Call[] = [];
      expect((await cli(args, { gh: fakeGh({}, calls) })).code).toBe(2);
      expect(calls).toHaveLength(0);
    }
  });
});
