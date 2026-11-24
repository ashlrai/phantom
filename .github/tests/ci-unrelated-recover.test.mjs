/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PAGE_CAP, REPO, SCAN_CAP, commitAttempts, loadSnapshot, main, mutationRequest, planRecovery, protectedJob, requiredChecks,
} from '../scripts/ci-unrelated-recover.mjs';

const master = 'b'.repeat(40);
const head = 'a'.repeat(40);
const other = 'c'.repeat(40);
const NOW = Date.parse('2026-11-16T12:00:00Z');

const pull = (over = {}) => ({
  number: 10, draft: false, autoMerge: true, headSha: head, sameRepo: true, dirty: false, behindBy: 0, ...over,
});
const run = (over = {}) => ({ id: 1, name: 'Merge Gate', status: 'completed', conclusion: 'failure', runId: 50, ...over });
const jobs = (over = {}) => ({ 50: { runAttempt: 1, failed: ['Fast gate (typecheck + affected tests)', 'Merge Gate'], ...over } });
const snapshot = (over = {}) => ({
  required: ['Merge Gate'],
  masterSha: master,
  pulls: [pull()],
  checks: {
    [head]: [run()],
    [master]: [run({ id: 9, conclusion: 'failure' })],
  },
  jobs: jobs(),
  state: { v: 1, attempts: [] },
  now: NOW,
  budget: 8,
  ...over,
});

