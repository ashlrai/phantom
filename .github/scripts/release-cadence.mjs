/* global process, console, fetch, Buffer, AbortSignal, performance, setTimeout */
// Read-only scheduling policy. Release-please owns version PRs; auto-tag owns
// tags. In particular, elapsed time is never permission to bypass green CI.
import assert from 'node:assert/strict';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Follow an annotated tag to its commit. A lightweight tag is already a commit. */
export async function peeledCommit(read, base, object) {
  let current = object;
  const seen = new Set();
  for (let depth = 0; current?.type === 'tag'; depth += 1) {
    assert.ok(depth < 4 && SHA.test(current.sha) && !seen.has(current.sha), 'invalid tag annotation');
    seen.add(current.sha);
    const tag = await read(`${base}/git/tags/${current.sha}`);
    assert.equal(tag?.sha, current.sha, 'tag annotation sha mismatches');
    current = tag.object;
  }
  assert.equal(current?.type, 'commit', 'release tag does not peel to a commit');
  assert.match(current.sha ?? '', SHA);
  return current.sha;
}
export function nextPatch(version) {
  assert.match(version ?? '', VERSION, 'invalid source version');
  const parts = version.split('.').map(Number);
  assert.ok(parts.every(Number.isSafeInteger) && parts[2] < Number.MAX_SAFE_INTEGER, 'version overflow');
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}
export function cadenceMinutes(raw = '30') {
  assert.match(raw, /^[1-9]\d*$/, 'invalid release cadence');
  const minutes = Number(raw);
  assert.ok(Number.isSafeInteger(minutes) && minutes >= 5 && minutes <= 1440, 'release cadence must be 5..1440 minutes');
  return minutes;
}

/**
 * How far behind the live tip the newest decisive green push run may sit.
 * Every master commit lands through the merge queue's required Merge Gate,
 * so a bounded run of queue-verified commits on top of a green fast-gate
 * verdict is not known-red master. The release PR's own required checks —
 * not this read — remain the merge gate for the exact head that ships.
 */
export const GREEN_EVIDENCE_MAX_AHEAD = 100;
// Completed run conclusions that carry a verdict on the code. Cancelled,
// neutral, skipped, stale and startup/action-required runs carry none and
// must never mask or block the newest real verdict.
const DECISIVE_RED = new Set(['failure', 'timed_out']);
const decisiveVerdict = run => run.status === 'completed'
  && (run.conclusion === 'success' || DECISIVE_RED.has(run.conclusion));

/**
 * How many times the plan re-evaluates when master moves mid-check. Merge
 * bursts make a still tip rare; each pass re-reads every input pinned to
 * one observed tip, so the bound caps read spend rather than safety, and
 * exhausting it simply waits for the next scheduled wake.
 */
export const CADENCE_MAX_ATTEMPTS = 3;

/**
 * One evaluation pass pinned to a single observed master tip. Returns the
 * plan, or null when the closing re-read sees a newer tip — the caller
 * then re-runs the whole pass at the live tip instead of demanding the
 * world stand still for the check.
 */
