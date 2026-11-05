import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptDiscover } from '../src/cli/fleet-ci-receipt-discover.js';
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
const runMeta = { id: RUN, run_attempt: 3, head_sha: SHA, status: 'completed', conclusion: 'failure',
  repository: { full_name: REPO } };
const artifactMeta = { id: ART, name: NAME, size_in_bytes: 1234, expired: false,
  workflow_run: { id: RUN } };
const jobsPage = [{ total_count: 2, jobs: [jobRow(7000, 'job-a', 'success'), jobRow(7001, 'job-b', 'failure')] }];
const artifactsPage = [{ total_count: 1, artifacts: [artifactRow(ART, NAME, false)] }];
const priorDoc = { version: 1, repo: REPO,
  receipts: [receiptRow('job-a', 7000, 'success'), receiptRow('job-b', 7001, 'failure')] };
const ARGS = ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT), '--artifact-name', NAME, '--json'];

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
type Call = { bin: string; args: string[] };
interface FakeGh {
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult; artifacts?: GitRunResult;
  downloadBody?: string | null; // written as receipts.json into --dir; null/undefined writes nothing
}
const fakeGh = (f: FakeGh, calls: Call[]): GitRunner => async (bin, args) => {
  calls.push({ bin, args: [...args] });
  const url = args.find((a) => a.startsWith('repos/'));
  if (bin !== 'gh') return bad();
  if (args[0] === 'api') {
    if (url === `repos/${REPO}/actions/runs/${RUN}`) return f.run ?? ok(JSON.stringify(runMeta));
    if (url === `repos/${REPO}/actions/artifacts/${ART}`) return f.artifact ?? ok(JSON.stringify(artifactMeta));
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`) return f.jobs ?? ok(JSON.stringify(jobsPage));
    if (url === `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`) return f.artifacts ?? ok(JSON.stringify(artifactsPage));
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

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });
const cli = async (args: string[], gh: GitRunner) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptDiscover(args, { gh }), out: out.join('\n'), err: err.join('') };
};
const apiCalls = (calls: Call[]) => calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1));
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));

describe('fleet ci-receipt-discover', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-receipt-discover')).toEqual(
      { module: './fleet-ci-receipt-discover.js', exportName: 'cmdFleetCiReceiptDiscover' });
    const { code, out: o } = await cli(['--help'], fakeGh({}, []));
    expect(code).toBe(0);
    for (const s of ['ci-resume-inputs', 'exactly one', 'expired', 'ambiguous', 'attempt', 'stderr', 'POSTs']) {
      expect(o).toContain(s);
    }
  });

  it('discovers the named artifact, binds receipts and prints a prior-ready document', async () => {
    const calls: Call[] = [];
    const { code, out: o, err: e } = await cli(ARGS, fakeGh({ downloadBody: JSON.stringify(priorDoc) }, calls));
    expect(code).toBe(0);
    expect(parseCiResumePrior(JSON.parse(o))).toEqual(priorDoc); // stdout is the document alone
    expect(o).toContain(DIGEST); // producer digest preserved, never recomputed
    expect(e).toContain('ci-receipt-discover:');
    expect(e).toContain(`resolves to artifact ${ART}`);
    expect(apiCalls(calls)).toEqual([
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`, // discovery listing
      `repos/${REPO}/actions/runs/${RUN}`, // binder: run metadata
      `repos/${REPO}/actions/artifacts/${ART}`, // binder: artifact metadata by id
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`, // binder: attempt jobs
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`, // binder: name-uniqueness listing
    ]);
    const dl = calls.find((c) => c.args[0] === 'run' && c.args[1] === 'download');
    expect(dl?.args).toEqual(expect.arrayContaining(['download', String(RUN), '--repo', REPO, '--name', NAME]));
    expect(mutations(calls)).toEqual([]); // zero mutation calls
  });

  it('resolves an artifact that lands on a later page of a bounded listing', async () => {
    const other = Array.from({ length: 100 }, (_, i) => artifactRow(1000 + i, `logs-${i}`, false));
    const pages = [
      { total_count: 101, artifacts: other },
      { total_count: 101, artifacts: [artifactRow(ART, NAME, false)] },
    ];
    const calls: Call[] = [];
    const { code, out: o } = await cli(ARGS, fakeGh({ artifacts: ok(JSON.stringify(pages)), downloadBody: JSON.stringify(priorDoc) }, calls));
    expect(code).toBe(0);
    expect(parseCiResumePrior(JSON.parse(o))).toEqual(priorDoc);
    expect(mutations(calls)).toEqual([]);
  });

  it('fails closed when no artifact in the run bears the exact name', async () => {
    const calls: Call[] = [];
    for (const page of [
      [{ total_count: 0, artifacts: [] }],
      [{ total_count: 2, artifacts: [artifactRow(1, `${NAME}-old`, false), artifactRow(2, 'other', false)] }],
      [{ total_count: 1, artifacts: [artifactRow(ART, NAME, true)] }], // only an expired bearer
    ]) {
      const { code, out: o } = await cli(ARGS, fakeGh({ artifacts: ok(JSON.stringify(page)) }, calls));
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
    }
    // Discovery refused before any binder call: no run-meta, no download.
    expect(apiCalls(calls)).toEqual([
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
    ]);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
    expect(mutations(calls)).toEqual([]);
  });

  it('refuses duplicate names, including an expired sibling — never picks newest', async () => {
    for (const artifacts of [
      [artifactRow(ART, NAME, false), artifactRow(88, NAME, false)], // two live bearers
      [artifactRow(ART, NAME, false), artifactRow(88, NAME, true)], // live + expired sibling
      [artifactRow(88, NAME, true), artifactRow(ART, NAME, false)], // order does not rescue it
    ]) {
      const calls: Call[] = [];
      const page = [{ total_count: artifacts.length, artifacts }];
      const { code, out: o } = await cli(ARGS, fakeGh({ artifacts: ok(JSON.stringify(page)) }, calls));
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('rejects truncated, partial or internally inconsistent pages', async () => {
    const short = [{ total_count: 2, artifacts: [artifactRow(ART, NAME, false)] }];
    const drifting = [{ total_count: 1, artifacts: [artifactRow(ART, NAME, false)] },
      { total_count: 2, artifacts: [] }];
    const noCount = [{ artifacts: [artifactRow(ART, NAME, false)] }];
    const malformed = [{ total_count: 1, artifacts: [{ id: 'x', name: NAME, expired: false }] }];
    for (const page of [short, drifting, noCount, malformed, 'not json']) {
      const calls: Call[] = [];
      const { code } = await cli(ARGS,
        fakeGh({ artifacts: typeof page === 'string' ? bad({ code: 0, stdout: page }) : ok(JSON.stringify(page)) }, calls));
      expect(code).toBe(1);
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
    }
    const calls: Call[] = [];
    expect((await cli(ARGS, fakeGh({ artifacts: { ...ok(''), truncated: true } }, calls))).code).toBe(1);
    expect(apiCalls(calls)).toHaveLength(1);
  });

  it('still fails when the listing says a name but the binder evidence disagrees', async () => {
    // Artifact metadata names a different run: binder rejects.
    const wrongRun = { ...artifactMeta, workflow_run: { id: 1 } };
    expect((await cli(ARGS, fakeGh({ artifact: ok(JSON.stringify(wrongRun)), downloadBody: JSON.stringify(priorDoc) }, []))).code).toBe(1);
    // Receipts bound to a different attempt or run or sha or job: binder rejects.
    for (const edit of [{ attempt: 1 }, { run: 1 }, { headSha: 'c'.repeat(40) }, { jobId: 4242 }, { conclusion: 'cancelled' }]) {
      const doc = { ...priorDoc, receipts: [{ ...priorDoc.receipts[0]!, ...edit }] };
      expect((await cli(ARGS, fakeGh({ downloadBody: JSON.stringify(doc) }, []))).code).toBe(1);
    }
    // Attempt beyond the run's real attempt count.
    expect((await cli(['--repo', REPO, '--run', String(RUN), '--attempt', '9', '--artifact-name', NAME],
      fakeGh({}, []))).code).toBe(1);
    // A bearer that the listing itself places in another run.
    const foreign = [{ total_count: 1, artifacts: [artifactRow(ART, NAME, false, 55)] }];
    expect((await cli(ARGS, fakeGh({ artifacts: ok(JSON.stringify(foreign)) }, []))).code).toBe(1);
  });

  it('surfaces download and transport failures without a document', async () => {
    for (const f of [
      { downloadBody: null }, // archive with no receipts.json member
      { jobs: bad() },
      { run: bad({ missing: true }) },
      { artifact: bad() },
    ] satisfies FakeGh[]) {
      const { code, out: o } = await cli(ARGS, fakeGh(f, []));
      expect(code).toBe(1);
      expect(o).not.toContain('"receipts"');
    }
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
      [...ARGS.slice(0, -1), '--artifact-name', 'a'.repeat(201)],
    ]) {
      const calls: Call[] = [];
      expect((await cli(args, fakeGh({}, calls))).code).toBe(2);
      expect(calls).toHaveLength(0);
    }
  });
});
