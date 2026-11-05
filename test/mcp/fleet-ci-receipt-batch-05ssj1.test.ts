/**
 * fleet-ci-receipt-batch-05ssj1 — fleet_ci_receipt_await_batch through the
 * real in-memory MCP tools/list and tools/call transport: discoverable,
 * callable, one bound and one independently failed target, a shared
 * deadline that is never refreshed, request cancellation, whole-document
 * rejection before the reader, and at most one artifact wait in flight.
 * Fake gh responses only — no real GitHub access, no mutations.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  parseFleetCiReceiptAwaitBatchArgs, readFleetCiReceiptAwaitBatch,
  type FleetCiReceiptAwaitBatchArgs,
} from '../../src/mcp/fleet-ci-receipt-await-batch.js';
import {
  CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS, CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES,
  CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
} from '../../src/core/fleet/ci-receipt-await-batch.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../../src/core/fleet/ci-receipt-await.js';
import { parseCiResumePrior } from '../../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../../src/core/verse/git-ops.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface T { repo: string; run: number; attempt: number; artifactName: string; art: number }
const T1: T = { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', art: 77 };
const T2: T = { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', art: 88 };
const target = (t: T) => ({ repo: t.repo, run: t.run, attempt: t.attempt, artifactName: t.artifactName });
const TARGETS = [target(T1), target(T2)];

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
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));
const gets = (calls: Call[]) => calls.every((c) => c.bin === 'gh'
  && (c.args[0] === 'api' || (c.args[0] === 'run' && c.args[1] === 'download')));
const apiCalls = (calls: Call[]) =>
  calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1)!);

const baseArgs = (over: Record<string, unknown> = {}) =>
  ({ targets: TARGETS, timeoutMs: 60_000, pollMs: 500, ...over });

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map((c) => c.close())); });
async function connect(ciReceiptAwaitBatch?: FleetReaders['ciReceiptAwaitBatch'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ci-receipt-batch-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers, ciReceiptAwaitBatch })
    .connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

describe('fleet_ci_receipt_await_batch over MCP', () => {
  it('is advertised read-only with the bounded targets document and timings', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('fleet_ci_receipt_await_batch');
    expect(names).toContain('fleet_ci_receipt_await'); // single-target behavior preserved
    const tool = (await client.listTools()).tools.find((t) => t.name === 'fleet_ci_receipt_await_batch');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        targets: {
          type: 'array', minItems: 1, maxItems: CI_RECEIPT_AWAIT_BATCH_MAX_TARGETS,
          description: expect.stringContaining('input order'),
          items: {
            type: 'object',
            properties: {
              repo: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$',
                description: expect.stringContaining('owner/name') },
              run: { type: 'integer', minimum: 1, description: expect.stringContaining('run') },
              attempt: { type: 'integer', minimum: 1, description: expect.stringContaining('attempt') },
              artifactName: { type: 'string', minLength: 1, maxLength: 200,
                description: expect.stringContaining('artifact') },
            },
            required: ['repo', 'run', 'attempt', 'artifactName'],
            additionalProperties: false,
          },
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
          default: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, description: expect.stringContaining('deadline') },
        pollMs: { type: 'integer', minimum: CI_RECEIPT_AWAIT_MIN_POLL_MS, maximum: expect.any(Number),
          default: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, description: expect.any(String) },
      },
      required: ['targets'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/awaitCiReceiptBatch/);
    expect(tool?.description).toMatch(/fleet_ci_resume_inputs/);
    expect(tool?.description).toMatch(/never reruns CI/i);
    expect(tool?.description).toMatch(/read-only/i);
  });

  it('reaches the injected reader with validated targets, timings and a request signal', async () => {
    const reader = vi.fn(async (_input: FleetCiReceiptAwaitBatchArgs, _signal: AbortSignal) => ({ ok: true }));
    const client = await connect(reader);
    const result = await client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: baseArgs() });
    expect(result.isError).not.toBe(true);
    expect(parse(result)).toEqual({ ok: true });
    expect(reader).toHaveBeenCalledOnce();
    const [input, signal] = reader.mock.calls[0]!;
    expect(input).toEqual(baseArgs());
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('applies the shared timeoutMs/pollMs defaults when omitted', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: { targets: TARGETS } });
    expect(reader).toHaveBeenCalledWith(
      { targets: TARGETS, timeoutMs: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, pollMs: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS },
      expect.any(AbortSignal));
  });

  // Lazy factories: the table is built before beforeAll-less fixtures resolve.
  const t0 = (over: Record<string, unknown>) => ({ ...baseArgs(), targets: [{ ...TARGETS[0], ...over }] });
  it.each<[string, () => Record<string, unknown>]>([
    ['injected cwd', () => ({ ...baseArgs(), cwd: '/tmp' })],
    ['injected root', () => ({ ...baseArgs(), root: '/' })],
    ['injected env', () => ({ ...baseArgs(), env: {} })],
    ['injected executable', () => ({ ...baseArgs(), executable: 'gh' })],
    ['injected runner', () => ({ ...baseArgs(), gh: {}, runner: {} })],
    ['injected api route', () => ({ ...baseArgs(), route: '/x', apiUrl: 'http://x' })],
    ['injected signal', () => ({ ...baseArgs(), signal: {} })],
    ['injected document', () => ({ ...baseArgs(), document: { version: 1, targets: TARGETS } })],
    ['injected extra key', () => ({ ...baseArgs(), extra: 1 })],
    ['missing targets', () => ({ timeoutMs: 60_000 })],
    ['targets a string', () => ({ ...baseArgs(), targets: 'x' })],
    ['targets null', () => ({ ...baseArgs(), targets: null })],
    ['targets empty', () => ({ ...baseArgs(), targets: [] })],
    ['targets over bound', () => ({ ...baseArgs(), targets: Array(17).fill(TARGETS[0]) })],
    ['duplicate exact target', () => ({ ...baseArgs(), targets: [TARGETS[0], TARGETS[0]] })],
    ['duplicate repo case-insensitive', () => ({ ...baseArgs(), targets: [TARGETS[0], { ...TARGETS[0], repo: 'ASHLRAI/PHANTOM' }] })],
    ['target missing field', () => ({ ...baseArgs(), targets: [{ repo: 'a/b', run: 1, attempt: 1 }] })],
    ['target extra key', () => t0({ blob: 1 })],
    ['target repo with spaces', () => t0({ repo: 'bad repo' })],
    ['target repo extra segment', () => t0({ repo: 'o/n/x' })],
    ['target repo dotdot', () => t0({ repo: 'owner/..' })],
    ['target run zero', () => t0({ run: 0 })],
    ['target run fractional', () => t0({ run: 1.5 })],
    ['target run a string', () => t0({ run: '991' })],
    ['target attempt zero', () => t0({ attempt: 0 })],
    ['target artifactName empty', () => t0({ artifactName: '' })],
    ['target artifactName flag-shaped', () => t0({ artifactName: '-n' })],
    ['target artifactName control char', () => t0({ artifactName: 'bad\nname' })],
    ['target artifactName overlong', () => t0({ artifactName: 'a'.repeat(201) })],
    ['timeoutMs zero', () => ({ ...baseArgs(), timeoutMs: 0 })],
    ['timeoutMs fractional', () => ({ ...baseArgs(), timeoutMs: 1.5 })],
    ['timeoutMs a string', () => ({ ...baseArgs(), timeoutMs: 'x' })],
    ['timeoutMs null', () => ({ ...baseArgs(), timeoutMs: null })],
    ['timeoutMs over one hour', () => ({ ...baseArgs(), timeoutMs: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS + 1 })],
    ['pollMs zero', () => ({ ...baseArgs(), pollMs: 0 })],
    ['pollMs below floor', () => ({ ...baseArgs(), pollMs: CI_RECEIPT_AWAIT_MIN_POLL_MS - 1 })],
    ['pollMs null', () => ({ ...baseArgs(), pollMs: null })],
    ['pollMs over bound', () => ({ ...baseArgs(), pollMs: 3_600_001 })],
    ['oversize serialized document', () => t0({ blob: 'x'.repeat(CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES) })],
    ['oversize targets string', () => ({ ...baseArgs(), targets: 'x'.repeat(CI_RECEIPT_AWAIT_BATCH_MAX_INPUT_BYTES) })],
  ])('rejects injected, malformed, oversize or duplicate arguments before the reader: %s', async (_label, badArgs) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: badArgs() }))
      .rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects a non-object arguments payload before the reader', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: 'receipts.json' as never }))
      .rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('binds one target and records the other\'s independent failure through the real waiter', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, downloadBody: JSON.stringify(priorDoc(T1)) }, // completed + artifact present: binds immediately
      { t: T2, attemptQueue: [ok(JSON.stringify(attemptMeta(T2, 'completed')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // completed, artifact missing: terminal
    ], calls, reads);
    const client = await connect((input, signal) =>
      readFleetCiReceiptAwaitBatch(input, signal, { gh, now: clock.now, sleep: clock.sleep }));
    const result = await client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: baseArgs() });
    expect(result.isError).not.toBe(true);
    const out = parse(result);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none' });
    expect(out.note).toMatch(/never reruns CI|read-only/i);
    const report = out.report;
    expect(report.version).toBe(1);
    expect(report.total).toBe(2);
    expect(report.bound).toBe(1); expect(report.failed).toBe(1); expect(report.notStarted).toBe(0);
    expect(report.timedOut).toBe(false); expect(report.aborted).toBe(false);
    // Exact identities and input order survive; each entry keeps its own outcome.
    expect(report.entries.map((e: { repo: string; run: number; attempt: number; artifactName: string }) =>
      `${e.repo}#${e.run}#${e.attempt}#${e.artifactName}`))
      .toEqual([`${T1.repo}#${T1.run}#${T1.attempt}#${T1.artifactName}`,
        `${T2.repo}#${T2.run}#${T2.attempt}#${T2.artifactName}`]);
    expect(report.entries.map((e: { outcome: string }) => e.outcome)).toEqual(['bound', 'failed']);
    // Exact validated prior survives public JSON scrubbing; producer digest verbatim.
    expect(parseCiResumePrior(report.entries[0].prior)).toEqual(priorDoc(T1));
    expect(JSON.stringify(report.entries[0].prior)).toContain(DIGEST);
    expect(report.entries[1].prior).toBeNull(); // a failure never yields a prior
    expect(report.entries[1].reason).toContain('completed');
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.diagnostics.length).toBeLessThanOrEqual(CI_RECEIPT_AWAIT_BATCH_MAX_DIAGNOSTICS);
    expect(apiCalls(calls).filter((u) => u.includes(`/runs/${T2.run}`)))
      .toEqual([attemptUrl(T2), artifactsUrl(T2)]); // one observation, no retry, no download
    expect(calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'download')).toHaveLength(1); // T1 only
    expect(reads.max).toBe(1); // at most one artifact wait in flight
    expect(gets(calls)).toBe(true); // GET listing/metadata plus one bounded download
    expect(mutations(calls)).toEqual([]); // zero mutation calls
  });

  it('never renews the shared deadline: target two is not started once target one consumes it', async () => {
    const calls: Call[] = []; const reads = { inFlight: 0, max: 0 };
    const clock = fakeClock();
    const gh = fakeGh([
      { t: T1, attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
        artifactsQueue: [ok(JSON.stringify(emptyPage))] }, // pending forever
      { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) }, // would bind instantly — never reached
    ], calls, reads);
    const client = await connect((input, signal) =>
      readFleetCiReceiptAwaitBatch(input, signal, { gh, now: clock.now, sleep: clock.sleep }));
    const result = await client.callTool({ name: 'fleet_ci_receipt_await_batch',
      arguments: baseArgs({ timeoutMs: 1000, pollMs: 250 }) });
    expect(result.isError).not.toBe(true);
    const report = parse(result).report;
    expect(report.timedOut).toBe(true); expect(report.aborted).toBe(false);
    expect(report.entries[0].outcome).toBe('failed');
    expect(report.entries[0].reason).toContain('timed out');
    expect(report.entries[1].outcome).toBe('not-started');
    expect(report.entries[1].prior).toBeNull(); // never a fabricated prior
    expect(report.entries[1].reason).toContain('deadline');
    expect(apiCalls(calls)).toEqual(Array(4).fill([attemptUrl(T1), artifactsUrl(T1)]).flat()); // all target one
    expect(calls.some((c) => c.args.some((a) => a.includes(String(T2.run))))).toBe(false); // zero reads for T2
    expect(reads.max).toBe(1);
    expect(mutations(calls)).toEqual([]);
  });

  it('reports request cancellation honestly: pre-aborted and mid-batch, never a fabricated prior', async () => {
    const pre = new AbortController(); pre.abort();
    const calls: Call[] = [];
    const out = await readFleetCiReceiptAwaitBatch(
      parseFleetCiReceiptAwaitBatchArgs(baseArgs())!, pre.signal,
      { gh: fakeGh([], calls), now: fakeClock().now, sleep: async () => {} });
    expect(out.report.aborted).toBe(true); expect(out.report.timedOut).toBe(false);
    expect(out.report.entries.map((e) => e.outcome)).toEqual(['not-started', 'not-started']);
    expect(out.report.entries.map((e) => e.reason)).toEqual(['batch aborted', 'batch aborted']);
    expect(calls).toHaveLength(0); // nothing was read

    const mid = new AbortController();
    const calls2: Call[] = [];
    const clock = fakeClock();
    const running = ok(JSON.stringify(attemptMeta(T1, 'in_progress')));
    const out2 = await readFleetCiReceiptAwaitBatch(
      parseFleetCiReceiptAwaitBatchArgs(baseArgs())!, mid.signal, {
        gh: fakeGh([
          { t: T1, attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] },
          { t: T2, downloadBody: JSON.stringify(priorDoc(T2)) },
        ], calls2),
        now: clock.now, sleep: async (ms) => { await clock.sleep(ms); mid.abort(); },
      });
    expect(out2.report.aborted).toBe(true);
    expect(out2.report.entries[0].outcome).toBe('failed');
    expect(out2.report.entries[0].reason).toContain('abort');
    expect(out2.report.entries[1].outcome).toBe('not-started');
    expect(out2.report.entries[1].reason).toBe('batch aborted');
    expect(out2.report.entries[1].prior).toBeNull();
    expect(calls2.some((c) => c.args.some((a) => a.includes(String(T2.run))))).toBe(false);
    expect(mutations(calls2)).toEqual([]);
  });

  it('passes the server request signal to the reader so client cancellation aborts the batch', async () => {
    let resolveSeen: (signal: AbortSignal) => void = () => {};
    const seen = new Promise<AbortSignal>((r) => { resolveSeen = r; });
    const client = await connect((_input, signal) => { resolveSeen(signal); return new Promise(() => {}); });
    const ac = new AbortController();
    const call = client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: baseArgs() },
      undefined, { signal: ac.signal });
    const rejection = expect(call).rejects.toThrow();
    const signal = await seen;
    ac.abort();
    await rejection;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it('sanitizes an unexpected reader exception', async () => {
    const client = await connect(async () => { throw new Error('private-batch-detail'); });
    const result = await client.callTool({ name: 'fleet_ci_receipt_await_batch', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('private-batch-detail');
    expect(JSON.stringify(result)).not.toContain('"receipts"');
  });

  it('leaves mutation-sounding names unregistered', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const name of ['fleet_ci_receipt_await_batch_apply', 'fleet_ci_receipt_batch_download',
      'fleet_ci_receipt_rerun_batch']) {
      await expect(client.callTool({ name })).rejects.toMatchObject({ code: -32602 });
    }
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('parseFleetCiReceiptAwaitBatchArgs', () => {
  it('returns validated targets and timings, and stays pure', () => {
    expect(parseFleetCiReceiptAwaitBatchArgs(baseArgs())).toEqual(baseArgs());
    expect(parseFleetCiReceiptAwaitBatchArgs({ targets: TARGETS })).toEqual({
      targets: TARGETS, timeoutMs: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, pollMs: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS,
    });
    expect(parseFleetCiReceiptAwaitBatchArgs({ ...baseArgs(), nope: 1 })).toBeNull();
    expect(parseFleetCiReceiptAwaitBatchArgs({})).toBeNull();
    expect(parseFleetCiReceiptAwaitBatchArgs({ targets: [TARGETS[0], TARGETS[0]] })).toBeNull();
  });
});
