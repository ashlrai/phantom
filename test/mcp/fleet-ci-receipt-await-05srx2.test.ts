import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  MAX_FLEET_CI_RECEIPT_DIAGNOSTICS, parseFleetCiReceiptAwaitArgs, readFleetCiReceiptAwait,
  type FleetCiReceiptAwaitArgs,
} from '../../src/mcp/fleet-ci-receipt-await.js';
import {
  CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS,
  CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS, CI_RECEIPT_AWAIT_MIN_POLL_MS,
} from '../../src/core/fleet/ci-receipt-await.js';
import { parseCiResumePrior } from '../../src/core/fleet/ci-resume-inputs.js';
import type { GitRunner, GitRunResult } from '../../src/core/verse/git-ops.js';

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

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
type Call = { bin: string; args: string[] };
interface FakeGh {
  attemptQueue?: GitRunResult[];
  artifactsQueue?: GitRunResult[];
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null;
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;
const fakeGh = (f: FakeGh, calls: Call[]): GitRunner => async (bin, args) => {
  calls.push({ bin, args: [...args] });
  const url = args.find((a) => a.startsWith('repos/'));
  if (bin !== 'gh') return bad();
  if (args[0] === 'api') {
    if (url === `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`) {
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

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
};
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'edit', 'merge', 'comment', 'review', 'workflow'];
const mutations = (calls: Call[]) => calls.filter((c) => c.args.some((a) => MUTATING.includes(a) || a === '--method'));
const gets = (calls: Call[]) => calls.every((c) => c.bin === 'gh'
  && (c.args[0] === 'api' || (c.args[0] === 'run' && c.args[1] === 'download')));

const baseArgs = (over: Record<string, unknown> = {}) =>
  ({ repo: REPO, run: RUN, attempt: ATTEMPT, artifactName: NAME, timeoutMs: 60_000, pollMs: 500, ...over });

const connections: Client[] = [];
afterEach(async () => { await Promise.all(connections.splice(0).map((c) => c.close())); });
async function connect(ciReceiptAwait?: FleetReaders['ciReceiptAwait'], readers: FleetReaders = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ci-receipt-await-test', version: '1.0.0' });
  connections.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), ...readers, ciReceiptAwait }).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);
const textOf = (result: { content?: unknown }) => (result.content as Array<{ text: string }>)[0].text;

