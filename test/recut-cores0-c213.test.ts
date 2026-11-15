/**
 * RQ-PHX-RECUTCORES0C213: recut of PR #5236 (RQ-PHX-QUEUECONFLICTRECOVER198S)
 * onto the post-#5281 master. Covers the deltas master was still missing: the
 * `conflicted` verb on `phm fleet queue`, receipt timing fields
 * (enqueuedAt/completedAt) written at ingestion and acknowledgment, and the
 * '@{' baseRef hardening. Private temp HOME, fake SHAs and PRs, no live action.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeRouterJob, enqueueRouterRecut, readRouterQueue, routerQueueRoot } from '../src/core/fleet/router-queue.js';
import { cmdRouterQueue } from '../src/cli/router-queue.js';

const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);
const PR = 'https://github.com/ashlrai/phantom/pull/42';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const conflict = { v: 1, state: 'CONFLICTING', prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: '2026-01-02T00:00:00.000Z' };
const merge = { v: 1, state: 'MERGED', prUrl: PR, headSha: HEAD_A, mergeSha: 'c'.repeat(40), mergedAt: '2026-01-01T00:00:00.000Z' };

let home: string;
let root: string;
const originalHome = process.env['HOME'];
const file = (name: string) => join(root, name);
const load = (name: string) => readFileSync(file(name), 'utf8');
const save = (name: string, text: string) => writeFileSync(file(name), text, { mode: 0o600 });
const receipts = () => JSON.parse(load('state.json')).receipts;

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'recut-cores0-c213-'));
  process.env['HOME'] = home;
  root = routerQueueRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  save('config.json', JSON.stringify({ v: 1, repositories: repos }));
});
afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], input = '') {
  const output: unknown[] = [];
  const code = await cmdRouterQueue(args, { input: (async function* () { yield input; })(), output: (value) => output.push(value) });
  return { code, output };
}

describe('conflicted verb and receipt timing (recovered from #5236)', () => {
  it('phm fleet queue conflicted ingests a verified observation and stamps enqueuedAt', async () => {
    const before = Date.now();
    const ingested = await run(['conflicted', '--json'], JSON.stringify(conflict));
    expect(ingested.code).toBe(0);
    expect(ingested.output[0]).toMatchObject({ status: 'enqueued', jobId: expect.stringMatching(/^rq-[a-f0-9]{64}$/) });
    const [receipt] = receipts();
    expect(receipt).toMatchObject({ state: 'CONFLICTING', prUrl: PR, headSha: HEAD_A, baseRef: 'master', status: 'queued', completedAt: null });
    const enqueuedAt = Date.parse(receipt.enqueuedAt);
    expect(enqueuedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(enqueuedAt).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('complete stamps completedAt on the receipt it settles', async () => {
    const { jobId } = enqueueRouterRecut(conflict);
    expect(receipts()[0]).toMatchObject({ status: 'queued', completedAt: null });
    expect(completeRouterJob(jobId!)).toEqual({ status: 'done', jobId });
    const [receipt] = receipts();
    expect(receipt.status).toBe('done');
    expect(Date.parse(receipt.completedAt)).toBeGreaterThanOrEqual(Date.parse(receipt.enqueuedAt) - 1);
  });

  it('a revived recut refreshes enqueuedAt and clears completedAt', () => {
    const first = enqueueRouterRecut(conflict);
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    // Age the superseded receipt's stamp so the refresh is observable.
    const state = JSON.parse(load('state.json'));
    const aged = state.receipts.find((r: { headSha: string }) => r.headSha === HEAD_A);
    expect(aged.status).toBe('superseded');
    aged.enqueuedAt = '2026-01-02T00:00:00.000Z';
    save('state.json', JSON.stringify(state));
    // Head moves back with the newest observation on record: the old recut revives.
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-04T00:00:00.000Z' })).toEqual({ status: 'enqueued', jobId: first.jobId });
    const revived = receipts().find((r: { headSha: string }) => r.headSha === HEAD_A);
    expect(revived.status).toBe('queued');
    expect(revived.enqueuedAt).not.toBe('2026-01-02T00:00:00.000Z');
    expect(revived.completedAt).toBeNull();
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([first.jobId]);
  });

  it('rejects a baseRef carrying @{ (reflog syntax) without touching state', async () => {
    const result = await run(['conflicted'], JSON.stringify({ ...conflict, baseRef: 'main@{upstream}' }));
    expect(result.code).toBe(1);
    expect(result.output[0]).toEqual({ error: 'queue-unavailable-or-invalid' });
    expect(receipts()).toEqual([]);
    expect(existsSync(file('router-queue.md'))).toBe(false);
  });

  it.each([
    { enqueuedAt: '2026-01-02T00:00:00.000Z' },                                  // missing completedAt
    { completedAt: '2026-01-02T00:00:00.000Z' },                                  // missing enqueuedAt
    { enqueuedAt: '2999-01-01T00:00:00.000Z', completedAt: null },                // future stamp
    { enqueuedAt: '2026-01-02T00:00:00.000Z', completedAt: 'never' },             // malformed stamp
  ])('fails closed on a stored receipt with malformed timing %j', (timing) => {
    save('state.json', JSON.stringify({ v: 1, receipts: [{ ...conflict, status: 'queued', ...timing }],
      observed: { sha256: '0'.repeat(64), lines: [], lineCount: 0, reads: 0 } }));
    expect(() => readRouterQueue()).toThrow();
  });

  it('a recorded merge still voids queued recuts and keeps their timing intact', async () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const mergeResult = await run(['merged'], JSON.stringify(merge));
    expect(mergeResult.code).toBe(0);
    const recut = receipts().find((r: { state: string }) => r.state === 'CONFLICTING');
    expect(recut).toMatchObject({ status: 'superseded', completedAt: null });
    expect(recut.enqueuedAt).not.toBeNull();
    expect(readRouterQueue().map((j) => j.jobId)).not.toContain(jobId);
  });
});
