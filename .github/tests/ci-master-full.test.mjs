import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { FULL_CHECK, FULL_CRON, FULL_REQUIRED, FULL_SKIPPED, fullFailures, fullHistory, recordFull, requireFullGreen } from '../scripts/ci-master-full.mjs';

const candidate = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const repo = 'ashlrai/phantom';
const run = (id, head = candidate, extra = {}) => ({ id, head_sha: head, run_attempt: 1,
  workflow_id: 10, path: '.github/workflows/ci.yml', event: 'schedule', head_branch: 'master',
  head_repository: { id: 1263526319 }, status: 'completed', conclusion: 'success', ...extra });
const check = (conclusion = 'success') => ({ name: FULL_CHECK, status: 'completed', conclusion });
function fixture(runs = [run(20)], inventories = {}, calls = []) {
  return async path => {
    calls.push(path);
    if (path.endsWith('/workflows/ci.yml')) return { id: 10, path: '.github/workflows/ci.yml' };
    if (path.includes('/workflows/10/runs?')) {
      const event = path.match(/event=(schedule|workflow_dispatch)&branch=master/)?.[1];
      assert.ok(event, `unexpected runs query ${path}`);
      return { workflow_runs: runs.filter(r => r.event === event) };
    }
    const id = Number(path.match(/\/runs\/(\d+)\/attempts\/\d+\/jobs/)?.[1]);
    assert.ok(id, `unexpected path ${path}`);
    const jobs = inventories[id] ?? [check()];
    return { jobs, total_count: jobs.length };
  };
}
const dependencies = () => Object.fromEntries([
  ...FULL_REQUIRED.map(id => [id, { result: 'success', ...(id === 'classify' ? { outputs: { lane: 'full', release_gate: 'false' } } : {}) }]),
  ...FULL_SKIPPED.map(id => [id, { result: 'skipped' }]),
]);
const env = { GITHUB_EVENT_NAME: 'schedule', FULL_SCHEDULE: FULL_CRON, GITHUB_REF: 'refs/heads/master',
  GITHUB_SHA: candidate, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: '30', GITHUB_RUN_ATTEMPT: '1' };

test('only exact master SHA with completed green scheduled full is admitted', async () => {
  const result = await requireFullGreen({ repo, candidate, api: fixture() });
  assert.equal(result.id, 20);
  await assert.rejects(requireFullGreen({ repo, candidate: previous, api: fixture() }), /candidate has no current/);
  await assert.rejects(requireFullGreen({ repo, candidate: 'master', api: fixture() }), /exact SHA/);
});

for (const outcome of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) {
  test(`full ${outcome} refuses tagging despite an older green run on the same SHA`, async () => {
    const api = fixture([run(20), run(19)], { 20: [check(outcome), { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'failure' }] });
    await assert.rejects(requireFullGreen({ repo, candidate, api }), /missing, red or pending/);
  });
}

test('pending full, missing marker, failed workflow and wrong source cannot authorize', async () => {
  for (const extra of [{ status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { head_branch: 'worker' },
    { workflow_id: 11 }, { head_repository: { id: 42 } }, { path: '.github/workflows/fake.yml' }]) {
    await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([run(20, candidate, extra)]) }));
  }
  const matrix = [{ name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'success' }];
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([run(20), run(19)], { 20: matrix }) }));
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([]) }));
  await assert.rejects(requireFullGreen({ repo, candidate, api: async () => { throw new Error('unavailable'); } }));
});

test('a push-event run is never fetched as full evidence', async () => {
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([run(20, candidate, { event: 'push' })]) }), /missing, red or pending/);
});

test('green full on an ancestor admits the candidate; unrelated or unverified ancestry refuses', async () => {
  const api = fixture([run(20, previous)]);
  assert.equal((await requireFullGreen({ repo, candidate, api, isAncestor: async (r, base, head) => r === repo && base === previous && head === candidate })).id, 20);
  await assert.rejects(requireFullGreen({ repo, candidate, api, isAncestor: async () => false }), /candidate has no current/);
  await assert.rejects(requireFullGreen({ repo, candidate, api, isAncestor: async () => { throw new Error('compare unavailable'); } }));
  // An injected reader never reaches the network for ancestry.
  await assert.rejects(requireFullGreen({ repo, candidate, api }), /candidate has no current/);
  // A red latest full still refuses even when an older green is an ancestor.
  const red = fixture([run(21, previous), run(20, previous)], { 21: [check('failure')] });
  await assert.rejects(requireFullGreen({ repo, candidate, api: red, isAncestor: async () => true }), /missing, red or pending/);
});

