// Scheduled master qualification. Only canonical CI run/job metadata is trusted;
// missing, red, cancelled, pending or superseded full evidence refuses a tag.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requireProducerEnvironment } from './github-repository-binding.mjs';

export const FULL_CRON = '17 */6 * * *';
export const FULL_CHECK = 'Master full qualification';
export const FULL_REQUIRED = Object.freeze([
  'secret-shape', 'secret-scan', 'classify', 'ci', 'ci-shared-macos',
  'mac-general', 'mac-isolated', 'native-macos-broker-foundation',
  'windows-service-authority', 'merge-gate',
]);
export const FULL_SKIPPED = Object.freeze(['quick', 'clean-tree', 'authority-drift', 'fast-gate', 'site', 'docs', 'release-build']);
// Full evidence sources: the six-hour schedule, and a manual full dispatch of
// the canonical CI workflow on master (the workflow header documents dispatch as
// a full run). A dispatched full has no receipt job, so it qualifies only when
// the run is green, the full matrix and a Mac exhaustive slice ran, and every
// job is success or skipped.
export const FULL_EVENTS = Object.freeze(['schedule', 'workflow_dispatch']);
const MAC_PREFIX = 'Mac exhaustive (';
const CLASSIFY_JOB = 'Classify PR site lane';
const RELEASE_JOB = 'Desktop release smoke';
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

