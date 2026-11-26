/* global AbortSignal, console, fetch, process */
import assert from 'node:assert/strict';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// release-please scans all open PRs plus up to 200 merged and 200 snoozed
// PRs before updating the branch. Leave headroom for pagination and writes.
// This is an admission check, not a reservation against other token users.
const MINIMUM_REMAINING = 100;

export async function checkReleasePrBudget({ token, fetchImpl = fetch }) {
  assert.ok(typeof token === 'string' && token.trim(), 'missing GitHub token');
  const response = await fetchImpl('https://api.github.com/rate_limit', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, 'GitHub rate-limit read failed');
  let data;
  try { data = await response.json(); }
  catch { throw new Error('invalid GitHub rate-limit response'); }
  // Validate both budgets before deferring so malformed evidence stays an
  // error, even when the other resource is already known to be exhausted.
  for (const resource of ['core', 'graphql']) {
    const budget = data?.resources?.[resource];
    assert.ok(budget && Number.isSafeInteger(budget.limit) && budget.limit > 0
      && Number.isSafeInteger(budget.remaining) && budget.remaining >= 0 && budget.remaining <= budget.limit
      && Number.isSafeInteger(budget.reset) && budget.reset > 0,
    `invalid GitHub rate-limit data for ${resource}`);
  }
  for (const resource of ['core', 'graphql']) {
    const { remaining, reset } = data.resources[resource];
    if (remaining < MINIMUM_REMAINING) {
      return { ready: false, reason: 'github-api-budget-low', resource, remaining, reset };
    }
  }
  return { ready: true, reason: 'github-api-budget-available' };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    assert.ok(process.env.GITHUB_OUTPUT);
    const plan = await checkReleasePrBudget({ token: process.env.GH_TOKEN });
    appendFileSync(process.env.GITHUB_OUTPUT, `ready=${plan.ready}\n`);
    console.log(JSON.stringify(plan));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
