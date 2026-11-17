/**
 * RQ-PHX-RECUTFLEETMZC361 recut check — the queue-age/merge-latency read model
 * carried from #5211 (RQ-DRAINRECUTQ8): routerQueueStats measures how long
 * follow-up and recut work waits outstanding, event→completion latency and
 * queue residence per receipt kind, honestly null where timing predates it.
 * Exercised through the real enqueue/complete path on a temp queue root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeRouterJob,
  enqueueRouterFollowup,
  enqueueRouterRecut,
  routerQueueRoot,
  routerQueueStats,
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
const state = () => JSON.parse(load('state.json'));
const receipts = () => state().receipts;
const recutReceipts = () => receipts().filter((r: { state: string }) => r.state === 'CONFLICTING');

beforeEach(() => {
  home = mkdtempSync(join(realpathSync(tmpdir()), 'router-queue-recut-c361-'));
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
