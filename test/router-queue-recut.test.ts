/**
 * RQ-DRAINRECUTQ8: the idempotent conflict recut path on the merged-PR router
 * queue. A trusted bridge reports an independently verified CONFLICTING
 * observation; the queue emits exactly one recut job per (prUrl, headSha):
 *
 *   - replays of the same observation are duplicates, never new work;
 *   - a moved head supersedes the queued recut for the old one;
 *   - a merge event or a recorded merge for the PR supersedes/voids recuts;
 *   - a head that moves back revives its recut only when the observation
 *     postdates every other one on record;
 *   - the generated task preserves the original change, rebuilds on the
 *     current base, runs required checks, and opens a replacement PR — the
 *     queue never merges and never bypasses protections;
 *   - queue age and merge/recut latency are measured over receipts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as preferences from '../src/core/verse/preferences.js';
import {
  completeRouterJob,
  enqueueRouterFollowup,
  enqueueRouterRecut,
  readRouterQueue,
  routerQueueRoot,
  routerQueueStats,
} from '../src/core/fleet/router-queue.js';
import { cmdRouterQueue } from '../src/cli/router-queue.js';

const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);
const PR = 'https://github.com/ashlrai/phantom/pull/42';
const PR2 = 'https://github.com/ashlrai/phantom/pull/43';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const merge = { v: 1, state: 'MERGED', prUrl: PR, headSha: HEAD_A, mergeSha: MERGE_SHA, mergedAt: '2026-01-01T00:00:00.000Z' };
const conflict = { v: 1, state: 'CONFLICTING', prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: '2026-01-02T00:00:00.000Z' };

let home: string;
let root: string;
const originalHome = process.env['HOME'];
const file = (name: string) => join(root, name);
const load = (name: string) => readFileSync(file(name), 'utf8');
const save = (name: string, text: string) => writeFileSync(file(name), text, { mode: 0o600 });
const state = () => JSON.parse(load('state.json'));
const receipts = () => state().receipts;
const recutReceipts = () => receipts().filter((r: { state: string }) => r.state === 'CONFLICTING');
const jobJson = (id: string) => {
  const match = new RegExp(`## ${id}\n\n\`\`\`json\n([^\n]+)\n\`\`\``).exec(load('router-queue.md'));
  return match ? JSON.parse(match[1]!) : null;
};

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'router-queue-recut-'));
  process.env['HOME'] = home;
  root = routerQueueRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  save('config.json', JSON.stringify({ v: 1, repositories: repos }));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('conflicted-PR recut queue', () => {
  it('enqueues one recut job per conflicting head and dedupes replays, even after completion', () => {
    const first = enqueueRouterRecut(conflict);
    expect(first).toEqual({ status: 'enqueued', jobId: expect.stringMatching(/^rq-[a-f0-9]{64}$/) });
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'duplicate', jobId: first.jobId });
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-02T01:00:00.000Z' })).toEqual({ status: 'duplicate', jobId: first.jobId });
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe(first.jobId);
    completeRouterJob(first.jobId!);
    expect(readRouterQueue()).toEqual([]);
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'duplicate', jobId: first.jobId });
    expect(recutReceipts()[0]).toMatchObject({ status: 'done', headSha: HEAD_A });
    expect(recutReceipts()[0].completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('generates a structured recut task: preserve the change, rebuild on the current base, run required checks, queue a replacement under protection', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const row = jobJson(jobId!);
    expect(row).toMatchObject({ id: jobId, repo: 'ashlrai/phantom', prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: conflict.observedAt });
    const task = row.task;
    expect(task).toContain(`Recut conflicting pull request ${PR}`);
    expect(task).toContain(HEAD_A);
    expect(task).toContain('preserve the intended change exactly');
    expect(task).toContain('rebuild it on the current master');
    expect(task).toContain('required checks');
    expect(task).toContain('one replacement PR');
    expect(task).toContain('protected merge queue');
    expect(task).toContain('never force-push');
    expect(task).toContain('admin bypass');
    expect(task).toContain('never change protections');
    // Recut instructions come from structured fields only — nothing else is text.
    const prompt = readRouterQueue()[0]!.prompt;
    expect(prompt).toContain('untrusted work-spec data');
    expect(prompt).toContain(HEAD_A);
  });

  it('supersedes the queued recut when the source head moves', () => {
    const first = enqueueRouterRecut(conflict);
    const second = enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(second.status).toBe('enqueued');
    expect(second.jobId).not.toBe(first.jobId);
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe(second.jobId);
    const byHead = Object.fromEntries(recutReceipts().map((r: { headSha: string; status: string }) => [r.headSha.slice(0, 1), r.status]));
    expect(byHead).toEqual({ a: 'superseded', b: 'queued' });
    // The superseded job never comes back on its own.
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([second.jobId]);
  });

  it('revives a superseded recut when the head moves back and the observation is newest', () => {
    const first = enqueueRouterRecut(conflict);
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    const revived = enqueueRouterRecut({ ...conflict, observedAt: '2026-01-04T00:00:00.000Z' });
    expect(revived).toEqual({ status: 'enqueued', jobId: first.jobId });
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe(first.jobId);
    const byHead = Object.fromEntries(recutReceipts().map((r: { headSha: string; status: string }) => [r.headSha.slice(0, 1), r.status]));
    expect(byHead).toEqual({ a: 'queued', b: 'superseded' });
    expect(recutReceipts().find((r: { headSha: string }) => r.headSha === HEAD_A).observedAt).toBe('2026-01-04T00:00:00.000Z');
  });

  it.each([
    ['a stale observation of an old head', { ...conflict, headSha: '0'.repeat(40), observedAt: '2026-01-01T12:00:00.000Z' }],
    ['an observation equal in time to the queued head but of a different head', null],
    ['a conflict for a PR whose merge is already recorded', 'merged'],
  ])('enqueues nothing for %s', (_label, event) => {
    if (event === null) {
      enqueueRouterRecut(conflict);
      expect(() => enqueueRouterRecut({ ...conflict, headSha: HEAD_B })).toThrow();
      expect(readRouterQueue()).toHaveLength(1);
      return;
    }
    if (event === 'merged') {
      enqueueRouterFollowup(merge);
      expect(enqueueRouterRecut(conflict)).toEqual({ status: 'obsolete', jobId: null });
      expect(readRouterQueue()).toHaveLength(1);
      expect(recutReceipts()).toEqual([]);
      return;
    }
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(enqueueRouterRecut(event)).toEqual({ status: 'obsolete', jobId: null });
    expect(readRouterQueue()).toHaveLength(1);
    expect(recutReceipts()).toHaveLength(1);
  });

  it('a recorded merge supersedes the queued recut for the same PR', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([jobId]);
    enqueueRouterFollowup(merge);
    expect(recutReceipts()[0].status).toBe('superseded');
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).not.toBe(jobId);
    expect(jobJson(jobs[0]!.jobId)).toMatchObject({ mergeSha: MERGE_SHA });
  });

  it('keeps recuts for different PRs independent', () => {
    const a = enqueueRouterRecut(conflict);
    const b = enqueueRouterRecut({ ...conflict, prUrl: PR2 });
    expect(readRouterQueue().map((j) => j.jobId).sort()).toEqual([a.jobId, b.jobId].sort());
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    const jobs = readRouterQueue().map((j) => j.jobId);
    expect(jobs).toContain(b.jobId);
    expect(jobs).not.toContain(a.jobId);
    completeRouterJob(b.jobId!);
    expect(readRouterQueue().map((j) => j.jobId)).not.toContain(b.jobId);
  });

  it('does not let a conflict receipt collide with the merge dedupe key', () => {
    enqueueRouterRecut(conflict);
    const other = enqueueRouterRecut({ ...conflict, prUrl: 'https://github.com/ashlrai/locus/pull/7' });
    expect(other.status).toBe('enqueued');
    expect(other.jobId).toMatch(/^rq-[a-f0-9]{64}$/);
  });

  it.each([
    { state: 'OPEN' }, { state: 'MERGED' }, { headSha: 'nope' }, { headSha: HEAD_A.toUpperCase() },
    { observedAt: 'never' }, { observedAt: '2999-01-01T00:00:00.000Z' },
    { baseRef: '' }, { baseRef: '$(evil)' }, { baseRef: 'main..DROP' }, { baseRef: 'a b' }, { baseRef: 'x'.repeat(300) },
    { prUrl: 'https://github.com/attacker/phantom/pull/42' },
    { prUrl: 'https://github.com/ashlrai/not-allowed/pull/42' },
    { prUrl: 'https://github.com/masonwyatt23/phantom/pull/42' },
    { extra: 'field' }, { missing: 'headSha', headSha: undefined },
  ])('rejects malformed or out-of-scope conflict input %j', (patch) => {
    const event = { ...conflict, ...patch };
    for (const key of Object.keys(event)) if ((event as Record<string, unknown>)[key] === undefined) delete (event as Record<string, unknown>)[key];
    expect(() => enqueueRouterRecut(event)).toThrow();
    expect(recutReceipts()).toEqual([]);
  });

  it('refuses conflicting baseRef metadata for a previously seen head', () => {
    enqueueRouterRecut(conflict);
    expect(() => enqueueRouterRecut({ ...conflict, baseRef: 'develop', observedAt: '2026-01-04T00:00:00.000Z' })).toThrow();
    expect(recutReceipts()[0].baseRef).toBe('master');
  });

  it.each(['repo', 'prUrl', 'headSha', 'baseRef', 'observedAt', 'id', 'mergeSha'])('refuses modified recut queue metadata %s', (field) => {
    enqueueRouterRecut(conflict);
    const text = load('router-queue.md');
    const match = /```json\n([^\n]+)\n```/.exec(text)!;
    save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), [field]: 'forged' })));
    expect(() => readRouterQueue()).toThrow();
  });

  it('refuses a recut row carrying merge metadata', () => {
    enqueueRouterRecut(conflict);
    const text = load('router-queue.md');
    const match = /```json\n([^\n]+)\n```/.exec(text)!;
    save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), mergeSha: MERGE_SHA })));
    expect(() => readRouterQueue()).toThrow();
  });

  it('repairs a deleted recut job from its receipt and preserves operator-edited task text', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const text = load('router-queue.md');
    const match = /```json\n([^\n]+)\n```/.exec(text)!;
    save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), task: 'Recut PR 42 onto current master, preserving the feature flag work.' })));
    expect(JSON.parse(readRouterQueue()[0]!.prompt.split('\n')[1]!).task).toContain('feature flag work');
    unlinkSync(file('router-queue.md'));
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.jobId).toBe(jobId);
    expect(jobs[0]!.prompt).toContain(HEAD_A);
  });

  it('recovers a recut after receipt persistence succeeds but the queue write fails', () => {
    const realWrite = preferences.writePrivateFileAtomic;
    const spy = vi.spyOn(preferences, 'writePrivateFileAtomic').mockImplementation((path, text) => {
      if (path.endsWith('router-queue.md')) throw new Error('simulated crash');
      return realWrite(path, text);
    });
    const attempted = (() => { try { return enqueueRouterRecut(conflict); } catch { return { jobId: null }; } })();
    const jobId = attempted.jobId;
    expect(recutReceipts()).toHaveLength(1);
    spy.mockRestore();
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    if (jobId) expect(jobs[0]!.jobId).toBe(jobId);
    expect(enqueueRouterRecut(conflict).status).toBe('duplicate');
  });

  it('complete acknowledges a recut by its derived id only', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    expect(() => completeRouterJob('rq-' + 'f'.repeat(64))).toThrow();
    expect(() => completeRouterJob(jobId!.replace('rq-', 'RQ-'))).toThrow();
    expect(completeRouterJob(jobId!)).toEqual({ status: 'done', jobId });
  });

  it('completing a superseded recut acknowledges it without resurrecting it', () => {
    const first = enqueueRouterRecut(conflict);
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(completeRouterJob(first.jobId!)).toEqual({ status: 'done', jobId: first.jobId });
    expect(recutReceipts().find((r: { headSha: string }) => r.headSha === HEAD_A).status).toBe('done');
    expect(readRouterQueue()).toHaveLength(1);
  });
});

describe('queue age and merge latency stats', () => {
  it('reports outstanding age, event→completion latency and queue residence per kind', () => {
    enqueueRouterFollowup({ ...merge, prUrl: PR2 });
    const { jobId } = enqueueRouterRecut(conflict);
    const before = routerQueueStats();
    expect(before.totals).toEqual({ outstanding: 2, done: 0, superseded: 0 });
    expect(before.merge.outstanding).toBe(1);
    expect(before.conflict.outstanding).toBe(1);
    expect(before.conflict.oldestAgeMs).toBeGreaterThanOrEqual(0);
    completeRouterJob(jobId!);
    const stats = routerQueueStats(Date.now());
    expect(stats.totals).toEqual({ outstanding: 1, done: 1, superseded: 0 });
    const stored = recutReceipts()[0];
    const expectedLatency = Date.parse(stored.completedAt) - Date.parse(conflict.observedAt);
    const expectedQueue = Date.parse(stored.completedAt) - Date.parse(stored.enqueuedAt);
    expect(stats.conflict.done).toBe(1);
    expect(stats.conflict.maxLatencyMs).toBe(expectedLatency);
    expect(stats.conflict.meanLatencyMs).toBe(expectedLatency);
    expect(stats.conflict.maxQueueMs).toBe(expectedQueue);
    expect(stats.conflict.latencyUnknown).toBe(0);
    expect(stats.merge.meanLatencyMs).toBeNull();
    expect(stats.merge.done).toBe(0);
    // Outstanding merge work still ages; recut is done, not aged.
    expect(stats.merge.oldestAgeMs).toBeGreaterThanOrEqual(0);
    expect(stats.conflict.oldestAgeMs).toBeNull();
  });

  it('counts superseded recuts and reports latencyUnknown for pre-timing receipts', () => {
    enqueueRouterRecut(conflict);
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    // Simulate a receipt written before timing existed.
    const s = state();
    const legacy = { v: 1, state: 'MERGED', prUrl: 'https://github.com/ashlrai/locus/pull/9', headSha: HEAD_B, mergeSha: MERGE_SHA, mergedAt: '2026-01-01T00:00:00.000Z', status: 'done' };
    s.receipts.push(legacy);
    save('state.json', JSON.stringify(s));
    const stats = routerQueueStats();
    expect(stats.totals.superseded).toBe(1);
    expect(stats.merge.done).toBe(1);
    expect(stats.merge.latencyUnknown).toBe(1);
    expect(stats.merge.meanLatencyMs).toBeNull();
  });
});

describe('bridge CLI recut + stats handoff', () => {
  async function run(args: string[], input = '') {
    const output: unknown[] = [];
    const code = await cmdRouterQueue(args, { input: (async function* () { yield input; })(), output: (value) => output.push(value) });
    return { code, output };
  }

  it('ingests a conflict observation, emits the recut, and deduplicates a replay', async () => {
    const ingested = await run(['conflicted', '--json'], JSON.stringify(conflict));
    expect(ingested.code).toBe(0);
    const { jobId } = ingested.output[0] as { status: string; jobId: string };
    expect((await run(['read'])).output[0]).toEqual({ v: 1, jobs: [{ jobId, repo: 'ashlrai/phantom', prompt: expect.stringContaining(HEAD_A) }] });
    expect((await run(['conflicted'], JSON.stringify(conflict))).output[0]).toEqual({ status: 'duplicate', jobId });
    expect((await run(['complete', jobId])).code).toBe(0);
    expect((await run(['read'])).output[0]).toEqual({ v: 1, jobs: [] });
  });

  it('reports queue age and latency as JSON', async () => {
    await run(['conflicted'], JSON.stringify(conflict));
    const stats = await run(['stats', '--json']);
    expect(stats.code).toBe(0);
    expect(stats.output[0]).toMatchObject({ v: 1, totals: { outstanding: 1, done: 0, superseded: 0 } });
    expect((stats.output[0] as { conflict: { outstanding: number } }).conflict.outstanding).toBe(1);
  });

  it.each([['conflicted', 'not JSON SECRET_VALUE'], ['conflicted', 'x'.repeat(4097)], ['conflicted', '{}']])(
    'refuses invalid conflicted stdin without echoing it', async (verb, input) => {
      const result = await run([verb], input);
      expect(result).toEqual({ code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] });
    });

  it.each([['conflicted', '--shell'], ['stats', 'extra'], ['stats', '--json', '--json']])(
    'rejects unexpected CLI args %j before reading work', async (...args) => {
      expect((await run(args)).code).toBe(2);
    });

  it('help has no side effects on the recut verb', async () => {
    expect((await run(['conflicted', '--help'])).code).toBe(0);
  });
});
