import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { cmdFleetCiResumeReceipts } from '../src/cli/fleet-ci-resume-receipts.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { parseCiResumePrior } from '../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const SHA = 'a'.repeat(40);
const RUN = 991; const ATTEMPT = 2; const ART = 77;
const DIGEST = `sha256:${'b'.repeat(64)}`;

const jobRow = (id: number, name: string, conclusion: string) =>
  ({ id, run_id: RUN, run_attempt: ATTEMPT, name, status: 'completed', conclusion, head_sha: SHA });
const receiptRow = (job: string, jobId: number, conclusion: string) =>
  ({ job, run: RUN, attempt: ATTEMPT, jobId, headSha: SHA, conclusion, inputsDigest: DIGEST });
const runMeta = { id: RUN, run_attempt: 3, head_sha: SHA, status: 'completed', conclusion: 'failure',
  repository: { full_name: REPO } };
const artifactMeta = { id: ART, name: 'ci-resume-receipts', size_in_bytes: 1234, expired: false,
  workflow_run: { id: RUN } };
const jobsPage = [{ total_count: 2, jobs: [jobRow(7000, 'job-a', 'success'), jobRow(7001, 'job-b', 'failure')] }];
const artifactsPage = [{ total_count: 1, artifacts: [{ id: ART, name: 'ci-resume-receipts', expired: false }] }];
const priorDoc = { version: 1, repo: REPO,
  receipts: [receiptRow('job-a', 7000, 'success'), receiptRow('job-b', 7001, 'failure')] };
const ARGS = ['--repo', REPO, '--run', String(RUN), '--attempt', String(ATTEMPT), '--artifact-id', String(ART), '--json'];

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

/** Minimal well-formed ZIP writer for fixtures: stored or deflated members. */
const makeZip = (entries: { name: string; data: Buffer; store?: boolean }[]): Buffer => {
  const parts: Buffer[] = []; const cds: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const method = e.store ? 0 : 8;
    const body = e.store ? e.data : deflateRawSync(e.data);
    const crc = crc32(e.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, name);
    off += 30 + name.length + body.length;
  }
  const cdBuf = Buffer.concat(cds); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
};

const dirs: string[] = [];
let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const archive = (buf: Buffer): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-resume-arc-')); dirs.push(dir);
  const p = join(dir, 'a.zip'); writeFileSync(p, buf); return p;
};
const cli = async (args: string[], gh: GitRunner) => {
  out = []; err = [];
  return { code: await cmdFleetCiResumeReceipts(args, { gh }), out: out.join('\n'), err: err.join('') };
};

