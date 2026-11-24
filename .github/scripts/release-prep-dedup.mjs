// Release prep: start one release-gate CI run per master sha.
// Desktop release smoke and Release suites live in ci.yml and run only when
// release_gate is set. A master push does not set it, and the half-hour
// schedule rarely fires, so Auto-tag waits. This decides whether to dispatch
// ci.yml with release_gate=true. It reads check runs and workflow runs for
// one exact sha. It does not sign, publish, or create tags.
// A sha whose package.json version is already tagged AND published owes no
// release-gate run — Auto-tag's own nothing-to-do proof — so the decide job
// skips the dispatch instead of spending a macOS smoke per merge.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ACTIONS_APP_ID = 15368;
export const SMOKE = 'Desktop release smoke';
export const SUITES = 'Release suites (build + signing path)';
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
// A release-gate dispatch pins the master sha that was tip at dispatch time.
// The release-gate concurrency group is serial and never cancels, so during a
// merge burst per-sha dedup alone queues one stale-sha run per merge for the
// whole owed-version window. Any unfinished workflow_dispatch on master —
// release prep's event; Auto-tag dispatches on tag refs and manual dispatches
// are rare — already covers the owed version: its sha is tagged through
// Auto-tag's exact-SHA dispatch when the run completes. The age bound keeps a
// zombie queued run from gating every later dispatch forever; it sits above
// the longest honest queue-plus-run window (a 90-minute job ceiling behind one
// serial predecessor).
export const RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS = 3 * 60 * 60_000;

export function releasePrepDecision({ checks, runs, dispatchRuns = [], now = Date.now() }) {
  assert.ok(Array.isArray(checks) && Array.isArray(runs), 'missing release prep inventory');
  const named = (name) => checks.filter((row) => row?.name === name && row?.appId === ACTIONS_APP_ID);
  const success = (rows) => rows.some((row) => row.status === 'completed' && row.conclusion === 'success');
  const active = (rows) => rows.some((row) => row.status !== 'completed');
  const smoke = named(SMOKE);
  const suites = named(SUITES);
  if (success(smoke) && success(suites)) return { dispatch: false, reason: 'already-green' };
  if (active(smoke) || active(suites)) return { dispatch: false, reason: 'checks-in-progress' };
  const inflight = runs.filter((row) => row?.path === '.github/workflows/ci.yml'
    && (row.event === 'workflow_dispatch' || row.event === 'schedule')
    && row.status !== 'completed');
  if (inflight.length > 0) return { dispatch: false, reason: 'release-run-in-flight' };
  const outstanding = dispatchRuns.filter((row) => {
    if (row?.path !== '.github/workflows/ci.yml' || row.event !== 'workflow_dispatch' || row.status === 'completed') return false;
    const age = now - row.createdAt;
    return Number.isFinite(row.createdAt) && age >= -60_000 && age <= RELEASE_RUN_IN_FLIGHT_MAX_AGE_MS;
  });
  if (outstanding.length > 0) return { dispatch: false, reason: 'release-run-in-flight' };
  return { dispatch: true, reason: 'needed' };
}

export function rateLimitDelay(status, headers, body, attempt, now = Date.now()) {
  if (status !== 429 && !(status === 403 && (/rate limit/i.test(body) || headers['x-ratelimit-remaining'] === '0' || headers['retry-after']))) return null;
  const retry = headers['retry-after'];
  const retryMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - now)) : 0;
  const reset = Number(headers['x-ratelimit-reset']);
  const resetMs = headers['x-ratelimit-remaining'] === '0' && Number.isFinite(reset) ? Math.max(0, reset * 1000 - now + 1000) : 0;
  return Math.max(1000 * 2 ** (attempt - 1), Number.isFinite(retryMs) ? retryMs : 0, resetMs);
}

