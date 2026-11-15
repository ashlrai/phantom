#!/usr/bin/env node
// Merge drain: refresh every eligible behind PR branch in bounded batches.
//
// Eligibility matches the retired scripts/bridge/update-behind.mjs (now
// `fleet behind-sweep`): open, non-draft, auto-merge already enabled,
// same-repo head on a codex-bridge/* branch targeting master — so the drain
// never grants new merge authority: a green (clean/unstable) eligible PR is
// already inside the existing GitHub merge queue, and each compare-and-swap
// update-branch request lets that same auto-merge grant re-enter the queue
// once checks go green. Conflicts are reported with the same RQ recut
// handoff and are never closed, merged, or force-updated by this pass.
//
//   node scripts/ci/merge-drain.mjs <owner/repo> [--limit N] [--batch N]
//                                   [--concurrency N] [--retries N]
//
// The report is one JSON object on stdout; per-PR outcomes are data, not a
// process failure. Provider error text may carry credentials and is never
// inspected or logged — a failed call is re-decided from a fresh authorized
// observation of PR state.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const backoff = (attempt) => Math.min(250 * 2 ** attempt, 4_000);

// Cheap scope check usable on pull-list rows (which carry no auto_merge or
// mergeable fields): the batch drain pre-filters with this before paying for
// a per-PR read.
function bridgeScope(pr, repo) {
  return pr.state === 'open' && pr.draft === false &&
    pr.base?.repo?.full_name === repo && pr.head?.repo?.full_name === repo &&
    pr.base?.ref === 'master' && /^codex-bridge\/[A-Za-z0-9_-]+$/.test(pr.head?.ref ?? '');
}

function eligible(pr, repo) {
  return bridgeScope(pr, repo) && Boolean(pr.auto_merge);
}

function recut(repo, number, pr) {
  // Key by source head, not moving master: supervisor retries must not fan out
  // duplicate recuts each time another PR merges. No PR text enters the ask.
  const id = createHash('sha256').update(`${repo}:${number}:${pr.head.sha}`).digest('hex');
  return {
    status: 'recut-required', headSha: pr.head.sha,
    ask: {
      schema: 'ask.v1', id: `RQ-RECUT-${id}`, tier: 'work', pool: 'codex-personal',
      priority: 'P0', repos: [repo],
      task: `Recover conflicted bridge PR https://github.com/${repo}/pull/${number} ` +
        `(expected source head ${pr.head.sha}) through the existing RQ recut path. ` +
        'Re-read the source and existing replacements before acting; a changed source head cancels this request. ' +
        'Reuse a pending recut instead of creating another. Recut on current master, preserve the intended change, ' +
        'and run affected tests and required checks. Leave merging to the protected merge queue. ' +
        'Apply CLOSE-STALE C1-C6 before closing anything superseded; if those criteria are unavailable, ' +
        'leave the original open. No admin bypass, force-push to ashlrai branches, or ruleset changes.',
    },
  };
}

