// Bounded lookup of the last green full run, then a shallow git fetch that
// deepens only until that commit is present. This replaces the full-history
// walk, which spent its 60s budget on every scheduled job and failed closed.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export const HISTORY_PAGE = 15;
export const HISTORY_MAX_PAGES = 4;
export const HISTORY_BUDGET_MS = 20_000;
export const FETCH_DEEPEN = 80;
export const FETCH_DEEPEN_CAP = 6;
const REPOSITORY_ID = 1263526319;
const MATRIX = 'CI (Node 22,';
const SMOKE = 'Desktop release smoke';
const QUALIFIED = 'Master full qualification';

export function classifyFullJobs(run, jobs) {
  if (!run || !Array.isArray(jobs)) return 'ignore';
  if (run.event !== 'schedule' && run.event !== 'workflow_dispatch') return 'ignore';
  if (run.status !== 'completed') return 'pending';
  const matrixRan = jobs.some((job) => job.name?.startsWith(MATRIX) && job.conclusion !== 'skipped');
  const smokeRan = jobs.some((job) => job.name === SMOKE && job.conclusion !== 'skipped');
  if (smokeRan || !matrixRan) return 'ignore';
  const check = jobs.find((job) => job.name === QUALIFIED);
  const jobsGreen = jobs.every((job) => job.conclusion === 'success' || job.conclusion === 'skipped');
  const green = run.conclusion === 'success' && (run.event === 'workflow_dispatch' ? jobsGreen : check?.conclusion === 'success');
  return green ? 'green' : 'red';
}

function budgetError() {
  const error = new Error('history budget exceeded');
  error.code = 'HISTORY_BUDGET';
  return error;
}

/**
 * Read schedule runs one shallow page at a time and stop at the first green
 * full attempt. A budget or page cap returns what was seen. It does not throw
 * the full-history deadline.
 */
export async function boundedHistory({
  repo, api, pageSize = HISTORY_PAGE, maxPages = HISTORY_MAX_PAGES, budgetMs = HISTORY_BUDGET_MS, now = () => Date.now(),
}) {
  assert.ok(repo === 'ashlrai/phantom' || repo === 'ashlrai/ashlr-hub', 'unreviewed repository');
  assert.ok(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 30, 'page size out of range');
  assert.ok(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 8, 'page cap out of range');
  const deadline = now() + budgetMs;
  const read = async (path) => {
    if (now() >= deadline) throw budgetError();
    return api(path);
  };
  const workflow = await read(`repos/${repo}/actions/workflows/ci.yml`);
  assert.ok(workflow?.path === '.github/workflows/ci.yml' && Number.isSafeInteger(workflow.id), 'canonical CI workflow missing');
  const evidence = [];
  let green = null;
  let capped = false;
  for (let page = 1; page <= maxPages && !green; page += 1) {
    let data;
    try {
      data = await read(`repos/${repo}/actions/workflows/${workflow.id}/runs?event=schedule&branch=master&per_page=${pageSize}&page=${page}`);
    } catch (error) {
      if (error?.code === 'HISTORY_BUDGET') { capped = true; break; }
      throw error;
    }
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    for (const run of runs) {
      if (run?.head_repository?.id !== REPOSITORY_ID || run.path !== '.github/workflows/ci.yml') continue;
      if (!/^[0-9a-f]{40}$/.test(run.head_sha ?? '') || !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) continue;
      let jobs = [];
      try {
        const body = await read(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
        jobs = body?.jobs ?? [];
      } catch (error) {
        if (error?.code === 'HISTORY_BUDGET') { capped = true; break; }
        throw error;
      }
      const kind = classifyFullJobs(run, jobs);
      if (kind === 'ignore') continue;
      const row = { ...run, qualified: kind === 'green' };
      evidence.push(row);
      if (kind === 'green') { green = row; break; }
    }
    if (capped || runs.length < pageSize) break;
  }
  if (!green && evidence.length === 0) capped = true;
  return { latest: evidence[0] ?? null, green, evidence, capped: capped || !green };
}

export function commitPresent(git, sha) {
  assert.match(sha, /^[0-9a-f]{40}$/);
  try {
    git(['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function shallowRepo(git) {
  try { return git(['rev-parse', '--is-shallow-repository']).trim() === 'true'; } catch { return false; }
}

/**
 * The checkout is shallow. Deepen in fixed steps until `sha` is present.
 * Unshallow only after the deepen cap is spent.
 */
export function ensureCommitReachable({ git, sha, deepen = FETCH_DEEPEN, cap = FETCH_DEEPEN_CAP }) {
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.ok(Number.isInteger(deepen) && deepen > 0 && deepen <= 500, 'deepen step out of range');
  assert.ok(Number.isInteger(cap) && cap >= 0 && cap <= 20, 'deepen cap out of range');
  if (commitPresent(git, sha)) return { mode: 'present', deepens: 0, unshallow: false };
  let deepens = 0;
  if (shallowRepo(git)) {
    for (; deepens < cap; deepens += 1) {
      git(['fetch', `--deepen=${deepen}`, 'origin']);
      if (commitPresent(git, sha)) return { mode: 'deepen', deepens: deepens + 1, unshallow: false };
    }
    git(['fetch', '--unshallow', 'origin']);
    if (!commitPresent(git, sha)) throw new Error('commit unavailable after unshallow');
    return { mode: 'unshallow', deepens, unshallow: true };
  }
  git(['fetch', 'origin', sha]);
  if (!commitPresent(git, sha)) throw new Error('commit unavailable');
  return { mode: 'fetch', deepens: 0, unshallow: false };
}

export function gitRunner(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}