test('required checks come from rulesets and enforced classic protection', () => {
  const names = requiredChecks(
    [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Merge Gate' }, { context: '' }] } }],
    { protection: { required_status_checks: { enforcement_level: 'everyone', contexts: ['Fast gate (typecheck + affected tests)'] } } },
  );
  assert.deepEqual(names, ['Fast gate (typecheck + affected tests)', 'Merge Gate']);
  assert.deepEqual(requiredChecks([], { protection: { required_status_checks: { enforcement_level: 'off', contexts: ['Merge Gate'] } } }), []);
});

test('protected jobs stay outside recovery', () => {
  assert.equal(protectedJob('Secret-shape scan'), true);
  assert.equal(protectedJob('Secret scan (diff)'), true);
  assert.equal(protectedJob('Check generated files'), true);
  assert.equal(protectedJob('Notarize desktop'), true);
  assert.equal(protectedJob('Fast gate (typecheck + affected tests)'), false);
  assert.equal(protectedJob('Merge Gate'), false);
});

test('master red and an up-to-date branch reruns the failed jobs once', () => {
  const plan = planRecovery(snapshot());
  assert.deepEqual(plan.actions, [{ kind: 'rerun', pr: 10, sha: head, runId: 50, check: 'Merge Gate' }]);
  assert.match(plan.logs[0], /recover rerun pr=10/);
  const repeated = planRecovery(snapshot());
  assert.deepEqual(repeated.actions, plan.actions);
  const spent = planRecovery(snapshot({ state: commitAttempts(snapshot().state, plan.actions, NOW) }));
  assert.deepEqual(spent.actions, []);
  assert.match(spent.logs[0], /already-retried/);
});

test('a later successful required check is not a failure, and an in-progress check waits', () => {
  const passed = planRecovery(snapshot({
    checks: { [head]: [run({ id: 1, conclusion: 'failure' }), run({ id: 2, conclusion: 'success' })], [master]: [run({ id: 9, conclusion: 'failure' })] },
  }));
  assert.deepEqual(passed.actions, []);
  const waiting = planRecovery(snapshot({
    checks: { [head]: [run({ id: 4, status: 'in_progress', conclusion: null })], [master]: [run({ id: 9 })] },
  }));
  assert.deepEqual(waiting.actions, []);
  assert.match(waiting.logs[0], /in-progress/);
});

test('a behind branch is left to the merge queue unless master is red', () => {
  const green = planRecovery(snapshot({
    pulls: [pull({ behindBy: 3, dirty: true })],
    checks: { [head]: [run()], [master]: [run({ id: 9, conclusion: 'success' })] },
  }));
  assert.deepEqual(green.actions, []);
  assert.match(green.logs[0], /own-failure/);
  const red = planRecovery(snapshot({ pulls: [pull({ behindBy: 3 })] }));
  assert.deepEqual(red.actions, [{ kind: 'rerun', pr: 10, sha: head, runId: 50, check: 'Merge Gate' }]);
  assert.equal(red.actions.some((action) => action.kind !== 'rerun'), false);
});

test('an up-to-date red PR whose master check is green is left alone', () => {
  const plan = planRecovery(snapshot({
    checks: { [head]: [run()], [master]: [run({ id: 9, conclusion: 'success' })] },
  }));
  assert.deepEqual(plan.actions, []);
  assert.match(plan.logs[0], /own-failure/);
});

test('drafts, forks, disabled auto-merge, protected jobs and unknown jobs do not mutate', () => {
  for (const [name, pulls, jobMap] of [
    ['draft', [pull({ draft: true })], jobs()],
    ['fork', [pull({ sameRepo: false })], jobs()],
    ['manual', [pull({ autoMerge: false })], jobs()],
    ['secret', [pull()], jobs({ failed: ['Secret-shape scan', 'Merge Gate'] })],
    ['unknown', [pull()], { }],
  ]) {
    const plan = planRecovery(snapshot({ pulls, jobs: jobMap, checks: { [head]: [run()], [master]: [run({ id: 9, conclusion: 'failure' })] } }));
    assert.deepEqual(plan.actions, [], name);
  }
});

test('a second attempt and a full daily budget stop further recovery', () => {
  const retried = planRecovery(snapshot({ jobs: jobs({ runAttempt: 2 }) }));
  assert.deepEqual(retried.actions, []);
  assert.match(retried.logs[0], /already-retried attempt=2/);
  const attempts = [1, 2, 3].map((n) => ({ pr: 10, sha: `${n.toString(16).padStart(40, 'd')}`, kind: 'rerun', at: NOW - 1000 }));
  const capped = planRecovery(snapshot({ state: { v: 1, attempts }, pulls: [pull({ headSha: other })], checks: { [other]: [run()], [master]: [run({ id: 9 })] } }));
  assert.deepEqual(capped.actions, []);
  assert.match(capped.logs[0], /pr-budget/);
  const expired = attempts.map((row) => ({ ...row, at: NOW - (25 * 60 * 60 * 1000) }));
  const fresh = planRecovery(snapshot({ state: { v: 1, attempts: expired } }));
  assert.equal(fresh.actions.length, 1);
});

test('the per-run budget keeps the rest for the next pass', () => {
  const pulls = [pull({ number: 11, headSha: head }), pull({ number: 12, headSha: other })];
  const plan = planRecovery(snapshot({
    budget: 1,
    pulls,
    checks: { [head]: [run()], [other]: [run({ runId: 51 })], [master]: [run({ id: 9 })] },
    jobs: { ...jobs(), 51: { runAttempt: 1, failed: ['Merge Gate'] } },
  }));
  assert.deepEqual(plan.actions.map((action) => action.pr), [11]);
  assert.match(plan.logs.at(-1), /pr=12 reason=budget/);
});

test('missing recoverable required checks abort before any action', () => {
  const plan = planRecovery(snapshot({ required: ['Secret scan (diff)'] }));
  assert.equal(plan.abort, true);
  assert.deepEqual(plan.actions, []);
});

test('the only mutation is one rerun of the failed jobs', () => {
  const rerun = mutationRequest(REPO, { kind: 'rerun', pr: 10, sha: head, runId: 50 });
  assert.equal(rerun.body, null);
  assert.equal(rerun.args.includes('PUT'), false);
  assert.match(rerun.args.at(-1), /\/actions\/runs\/50\/rerun-failed-jobs$/);
  assert.throws(() => mutationRequest(REPO, { kind: 'update-branch', pr: 10, sha: head }));
  assert.throws(() => mutationRequest(REPO, { kind: 'rebase', pr: 10, sha: head }));
  assert.throws(() => mutationRequest('other/repo', { kind: 'rerun', runId: 1 }));
});

test('recovery workflow rejects workflow_run', () => {
  const workflow = readFileSync(new URL('../workflows/unrelated-pr-recover.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /workflow_run/);
  assert.match(workflow, /^ {2}schedule:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.match(workflow, /cron: '\*\/20 \* \* \* \*'/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
});

test('the workflow and script stay on REST and off protected gates', () => {
  const source = readFileSync(new URL('../scripts/ci-unrelated-recover.mjs', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../workflows/unrelated-pr-recover.yml', import.meta.url), 'utf8');
  for (const text of [source, workflow]) {
    assert.equal(/graphql/i.test(text), false, text.slice(0, 40));
    assert.equal(text.includes('--admin'), false);
    assert.equal(/rebase/i.test(text), false);
    assert.equal(/\bforce\b/i.test(text), false);
  }
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /workflow_run/);
  assert.match(workflow, /github\.token/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /name: recover-unrelated-pr-failures/);
  assert.doesNotMatch(source, /update-branch/);
  assert.doesNotMatch(workflow, /update-branch/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
});

function route(map) {
  const calls = [];
  const gh = async (args, input) => {
    calls.push({ args: [...args], input });
    const methodAt = args.indexOf('--method');
    const key = `${args[methodAt + 1]} ${args.find((arg) => String(arg).startsWith('repos/'))}`;
    const hit = map[key];
    if (!hit && (args.includes('PUT') || args.includes('POST'))) return { ok: true, status: 200, body: '' };
    if (!hit) return { ok: false, status: 404, body: '' };
    return { ok: true, status: 200, body: JSON.stringify(hit) };
  };
  return { gh, calls };
}

const checkRun = (id, conclusion, runId = 50) => ({
  id, name: 'Merge Gate', status: 'completed', conclusion,
  details_url: `https://github.com/ashlrai/phantom/actions/runs/${runId}/job/${id}`,
});

function apiMap(over = {}) {
  return {
    [`GET repos/${REPO}/rules/branches/master?per_page=100`]: [
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Merge Gate' }] } },
    ],
    [`GET repos/${REPO}/branches/master`]: { commit: { sha: master }, protection: {} },
    [`GET repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`]: [{
      number: 10, draft: false, auto_merge: { merge_method: 'squash' },
      head: { sha: head, repo: { full_name: REPO } }, base: { repo: { full_name: REPO } },
    }],
    [`GET repos/${REPO}/commits/${master}/check-runs?per_page=100&page=1`]: { total_count: 1, check_runs: [checkRun(9, 'failure')] },
    [`GET repos/${REPO}/commits/${head}/check-runs?per_page=100&page=1`]: { total_count: 1, check_runs: [checkRun(4, 'failure')] },
    [`GET repos/${REPO}/actions/runs/50/jobs?per_page=100&filter=latest`]: {
      total_count: 2,
      jobs: [
        { name: 'Fast gate (typecheck + affected tests)', conclusion: 'failure', run_attempt: 1 },
        { name: 'Merge Gate', conclusion: 'failure', run_attempt: 1 },
      ],
    },
    ...over,
  };
}

function fullPullPages(autoMerge = true) {
  const map = apiMap();
  const path = `GET repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=`;
  const row = map[`${path}1`][0];
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    map[`${path}${page}`] = Array.from({ length: 100 }, (_, index) => ({
      ...row, number: (page - 1) * 100 + index + 1, auto_merge: autoMerge ? row.auto_merge : null,
    }));
  }
  return map;
}

test('full PR pages keep a bounded recovery sample instead of aborting', async () => {
  const { gh, calls } = route(fullPullPages());
  const loaded = await loadSnapshot(gh, REPO);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.capped, true);
  assert.deepEqual(loaded.snapshot.pulls.map((row) => row.number), Array.from({ length: SCAN_CAP }, (_, i) => i + 1));
  assert.deepEqual(loaded.snapshot.checks[head], [run({ id: 4 })]);
  assert.equal(calls.filter((call) => call.args.at(-1).includes('/pulls?')).length, PAGE_CAP);
  assert.equal(calls.some((call) => call.args.includes('POST')), false);
});

test('full PR pages without eligible candidates complete without mutations', async () => {
  const { gh, calls } = route(fullPullPages(false));
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const logs = [];
  try {
    assert.equal(await main({ allowLocal: true, repo: REPO, gh, statePath: join(dir, 'state.json'), now: NOW, log: (line) => logs.push(line) }), 0);
    assert.ok(logs.includes('recover note scan-capped kept=0'));
    assert.ok(logs.includes('recover done actions=0'));
    assert.equal(calls.some((call) => call.args.includes('PUT') || call.args.includes('POST')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a candidate on the last full PR page is recovered once per head', async () => {
  const map = fullPullPages(false);
  map[`GET repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${PAGE_CAP}`].at(-1).auto_merge = {};
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  try {
    for (let pass = 0; pass < 2; pass += 1) {
      const { gh, calls } = route(map);
      assert.equal(await main({ allowLocal: true, repo: REPO, gh, statePath: join(dir, 'state.json'), now: NOW, log() {} }), 0);
      const posts = calls.filter((call) => call.args.includes('POST'));
      assert.equal(posts.length, pass === 0 ? 1 : 0);
      if (posts.length) assert.equal(posts[0].args.at(-1), `repos/${REPO}/actions/runs/50/rerun-failed-jobs`);
    }
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).attempts.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable later PR page still aborts before recovery', async () => {
  const map = fullPullPages();
  delete map[`GET repos/${REPO}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2`];
  const { gh, calls } = route(map);
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const logs = [];
  try {
    assert.equal(await main({ allowLocal: true, repo: REPO, gh, statePath: join(dir, 'state.json'), now: NOW, log: (line) => logs.push(line) }), 1);
    assert.deepEqual(logs, ['recover abort reason=pulls-unreadable']);
    assert.equal(calls.some((call) => call.args.includes('PUT') || call.args.includes('POST')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('load and apply rerun once per head and do not repeat it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const statePath = join(dir, 'state.json');
  try {
    const first = route(apiMap());
    const code = await main({ allowLocal: true, repo: REPO, gh: first.gh, statePath, now: NOW, env: {}, log() {} });
    assert.equal(code, 0);
    const posts = first.calls.filter((call) => call.args.includes('POST'));
    assert.equal(posts.length, 1);
    assert.match(posts[0].args.at(-1), /\/rerun-failed-jobs$/);
    assert.equal(first.calls.some((call) => call.args.includes('PUT')), false);
    assert.equal(first.calls.every((call) => call.args.every((arg) => !String(arg).includes('graphql'))), true);
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].kind, 'rerun');
    const second = route(apiMap());
    const again = await main({ allowLocal: true, repo: REPO, gh: second.gh, statePath, now: NOW, env: {}, log() {} });
    assert.equal(again, 0);
    assert.equal(second.calls.some((call) => call.args.includes('PUT') || call.args.includes('POST')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a validation failure still consumes the head budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  const statePath = join(dir, 'state.json');
  try {
    const reader = route(apiMap());
    const mixed = async (args, input) => args.includes('POST') ? { ok: false, status: 422, body: '' } : reader.gh(args, input);
    assert.equal(await main({ allowLocal: true, repo: REPO, gh: mixed, statePath, now: NOW, env: {}, log() {} }), 0);
    const next = route(apiMap());
    assert.equal(await main({ allowLocal: true, repo: REPO, gh: next.gh, statePath, now: NOW, env: {}, log() {} }), 0);
    assert.equal(next.calls.some((call) => call.args.includes('POST') || call.args.includes('PUT')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the job refuses to run outside Actions or another repository', async () => {
  const calls = [];
  const logs = [];
  const gh = async () => { calls.push(1); return { ok: false, status: 500, body: '' }; };
  const log = (line) => logs.push(line);
  // CI sets GITHUB_ACTIONS and GITHUB_REPOSITORY on the process. The guard must
  // read the env handed to this call, not whatever the runner inherited.
  assert.equal(await main({ gh, repo: REPO, statePath: 'unused', env: {}, log }), 2);
  assert.match(logs.at(-1), /not-actions/);
  assert.equal(await main({
    gh, statePath: 'unused', log,
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'other/repo' },
  }), 2);
  assert.match(logs.at(-1), /repository/);
  assert.equal(await main({ allowLocal: true, gh, repo: 'other/repo', statePath: 'unused', env: { GITHUB_ACTIONS: 'true' }, log }), 2);
  assert.deepEqual(calls, []);
});

test('an unreadable ruleset performs no recovery', async () => {
  const { gh, calls } = route({});
  const dir = mkdtempSync(join(tmpdir(), 'recover-'));
  try {
    const code = await main({ allowLocal: true, repo: REPO, gh, statePath: join(dir, 'state.json'), now: NOW, log() {} });
    assert.equal(code, 1);
    assert.equal(calls.some((call) => call.args.includes('PUT') || call.args.includes('POST')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sparse checkout includes every file the tests read', () => {
  const workflow = readFileSync(new URL('../workflows/unrelated-pr-recover.yml', import.meta.url), 'utf8');
  const block = workflow.match(/sparse-checkout: \|\n((?: {12}\S.*\n)+)/);
  assert.ok(block, 'sparse-checkout block');
  const listed = block[1].split('\n').map((line) => line.trim()).filter(Boolean);
  for (const file of [
    '.github/scripts/ci-unrelated-recover.mjs',
    '.github/tests/ci-unrelated-recover.test.mjs',
    '.github/workflows/unrelated-pr-recover.yml',
  ]) {
    assert.ok(listed.includes(file), `${file} missing from sparse-checkout`);
  }
});