describe('fleet_ci_receipt_await over MCP', () => {
  it('is advertised read-only with the exact-attempt identity and bounded timings', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'fleet_ci_receipt_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$', description: expect.stringContaining('owner/name') },
        run: { type: 'integer', minimum: 1, description: expect.stringContaining('run') },
        attempt: { type: 'integer', minimum: 1, description: expect.stringContaining('attempt') },
        artifactName: { type: 'string', minLength: 1, maxLength: 200, description: expect.stringContaining('artifact') },
        timeoutMs: { type: 'integer', minimum: 1, maximum: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS,
          default: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, description: expect.stringContaining('wait') },
        pollMs: { type: 'integer', minimum: CI_RECEIPT_AWAIT_MIN_POLL_MS, maximum: expect.any(Number),
          default: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS, description: expect.any(String) },
      },
      required: ['repo', 'run', 'attempt', 'artifactName'],
      additionalProperties: false,
    });
    expect(tool?.description).toMatch(/awaitCiReceipt/);
    expect(tool?.description).toMatch(/fleet_ci_resume_inputs/);
    expect(tool?.description).toMatch(/never reruns CI/i);
    expect(tool?.description).toMatch(/read-only/i);
  });

  it('reaches the injected reader with parsed identity, bounded timings and a request signal', async () => {
    const reader = vi.fn(async (_input: FleetCiReceiptAwaitArgs, _signal: AbortSignal) => ({ ok: true }));
    const client = await connect(reader);
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
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
    const args = { repo: REPO, run: RUN, attempt: ATTEMPT, artifactName: NAME };
    await client.callTool({ name: 'fleet_ci_receipt_await', arguments: args });
    expect(reader).toHaveBeenCalledWith(
      { ...args, timeoutMs: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, pollMs: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS },
      expect.any(AbortSignal));
  });

  // Lazy factories: the table is built before beforeAll-less fixtures resolve.
  it.each<[string, () => Record<string, unknown>]>([
    ['injected cwd', () => ({ ...baseArgs(), cwd: '/tmp' })],
    ['injected root', () => ({ ...baseArgs(), root: '/' })],
    ['injected path', () => ({ ...baseArgs(), path: 'x' })],
    ['injected dir', () => ({ ...baseArgs(), dir: '.' })],
    ['injected env', () => ({ ...baseArgs(), env: {} })],
    ['injected executable', () => ({ ...baseArgs(), executable: 'gh' })],
    ['injected runner', () => ({ ...baseArgs(), gh: {}, runner: {} })],
    ['injected api route', () => ({ ...baseArgs(), route: '/x', apiUrl: 'http://x' })],
    ['injected archive', () => ({ ...baseArgs(), archive: '/tmp/a.zip' })],
    ['injected signal', () => ({ ...baseArgs(), signal: {} })],
    ['injected limit', () => ({ ...baseArgs(), limit: 1 })],
    ['injected extra key', () => ({ ...baseArgs(), extra: 1 })],
    ['missing repo', () => ({ run: RUN, attempt: ATTEMPT, artifactName: NAME })],
    ['repo a number', () => ({ ...baseArgs(), repo: 5 })],
    ['repo with spaces', () => ({ ...baseArgs(), repo: 'bad repo' })],
    ['repo missing owner', () => ({ ...baseArgs(), repo: '/name' })],
    ['repo missing name', () => ({ ...baseArgs(), repo: 'owner/' })],
    ['repo extra segment', () => ({ ...baseArgs(), repo: 'owner/name/extra' })],
    ['repo double-dash owner', () => ({ ...baseArgs(), repo: 'ow--ner/name' })],
    ['repo trailing-dash owner', () => ({ ...baseArgs(), repo: 'owner-/name' })],
    ['repo overlong owner', () => ({ ...baseArgs(), repo: `${'a'.repeat(40)}/name` })],
    ['repo dot name', () => ({ ...baseArgs(), repo: 'owner/.' })],
    ['repo dotdot name', () => ({ ...baseArgs(), repo: 'owner/..' })],
    ['run zero', () => ({ ...baseArgs(), run: 0 })],
    ['run fractional', () => ({ ...baseArgs(), run: 1.5 })],
    ['run a string', () => ({ ...baseArgs(), run: String(RUN) })],
    ['run unsafe integer', () => ({ ...baseArgs(), run: Number.MAX_SAFE_INTEGER + 1 })],
    ['attempt zero', () => ({ ...baseArgs(), attempt: 0 })],
    ['attempt a string', () => ({ ...baseArgs(), attempt: '2' })],
    ['artifactName empty', () => ({ ...baseArgs(), artifactName: '' })],
    ['artifactName flag-shaped', () => ({ ...baseArgs(), artifactName: '-name' })],
    ['artifactName control char', () => ({ ...baseArgs(), artifactName: 'bad\nname' })],
    ['artifactName overlong', () => ({ ...baseArgs(), artifactName: 'a'.repeat(201) })],
    ['artifactName a number', () => ({ ...baseArgs(), artifactName: 7 })],
    ['timeoutMs zero', () => ({ ...baseArgs(), timeoutMs: 0 })],
    ['timeoutMs fractional', () => ({ ...baseArgs(), timeoutMs: 1.5 })],
    ['timeoutMs a string', () => ({ ...baseArgs(), timeoutMs: 'x' })],
    ['timeoutMs null', () => ({ ...baseArgs(), timeoutMs: null })],
    ['timeoutMs over one hour', () => ({ ...baseArgs(), timeoutMs: CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS + 1 })],
    ['pollMs zero', () => ({ ...baseArgs(), pollMs: 0 })],
    ['pollMs below floor', () => ({ ...baseArgs(), pollMs: CI_RECEIPT_AWAIT_MIN_POLL_MS - 1 })],
    ['pollMs null', () => ({ ...baseArgs(), pollMs: null })],
    ['pollMs over bound', () => ({ ...baseArgs(), pollMs: 3_600_001 })],
  ])('rejects injected, missing or malformed arguments before the reader: %s', async (_label, badArgs) => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_receipt_await', arguments: badArgs() })).rejects.toMatchObject({ code: -32602 });
    expect(reader).not.toHaveBeenCalled();
  });

  it('rejects a non-object arguments payload before the reader', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_ci_receipt_await', arguments: 'receipts.json' as never })).rejects.toThrow();
    expect(reader).not.toHaveBeenCalled();
  });

  it('waits through pending polls via the real waiter, then returns a prior parseCiResumePrior accepts', async () => {
    const calls: Call[] = [];
    const clock = fakeClock();
    const gh = fakeGh({
      attemptQueue: [ok(JSON.stringify(attemptMeta('in_progress'))), ok(JSON.stringify(attemptMeta('in_progress'))),
        ok(JSON.stringify(attemptMeta('completed')))],
      artifactsQueue: [ok(JSON.stringify(emptyPage)), ok(JSON.stringify(emptyPage)), ok(JSON.stringify(presentPage))],
      downloadBody: JSON.stringify(priorDoc),
    }, calls);
    const client = await connect((input, signal) =>
      readFleetCiReceiptAwait(input, signal, { gh, now: clock.now, sleep: clock.sleep }));
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(result.isError).not.toBe(true);
    const out = parse(result);
    expect(out).toMatchObject({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none' });
    expect(out.note).toMatch(/never reruns CI|read-only/i);
    expect(parseCiResumePrior(out.prior)).toEqual(priorDoc); // consumable by fleet_ci_resume_inputs
    expect(JSON.stringify(out.prior)).toContain(DIGEST); // producer digests preserved verbatim
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(out.diagnostics.length).toBeLessThanOrEqual(MAX_FLEET_CI_RECEIPT_DIAGNOSTICS);
    expect(out.diagnostics.join('\n')).toContain('in_progress');
    // Exact attempt binding: the reads name the requested run/attempt URLs only.
    const apiUrls = calls.filter((c) => c.args[0] === 'api').map((c) => c.args.at(-1));
    expect(apiUrls.slice(0, 6)).toEqual([
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
      `repos/${REPO}/actions/runs/${RUN}/attempts/${ATTEMPT}`,
      `repos/${REPO}/actions/runs/${RUN}/artifacts?per_page=100`,
    ]);
    expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(true);
    expect(gets(calls)).toBe(true); // GET listing/metadata plus one bounded download
    expect(mutations(calls)).toEqual([]); // zero mutation calls
  });

  it('keeps terminal evidence a sanitized tool error, never a fabricated prior', async () => {
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    for (const f of [
      { attemptQueue: [ok(JSON.stringify(attemptMeta('completed')))], artifactsQueue: [ok(JSON.stringify(emptyPage))] },
      { attemptQueue: [running], artifactsQueue: [ok(JSON.stringify([{ total_count: 2,
        artifacts: [artifactRow(ART, NAME, false), artifactRow(88, NAME, false)] }]))] }, // duplicate bearers
      { attemptQueue: [running], artifactsQueue: [ok(JSON.stringify([{ total_count: 1,
        artifacts: [artifactRow(88, NAME, true)] }]))] }, // only an expired bearer
      { attemptQueue: [running], artifactsQueue: [ok(JSON.stringify([{ total_count: 1,
        artifacts: [{ ...artifactRow(ART, NAME, false), workflow_run: { id: 55 } }] }]))] }, // foreign run
      { attemptQueue: [bad({ code: 0, stdout: 'not json' })] }, // malformed evidence
      { artifactsQueue: [bad()] }, // listing transport failure
    ] satisfies FakeGh[]) {
      const calls: Call[] = [];
      const clock = fakeClock();
      const client = await connect((input, signal) =>
        readFleetCiReceiptAwait(input, signal, { gh: fakeGh(f, calls), now: clock.now, sleep: clock.sleep }));
      const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
      expect(JSON.stringify(result)).not.toContain('"receipts"');
      expect(calls.some((c) => c.args[0] === 'run' && c.args[1] === 'download')).toBe(false);
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('refuses receipts bound to another run or attempt through the real binder', async () => {
    for (const doc of [
      { ...priorDoc, receipts: [receiptRow('job-a', 7000, 'success'), { ...receiptRow('job-b', 7001, 'failure'), attempt: 3 }] },
      { ...priorDoc, receipts: [receiptRow('job-a', 7000, 'success'), { ...receiptRow('job-b', 7001, 'failure'), jobId: 9999 }] },
      { ...priorDoc, receipts: [receiptRow('job-a', 7000, 'success'), { ...receiptRow('job-b', 7001, 'failure'), headSha: 'c'.repeat(40) }] },
    ]) {
      const calls: Call[] = [];
      const client = await connect((input, signal) =>
        readFleetCiReceiptAwait(input, signal, {
          gh: fakeGh({ downloadBody: JSON.stringify(doc) }, calls),
          now: fakeClock().now, sleep: async () => {} }));
      const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(DIGEST);
      expect(mutations(calls)).toEqual([]);
    }
  });

  it('times out as a sanitized tool error while an active attempt stays pending', async () => {
    const calls: Call[] = [];
    const clock = fakeClock();
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    const client = await connect((input, signal) =>
      readFleetCiReceiptAwait(input, signal, {
        gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls),
        now: clock.now, sleep: clock.sleep }));
    const result = await client.callTool({ name: 'fleet_ci_receipt_await',
      arguments: baseArgs({ timeoutMs: 1000, pollMs: 250 }) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('"receipts"');
    expect(mutations(calls)).toEqual([]);
  });

  it('surfaces cancellation through the real waiter, before and during the wait', async () => {
    const pre = new AbortController(); pre.abort();
    const calls: Call[] = [];
    await expect(readFleetCiReceiptAwait(parseFleetCiReceiptAwaitArgs(baseArgs())!, pre.signal,
      { gh: fakeGh({}, calls) })).rejects.toThrow(/aborted/);
    expect(calls).toHaveLength(0); // nothing was read

    const mid = new AbortController();
    const calls2: Call[] = [];
    const running = ok(JSON.stringify(attemptMeta('in_progress')));
    await expect(readFleetCiReceiptAwait(parseFleetCiReceiptAwaitArgs(baseArgs())!, mid.signal, {
      gh: fakeGh({ attemptQueue: [running], artifactsQueue: [ok(JSON.stringify(emptyPage))] }, calls2),
      now: fakeClock().now, sleep: async () => { mid.abort(); },
    })).rejects.toThrow(/aborted/);
    expect(calls2.filter((c) => c.args[0] === 'api')).toHaveLength(2); // one observation, then cancelled
  });

  it('passes the server request signal to the reader so client cancellation aborts the wait', async () => {
    let resolveSeen: (signal: AbortSignal) => void = () => {};
    const seen = new Promise<AbortSignal>((r) => { resolveSeen = r; });
    const client = await connect((_input, signal) => { resolveSeen(signal); return new Promise(() => {}); });
    const ac = new AbortController();
    const call = client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() }, undefined, { signal: ac.signal });
    const rejection = expect(call).rejects.toThrow();
    const signal = await seen;
    ac.abort();
    await rejection;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });

  it('sanitizes an unexpected reader exception', async () => {
    const client = await connect(async () => { throw new Error('private-waiter-detail'); });
    const result = await client.callTool({ name: 'fleet_ci_receipt_await', arguments: baseArgs() });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Fleet observation unavailable; inspect local configuration and fleet stores.');
    expect(JSON.stringify(result)).not.toContain('private-waiter-detail');
  });

  it('leaves mutation-sounding names unregistered', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const name of ['fleet_ci_receipt_download', 'fleet_ci_rerun', 'fleet_ci_receipt_await_apply']) {
      await expect(client.callTool({ name })).rejects.toMatchObject({ code: -32602 });
    }
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('parseFleetCiReceiptAwaitArgs', () => {
  it('bounds diagnostics are declared in the result shape and parser stays pure', () => {
    expect(parseFleetCiReceiptAwaitArgs(baseArgs())).toEqual(baseArgs());
    expect(parseFleetCiReceiptAwaitArgs({ repo: REPO, run: RUN, attempt: ATTEMPT, artifactName: NAME })).toEqual({
      repo: REPO, run: RUN, attempt: ATTEMPT, artifactName: NAME,
      timeoutMs: CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS, pollMs: CI_RECEIPT_AWAIT_DEFAULT_POLL_MS,
    });
    expect(parseFleetCiReceiptAwaitArgs({ ...baseArgs(), nope: 1 })).toBeNull();
    expect(parseFleetCiReceiptAwaitArgs({})).toBeNull();
  });
});