const ghCall = async (args) => JSON.parse((await execFileAsync(
  'locus', ['exec', '--', 'gh', ...args],
  { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
)).stdout);

// Structured annotations only: httpStatus/transient are what a caller may set,
// never parsed text. Unannotated failures stay retryable inside the per-PR
// bound — the fresh re-observation, not the error, decides the outcome.
function transient(error) {
  const status = error?.httpStatus;
  if (Number.isInteger(status)) return status === 408 || status === 429 || status >= 500;
  return error?.transient !== false;
}

async function observed(ctx, endpoint) {
  for (let attempt = 0; attempt <= ctx.retries; attempt += 1) {
    if (attempt > 0) await ctx.sleep(backoff(attempt - 1));
    try {
      return await ctx.call(['api', endpoint]);
    } catch (error) {
      if (attempt === ctx.retries || !transient(error)) return null;
    }
  }
  return null;
}

async function drainOne(repo, number, ctx) {
  let putSha = null;
  let putPermanent = false;
  let updateFailed = false;
  for (let attempt = 0; attempt <= ctx.retries; attempt += 1) {
    const pr = await observed(ctx, `repos/${repo}/pulls/${number}`);
    if (pr === null || typeof pr !== 'object') {
      return { number, status: 'failed', reason: 'observe' };
    }
    if (!eligible(pr, repo)) return { number, status: 'skipped' };
    const sha = pr.head?.sha ?? '';
    if (!SHA.test(sha)) return { number, status: 'failed', reason: 'head-sha' };
    // A head that moved after our PUT either means the update applied despite
    // the reported error or that the branch was pushed concurrently; either
    // way the fresh observation is a different revision we did not act on.
    if (putSha !== null && sha !== putSha) return { number, status: 'head-moved', headSha: sha };
    const state = pr.mergeable_state;
    if (pr.mergeable === false && state === 'dirty') {
      return { number, status: 'conflict', headSha: sha, ask: recut(repo, number, pr).ask };
    }
    if (state === 'clean' || state === 'unstable') return { number, status: 'queued', headSha: sha };
    if (state === 'blocked') return { number, status: 'blocked', headSha: sha };
    if (pr.mergeable === true && state === 'behind') {
      if (putPermanent) return { number, status: 'failed', reason: 'update' };
      if (!ctx.takeUpdateSlot()) return { number, status: 'deferred', headSha: sha };
      putSha = sha;
      try {
        await ctx.call(['api', '--method', 'PUT', `repos/${repo}/pulls/${number}/update-branch`,
          '-f', `expected_head_sha=${sha}`]);
        return { number, status: 'update-requested', headSha: sha };
      } catch (error) {
        // Loop back for a fresh observation: it resolves a confirmed conflict,
        // a moved head, or a still-behind retry without reading error text.
        updateFailed = true;
        putPermanent = !transient(error);
      }
    }
    // 'unknown'/computing states and update refusals fall through to a bounded
    // re-observation; pause first so a still-computing mergeable can settle.
    if (attempt < ctx.retries) await ctx.sleep(backoff(attempt));
  }
  return updateFailed
    ? { number, status: 'failed', reason: 'update' }
    : { number, status: 'pending' };
}

// Bounded worker pool: at most `width` candidates hold an in-flight provider
// call at once. Single-threaded, so the shared cursor needs no lock.
async function pool(items, width, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function listOpenPulls(repo, ctx) {
  const rows = [];
  for (let page = 1; rows.length < ctx.limit; page += 1) {
    const batch = await observed(ctx, `repos/${repo}/pulls?state=open&per_page=100&page=${page}`);
    if (batch === null) throw new Error('Unable to list open pull requests');
    if (!Array.isArray(batch)) throw new Error('Unexpected pulls response');
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows.slice(0, ctx.limit);
}

export async function mergeDrain(repo, options = {}) {
  const {
    call = ghCall, limit = 100, batch = 20, concurrency = 4,
    retries = 2, sleep = delay,
  } = options;
  if (!/^ashlrai\/[a-z0-9][a-z0-9-]*$/.test(repo)) {
    throw new Error('Expected an AshlrAI repository');
  }
  for (const [name, value, max] of [
    ['limit', limit, 1000], ['batch', batch, 200],
    ['concurrency', concurrency, 16], ['retries', retries, 8],
  ]) {
    if (!Number.isSafeInteger(value) || value < (name === 'retries' ? 0 : 1) || value > max) {
      throw new Error(`Expected a bounded positive integer for --${name}`);
    }
  }
  if (typeof call !== 'function' || typeof sleep !== 'function') {
    throw new Error('Expected injectable call and sleep functions');
  }
  let updateSlots = batch;
  const ctx = {
    call, limit, retries, sleep,
    // A slot pays for one update-branch request, retries included, so a run
    // never issues more than --batch PUT calls no matter how many PRs drain.
    takeUpdateSlot() {
      if (updateSlots <= 0) return false;
      updateSlots -= 1;
      return true;
    },
  };
  const rows = await listOpenPulls(repo, ctx);
  const prs = [];
  const candidates = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.number) || row.number <= 0) {
      throw new Error('Unexpected pulls response');
    }
    if (bridgeScope(row, repo)) candidates.push(row);
    else prs.push({ number: row.number, status: 'skipped' });
  }
  candidates.sort((a, b) => a.number - b.number);
  prs.push(...await pool(candidates, concurrency, (row) => drainOne(repo, row.number, ctx)));
  prs.sort((a, b) => a.number - b.number);
  const totals = {};
  for (const result of prs) totals[result.status] = (totals[result.status] ?? 0) + 1;
  return { repo, scanned: rows.length, candidates: candidates.length,
    batch, concurrency, retries, totals, prs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [repo, ...rest] = process.argv.slice(2);
    const options = {};
    const flags = { '--limit': 'limit', '--batch': 'batch',
      '--concurrency': 'concurrency', '--retries': 'retries' };
    for (let i = 0; i < rest.length; i += 1) {
      const key = flags[rest[i]];
      if (key === undefined || i + 1 >= rest.length) throw new Error('Expected flag value pairs');
      options[key] = Number(rest[i + 1]);
      i += 1;
    }
    if (repo === undefined) throw new Error('Expected a repository');
    console.log(JSON.stringify(await mergeDrain(repo, options)));
  } catch {
    // Provider errors may contain credential-bearing details; keep them out of logs.
    console.error('Merge drain refused or failed; verify Locus identity and repository state');
    process.exitCode = 1;
  }
}
