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
const ACTIONS_APP_ID = 15368;

/**
 * Required status-check contexts on master, unioned from the branch ruleset
 * and classic branch protection — the same authority the release train
 * enforces and the merge queue applies. Both are repository configuration,
 * not tip state, so the plan reads them lazily, once, and only when a
 * decisive run's whole-run conclusion needs re-judging.
 */
async function requiredCheckNames(read, base) {
  const [branch, rules] = await Promise.all([
    read(`${base}/branches/master`),
    read(`${base}/rules/branches/master`),
  ]);
  const names = new Set();
  const protection = branch?.protection?.required_status_checks?.contexts;
  const collect = context => {
    if (typeof context === 'string' && context.length > 0 && context.length <= 128 && !context.includes('\n')) names.add(context);
  };
  if (Array.isArray(protection)) for (const context of protection) collect(context);
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      if (rule?.type !== 'required_status_checks') continue;
      const checks = rule?.parameters?.required_status_checks;
      if (!Array.isArray(checks)) continue;
      for (const check of checks) collect(check?.context);
    }
  }
  return [...names];
}

/**
 * Latest Actions check runs on one SHA. Any inventory inconsistency is
 * 'unknown', never green — the same bound the release train's required-CI
 * read applies.
 */
async function checkRunsOnSha(read, base, sha) {
  const runs = [];
  let total = null;
  for (let page = 1; page <= 10; page += 1) {
    const listed = await read(`${base}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100&page=${page}`);
    const batch = listed && Array.isArray(listed.check_runs) ? listed.check_runs : null;
    const pageTotal = listed && Number.isInteger(listed.total_count) ? listed.total_count : null;
    if (!batch || pageTotal === null || pageTotal < 0) return 'unknown';
    if (total === null) total = pageTotal;
    else if (pageTotal !== total) return 'unknown';
    for (const row of batch) {
      const item = row && typeof row === 'object' ? row : {};
      const app = item.app && typeof item.app === 'object' ? item.app : {};
      runs.push({
        name: typeof item.name === 'string' ? item.name : '',
        status: typeof item.status === 'string' ? item.status : '',
        conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
        appId: Number(app.id),
      });
    }
    if (batch.length < 100) break;
  }
  if (total === null || total !== runs.length || runs.length > 1000) return 'unknown';
  return runs;
}

/**
 * Same verdict the release train's judgeRequiredChecks reaches: every
 * required context needs a completed success with no unsettled re-run; a
 * completed non-success and no success is red; anything missing, running
 * or unreadable is pending or unknown — never green.
 */
function judgeRequiredChecks(names, runs) {
  const required = [...new Set(names)];
  if (required.length === 0) return 'unknown';
  let pending = false;
  for (const name of required) {
    const matched = runs.filter(run => run.appId === ACTIONS_APP_ID && run.name === name);
    if (matched.length === 0) { pending = true; continue; }
    let seenSuccess = false, seenIncomplete = false, seenFailure = false;
    for (const run of matched) {
      if (run.status !== 'completed') seenIncomplete = true;
      else if (run.conclusion === 'success') seenSuccess = true;
      else seenFailure = true;
    }
    if (seenIncomplete) pending = true;
    else if (seenSuccess) continue;
    else if (seenFailure) return 'red';
    else pending = true;
  }
  return pending ? 'pending' : 'green';
}

const RELEASE_PR_BRANCH_PREFIX = 'release-please--';
const RELEASE_PR_BRANCH_SCAN_CAP = 10;

/**
 * Open release-please pull requests on this repository. Branch discovery uses
 * the git matching-refs prefix — the same `release-please--*` shape the
 * release train already keys on — then each candidate branch is looked up
 * through the head filter, so the probe reads a handful of small responses
 * instead of paging the fleet's entire open-PR list (hundreds of PRs,
 * megabytes per page) on every cadence wake. An inventory that cannot be
 * fully read proves nothing and returns null rather than asserting — the
 * freeze below is a heuristic, never a reason to fail the cadence job.
 */