test('a green manual full dispatch qualifies only with full matrix, a Mac slice and every job green', async () => {
  const d = (id, extra = {}) => run(id, candidate, { event: 'workflow_dispatch', ...extra });
  const jobs = (extra = []) => [{ name: 'CI (Node 22, ubuntu, authority 1/3)', status: 'completed', conclusion: 'success' },
    { name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'success' }, { ...check('skipped') }, ...extra];
  assert.equal((await requireFullGreen({ repo, candidate, api: fixture([d(30), run(20)], { 30: jobs() }) })).id, 30);
  for (const bad of [[{ name: 'Merge Gate', status: 'completed', conclusion: 'failure' }], [{ name: 'Windows service authority (Server 2022)', status: 'completed', conclusion: 'cancelled' }]]) {
    await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([d(30, { conclusion: 'failure' }), run(20)], { 30: jobs(bad) }) }), /missing, red or pending/);
  }
  const noMac = [{ name: 'CI (Node 22, ubuntu, authority 1/3)', status: 'completed', conclusion: 'success' }, { name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'skipped' }];
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([d(30), run(20)], { 30: noMac }) }), /missing, red or pending/);
  // An in-flight dispatched full blocks; a dispatch that never ran the matrix is ignored.
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([d(30, { status: 'in_progress', conclusion: null }), run(20)], { 30: jobs() }) }), /missing, red or pending/);
  assert.equal((await requireFullGreen({ repo, candidate, api: fixture([d(30), run(20)], { 30: [{ name: 'Quick typecheck', status: 'completed', conclusion: 'success' }] }) })).id, 20);
});

test('half-hour release preparation cannot qualify a SHA or hide a red full', async () => {
  const api = fixture([run(22), run(21, previous), run(20)], { 22: [check('skipped')], 21: [check('failure')] });
  await assert.rejects(requireFullGreen({ repo, candidate, api }), /missing, red or pending/);
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([run(22)], { 22: [check('skipped')] }) }));
});

test('in-flight half-hour release preparation does not mask the latest full', async () => {
  const classify = { name: 'Classify PR site lane', status: 'completed', conclusion: 'success' };
  const pending = { status: 'in_progress', conclusion: null };
  for (const release of [{ name: 'Desktop release smoke', status: 'in_progress', conclusion: null }, { name: 'Desktop release smoke', conclusion: 'success' }]) {
    const api = fixture([run(22, previous, pending), run(20)], { 22: [classify, release, check('skipped')] });
    assert.equal((await requireFullGreen({ repo, candidate, api })).id, 20);
  }
  // A full run reports the release job skipped, so an in-flight full still blocks.
  const full = fixture([run(22, previous, pending), run(20)], { 22: [classify, { name: 'Desktop release smoke', conclusion: 'skipped' }] });
  await assert.rejects(requireFullGreen({ repo, candidate, api: full }), /missing, red or pending/);
  // Before classify finishes the shape is unknown, so never fall back.
  const early = fixture([run(22, previous, pending), run(20)], { 22: [{ ...classify, status: 'in_progress', conclusion: null }, { name: 'Desktop release smoke', conclusion: null }] });
  await assert.rejects(requireFullGreen({ repo, candidate, api: early }), /missing, red or pending/);
});

test('reruns use the exact latest attempt and incomplete/duplicate jobs fail closed', async () => {
  const calls = [];
  const api = fixture([run(20, candidate, { run_attempt: 2 })], { 20: [check('failure')] }, calls);
  await assert.rejects(requireFullGreen({ repo, candidate, api }));
  assert.ok(calls.some(path => path.includes('/attempts/2/jobs?')));
  await assert.rejects(requireFullGreen({ repo, candidate, api: fixture([run(20)], { 20: [check(), check()] }) }));
  const good = fixture();
  await assert.rejects(requireFullGreen({ repo, candidate, api: async path => {
    const data = await good(path);
    return path.includes('/jobs?') ? { ...data, total_count: data.jobs.length + 1 } : data;
  } }));
});