// One shared budget covers all inventory requests in this invocation.
let waited = 0;
export function githubJson(path, invoke = execFileSync, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)) {
  assert.match(path, /^repos\/ashlrai\/phantom\/(?:commits\/[a-f0-9]{40}\/check-runs\?|actions\/workflows\/ci\.yml\/runs\?|commits\/master$|contents\/package\.json\?ref=[a-f0-9]{40}$|git\/ref\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$|releases\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$)/);
  for (let attempt = 1; attempt <= 4; attempt++) {
    let response;
    try {
      response = invoke('gh', ['api', '--include', '--hostname', 'github.com', path], {
        encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      response = String(error.stdout ?? '');
      if (!response.startsWith('HTTP/')) throw new Error('GitHub API request failed');
    }
    const separator = response.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
    const split = response.indexOf(separator);
    assert.ok(split >= 0, 'invalid GitHub API response');
    const lines = response.slice(0, split).split(/\r?\n/);
    const status = Number(lines[0].match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
    const headers = Object.fromEntries(lines.slice(1).map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const body = response.slice(split + separator.length);
    if (status >= 200 && status < 300) return JSON.parse(body);
    // Transient server errors (500/502/503/504) are retried with backoff; the
    // daily run otherwise fails on a single GitHub blip.
    const transient = status === 500 || status === 502 || status === 503 || status === 504;
    const delay = transient ? 1000 * 2 ** (attempt - 1) : rateLimitDelay(status, headers, body, attempt);
    if (delay === null || (transient && (attempt === 4 || waited + delay >= 180_000))) throw new Error(`GitHub API request failed (HTTP ${status})`);
    if (attempt === 4 || waited + delay >= 180_000) throw new Error(`GitHub API rate limit persisted after ${attempt} attempt(s); retry budget exhausted`);
    waited += delay;
    sleep(delay);
  }

}

// A tolerant read for existence checks: HTTP 404 means absent, any other
// failure means unknown — both leave the sha a candidate, so release prep
// keeps dispatching exactly as before whenever evidence is incomplete.
function readOrNull(read, path) {
  try {
    return read(path);
  } catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return null;
    return undefined;
  }
}

// True only when the version package.json carries at this sha is already
// released: tag v<version> exists AND releases/tags/v<version> answers with a
// published release (that endpoint 404s drafts, the same proof auto-tag's
// nothing-to-do step uses). A tag without a published release — draft pending
// or release leg still owed — stays a candidate so Auto-tag's heal path keeps
// its per-sha release-gate evidence.
export function masterReleaseSettled(repo, sha, read = githubJson) {
  assert.equal(repo, 'ashlrai/phantom');
  assert.match(sha, SHA);
  let pkg;
  try {
    pkg = read(`repos/${repo}/contents/package.json?ref=${sha}`);
  } catch {
    return false;
  }
  let version;
  try {
    const content = pkg !== null && typeof pkg === 'object' ? pkg.content : null;
    if (pkg?.encoding !== 'base64' || typeof content !== 'string') return false;
    version = JSON.parse(Buffer.from(content, 'base64').toString('utf8'))?.version;
  } catch {
    return false;
  }
  if (typeof version !== 'string' || !VERSION.test(version)) return false;
  const tag = `v${version}`;
  const ref = readOrNull(read, `repos/${repo}/git/ref/tags/${tag}`);
  if (ref === null || ref === undefined) return false;
  const release = readOrNull(read, `repos/${repo}/releases/tags/${tag}`);
  return release !== null && release !== undefined;
}

export function readReleasePrep(repo, sha, read = githubJson, now = Date.now()) {
  assert.equal(repo, 'ashlrai/phantom');
  assert.match(sha, SHA);
  const checks = read(`repos/${repo}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100`);
  assert.ok(Array.isArray(checks.check_runs), 'missing check runs');
  const runs = read(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`);
  assert.ok(Array.isArray(runs.workflow_runs), 'missing workflow runs');
  // Master-wide dispatch inventory for cross-sha coalescing: a release-gate
  // run outstanding on any recent master sha already covers the owed version.
  const dispatches = read(`repos/${repo}/actions/workflows/ci.yml/runs?event=workflow_dispatch&branch=master&per_page=50`);
  assert.ok(Array.isArray(dispatches.workflow_runs), 'missing dispatch inventory');
  return releasePrepDecision({
    checks: checks.check_runs.map((row) => ({
      name: row.name, status: row.status, conclusion: row.conclusion ?? null, appId: row.app?.id,
    })),
    runs: runs.workflow_runs.map((row) => ({
      path: row.path, event: row.event, status: row.status,
    })),
    dispatchRuns: dispatches.workflow_runs.map((row) => ({
      path: row.path, event: row.event, status: row.status, createdAt: Date.parse(row.created_at),
    })),
    now,
  });
}

export function releasePrepPlan(repo, sha, read = githubJson, now = Date.now()) {
  if (masterReleaseSettled(repo, sha, read)) return { dispatch: false, reason: 'release-settled' };
  return readReleasePrep(repo, sha, read, now);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.REPO, 'ashlrai/phantom');
    const sha = githubJson(`repos/${process.env.REPO}/commits/master`).sha;
    assert.match(sha ?? '', SHA);
    const decision = releasePrepPlan(process.env.REPO, sha);
    appendFileSync(process.env.GITHUB_OUTPUT, `dispatch=${decision.dispatch}\n`);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