describe('fleet ci-resume-receipts', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('ci-resume-receipts')).toEqual(
      { module: './fleet-ci-resume-receipts.js', exportName: 'cmdFleetCiResumeReceipts' });
    const { code, out: o } = await cli(['--help'], fakeGh({}, []));
    expect(code).toBe(0);
    for (const s of ['receipts.json', '--prior', 'ci-resume-inputs', 'cannot authorize', '--archive', 'gh run download']) {
      expect(o).toContain(s);
    }
  });

  it('fetches the selected artifact and prints a parseCiResumePrior-ready document', async () => {
    const calls: Call[] = [];
    const { code, out: o, err: e } = await cli(ARGS, fakeGh({ downloadBody: JSON.stringify(priorDoc) }, calls));
    expect(code).toBe(0);
    const doc = JSON.parse(o);
    expect(parseCiResumePrior(doc)).toEqual(priorDoc); // stdout is the document alone
    expect(o).toContain(DIGEST); // producer digest preserved, never recomputed
    expect(e).toContain('run 991 attempt 2');
    const apis = calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1));
    expect(apis).toEqual([
      `repos/${REPO}/actions/runs/${RUN}`,
      `repos/${REPO}/actions/artifacts/${ART}`,
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
    ]);
    const dl = calls.find((c) => c.args[0] === 'run' && c.args[1] === 'download');
    expect(dl?.args).toEqual(expect.arrayContaining(['download', String(RUN), '--repo', REPO, '--name', 'ci-resume-receipts']));
  });

  it('reads receipts.json from an explicit --archive zip in memory', async () => {
    const calls: Call[] = [];
    const zip = archive(makeZip([
      { name: 'receipts.json', data: Buffer.from(JSON.stringify(priorDoc)) },
      { name: 'notes.txt', data: Buffer.from('ignore me'), store: true },
    ]));
    const { code, out: o } = await cli([...ARGS.slice(0, -1), '--archive', zip, '--json'], fakeGh({}, calls));
    expect(code).toBe(0);
    expect(parseCiResumePrior(JSON.parse(o))).toEqual(priorDoc);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
    expect(calls.filter((c) => c.args[0] === 'api')).toHaveLength(3); // no run-artifacts listing needed
  });

  it('rejects receipts bound to a different attempt, sha, run, job or conclusion', async () => {
    for (const edit of [
      { attempt: 1 }, { headSha: 'c'.repeat(40) }, { run: 1 }, { jobId: 4242 }, { conclusion: 'cancelled' }, { attempt: null },
    ]) {
      const doc = { ...priorDoc, receipts: [{ ...priorDoc.receipts[0]!, ...edit }] };
      const { code, err: e } = await cli(ARGS, fakeGh({ downloadBody: JSON.stringify(doc) }, []));
      expect(code).toBe(1); expect(e).toContain('ci-resume-receipts:');
    }
    const dup = { ...priorDoc, receipts: [priorDoc.receipts[0], priorDoc.receipts[0]] };
    expect((await cli(ARGS, fakeGh({ downloadBody: JSON.stringify(dup) }, []))).code).toBe(1);
  });

  it('stays unavailable on expired, missing or ambiguous artifacts', async () => {
    expect((await cli(ARGS, fakeGh({ artifact: ok(JSON.stringify({ ...artifactMeta, expired: true })), downloadBody: '' }, []))).code).toBe(1);
    expect((await cli(ARGS, fakeGh({ artifact: bad() }, []))).code).toBe(1);
    const wrongRun = { ...artifactMeta, workflow_run: { id: 1 } };
    expect((await cli(ARGS, fakeGh({ artifact: ok(JSON.stringify(wrongRun)) }, []))).code).toBe(1);
    const ambiguous = [{ total_count: 2, artifacts: [{ id: ART, name: 'ci-resume-receipts' }, { id: 88, name: 'ci-resume-receipts' }] }];
    const calls: Call[] = [];
    const { code } = await cli(ARGS, fakeGh({ artifacts: ok(JSON.stringify(ambiguous)), downloadBody: JSON.stringify(priorDoc) }, calls));
    expect(code).toBe(1);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false); // refused before fetch
  });

  it('rejects unsafe archives: traversal, duplicates, oversize, malformed bytes', async () => {
    const payload = Buffer.from(JSON.stringify(priorDoc));
    const cases: Buffer[] = [
      makeZip([{ name: '../evil', data: Buffer.from('x'), store: true }, { name: 'receipts.json', data: payload }]),
      makeZip([{ name: 'receipts.json', data: payload }, { name: 'receipts.json', data: payload }]),
      makeZip([{ name: 'other.txt', data: payload }]),
      Buffer.from('definitely not a zip file'),
      makeZip([{ name: 'receipts.json', data: Buffer.alloc(1024 * 1024 + 1) }]),
      makeZip([{ name: 'receipts.json', data: payload }]).subarray(0, 60), // truncated
    ];
    for (const buf of cases) {
      const { code, err: e } = await cli([...ARGS.slice(0, -1), '--archive', archive(buf)], fakeGh({}, []));
      expect(code).toBe(1); expect(e).toContain('ci-resume-receipts:');
    }
    const tampered = makeZip([{ name: 'receipts.json', data: payload, store: true }]);
    tampered[50] = tampered[50]! ^ 0xff; // corrupt a stored member byte: CRC must catch it
    expect((await cli([...ARGS.slice(0, -1), '--archive', archive(tampered)], fakeGh({}, []))).code).toBe(1);
  });

  it('never succeeds with empty receipts or a mismatched repo or malformed document', async () => {
    for (const doc of [
      { ...priorDoc, receipts: [] }, { ...priorDoc, repo: 'other/repo' }, 'not json', { version: 2 },
    ]) {
      const { code } = await cli(ARGS, fakeGh({ downloadBody: typeof doc === 'string' ? doc : JSON.stringify(doc) }, []));
      expect(code).toBe(1);
    }
    const missing = await cli(ARGS, fakeGh({ downloadBody: null }, [])); // artifact without receipts.json
    expect(missing.code).toBe(1);
  });

  it('rejects ambiguous pagination, truncation, unfinished runs and missing gh', async () => {
    const short = [{ total_count: 2, jobs: [jobsPage[0]!.jobs[0]] }];
    const drifting = [{ total_count: 2, jobs: [] }, { total_count: 3, jobs: [] }];
    for (const jobs of [short, drifting]) {
      expect((await cli(ARGS, fakeGh({ jobs: ok(JSON.stringify(jobs)) }, []))).code).toBe(1);
    }
    expect((await cli(ARGS, fakeGh({ jobs: { ...ok(''), truncated: true } }, []))).code).toBe(1);
    expect((await cli(ARGS, fakeGh({ run: ok(JSON.stringify({ ...runMeta, status: 'in_progress' })) }, []))).code).toBe(1);
    expect((await cli(['--repo', REPO, '--run', String(RUN), '--attempt', '9', '--artifact-id', String(ART)],
      fakeGh({}, []))).code).toBe(1); // attempt beyond run_attempt
    expect((await cli(ARGS, fakeGh({ run: bad({ missing: true }) }, []))).code).toBe(1);
  });

  it('validates arguments before touching gh', async () => {
    for (const args of [
      ['--run', '1'], ['--repo', 'bad repo', '--run', '1', '--attempt', '1', '--artifact-id', '1'],
      [...ARGS, '--extra'], ['--repo', REPO, '--run', '0', '--attempt', '1', '--artifact-id', '1'],
    ]) {
      const calls: Call[] = [];
      expect((await cli(args, fakeGh({}, calls))).code).toBe(2);
      expect(calls).toHaveLength(0);
    }
  });
});