async function planAtLiveTip({ base, repository, minutes, now, read }) {
  const tip = (await read(`${base}/branches/master`)).commit?.sha;
  assert.match(tip ?? '', SHA);
  const content = response => {
    assert.equal(response.encoding, 'base64');
    return JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'));
  };
  // Independent inputs pinned to the same tip are read together: every
  // concurrent round trip widens the still-tip window a merge can hit, and
  // halving the rounds is what lets the bounded re-verify actually engage
  // during merge bursts. Nothing here is cached across attempts.
  const [pkgResponse, manifestResponse] = await Promise.all([
    read(`${base}/contents/package.json?ref=${tip}`),
    read(`${base}/contents/.release-please-manifest.json?ref=${tip}`),
  ]);
  const pkg = content(pkgResponse);
  assert.equal(pkg.name, '@ashlr/phantom');
  const version = nextPatch(pkg.version);
  const manifest = content(manifestResponse);
  assert.equal(manifest['.'], pkg.version, 'source and release-please manifest differ');
  // A merged bump owes its own tag first. Never create endless version-only
  // successors while the previous candidate is still awaiting its first tag.
  const tag = await read(`${base}/git/ref/tags/v${pkg.version}`);
  if (tag === null) return { due: false, reason: 'current-version-awaits-tag' };
  assert.equal(tag.ref, `refs/tags/v${pkg.version}`);
  const tagSha = await peeledCommit(read, base, tag.object);
  if (tagSha === tip) return { due: false, reason: 'no-new-commits' };
  // The tagged commit's timestamp and the tip distance are independent once
  // the tag sha is known; read them in the same round.
  const [tagged, compare] = await Promise.all([
    read(`${base}/commits/${tagSha}`),
    read(`${base}/compare/${tagSha}...${tip}`),
  ]);
  assert.equal(compare.status, 'ahead', 'current version tag is not an ancestor of master');
  assert.ok(Number.isSafeInteger(compare.ahead_by) && compare.ahead_by > 0);
  const taggedAt = Date.parse(tagged.commit?.committer?.date);
  assert.ok(Number.isFinite(taggedAt) && taggedAt <= now, 'invalid tagged commit timestamp');
  if (now - taggedAt < minutes * 60_000) return { due: false, reason: 'cadence-not-due' };
  // The newest decisive completed push run on master is the latest real CI
  // verdict. Requiring that exact verdict on the exact tip is impossible
  // while merges land faster than CI finishes; the tip or a bounded ancestor
  // is the evidence that master is not known-red.
  const response = await read(`${base}/actions/workflows/ci.yml/runs?event=push&branch=master&status=completed&per_page=100`);
  assert.ok(Array.isArray(response.workflow_runs) && Number.isSafeInteger(response.total_count)
    && response.total_count >= response.workflow_runs.length && response.workflow_runs.length <= 100
    && response.workflow_runs.length === Math.min(response.total_count, 100), 'incomplete push CI inventory');
  const runs = response.workflow_runs;
  assert.equal(new Set(runs.map(run => run.id)).size, runs.length, 'duplicate CI run identity');
  for (const run of runs) {
    requireRepositoryReference(repository, run.repository);
    assert.equal(run.path, '.github/workflows/ci.yml');
    assert.equal(run.head_branch, 'master'); assert.equal(run.event, 'push');
    assert.match(run.head_sha ?? '', SHA);
    assert.ok(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  }
  const latest = runs.filter(decisiveVerdict).sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!latest || latest.conclusion !== 'success') return { due: false, reason: 'push-ci-not-green' };
  if (latest.head_sha !== tip) {
    const green = await read(`${base}/compare/${latest.head_sha}...${tip}`);
    if (green.status !== 'ahead' || !Number.isSafeInteger(green.ahead_by)
      || green.ahead_by < 1 || green.ahead_by > GREEN_EVIDENCE_MAX_AHEAD) {
      return { due: false, reason: 'push-ci-stale' };
    }
  }
  // Re-read before opening a PR: a newer tip means this pass evaluated a
  // moving target, so the caller re-verifies at the live tip rather than
  // demanding the world stand still for the check.
  if ((await read(`${base}/branches/master`)).commit?.sha !== tip) return null;
  return { due: true, reason: 'green-master-cadence-due', version, revision: tip, ciRunId: latest.id, ciRunAttempt: latest.run_attempt };
}

export async function planReleaseCadence({ repository, minutes = 30, now = Date.now(), read, attempts = CADENCE_MAX_ATTEMPTS }) {
  assert.ok(Number.isFinite(now));
  cadenceMinutes(String(minutes));
  assert.ok(Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 10, 'invalid cadence attempt bound');
  const base = `repos/${repository}`;
  requireRepositoryMetadata(repository, await read(base));
  // The plan always evaluates the live master tip, never the SHA a workflow
  // happened to start on: during merge bursts the tip moves before the check
  // finishes, and pinning the decision to a stale SHA starves every release.
  // Movement mid-check re-verifies at the new tip, bounded by attempts; only
  // a tip that keeps moving past the bound still refuses.
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const plan = await planAtLiveTip({ base, repository, minutes, now, read });
    if (plan !== null) return plan;
  }
  return { due: false, reason: 'master-moved' };
}