async function openReleasePrs(read, base, repository) {
  const refs = await read(`${base}/git/matching-refs/heads/${RELEASE_PR_BRANCH_PREFIX}`);
  if (!Array.isArray(refs)) return null;
  const owner = repository.split('/')[0];
  const branches = [];
  for (const ref of refs) {
    const name = typeof ref?.ref === 'string' && ref.ref.startsWith(`refs/heads/${RELEASE_PR_BRANCH_PREFIX}`)
      ? ref.ref.slice('refs/heads/'.length) : null;
    if (name !== null && !branches.includes(name)) branches.push(name);
    if (branches.length > RELEASE_PR_BRANCH_SCAN_CAP) return null;
  }
  const found = [];
  for (const branch of branches) {
    const pulls = await read(`${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`);
    if (!Array.isArray(pulls) || pulls.length === 100) return null;
    for (const pr of pulls) {
      const head = pr?.head;
      if (head?.repo?.full_name !== repository || head?.ref !== branch) continue;
      if (pr?.base?.ref !== 'master') continue;
      if (typeof pr?.title !== 'string' || !/^chore\([^)]+\): release \d+\.\d+\.\d+/.test(pr.title)) continue;
      if (!SHA.test(head?.sha ?? '') || !Number.isSafeInteger(pr?.number) || pr.number <= 0) continue;
      found.push({ number: pr.number, sha: head.sha });
    }
  }
  return found;
}

/**
 * Whether an open release PR's head is still owned by verification. Every
 * release-please update force-pushes the branch and restarts its required
 * checks on a new SHA; while merges land faster than CI finishes, the head
 * never survives long enough for checks to complete and the release starves
 * (observed: one release PR force-pushed 34 times in 3.5 hours). Freezing
 * updates — never the merge — lets the PR's own required checks reach a
 * verdict on a stable head; the release train still enqueues the green head
 * independently, so this gates release-please updates only.
 *
 * Only positive evidence freezes: a decisively red verdict, an unreadable
 * check inventory, a conflicting PR (whose needed heal is the rebase update
 * itself), or a head whose required contexts have not all reported yet all
 * leave updates allowed — a context that never reports must not wedge the
 * freeze, and a head whose CI never triggered still needs its push.
 */
async function releasePrChecksInFlight(read, base, repository, requiredNames) {
  let prs = null;
  try {
    prs = await openReleasePrs(read, base, repository);
  } catch (error) {
    if (error instanceof MetadataRateLimitError || error instanceof MetadataTransientError) throw error;
    return false;
  }
  if (!prs || prs.length === 0) return false;
  const verdicts = await Promise.all(prs.map(async ({ number, sha }) => {
    try {
      const detail = await read(`${base}/pulls/${number}`);
      if (detail?.number !== number || detail?.mergeable === false || detail?.base?.ref !== 'master') return false;
      const headSha = SHA.test(detail?.head?.sha ?? '') ? detail.head.sha : sha;
      const [names, runs] = await Promise.all([requiredNames(), checkRunsOnSha(read, base, headSha)]);
      if (runs === 'unknown') return false;
      const verdict = judgeRequiredChecks(names, runs);
      if (verdict === 'green') return true;
      // Pending freezes only once every required context has a check-run row
      // on this head: all of CI has reported and is still settling. A missing
      // context means its checks may never have triggered — allow the update
      // that can start them.
      return verdict === 'pending'
        && names.every(name => runs.some(run => run.appId === ACTIONS_APP_ID && run.name === name));
    } catch (error) {
      if (error instanceof MetadataRateLimitError || error instanceof MetadataTransientError) throw error;
      return false;
    }
  }));
  return verdicts.some(Boolean);
}

/**
 * How many times the plan re-evaluates when its observed snapshot is
 * invalidated mid-check — a version bump, a non-fast-forward move, or a
 * tip that keeps changing past the moved-window bound. Ordinary
 * merge-burst movement is absorbed by the moved-tip verification inside a
 * pass, so the bound caps genuinely unstable reads rather than safety, and
 * exhausting it simply waits for the next scheduled wake.
 */
export const CADENCE_MAX_ATTEMPTS = 3;

/**
 * One evaluation pass pinned to a single observed master tip. Returns the
 * plan, or null when the closing re-read shows the snapshot no longer
 * describes live master — the caller then re-runs the whole pass at the
 * live tip instead of demanding the world stand still for the check.
 */
