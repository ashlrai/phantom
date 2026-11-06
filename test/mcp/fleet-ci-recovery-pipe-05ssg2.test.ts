/**
 * fleet_ci_recovery_pipe_05ssg2 — integration proof that a shell-free recovery
 * agent can call fleet_ci_receipt_await, pass the returned prior directly into
 * fleet_ci_resume_inputs, and get real plan output — all through the MCP server
 * boundary with an in-memory transport.
 *
 * Uses a temporary Git repository with base/fix commits, a manifest covering two
 * disjoint source groups (src/a vs src/b), fake gh archive transport, and real
 * digest computation through planCiResumeInputs.  No network, no auth, no host
 * state.  Only GET/download reads against the gh seam; no workflow dispatch or
 * status mutation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  parseFleetCiReceiptAwaitArgs, readFleetCiReceiptAwait,
  type FleetCiReceiptAwaitArgs,
} from '../../src/mcp/fleet-ci-receipt-await.js';
import { readFleetCiResumeInputs } from '../../src/mcp/fleet-ci-resume-inputs.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../../src/core/fleet/ci-receipt-await.js';
import { planCiResumeInputs, parseCiResumePrior } from '../../src/core/fleet/ci-resume-inputs.js';
import { defaultGitRunner, type GitRunner, type GitRunResult } from '../../src/core/verse/git-ops.js';

const REPO = 'ashlrai/phantom';
const RUN = 991; const ATTEMPT = 2; const ART = 77; const NAME = 'ci-resume-receipts';
const jobAId = 7000; const jobBId = 7001;
const jobAKey = 'job-a'; const jobBKey = 'job-b';

// ── helpers: git + commit ─────────────────────────────────────────────────────
const GIT_ENV = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: 64 << 20 });
const commit = (root: string): string => {
  git(root, 'add', '-A');
  git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'c');
  return git(root, 'rev-parse', 'HEAD').trim();
};
const putFile = (root: string, path: string, content: string) => {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

// ── helpers: receipt data ─────────────────────────────────────────────────────
const createReceiptsJson = (repo: string, run: number, attempt: number,
  headSha: string, jobs: Array<{ job: string; jobId: number; conclusion: string; inputsDigest: string }>): string => {
  const receipts = jobs.map((j) => ({
    job: j.job, run, attempt, jobId: j.jobId, headSha, conclusion: j.conclusion, inputsDigest: j.inputsDigest,
  }));
  return JSON.stringify({ version: 1, repo, receipts });
};

// ── fixtures ─────────────────────────────────────────────────────────────────
let root: string, base: string, head: string;
let baseDigestA: string, baseDigestB: string;
const dirs: string[] = [];
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mcp-recovery-pipe-')); dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  putFile(root, 'src/a/x.ts', 'a\n');
  putFile(root, 'src/b/y.ts', 'b\n');
  putFile(root, 'package-lock.json', '{}\n');
  putFile(root, 'docs/readme.md', 'doc\n');
  base = commit(root);
  const basePlan = await planCiResumeInputs({
    manifest: { version: 1, repo: REPO, shared: ['package-lock.json'], jobs: [
      { id: jobAKey, command: 'npm run test:a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
      { id: jobBKey, command: 'npm run test:b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
    ] },
    prior: parseCiResumePrior({ version: 1, repo: REPO, receipts: [] }),
    base, head: base, cwd: root, git: defaultGitRunner,
  });
  const jobA = basePlan.jobs.find(j => j.job === jobAKey)!;
  const jobB = basePlan.jobs.find(j => j.job === jobBKey)!;
  baseDigestA = jobA.baseDigest;
  baseDigestB = jobB.baseDigest;
  writeFileSync(join(root, 'src/b/y.ts'), 'b changed\n');
  head = commit(root);
}, 30_000);
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// ── helpers: fake gh (read-only) ──────────────────────────────────────────────
type Call = { bin: string; args: string[] };
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });

const SHA = 'a'.repeat(40);
const jobRow = (id: number, name: string, conclusion: string) =>
  ({ id, run_id: RUN, run_attempt: ATTEMPT, name, status: 'completed', conclusion, head_sha: SHA });
const artifactRow = (id: number, name: string, expired: boolean, runId: number = RUN) =>
  ({ id, name, expired, size_in_bytes: 1234, workflow_run: { id: runId } });
const attemptMeta = (status: string, attempt: number = ATTEMPT) =>
  ({ id: RUN, run_attempt: attempt, head_sha: SHA, status, conclusion: status === 'completed' ? 'failure' : null,
    repository: { full_name: REPO } });
const runMetaObj = { id: RUN, run_attempt: ATTEMPT, head_sha: SHA, status: 'completed', conclusion: 'failure',
  repository: { full_name: REPO } };
const artifactMeta = { id: ART, name: NAME, size_in_bytes: 1234, expired: false, workflow_run: { id: RUN } };
const jobsPage = [{ total_count: 2, jobs: [jobRow(jobAId, jobAKey, 'success'), jobRow(jobBId, jobBKey, 'success')] }];
const presentPage = [{ total_count: 1, artifacts: [artifactRow(ART, NAME, false)] }];
const bothPage = [{ total_count: 2, artifacts: [artifactRow(ART, NAME, false), artifactRow(ART + 1, NAME, true)] }];
const baseArgs = (over: Record<string, unknown> = {}) => ({
  repo: REPO, run: RUN, attempt: ATTEMPT, artifactName: NAME,
  timeoutMs: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, pollMs: CI_RECEIPT_AWAIT_MIN_POLL_MS, ...over });
const manifest = () => ({ version: 1, repo: REPO, shared: ['package-lock.json'], jobs: [
  { id: jobAKey, command: 'npm run test:a', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/a'] },
  { id: jobBKey, command: 'npm run test:b', os: 'ubuntu-24.04', arch: 'x64', toolchain: 'node-22', paths: ['src/b'] },
]});

const makeFakeGh = (calls: Call[], state: {
  artifactQueue?: GitRunResult[]; attemptQueue?: GitRunResult[];
  run: GitRunResult; artifact: GitRunResult; jobs: GitRunResult;
  downloadBody?: string;
}) => async (bin: string, args: string[]): Promise<GitRunResult> => {
  calls.push({ bin, args: [...args] });
  if (bin !== 'gh') return bad();
  if (args[0] === 'api') {
    const url = args.find(a => a.startsWith('repos/'));
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`) return pop(state.attemptQueue) ?? ok(JSON.stringify(attemptMeta('completed')));
    if (url === `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`) return pop(state.artifactQueue) ?? ok(JSON.stringify(presentPage));
    if (url === `repos/${REPO}/actions/runs/${RUN}`) return state.run;
    if (url === `repos/${REPO}/actions/artifacts/${ART}`) return state.artifact;
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`) return state.jobs;
    return bad();
  }
  // gh run download — writes receipts.json to the target directory
  if (args[0] === 'run' && args[1] === 'download') {
    const dirIdx = args.indexOf('--dir');
    const dir = dirIdx >= 0 ? args[dirIdx + 1] : undefined;
    if (state.downloadBody && dir) {
      writeFileSync(join(dir, 'receipts.json'), state.downloadBody);
    }
    return ok('');
  }
  return bad();
};

// ── helpers: MCP ───────────────────────────────────────────────────────────────
const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map(c => c.close())); });
async function connectMcp(
  ciReceiptAwait?: FleetReaders['ciReceiptAwait'],
  ciResumeInputs?: FleetReaders['ciResumeInputs'],
  readers: FleetReaders = {}): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'recovery-pipe-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ciReceiptAwait, ciResumeInputs, ...readers }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

// ── helper: build state for a given receipts set ──────────────────────────────
const mkState = (receipts: Array<{ job: string; jobId: number; conclusion: string; inputsDigest: string }>,
  extra: Partial<{ jobs: GitRunResult }> = {}): {
  run: GitRunResult; artifact: GitRunResult; jobs: GitRunResult;
  downloadBody: string;
  artifactQueue?: GitRunResult[]; attemptQueue?: GitRunResult[];
} => {
  const json = createReceiptsJson(REPO, RUN, ATTEMPT, SHA, receipts);
  return {
    run: ok(JSON.stringify(runMetaObj)),
    artifact: ok(JSON.stringify(artifactMeta)),
    jobs: extra.jobs ?? ok(JSON.stringify(jobsPage)),
    downloadBody: json,
    artifactQueue: [ok(JSON.stringify(presentPage))],
    attemptQueue: [ok(JSON.stringify(attemptMeta('completed')))],
  };
};

// ── tests ─────────────────────────────────────────────────────────────────────
describe('fleet_ci_recovery_pipe — receipt_await → resume_inputs cross-tool', () => {

  it('passes the complete prior from receipt_await into resume_inputs, unchanged', async () => {
    const calls: Call[] = [];
    const receipts = [
      { job: jobAKey, jobId: jobAId, conclusion: 'success', inputsDigest: baseDigestA },
      { job: jobBKey, jobId: jobBId, conclusion: 'success', inputsDigest: baseDigestB },
    ];
    const state = mkState(receipts);
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );

    const rawResult = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(rawResult.content).toBeDefined();
    const priorDoc = parse(rawResult);
    expect(priorDoc.prior.receipts).toHaveLength(2);
    expect(priorDoc.prior.receipts[0].inputsDigest).toBe(baseDigestA);
    expect(priorDoc.prior.receipts[1].inputsDigest).toBe(baseDigestB);

    const resumeResult = await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(), prior: priorDoc.prior, base, head,
    }});
    expect(resumeResult.content).toBeDefined();
    const planDoc = parse(resumeResult);
    const pj = Object.fromEntries(planDoc.plan.jobs.map(j => [j.job, j]));

    // job-a: unchanged source group → reusable
    expect(pj[jobAKey].decision).toBe('reuse');
    expect(pj[jobAKey].baseDigest).toBe(baseDigestA);
    expect(pj[jobAKey].headDigest).toBe(baseDigestA);
    expect(pj[jobAKey].changedCoveredPaths).toEqual([]);

    // job-b: changed source group → rerun
    expect(pj[jobBKey].decision).toBe('rerun');
    expect(pj[jobBKey].changedCoveredPaths).toContain('src/b/y.ts');

    // Only GET/download reads
    expect(calls.filter(c => c.args[0] === 'workflow_dispatch')).toEqual([]);
  });

  it('rejects a prior bound to the wrong attempt via receipt_await', async () => {
    const calls: Call[] = [];
    const receipts = [{ job: jobAKey, jobId: jobAId, conclusion: 'success', inputsDigest: baseDigestA }];
    const state = mkState(receipts);
    state.attemptQueue = [ok(JSON.stringify(attemptMeta('completed', 99)))];
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain(SHA);
  });

  it('rejects mismatched artifact metadata (expired sibling)', async () => {
    const calls: Call[] = [];
    const state = {
      run: ok(JSON.stringify(runMetaObj)), artifact: ok(JSON.stringify(artifactMeta)),
      jobs: ok(JSON.stringify(jobsPage)),
      artifactQueue: [ok(JSON.stringify(bothPage))],
      attemptQueue: [ok(JSON.stringify(attemptMeta('completed')))],
    };
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
  });

  it('tracked only GET/download gh calls: no dispatch, status, or check mutation', async () => {
    const calls: Call[] = [];
    const receipts = [
      { job: jobAKey, jobId: jobAId, conclusion: 'success', inputsDigest: baseDigestA },
      { job: jobBKey, jobId: jobBId, conclusion: 'success', inputsDigest: baseDigestB },
    ];
    const state = mkState(receipts);
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );

    const priorResult = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(priorResult.content).toBeDefined();
    const resumeResult = await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(), prior: parse(priorResult).prior, base, head,
    }});
    expect(resumeResult.content).toBeDefined();

    const allGh = calls.filter(c => c.bin === 'gh');
    for (const c of allGh) expect(['api', 'run'].includes(c.args[0])).toBe(true);
    const allArgs = allGh.flatMap(c => c.args).join(' ');
    expect(allArgs).not.toMatch(/dispatch|create|post|check/i);
  });

  it('failed job reruns even when digest is unchanged', async () => {
    const calls: Call[] = [];
    const receipts = [{ job: jobAKey, jobId: jobAId, conclusion: 'failure', inputsDigest: baseDigestA }];
    const state = mkState(receipts, {
      jobs: ok(JSON.stringify([{ total_count: 1, jobs: [jobRow(jobAId, jobAKey, 'failure')] }])),
    });
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );

    const priorResult = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(priorResult.content).toBeDefined();
    const resumeResult = await client.callTool({ name: 'fleet_ci_resume_inputs', arguments: {
      manifest: manifest(), prior: parse(priorResult).prior, base, head,
    }});
    expect(resumeResult.content).toBeDefined();
    const pj = parse(resumeResult).plan.jobs.find(j => j.job === jobAKey)!;
    expect(pj.decision).toBe('rerun');
  });

  it('producer digest survives the MCP JSON boundary exactly', async () => {
    const calls: Call[] = [];
    const receipts = [{ job: jobAKey, jobId: jobAId, conclusion: 'success', inputsDigest: baseDigestA }];
    const state = mkState(receipts, {
      jobs: ok(JSON.stringify([{ total_count: 1, jobs: [jobRow(jobAId, jobAKey, 'success')] }])),
    });
    const client = await connectMcp(
      async (input, signal) => readFleetCiReceiptAwait(input, signal, { gh: makeFakeGh(calls, state),
        now: () => 0, sleep: async () => {} }),
      async (input) => readFleetCiResumeInputs(input, { cwd: root, git: defaultGitRunner })
    );
    const priorResult = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(priorResult.content).toBeDefined();
    const fromMcp = parse(priorResult).prior.receipts[0].inputsDigest;
    expect(fromMcp).toBe(baseDigestA);
    expect(fromMcp.startsWith('sha256:')).toBe(true);
  });

  it('sanitizes unexpected reader exceptions, never leaking internals', async () => {
    const client = await connectMcp(
      async () => { throw new Error('private-waiter-secrets'); },
      async () => ({} as any)
    );
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('private-waiter-secrets');
  });
});