class MetadataRateLimitError extends Error {}
class MetadataTransientError extends Error {}

export async function planReleaseCadenceWhenAvailable(input) {
  try {
    return await planReleaseCadence(input);
  } catch (error) {
    if (error instanceof MetadataRateLimitError) return { due: false, reason: 'metadata-rate-limited' };
    if (error instanceof MetadataTransientError) return { due: false, reason: 'metadata-unavailable' };
    throw error;
  }
}

// Public reads deliberately carry no credential. The existing release-please
// job has no Actions permission; adding a scheduling read must not widen it.
export function createPublicMetadataReader({ fetchImpl = fetch, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = message => console.warn(message),
  timeoutSignal = ms => AbortSignal.timeout(ms) } = {}) {
  // One small budget covers the whole plan, not a renewed budget per endpoint.
  // Only timeouts and 500/gateway/service failures retry; JSON, identity and permission failures
  // still refuse. This reader never receives credentials or performs writes.
  const deadline = now() + 30_000;
  let firstTransient;
  const remaining = () => {
    const ms = Math.floor(deadline - now());
    assert.ok(ms > 0, `release metadata read deadline exhausted${firstTransient ? `; first transient ${firstTransient}` : ''}`);
    return ms;
  };
  return async endpoint => {
    assert.match(endpoint, /^repos\/ashlrai\/phantom(?:\/|$)/);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const signal = timeoutSignal(Math.min(5_000, remaining()));
      let response, text, transient;
      try {
        response = await fetchImpl(`https://api.github.com/${endpoint}`, {
          method: 'GET', headers: { Accept: 'application/vnd.github+json' }, redirect: 'error', signal,
        });
        if ([500, 502, 503, 504].includes(response.status)) {
          void response.body?.cancel().catch(() => {});
          transient = String(response.status);
        } else if (response.status === 200) {
          text = await response.text();
        }
      } catch (error) {
        if (!signal.aborted || !['TimeoutError', 'AbortError'].includes(error.name)) throw error;
        transient = 'timeout';
      }
      remaining();
      if (transient) {
        if (!firstTransient) {
          firstTransient = `${transient} at ${endpoint}`;
          report(`release metadata transient read failure: ${firstTransient}`);
        }
        if (attempt === 3) {
          const message = `release metadata unavailable (${transient}) after ${attempt} read attempts; first transient ${firstTransient}`;
          report(`${message}; deferring until the next run`);
          throw new MetadataTransientError(message);
        }
        const delay = attempt * 250;
        assert.ok(remaining() > delay, `release metadata read deadline exhausted; first transient ${firstTransient}`);
        await sleep(delay);
        continue;
      }
      if (response.status === 404 && endpoint.includes('/git/ref/tags/')) return null;
      if ([403, 429].includes(response.status) && response.headers?.get('x-ratelimit-remaining') === '0') {
        report(`release metadata rate limited at ${endpoint}; deferring until the next run`);
        throw new MetadataRateLimitError('release metadata rate limited');
      }
      assert.equal(response.status, 200, `release metadata unavailable (${response.status}) at ${endpoint}`);
      assert.ok(text.length <= 4 * 1024 * 1024, 'release metadata too large');
      return JSON.parse(text);
    }
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.GITHUB_REF, 'refs/heads/master');
    const plan = await planReleaseCadenceWhenAvailable({ repository: process.env.GITHUB_REPOSITORY,
      minutes: cadenceMinutes(process.env.RELEASE_CADENCE_MINUTES || '5'), read: createPublicMetadataReader() });
    assert.ok(process.env.GITHUB_OUTPUT);
    appendFileSync(process.env.GITHUB_OUTPUT, `due=${plan.due}\nversion=${plan.version ?? ''}\n`);
    console.log(JSON.stringify(plan));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
