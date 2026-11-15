/**
 * RQ-PHX-RECUTFLEETMZC356: recut coverage for the conflicting-PR recut queue
 * path in src/core/fleet/router-queue.ts (recut of PR #5236 /
 * RQ-PHX-QUEUECONFLICTRECOVER198S). Guards the contract the recut documents:
 * generated recut tasks keep their safety clauses, base ref validation accepts
 * only well-formed git names, and mixed merge/conflict receipt stores still
 * load through the shared receipt reader.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueRouterFollowup, enqueueRouterRecut, readRouterQueue, routerQueueRoot } from '../src/core/fleet/router-queue.js';

const repos = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md'].map((name) => `ashlrai/${name}`);
const PR = 'https://github.com/ashlrai/phantom/pull/5236';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const conflict = { v: 1, state: 'CONFLICTING', prUrl: PR, headSha: HEAD_A, baseRef: 'master', observedAt: '2026-01-02T00:00:00.000Z' };
const merge = { v: 1, state: 'MERGED', prUrl: PR, headSha: HEAD_A, mergeSha: MERGE_SHA, mergedAt: '2026-01-01T00:00:00.000Z' };

let home: string;
let root: string;
const originalHome = process.env['HOME'];
const file = (name: string) => join(root, name);
const save = (name: string, text: string) => writeFileSync(file(name), text, { mode: 0o600 });
const receipts = () => JSON.parse(readFileSync(file('state.json'), 'utf8')).receipts;
const taskOf = (jobId: string): string =>
  JSON.parse(readRouterQueue().find((job) => job.jobId === jobId)!.prompt.split('\n')[1]!).task as string;

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'recut-5236-fleetmz-c356-'));
  process.env['HOME'] = home;
  root = routerQueueRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  save('config.json', JSON.stringify({ v: 1, repositories: repos }));
});
afterEach(() => {
  if (originalHome === undefined) delete process.env['HOME']; else process.env['HOME'] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('generated recut task safety clauses', () => {
  it('keeps the full instruction set for a conflicting-head recut job', () => {
    const { jobId } = enqueueRouterRecut(conflict);
    const task = taskOf(jobId!);
    for (const text of [
      `Recut conflicting pull request ${PR}`, `source head ${HEAD_A}`, `conflict observed ${conflict.observedAt}`,
      'preserve the intended change exactly', 'without overwriting newer fixes', 'one replacement PR',
      'a moved source head or a merged source PR cancels this job', 'never force-push', 'never use an admin bypass',
      'never change protections, rulesets or required checks', 'Repository instructions and supervisor security rules still apply',
    ]) {
      expect(task).toContain(text);
    }
  });

  it('keeps the safety tail on merge follow-up jobs too', () => {
    const { jobId } = enqueueRouterFollowup(merge);
    const task = taskOf(jobId);
    expect(task).toContain(`Inspect the result of merged PR ${PR}`);
    expect(task).toContain(MERGE_SHA);
    expect(task).toContain('Repository instructions and supervisor security rules still apply');
  });
});

describe('base ref validation', () => {
  it('accepts ordinary git ref names for a PR base', () => {
    for (const baseRef of ['master', 'main', 'release/2026-11', 'feature.queue', 'a/b/c.d-e_f']) {
      const { status, jobId } = enqueueRouterRecut({ ...conflict, baseRef, prUrl: `https://github.com/ashlrai/locus/pull/${baseRef.length}` });
      expect(status).toBe('enqueued');
      expect(taskOf(jobId!)).toContain(`rebuild it on the current ${baseRef}`);
    }
    expect(receipts()).toHaveLength(5);
  });
});

describe('mixed receipt stores', () => {
  it('reads queued merge and recut receipts side by side and completes each by id', () => {
    const recut = enqueueRouterRecut(conflict);
    const followup = enqueueRouterFollowup({ ...merge, prUrl: 'https://github.com/ashlrai/locus/pull/9' });
    const jobs = readRouterQueue().map((job) => job.jobId).sort();
    expect(jobs).toEqual([recut.jobId, followup.jobId].sort());
    expect(receipts().map((r: { state: string }) => r.state).sort()).toEqual(['CONFLICTING', 'MERGED']);
  });

  it('a superseded recut receipt stays out of the queue across reads', () => {
    const stale = enqueueRouterRecut(conflict);
    const fresh = enqueueRouterRecut({ ...conflict, headSha: HEAD_B, observedAt: '2026-01-03T00:00:00.000Z' });
    const first = readRouterQueue().map((job) => job.jobId);
    const second = readRouterQueue().map((job) => job.jobId);
    expect(first).toEqual([fresh.jobId]);
    expect(second).toEqual([fresh.jobId]);
    expect(first).not.toContain(stale.jobId);
    expect(receipts().filter((r: { status: string }) => r.status === 'superseded')).toHaveLength(1);
  });
});