async function planAtLiveTip({ base, repository, minutes, now, read, requiredNames }) {
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
  if (tagSha === tip) {
    // The tagged commit being the tip means no new work landed yet — unless
    // master moved during this pass, in which case the live tip may already
    // carry commits the tag does not and the caller re-evaluates there.
    const live = (await read(`${base}/branches/master`)).commit?.sha;
    return live === tip ? { due: false, reason: 'no-new-commits' } : null;
  }
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
  if (!latest) return { due: false, reason: 'push-ci-not-green' };
  // A completed run can conclude failure on an advisory job while every
  // required check — the merge queue's actual authority — stayed green
  // (authority-drift is deliberately off Merge Gate needs). Re-judge the
  // required contexts on the run's SHA instead of trusting the whole-run
  // conclusion; all-green runs keep the cheap path with no extra reads.
  if (latest.conclusion !== 'success') {
    const [names, runsOnSha] = await Promise.all([
      requiredNames(),
      checkRunsOnSha(read, base, latest.head_sha),
    ]);
    const verdict = runsOnSha === 'unknown' ? 'unknown' : judgeRequiredChecks(names, runsOnSha);
    if (verdict !== 'green') return { due: false, reason: 'push-ci-not-green' };
  }
  let evidenceAhead = 0;
  if (latest.head_sha !== tip) {
    const green = await read(`${base}/compare/${latest.head_sha}...${tip}`);
    if (green.status !== 'ahead' || !Number.isSafeInteger(green.ahead_by)
      || green.ahead_by < 1 || green.ahead_by > GREEN_EVIDENCE_MAX_AHEAD) {
      return { due: false, reason: 'push-ci-stale' };
    }
    evidenceAhead = green.ahead_by;
  }
  // Re-read before opening a PR. A moved tip does not by itself invalidate
  // the pass: every input was pinned to `tip`, and master only fast-forwards
  // through the merge queue, so the evaluated tip remaining a bounded
  // ancestor of the live tip keeps the same green-evidence window. The
  // version carriers are re-read at the live tip — a release merge landing
  // mid-check changes them and forces a fresh pass at the new tip — and the
  // evidence distance grows by exactly the moved window, never past the
  // bound. Only a snapshot that genuinely changed hands back to the caller.
  const live = (await read(`${base}/branches/master`)).commit?.sha;
  if (live === tip) {
    return { due: true, reason: 'green-master-cadence-due', version, revision: tip, ciRunId: latest.id, ciRunAttempt: latest.run_attempt };
  }
  if (!SHA.test(live ?? '')) return null;
  const move = await read(`${base}/compare/${tip}...${live}`);
  const movedOk = move?.status === 'ahead' && Number.isSafeInteger(move.ahead_by)
    && move.ahead_by >= 1 && move.ahead_by <= GREEN_EVIDENCE_MAX_AHEAD;
  if (!movedOk) return null;
  if (evidenceAhead + move.ahead_by > GREEN_EVIDENCE_MAX_AHEAD) {
    return { due: false, reason: 'push-ci-stale' };
  }
  const [pkgLiveResponse, manifestLiveResponse] = await Promise.all([
    read(`${base}/contents/package.json?ref=${live}`),
    read(`${base}/contents/.release-please-manifest.json?ref=${live}`),
  ]);
  const pkgLive = content(pkgLiveResponse);
  const manifestLive = content(manifestLiveResponse);
  if (pkgLive?.name !== '@ashlr/phantom' || pkgLive.version !== pkg.version) return null;
  assert.equal(manifestLive?.['.'], pkgLive.version, 'source and release-please manifest differ');
  return { due: true, reason: 'green-master-cadence-due', version, revision: live, ciRunId: latest.id, ciRunAttempt: latest.run_attempt };
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
  // Ordinary movement is absorbed inside a pass; only a snapshot that keeps
  // invalidating past the attempt bound still refuses.
  let requiredNamesPromise = null;
  const requiredNames = () => (requiredNamesPromise ??= requiredCheckNames(read, base));
  // An open release PR whose required checks are still running — or already
  // green and awaiting the train's enqueue — must keep a stable head: every
  // due run makes release-please force-push the branch and restart CI on a
  // new SHA, so during merge bursts the head never survives long enough for
  // checks to finish and every release starves. Hold updates until the
  // head's required verdict is decisively red; this gates release-please
  // updates only — the train's own enqueue path is unaffected.
  if (await releasePrChecksInFlight(read, base, repository, requiredNames)) {
    return { due: false, reason: 'release-pr-checks-in-flight' };
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const plan = await planAtLiveTip({ base, repository, minutes, now, read, requiredNames });
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
    // An exhausted budget is an availability signal, not a malformed read:
    // defer cleanly so a slow merge burst cannot fail the whole job.
    if (ms <= 0) throw new MetadataTransientError(`release metadata read deadline exhausted${firstTransient ? `; first transient ${firstTransient}` : ''}`);
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
        if (remaining() <= delay) throw new MetadataTransientError(`release metadata read deadline exhausted; first transient ${firstTransient}`);
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
