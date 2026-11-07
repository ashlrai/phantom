/* global process, console, fetch, Buffer, AbortSignal, performance, setTimeout */
// Read-only scheduling policy. Release-please owns version PRs; auto-tag owns
// tags. In particular, elapsed time is never permission to bypass green CI.
import assert from 'node:assert/strict';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireRepositoryMetadata, requireRepositoryReference } from './github-repository-binding.mjs';

const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

export async function planReleaseCadence({ repository, revision, minutes = 30, now = Date.now(), read }) {
  assert.match(revision ?? '', SHA);
  assert.ok(Number.isFinite(now));
  cadenceMinutes(String(minutes));
  const base = `repos/${repository}`;
  requireRepositoryMetadata(repository, await read(base));
  const branch = await read(`${base}/branches/master`);
  if (branch.commit?.sha !== revision) return { due: false, reason: 'master-moved' };
  const content = async path => {
    const response = await read(`${base}/contents/${path}?ref=${revision}`);
    assert.equal(response.encoding, 'base64');
    return JSON.parse(Buffer.from(response.content, 'base64').toString('utf8'));
  };
  const pkg = await content('package.json');
  assert.equal(pkg.name, '@ashlr/phantom');
  const version = nextPatch(pkg.version);
  const manifest = await content('.release-please-manifest.json');
  assert.equal(manifest['.'], pkg.version, 'source and release-please manifest differ');
  // A merged bump owes its own tag first. Never create endless version-only
  // successors while the previous candidate is still awaiting its first tag.
  const tag = await read(`${base}/git/ref/tags/v${pkg.version}`);
  if (tag === null) return { due: false, reason: 'current-version-awaits-tag' };
  assert.equal(tag.ref, `refs/tags/v${pkg.version}`);
  assert.equal(tag.object?.type, 'commit');
  assert.match(tag.object.sha ?? '', SHA);
  if (tag.object.sha === revision) return { due: false, reason: 'no-new-commits' };
  const compare = await read(`${base}/compare/${tag.object.sha}...${revision}`);
  assert.equal(compare.status, 'ahead', 'current version tag is not an ancestor of master');
  assert.ok(Number.isSafeInteger(compare.ahead_by) && compare.ahead_by > 0);
  const tagged = await read(`${base}/commits/${tag.object.sha}`);
  const taggedAt = Date.parse(tagged.commit?.committer?.date);
  assert.ok(Number.isFinite(taggedAt) && taggedAt <= now, 'invalid tagged commit timestamp');
  if (now - taggedAt < minutes * 60_000) return { due: false, reason: 'cadence-not-due' };
  // Latest matching run wins: a failed or incomplete replacement is not masked
  // by an older green attempt. The API is scoped by event, branch AND SHA.
  const response = await read(`${base}/actions/workflows/ci.yml/runs?event=push&branch=master&head_sha=${revision}&per_page=100`);
  assert.ok(Array.isArray(response.workflow_runs) && Number.isSafeInteger(response.total_count) && response.total_count <= 100, 'incomplete push CI inventory');
  assert.equal(response.workflow_runs.length, response.total_count);
  const runs = response.workflow_runs;
  assert.equal(new Set(runs.map(run => run.id)).size, runs.length, 'duplicate CI run identity');
  for (const run of runs) {
    requireRepositoryReference(repository, run.repository);
    assert.equal(run.path, '.github/workflows/ci.yml');
    assert.equal(run.head_sha, revision); assert.equal(run.head_branch, 'master'); assert.equal(run.event, 'push');
    assert.ok(Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  }
  const latest = [...runs].sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)[0];
  if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') return { due: false, reason: 'push-ci-not-green' };
  // Re-read before opening a PR: this SHA must still be the default-branch tip.
  if ((await read(`${base}/branches/master`)).commit?.sha !== revision) return { due: false, reason: 'master-moved' };
  return { due: true, reason: 'green-master-cadence-due', version, revision, ciRunId: latest.id, ciRunAttempt: latest.run_attempt };
}

class MetadataRateLimitError extends Error {}

export async function planReleaseCadenceWhenAvailable(input) {
  try {
    return await planReleaseCadence(input);
  } catch (error) {
    if (error instanceof MetadataRateLimitError) return { due: false, reason: 'metadata-rate-limited' };
    throw error;
  }
}

// Public reads deliberately carry no credential. The existing release-please
// job has no Actions permission; adding a scheduling read must not widen it.
export function createPublicMetadataReader({ fetchImpl = fetch, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), report = message => console.warn(message),
  timeoutSignal = ms => AbortSignal.timeout(ms) } = {}) {
  // One small budget covers the whole plan, not a renewed budget per endpoint.
  // Only timeouts and gateway/service failures retry; JSON, identity and permission failures
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
        if ([502, 503, 504].includes(response.status)) {
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
        assert.ok(attempt < 3, `release metadata unavailable (${transient}) after ${attempt} read attempts; first transient ${firstTransient}`);
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
    const plan = await planReleaseCadenceWhenAvailable({ repository: process.env.GITHUB_REPOSITORY, revision: process.env.GITHUB_SHA,
      minutes: cadenceMinutes(process.env.RELEASE_CADENCE_MINUTES || '30'), read: createPublicMetadataReader() });
    assert.ok(process.env.GITHUB_OUTPUT);
    appendFileSync(process.env.GITHUB_OUTPUT, `due=${plan.due}\nversion=${plan.version ?? ''}\n`);
    console.log(JSON.stringify(plan));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
