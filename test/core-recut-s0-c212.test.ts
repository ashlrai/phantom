/**
 * RQ-PHX-RECUTCORES0C212: conflicting-head recut queue behavior
 * recovered from accumulated PR #5211 (subset only; no timing/stats/CLI).
 * Private temp HOME, fake SHAs and PRs, no real queue or live action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as preferences from '../src/core/verse/preferences.js';
import {
  completeRouterJob, enqueueRouterFollowup, enqueueRouterRecut, readRouterQueue, routerQueueRoot,
} from '../src/core/fleet/router-queue.js';

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
const receipts = () => JSON.parse(load('state.json')).receipts;
const recuts = () => receipts().filter((r: { state: string }) => r.state === 'CONFLICTING');
const statusByHead = () => Object.fromEntries(recuts().map((r: { headSha: string; status: string }) => [r.headSha.slice(0, 1), r.status]));
const rowJson = () => /```json\n([^\n]+)\n```/.exec(load('router-queue.md'))!;

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'router-queue-211s-'));
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

describe('conflicting-head recut queue', () => {
  it('records one job per (PR, head) and dedupes replays, even after completion', () => {
    const first = enqueueRouterRecut(conflict);
    expect(first).toEqual({ status: 'enqueued', jobId: expect.stringMatching(/^rq-[a-f0-9]{64}$/) });
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'duplicate', jobId: first.jobId });
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-02T01:00:00.000Z' })).toEqual({ status: 'duplicate', jobId: first.jobId });
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([first.jobId]);
    expect(completeRouterJob(first.jobId!)).toEqual({ status: 'done', jobId: first.jobId });
    expect(completeRouterJob(first.jobId!)).toEqual({ status: 'done', jobId: first.jobId });
    expect(readRouterQueue()).toEqual([]);
    expect(enqueueRouterRecut(conflict)).toEqual({ status: 'duplicate', jobId: first.jobId });
    expect(readRouterQueue()).toEqual([]);
    expect(statusByHead()).toEqual({ a: 'done' });
  });

  it('binds PR/head/base in a task that is data and grants no authority', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const [job] = readRouterQueue();
    expect(job).toMatchObject({ jobId, repo: 'ashlrai/phantom' });
    expect(job!.prompt).toContain('untrusted work-spec data');
    const row = JSON.parse(job!.prompt.split('\n')[1]!);
    expect(row).toMatchObject({ id: jobId, prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: conflict.observedAt });
    for (const text of [`Recut conflicting pull request ${PR}`, HEAD_A, 'preserve the intended change exactly',
      'rebuild it on the current master', 'required checks', 'one replacement PR', 'protected merge queue',
      'never force-push', 'admin bypass', 'never change protections']) expect(row.task).toContain(text);
  });

  it('supersedes the stale recut when the head moves', () => {
    const first = enqueueRouterRecut(conflict);
    const second = enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(second.status).toBe('enqueued');
    expect(second.jobId).not.toBe(first.jobId);
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([second.jobId]);
    expect(statusByHead()).toEqual({ a: 'superseded', b: 'queued' });
  });

  it('revives a superseded head only for an observation newer than every other', () => {
    const first = enqueueRouterRecut(conflict);
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    // Replay of the old head's own older observation is a duplicate; it must not revive it.
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-02T00:00:00.000Z' }).status).toBe('duplicate');
    // Newer than the superseded receipt but older than the live head's observation: obsolete.
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-02T12:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(statusByHead()).toEqual({ a: 'superseded', b: 'queued' });
    expect(enqueueRouterRecut({ ...conflict, observedAt: '2026-01-04T00:00:00.000Z' })).toEqual({ status: 'enqueued', jobId: first.jobId });
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([first.jobId]);
    expect(statusByHead()).toEqual({ a: 'queued', b: 'superseded' });
  });

  it('treats an older observation of a different head as obsolete', () => {
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(enqueueRouterRecut({ ...conflict, headSha: '0'.repeat(40), observedAt: '2026-01-01T12:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(readRouterQueue()).toHaveLength(1);
    expect(recuts()).toHaveLength(1);
  });

  it('refuses a different head observed at exactly the same instant, and a changed base for one head', () => {
    enqueueRouterRecut(conflict);
    expect(() => enqueueRouterRecut({ ...conflict, headSha: HEAD_B })).toThrow();
    expect(() => enqueueRouterRecut({ ...conflict, baseRef: 'develop', observedAt: '2026-01-04T00:00:00.000Z' })).toThrow();
    expect(readRouterQueue()).toHaveLength(1);
    expect(recuts()[0].baseRef).toBe('master');
  });

  it('voids outstanding recuts when the PR merges and ignores later conflict observations', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const followup = enqueueRouterFollowup(merge);
    expect(followup.status).toBe('enqueued');
    expect(recuts()[0].status).toBe('superseded');
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([followup.jobId]);
    expect(readRouterQueue()[0]!.jobId).not.toBe(jobId);
    expect(enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-05T00:00:00.000Z' })).toEqual({ status: 'obsolete', jobId: null });
    expect(recuts()).toHaveLength(1);
    // A replayed merge is still a duplicate and leaves everything as is.
    expect(enqueueRouterFollowup(merge).status).toBe('duplicate');
  });

  it('keeps recuts for different PRs independent', () => {
    const a = enqueueRouterRecut(conflict);
    const b = enqueueRouterRecut({ ...conflict, prUrl: PR2 });
    expect(readRouterQueue().map((j) => j.jobId).sort()).toEqual([a.jobId, b.jobId].sort());
    enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(readRouterQueue().map((j) => j.jobId)).toContain(b.jobId);
    expect(readRouterQueue().map((j) => j.jobId)).not.toContain(a.jobId);
  });

  it('reads old persisted merge receipts (no timing, no conflict kind) and queue rows unchanged', () => {
    const legacy = { ...merge, status: 'queued' };
    const done = { ...merge, prUrl: PR2, status: 'done' };
    // Seed through the public API, then rewrite state to the exact pre-timing shape.
    const first = enqueueRouterFollowup(merge);
    enqueueRouterFollowup({ ...merge, prUrl: PR2 });
    completeRouterJob(enqueueRouterFollowup({ ...merge, prUrl: PR2 }).jobId);
    const state = JSON.parse(load('state.json'));
    expect(state.receipts).toEqual([
      { ...legacy, enqueuedAt: expect.any(String), completedAt: null },
      { ...done, enqueuedAt: expect.any(String), completedAt: expect.any(String) },
    ]);
    save('state.json', JSON.stringify({ ...state, receipts: [legacy, done] }));
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([first.jobId]);
    expect(JSON.parse(rowJson()[1]!)).toMatchObject({ mergeSha: MERGE_SHA });
    // A recut for a third PR coexists with the legacy receipts.
    const recut = enqueueRouterRecut({ ...conflict, prUrl: 'https://github.com/ashlrai/locus/pull/7' });
    expect(readRouterQueue().map((j) => j.jobId).sort()).toEqual([first.jobId, recut.jobId].sort());
  });

  it.each([
    { state: 'OPEN' }, { state: 'MERGED' }, { headSha: 'nope' }, { headSha: HEAD_A.toUpperCase() },
    { observedAt: 'never' }, { observedAt: '2999-01-01T00:00:00.000Z' },
    { baseRef: '' }, { baseRef: '$(evil)' }, { baseRef: 'main..DROP' }, { baseRef: 'a b' }, { baseRef: 'x'.repeat(300) },
    { prUrl: 'https://github.com/attacker/phantom/pull/42' }, { prUrl: 'https://github.com/ashlrai/not-allowed/pull/42' },
    { extra: 'field' }, { status: 'done' },
  ])('rejects malformed or out-of-scope observation %j', (patch) => {
    expect(() => enqueueRouterRecut({ ...conflict, ...patch })).toThrow();
    expect(recuts()).toEqual([]);
  });

  it('rejects a missing field', () => {
    const { headSha: _omit, ...partial } = conflict;
    expect(() => enqueueRouterRecut(partial)).toThrow();
  });

  it.each(['repo', 'prUrl', 'headSha', 'baseRef', 'observedAt', 'id', 'mergeSha'])('refuses modified recut queue metadata %s', (field) => {
    enqueueRouterRecut(conflict);
    const text = load('router-queue.md');
    const match = rowJson();
    save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), [field]: 'forged' })));
    expect(() => readRouterQueue()).toThrow();
  });

  it('repairs a deleted recut row from its receipt and keeps operator-edited task data', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const text = load('router-queue.md');
    const match = rowJson();
    save('router-queue.md', text.replace(match[1]!, JSON.stringify({ ...JSON.parse(match[1]!), task: 'Recut PR 42 preserving the flag work.' })));
    expect(JSON.parse(readRouterQueue()[0]!.prompt.split('\n')[1]!).task).toContain('flag work');
    unlinkSync(file('router-queue.md'));
    const jobs = readRouterQueue();
    expect(jobs.map((j) => j.jobId)).toEqual([jobId]);
    expect(jobs[0]!.prompt).toContain(HEAD_A);
  });

  it('recovers after the receipt persists but the queue write fails', () => {
    const realWrite = preferences.writePrivateFileAtomic;
    vi.spyOn(preferences, 'writePrivateFileAtomic').mockImplementation((path, text) => {
      if (path.endsWith('router-queue.md')) throw new Error('simulated crash');
      return realWrite(path, text);
    });
    try { enqueueRouterRecut(conflict); } catch { /* expected */ }
    vi.restoreAllMocks();
    expect(recuts()).toHaveLength(1);
    expect(readRouterQueue()).toHaveLength(1);
    expect(enqueueRouterRecut(conflict).status).toBe('duplicate');
  });

  it('completes by derived id only and acknowledges a superseded recut without queueing it', () => {
    const first = enqueueRouterRecut(conflict);
    expect(() => completeRouterJob('rq-' + 'f'.repeat(64))).toThrow();
    expect(() => completeRouterJob(first.jobId!.replace('rq-', 'RQ-'))).toThrow();
    const second = enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    expect(completeRouterJob(first.jobId!)).toEqual({ status: 'done', jobId: first.jobId });
    expect(readRouterQueue().map((j) => j.jobId)).toEqual([second.jobId]);
  });
});