// Read-only API calls with the existing job token. Do not surface gh stderr:
// admission errors need no API bodies, credential diagnostics or job logs.
export function githubRead(path) {
  assert.match(path, /^repos\/ashlrai\/(?:phantom|ashlr-hub)\/actions\/[A-Za-z0-9_./?=&%-]+$/);
  try {
    return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', path], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('CI metadata unavailable; refusing unverified full evidence'); }
}

// Ancestor read for tag admission: exact compare path only, read-only token.
export function githubIsAncestor(repo, base, head) {
  assert.ok(repo === 'ashlrai/phantom' && sha(base) && sha(head), 'unreviewed compare');
  let data;
  try {
    data = JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', `repos/${repo}/compare/${base}...${head}`], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch { throw new Error('compare unavailable; refusing unverified ancestry'); }
  return data?.status === 'identical' || data?.status === 'ahead';
}
const refuseAncestor = async () => false;

function dispatchedFullGreen(run, jobs) {
  const ran = jobs.filter(job => job.conclusion !== 'skipped');
  return run.status === 'completed' && run.conclusion === 'success' &&
    ran.some(job => job.name?.startsWith('CI (Node 22,')) && ran.some(job => job.name?.startsWith(MAC_PREFIX)) &&
    jobs.every(job => job.status === 'completed' && (job.conclusion === 'success' || job.conclusion === 'skipped'));
}

export function fullFailures(needs) {
  assert.ok(needs && typeof needs === 'object' && !Array.isArray(needs), 'missing full dependency inventory');
  const expected = [...FULL_REQUIRED, ...FULL_SKIPPED];
  assert.deepEqual(Object.keys(needs).sort(), expected.sort(), 'full dependency inventory differs');
  const failures = FULL_REQUIRED.filter(id => needs[id]?.result !== 'success');
  failures.push(...FULL_SKIPPED.filter(id => needs[id]?.result !== 'skipped'));
  if (needs.classify?.outputs?.lane !== 'full' || needs.classify?.outputs?.release_gate !== 'false') failures.push('classify');
  return [...new Set(failures)];
}

// Bounded history is intentional. An empty, truncated or unavailable history
// never grants authority. Half-hour release preparation is not full evidence.
// Inspect latest attempts, including red attempts, rather than filtering green.
export async function fullHistory({ repo, api = githubRead, excludeRun = 0, latestOnly = false }) {
  assert.ok(['ashlrai/phantom', 'ashlrai/ashlr-hub'].includes(repo), 'unreviewed repository');
  const prefix = `repos/${repo}/actions`;
  const workflow = await api(`${prefix}/workflows/ci.yml`);
  assert.ok(positive(workflow.id) && workflow.path === '.github/workflows/ci.yml', 'canonical CI workflow missing');
  const evidence = [];
  const deadline = Date.now() + 60_000;
  const read = path => {
    assert.ok(Date.now() < deadline, 'full history deadline exceeded');
    return api(path);
  };
  // One page of each full source, newest first by run id across sources.
  const runs = new Map();
  for (const event of FULL_EVENTS) {
    const data = await read(`${prefix}/workflows/${workflow.id}/runs?event=${event}&branch=master&per_page=100&page=1`);
    assert.ok(Array.isArray(data.workflow_runs), 'missing scheduled CI history');
    for (const run of data.workflow_runs) {
      assert.ok(positive(run.id) && positive(run.run_attempt) && sha(run.head_sha) &&
        run.event === event && run.head_branch === 'master' && run.workflow_id === workflow.id &&
        run.path === workflow.path && run.head_repository?.id === 1263526319, 'scheduled CI identity differs');
      runs.set(run.id, run);
    }
  }
  {
    for (const run of [...runs.values()].sort((a, b) => b.id - a.id)) {
      // A rerun must not call a newer scheduled run its previous green.
      if (excludeRun && run.id >= excludeRun) continue;
      const jobs = await read(`${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      assert.ok(Array.isArray(jobs.jobs) && jobs.jobs.length === jobs.total_count, 'incomplete CI job inventory');
      const checks = jobs.jobs.filter(job => job.name === FULL_CHECK);
      assert.ok(checks.length <= 1, 'duplicate full qualification checks');
      const check = checks[0];
      const matrixRan = jobs.jobs.some(job => job.name?.startsWith('CI (Node 22,') && job.conclusion !== 'skipped');
      // A half-hour release-prep run is never full evidence, even while it is
      // still running: once classify succeeded, only that lane schedules the
      // release smoke job (a full run reports it skipped). Without this an
      // in-flight release-prep run masked the last full and blocked every tag.
      const classified = jobs.jobs.some(job => job.name === CLASSIFY_JOB && job.conclusion === 'success');
      if (classified && jobs.jobs.some(job => job.name === RELEASE_JOB && job.conclusion !== 'skipped')) continue;
      // A still-starting run could be the next full attempt. Never fall back to
      // older green evidence while its shape or result remains unknown.
      if (check?.conclusion === 'skipped' && !matrixRan && run.status === 'completed') continue;
      if (!check && !matrixRan && run.status === 'completed') continue;
      // A dispatch that never started the full matrix (for example the release
      // gate input) is not a full attempt.
      if (run.event === 'workflow_dispatch' && !matrixRan && run.status === 'completed') continue;
      evidence.push({ ...run, qualified: run.event === 'workflow_dispatch' ? dispatchedFullGreen(run, jobs.jobs) :
        run.status === 'completed' && run.conclusion === 'success' && check?.status === 'completed' && check.conclusion === 'success' });
      if (latestOnly || evidence.at(-1).qualified) return evidence;
    }
  }
  return evidence.sort((a, b) => b.id - a.id);
}

// The latest full attempt must be green. It may be on the candidate itself or
// on an ancestor of it; the candidate's own required fast checks are enforced
// by the Auto-tag checks step before this runs. A red or pending latest full
// still refuses, so a newer failure is never hidden by an older green.
export async function requireFullGreen({ repo, candidate, api = githubRead, isAncestor = api === githubRead ? githubIsAncestor : refuseAncestor }) {
  assert.ok(sha(candidate), 'candidate must be an exact SHA');
  const latest = (await fullHistory({ repo, api, latestOnly: true }))[0];
  assert.ok(latest?.qualified, 'latest scheduled full is missing, red or pending; refusing to tag');
  if (latest.head_sha === candidate) return latest;
  assert.ok(await isAncestor(repo, latest.head_sha, candidate), 'candidate has no current scheduled full qualification; refusing to tag');
  return latest;
}

export async function recordFull({ env, needs, api = githubRead }) {
  assert.ok(env.GITHUB_EVENT_NAME === 'schedule' && env.FULL_SCHEDULE === FULL_CRON &&
    env.GITHUB_REF === 'refs/heads/master' && sha(env.GITHUB_SHA), 'not a six-hour master full run');
  const failures = fullFailures(needs);
  let previous = null;
  let history = 'not-needed';
  if (failures.length) {
    try {
      previous = (await fullHistory({ repo: env.GITHUB_REPOSITORY, api, excludeRun: Number(env.GITHUB_RUN_ID) }))
        .find(run => run.qualified) ?? null;
      history = previous ? 'available' : 'no-prior-green';
    } catch { history = 'unavailable'; }
  }
  const receipt = { schemaVersion: 1, sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID,
    run_attempt: env.GITHUB_RUN_ATTEMPT, green: failures.length === 0, failures,
    previous_green_sha: previous?.head_sha ?? null, history };
  // The previous green bounds the first failing interval; it does not claim
  // which untested intermediate commit introduced the failure.
  const summary = receipt.green ? `full-green-sha=${receipt.sha}` :
    `full-red-sha=${receipt.sha} failing-jobs=${failures.join(',')} first-failing-range=${previous?.head_sha ?? 'unknown'}..${receipt.sha} history=${history}`;
  return { receipt, summary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    requireProducerEnvironment(process.env);
    if (process.argv[2] === 'require') {
      try {
        const run = await requireFullGreen({ repo: process.env.GITHUB_REPOSITORY, candidate: process.env.SHA });
        appendFileSync(process.env.GITHUB_OUTPUT, 'green=true\n');
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `full-green-sha=${run.head_sha} full-run=${run.id} full-attempt=${run.run_attempt}\n`);
      } catch (error) {
        // A fresh master push never has its own scheduled full yet. Hold quietly
        // (no tag, no red run); the scheduled-full workflow_run re-evaluates.
        if (process.env.TRIGGER !== 'push') throw error;
        process.stderr.write(`::notice::${error.message}\n`);
        appendFileSync(process.env.GITHUB_OUTPUT, 'green=false\n');
      }
    } else if (process.argv[2] === 'record') {
      const { receipt, summary } = await recordFull({ env: process.env, needs: JSON.parse(process.env.FULL_NEEDS) });
      writeFileSync('master-full.json', `${JSON.stringify(receipt, null, 2)}\n`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
      if (!receipt.green) process.exitCode = 1;
    } else throw new Error('Usage: ci-master-full.mjs record|require');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
