import { describe, expect, it } from 'vitest';
import { githubJson, rateLimitDelay, readReleasePrep } from '../.github/scripts/release-prep-dedup.mjs';

const path = 'repos/ashlrai/phantom/commits/master';
const limited = (headers = '') => `HTTP/2 429\r\n${headers}\r\n\r\n{"message":"rate limit exceeded"}`;
const ok = 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"sha":"ok"}';

describe('release-prep retry', () => {
  it('honors reset and retry-after headers', () => {
    expect(rateLimitDelay(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '110' }, 'rate limit exceeded', 1, 100000)).toBe(11000);
    expect(rateLimitDelay(429, { 'retry-after': '12' }, '', 1, 100000)).toBe(12000);
    expect(rateLimitDelay(403, {}, 'forbidden', 1)).toBeNull();
  });
  it('retries a rate-limited request', () => {
    let calls = 0;
    const waits: number[] = [];
    expect(githubJson(path, () => ++calls === 1 ? limited('retry-after: 2') : ok, (ms: number) => waits.push(ms))).toEqual({ sha: 'ok' });
    expect(calls).toBe(2);
    expect(waits).toEqual([2000]);
  });
  it('waits for a reset header in a mocked response', () => {
    let calls = 0;
    const waits: number[] = [];
    const reset = Math.floor(Date.now() / 1000) + 2;
    githubJson(path, () => ++calls === 1 ? limited(`x-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${reset}`) : ok, (ms: number) => waits.push(ms));
    expect(calls).toBe(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThanOrEqual(3000);
  });
  it('retries a transient 5xx response with backoff', () => {
    let calls = 0;
    const waits: number[] = [];
    const bad = 'HTTP/2 500\r\n\r\n{"message":"Server Error"}';
    expect(githubJson(path, () => ++calls < 3 ? bad : ok, (ms: number) => waits.push(ms))).toEqual({ sha: 'ok' });
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);
  });
  it('a persistent 5xx still fails with its status after four attempts', () => {
    let calls = 0;
    expect(() => githubJson(path, () => { calls++; return 'HTTP/2 502\r\n\r\n{}'; }, () => {})).toThrow(/HTTP 502/);
    expect(calls).toBe(4);
  });
  it('a 404 is not retried', () => {
    let calls = 0;
    expect(() => githubJson(path, () => { calls++; return 'HTTP/2 404\r\n\r\n{}'; }, () => {})).toThrow(/HTTP 404/);
    expect(calls).toBe(1);
  });
  it('fails after four attempts', () => {
    let calls = 0;
    expect(() => githubJson(path, () => { calls++; return limited(); }, () => {})).toThrow(/rate limit persisted after 4/);
    expect(calls).toBe(4);
  });
  it('checks the selected master sha for existing in-flight runs', () => {
    const sha = 'a'.repeat(40);
    const paths: string[] = [];
    const decision = readReleasePrep('ashlrai/phantom', sha, (p: string) => {
      paths.push(p);
      return p.includes('check-runs') ? { check_runs: [] } : { workflow_runs: [{ path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'queued', created_at: new Date().toISOString() }] };
    });
    expect(decision.reason).toBe('release-run-in-flight');
    // Per-sha inventories stay pinned to the selected sha; only the
    // cross-sha dispatch coalescing read is master-wide.
    const perSha = paths.filter((p) => !p.includes('event=workflow_dispatch&branch=master'));
    expect(perSha.every((p) => p.includes(sha))).toBe(true);
    expect(paths).toContain('repos/ashlrai/phantom/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=master&per_page=50');
  });

  it('a release-gate run outstanding on another master sha suppresses a duplicate dispatch', () => {
    const sha = 'a'.repeat(40);
    const other = { path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'in_progress', created_at: new Date().toISOString() };
    const decision = readReleasePrep('ashlrai/phantom', sha, (p: string) => {
      if (p.includes('check-runs')) return { check_runs: [] };
      if (p.includes('event=workflow_dispatch&branch=master')) return { workflow_runs: [other] };
      return { workflow_runs: [] };
    });
    expect(decision.reason).toBe('release-run-in-flight');
  });
});
