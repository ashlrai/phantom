// Release prep: start one release-gate CI run per master sha.
// Desktop release smoke and Release suites live in ci.yml and run only when
// release_gate is set. A master push does not set it, and the half-hour
// schedule rarely fires, so Auto-tag waits. This decides whether to dispatch
// ci.yml with release_gate=true. It reads check runs and workflow runs for
// one exact sha. It does not sign, publish, or create tags.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const ACTIONS_APP_ID = 15368;
export const SMOKE = 'Desktop release smoke';
export const SUITES = 'Release suites (build + signing path)';
const SHA = /^[a-f0-9]{40}$/;

export function releasePrepDecision({ checks, runs }) {
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
  return { dispatch: true, reason: 'needed' };
}

function githubJson(path) {
  assert.match(path, /^repos\/ashlrai\/phantom\/(?:commits\/[a-f0-9]{40}\/check-runs|actions\/workflows\/ci\.yml\/runs)\?/);
  const text = execFileSync('gh', ['api', '--hostname', 'github.com', path], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(text);
}

export function readReleasePrep(repo, sha, read = githubJson) {
  assert.equal(repo, 'ashlrai/phantom');
  assert.match(sha, SHA);
  const checks = read(`repos/${repo}/commits/${sha}/check-runs?filter=latest&app_id=${ACTIONS_APP_ID}&per_page=100`);
  assert.ok(Array.isArray(checks.check_runs), 'missing check runs');
  const runs = read(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`);
  assert.ok(Array.isArray(runs.workflow_runs), 'missing workflow runs');
  return releasePrepDecision({
    checks: checks.check_runs.map((row) => ({
      name: row.name, status: row.status, conclusion: row.conclusion ?? null, appId: row.app?.id,
    })),
    runs: runs.workflow_runs.map((row) => ({
      path: row.path, event: row.event, status: row.status,
    })),
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.REPO, 'ashlrai/phantom');
    assert.match(process.env.SHA ?? '', SHA);
    const decision = readReleasePrep(process.env.REPO, process.env.SHA);
    appendFileSync(process.env.GITHUB_OUTPUT, `dispatch=${decision.dispatch}\n`);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
