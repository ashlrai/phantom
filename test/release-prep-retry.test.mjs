import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubJson, rateLimitDelay, readReleasePrep } from '../.github/scripts/release-prep-dedup.mjs';

const path = 'repos/ashlrai/phantom/commits/master';
const limited = (headers = '') => `HTTP/2 429\r\n${headers}\r\n\r\n{"message":"rate limit exceeded"}`;
const ok = 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n{"sha":"ok"}';

test('honors reset and retry-after headers', () => {
  assert.equal(rateLimitDelay(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '110' }, 'rate limit exceeded', 1, 100000), 11000);
  assert.equal(rateLimitDelay(429, { 'retry-after': '12' }, '', 1, 100000), 12000);
  assert.equal(rateLimitDelay(403, {}, 'forbidden', 1), null);
});
test('retries a rate-limited request', () => {
  let calls = 0;
  const waits = [];
  assert.deepEqual(githubJson(path, () => ++calls === 1 ? limited('retry-after: 2') : ok, (ms) => waits.push(ms)), { sha: 'ok' });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});
test('waits for a reset header in a mocked response', () => {
  let calls = 0;
  const waits = [];
  const reset = Math.floor(Date.now() / 1000) + 2;
  githubJson(path, () => ++calls === 1 ? limited(`x-ratelimit-remaining: 0\r\nx-ratelimit-reset: ${reset}`) : ok, (ms) => waits.push(ms));
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 1000 && waits[0] <= 3000);
});
test('retries a transient 5xx response with backoff', () => {
  let calls = 0;
  const waits = [];
  const bad = 'HTTP/2 500\r\n\r\n{"message":"Server Error"}';
  assert.deepEqual(githubJson(path, () => ++calls < 3 ? bad : ok, (ms) => waits.push(ms)), { sha: 'ok' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
test('a persistent 5xx still fails with its status after four attempts', () => {
  let calls = 0;
  assert.throws(() => githubJson(path, () => { calls++; return 'HTTP/2 502\r\n\r\n{}'; }, () => {}), /HTTP 502/);
  assert.equal(calls, 4);
});
test('a 404 is not retried', () => {
  let calls = 0;
  assert.throws(() => githubJson(path, () => { calls++; return 'HTTP/2 404\r\n\r\n{}'; }, () => {}), /HTTP 404/);
  assert.equal(calls, 1);
});
test('fails after four attempts', () => {
  let calls = 0;
  assert.throws(() => githubJson(path, () => { calls++; return limited(); }, () => {}), /rate limit persisted after 4/);
  assert.equal(calls, 4);
});
test('checks the selected master sha for existing in-flight runs', () => {
  const sha = 'a'.repeat(40);
  const paths = [];
  const decision = readReleasePrep('ashlrai/phantom', sha, (p) => {
    paths.push(p);
    return p.includes('check-runs') ? { check_runs: [] } : { workflow_runs: [{ path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'queued', created_at: new Date().toISOString() }] };
  });
  assert.equal(decision.reason, 'release-run-in-flight');
  // Per-sha inventories stay pinned to the selected sha; only the
  // cross-sha dispatch coalescing read is master-wide.
  const perSha = paths.filter((p) => !p.includes('event=workflow_dispatch&branch=master'));
  assert.ok(perSha.every((p) => p.includes(sha)));
  assert.ok(paths.includes('repos/ashlrai/phantom/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=master&per_page=50'));
});

test('a release-gate run outstanding on another master sha suppresses a duplicate dispatch', () => {
  const sha = 'a'.repeat(40);
  const other = { path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'in_progress', created_at: new Date().toISOString() };
  const decision = readReleasePrep('ashlrai/phantom', sha, (p) => {
    if (p.includes('check-runs')) return { check_runs: [] };
    if (p.includes('event=workflow_dispatch&branch=master')) return { workflow_runs: [other] };
    return { workflow_runs: [] };
  });
  assert.equal(decision.reason, 'release-run-in-flight');
});
