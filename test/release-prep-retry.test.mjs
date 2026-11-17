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
    return p.includes('check-runs') ? { check_runs: [] } : { workflow_runs: [{ path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'queued' }] };
  });
  assert.equal(decision.reason, 'release-run-in-flight');
  assert.ok(paths.every((p) => p.includes(sha)));
});
