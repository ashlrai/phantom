/**
 * RQ-PHX-QUEUECONFLICTRECOVER198S: recovered conflict-recut ingestion on the
 * router queue (subset preserved from PR #5211 / RQ-DRAINRECUTQ8). A trusted
 * bridge reports an independently verified CONFLICTING observation; the queue
 * emits exactly one proposal-only recut job per (prUrl, headSha): replays are
 * duplicates, a moved head supersedes the old recut, a recorded or subsequent
 * merge voids it, and stale observations never revive obsolete work.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completeRouterJob, enqueueRouterFollowup, enqueueRouterRecut, readRouterQueue, routerQueueRoot } from '../src/core/fleet/router-queue.js';
import { cmdRouterQueue } from '../src/cli/router-queue.js';

const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);
const PR = 'https://github.com/ashlrai/phantom/pull/42';
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
const receipts = () => JSON.parse(load('state.json')).receipts;
const recuts = () => receipts().filter((r: { state: string }) => r.state === 'CONFLICTING');
const byHead = () => Object.fromEntries(recuts().map((r: { headSha: string; status: string }) => [r.headSha.slice(0, 1), r.status]));

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'router-queue-recut-198s-'));
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

describe('conflicted-PR recut recovery', () => {
  it('CLI ingestion yields one readable recut proposal and dedupes replays', async () => {
    const ingested = await run(['conflicted', '--json'], JSON.stringify(conflict));
    expect(ingested.code).toBe(0);
    expect(ingested.output[0]).toMatchObject({ status: 'enqueued', jobId: expect.stringMatching(/^rq-[a-f0-9]{64}$/) });
    const { jobId } = ingested.output[0] as { jobId: string };
    const read = await run(['read']);
    const jobs = (read.output[0] as { jobs: { jobId: string; repo: string; prompt: string }[] }).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ jobId, repo: 'ashlrai/phantom' });
    const spec = JSON.parse(jobs[0]!.prompt.split('\n')[1]!);
    expect(spec).toMatchObject({ id: jobId, prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: conflict.observedAt });
    for (const text of ['untrusted work-spec data', 'preserve the intended change exactly', 'rebuild it on the current master',
      'one replacement PR', 'never force-push', 'never change protections']) {
      expect(jobs[0]!.prompt + spec.task).toContain(text);
    }
    expect((await run(['conflicted'], JSON.stringify(conflict))).output[0]).toEqual({ status: 'duplicate', jobId });
    expect((await run(['read'])).output[0]).toEqual(read.output[0]);
  });

  it('a moved head supersedes the queued recut; the newest observation can revive it', () => {
    const first = enqueueRouterRecut(conflict);
    const second = enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(second.status).toBe('enqueued');
    expect(second.jobId).not.toBe(first.jobId);
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([second.jobId]);
    expect(byHead()).toEqual({ a: 'superseded', b: 'queued' });
    // Head moves back with the newest observation on record: the recut revives once.
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-04T00:00:00.000Z' })).toEqual({ status: 'enqueued', jobId: first.jobId });
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([first.jobId]);
  });

  it('a stale observation enqueues nothing and never revives an obsolete task', () => {
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    // Older observations of any other head: obsolete, not queued — no clock rollback.
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-02T00:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(enqueueRouterRecut({ ...conflict, headSha: HEAD_A, observedAt: '2026-01-02T12:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(readRouterQueue()).toHaveLength(1);
    // Equal-time observation of a different head is ambiguous: fail closed.
    expect(() => enqueueRouterRecut({ ...conflict, headSha: HEAD_A, observedAt: '2026-01-03T00:00:00.000Z' })).toThrow();
    expect(recuts()).toHaveLength(1);
  });

  it('a recorded merge voids pending recuts in both directions', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([jobId]);
    enqueueRouterFollowup(merge);
    expect(recuts()[0].status).toBe('superseded');
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prompt).toContain(MERGE_SHA);
    expect(enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(recuts()).toHaveLength(1);
    expect(enqueueRouterFollowup({ ...merge, prUrl: 'https://github.com/ashlrai/locus/pull/9' }).status).toBe('enqueued');
    expect(enqueueRouterRecut({ ...conflict, prUrl: 'https://github.com/ashlrai/locus/pull/9', observedAt: '2026-01-03T00:00:00.000Z' }))
      .toEqual({ status: 'obsolete', jobId: null });
  });

  it.each([
    { state: 'OPEN' }, { state: 'MERGED' }, { headSha: 'nope' }, { headSha: HEAD_A.toUpperCase() },
    { observedAt: 'never' }, { observedAt: '2999-01-01T00:00:00.000Z' }, { baseRef: '' }, { baseRef: '$(evil)' },
    { baseRef: 'main..DROP' }, { baseRef: 'a b' }, { baseRef: 'x'.repeat(300) },
    { prUrl: 'https://github.com/attacker/phantom/pull/42' }, { prUrl: 'https://github.com/ashlrai/not-allowed/pull/42' },
    { prUrl: 'https://evil.example.com/ashlrai/phantom/pull/42' }, { extra: 'field' },
  ])('rejects malformed or out-of-scope conflict input without touching state %j', (patch) => {
    enqueueRouterRecut(conflict);
    const before = JSON.stringify(receipts());
    const queueBefore = load('router-queue.md');
    expect(() => enqueueRouterRecut({ ...conflict, ...patch })).toThrow();
    expect(JSON.stringify(receipts())).toBe(before);
    expect(load('router-queue.md')).toBe(queueBefore);
  });

  it('refuses conflicting baseRef or forged queue metadata for a seen head', () => {
    enqueueRouterRecut(conflict);
    expect(() => enqueueRouterRecut({ ...conflict, baseRef: 'develop', observedAt: '2026-01-04T00:00:00.000Z' })).toThrow();
    expect(recuts()[0].baseRef).toBe('master');
    const text = load('router-queue.md');
    const match = /```json\n([^\n]+)\n```/.exec(text)!;
    for (const field of ['repo', 'prUrl', 'headSha', 'baseRef', 'observedAt', 'id']) {
      save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), [field]: 'forged' })));
      expect(() => readRouterQueue()).toThrow();
    }
  });

  it('complete acknowledges a recut by its derived id only; replay stays duplicate', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    expect(() => completeRouterJob('rq-' + 'f'.repeat(64))).toThrow();
    expect(completeRouterJob(jobId!)).toEqual({ status: 'done', jobId });
    expect(readRouterQueue()).toEqual([]);
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'duplicate', jobId });
    expect(recuts()[0]).toMatchObject({ status: 'done', headSha: HEAD_A });
  });

  it('legacy v1 merge receipts without timing fields still load, dedupe and complete', () => {
    save('state.json', JSON.stringify({ v: 1, receipts: [{ ...merge, status: 'queued' }],
      observed: { sha256: '0'.repeat(64), lines: [], lineCount: 0, reads: 0 } }));
    const jobs = readRouterQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.prompt).toContain(MERGE_SHA);
    expect(enqueueRouterFollowup(merge).status).toBe('duplicate');
    expect(completeRouterJob(jobs[0]!.jobId)).toEqual({ status: 'done', jobId: jobs[0]!.jobId });
    expect(readRouterQueue()).toEqual([]);
    // A recut for a different PR coexists with the settled merge receipt.
    expect(enqueueRouterRecut({ ...conflict, prUrl: 'https://github.com/ashlrai/locus/pull/7' }).status).toBe('enqueued');
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'obsolete', jobId: null });
  });
});

describe('CLI conflicted ingestion guards', () => {
  it.each(['not JSON SECRET_VALUE', 'x'.repeat(4097)])(
    'refuses invalid conflicted stdin without echoing it or touching the store (%#)', async (input) => {
      expect(await run(['conflicted'], input)).toEqual({ code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] });
      expect(existsSync(file('state.json'))).toBe(false);
    });

  it('stores no receipt for a parseable but invalid observation', async () => {
    expect(await run(['conflicted'], '{}')).toEqual({ code: 1, output: [{ error: 'queue-unavailable-or-invalid' }] });
    expect(receipts()).toEqual([]);
    expect(existsSync(file('router-queue.md'))).toBe(false);
  });

  it.each([['conflicted', '--shell'], ['conflicted', 'extra'], ['conflicted', '--json', '--json']])(
    'rejects unexpected CLI args %j before reading work', async (...args) => {
      expect((await run(args)).code).toBe(2);
      expect(existsSync(file('state.json'))).toBe(false);
    });

  it('help has no side effects on the conflicted verb', async () => {
    expect((await run(['conflicted', '--help'])).code).toBe(0);
    expect(existsSync(file('state.json'))).toBe(false);
  });
});