test('green receipt requires the exact full and deliberately skipped inventory', () => {
  assert.deepEqual(fullFailures(dependencies()), []);
  for (const id of FULL_REQUIRED) {
    for (const result of ['skipped', 'failure', 'cancelled', undefined]) {
      const needs = dependencies();
      needs[id].result = result;
      assert.ok(fullFailures(needs).includes(id));
    }
  }
  for (const id of FULL_SKIPPED) {
    const needs = dependencies();
    needs[id].result = 'success';
    assert.ok(fullFailures(needs).includes(id));
  }
  const missing = dependencies();
  delete missing.ci;
  assert.throws(() => fullFailures(missing), /inventory differs/);
  const release = dependencies();
  release.classify.outputs.release_gate = 'true';
  assert.ok(fullFailures(release).includes('classify'));
});

test('green summary records exact SHA without any API dependency', async () => {
  const result = await recordFull({ env, needs: dependencies(), api: () => { throw new Error('no API needed'); } });
  assert.equal(result.receipt.green, true);
  assert.equal(result.summary, `full-green-sha=${candidate}`);
});

test('red summary names failures and bounds the first failing interval from prior green', async () => {
  const needs = dependencies();
  needs.ci.result = 'failure';
  const api = fixture([run(30), run(29), run(20, previous)], { 29: [check('failure')] });
  const result = await recordFull({ env, needs, api });
  assert.equal(result.receipt.green, false);
  assert.equal(result.summary, `full-red-sha=${candidate} failing-jobs=ci first-failing-range=${previous}..${candidate} history=available`);
});

test('unavailable history is explicit on red, never invented or promoted to green', async () => {
  const needs = dependencies();
  needs['windows-service-authority'].result = 'cancelled';
  const result = await recordFull({ env, needs, api: async () => { throw new Error('no access'); } });
  assert.equal(result.receipt.previous_green_sha, null);
  assert.equal(result.receipt.green, false);
  assert.match(result.summary, /failing-jobs=windows-service-authority first-failing-range=unknown\.\./);
  assert.match(result.summary, /history=unavailable$/);
});

test('only six-hour master schedule can produce a full receipt', async () => {
  for (const extra of [{ FULL_SCHEDULE: '0,30 * * * *' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'merge_group' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/tags/v3.30.35' }]) {
    await assert.rejects(recordFull({ env: { ...env, ...extra }, needs: dependencies() }), /not a six-hour/);
  }
});

test('history ignores current and newer runs when finding the previous green', async () => {
  const history = await fullHistory({ repo, excludeRun: 30, api: fixture([run(31), run(30), run(20, previous)]) });
  assert.equal(history[0].head_sha, previous);
});

for (const conclusion of ['success', 'failure']) {
  test(`real guard CLI emits authorization only for full ${conclusion}`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'master-full-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const data = { workflow: { id: 10, path: '.github/workflows/ci.yml' },
      runs: { workflow_runs: [run(20)] }, jobs: { total_count: 1, jobs: [check(conclusion)] } };
    writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nconst p=process.argv.at(-1);const d=${JSON.stringify(data)};process.stdout.write(JSON.stringify(p.endsWith('/ci.yml')?d.workflow:p.includes('/jobs?')?d.jobs:p.includes('event=schedule')?d.runs:{workflow_runs:[]}));\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-master-full.mjs', import.meta.url)), 'require'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHA: candidate,
        GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(result.status, conclusion === 'success' ? 0 : 1, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), conclusion === 'success' ? 'green=true\n' : '');
    if (conclusion === 'success') assert.match(readFileSync(summary, 'utf8'), /full-green-sha=.*full-run=20 full-attempt=1/);
  });
}

test('push trigger holds quietly (green=false, exit 0) while other triggers fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'master-full-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
  for (const trigger of ['push', 'schedule']) {
    writeFileSync(output, '');
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-master-full.mjs', import.meta.url)), 'require'], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHA: candidate, TRIGGER: trigger,
        GITHUB_REPOSITORY: repo, GITHUB_REPOSITORY_ID: '1263526319', GITHUB_REPOSITORY_OWNER_ID: '258113726',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary') },
    });
    assert.equal(result.status, trigger === 'push' ? 0 : 1, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), trigger === 'push' ? 'green=false\n' : '');
  }
});
