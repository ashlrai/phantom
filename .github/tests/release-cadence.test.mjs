/* global AbortController, Buffer, DOMException, URL, setTimeout */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { cadenceMinutes, nextPatch, planReleaseCadence, planReleaseCadenceWhenAvailable, createPublicMetadataReader, peeledCommit, GREEN_EVIDENCE_MAX_AHEAD, CADENCE_MAX_ATTEMPTS } from '../scripts/release-cadence.mjs';
import { peelReleaseTag } from '../scripts/peel-release-tag.mjs';
import { reconcileTaggedReleasePrs } from '../scripts/release-pr-labels.mjs';
import { normalizeReleaseNotes } from '../../scripts/sync-release-notes.mjs';

const revision = 'a'.repeat(40), tagged = 'b'.repeat(40);
const RUNS_KEY = '/actions/workflows/ci.yml/runs?event=push&branch=master&status=completed&per_page=100';
const CHECK_RUNS_KEY = (sha, page = 1) => `/commits/${sha}/check-runs?filter=latest&app_id=15368&per_page=100&page=${page}`;
const repo = { full_name: 'ashlrai/phantom', id: 1263526319, node_id: 'R_kgDOS0_hrw',
  owner: { id: 258113726, login: 'ashlrai' }, default_branch: 'master', private: false, visibility: 'public' };
const now = Date.parse('2026-11-05T04:00:00Z');
function fixture(overrides = {}) {
  const run = { id: 123, run_attempt: 1, path: '.github/workflows/ci.yml', head_sha: revision,
    repository: repo, head_branch: 'master', event: 'push', status: 'completed', conclusion: 'success' };
  const data = {
    '': repo, '/branches/master': { commit: { sha: revision } },
    '/git/matching-refs/heads/release-please--': [],
    '/rules/branches/master': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Merge Gate' }] } }],
    // Default required-check evidence on the fixture run SHA is red, so a
    // non-success run conclusion keeps failing closed unless a test opts in.
    [CHECK_RUNS_KEY(revision)]: { total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'failure', app: { id: 15368 } }] },
    [`/contents/package.json?ref=${revision}`]: { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: '3.30.1' })).toString('base64') },
    [`/contents/.release-please-manifest.json?ref=${revision}`]: { encoding: 'base64', content: Buffer.from('{".":"3.30.1"}').toString('base64') },
    '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: tagged } },
    [`/compare/${tagged}...${revision}`]: { status: 'ahead', ahead_by: 4 },
    [`/commits/${tagged}`]: { commit: { committer: { date: '2026-11-05T03:20:00Z' } } },
    [RUNS_KEY]: { total_count: 1, workflow_runs: [run] },
    ...overrides,
  };
  const read = async path => {
    assert.ok(path.startsWith('repos/ashlrai/phantom'));
    const key = path.slice('repos/ashlrai/phantom'.length);
    assert.ok(Object.hasOwn(data, key), `unexpected read ${key}`);
    return data[key];
  };
  return { read, run, data, input: { repository: 'ashlrai/phantom', now, read } };
}

// Re-pin the fixture's tip-scoped reads (contents and tag compares) to
// another master sha so a moved tip can be evaluated in full.
function repin(f, sha) {
  for (const path of ['package.json', '.release-please-manifest.json']) {
    f.data[`/contents/${path}?ref=${sha}`] = f.data[`/contents/${path}?ref=${revision}`];
  }
  for (const key of Object.keys(f.data)) {
    if (key.startsWith('/compare/') && key.endsWith(`...${revision}`)) {
      f.data[`${key.slice(0, -revision.length)}${sha}`] = f.data[key];
    }
  }
}

const RELEASE_PR_BRANCH = 'release-please--branches--master--components--phantom';
const releasePrHeadKey = branch => `/pulls?state=open&head=${encodeURIComponent(`ashlrai:${branch}`)}&per_page=100`;
// An open release-please PR discovered through matching-refs plus the head
// filter, with its detail read. Returns the listed head sha for check-run
// fixtures.
function openReleasePr(f, { number = 7251, sha = '7'.repeat(40), mergeable = true,
  title = 'chore(master): release 3.30.2', branch = RELEASE_PR_BRANCH,
  repoFullName = 'ashlrai/phantom', detailSha, baseRef = 'master' } = {}) {
  f.data['/git/matching-refs/heads/release-please--'] = [{ ref: `refs/heads/${branch}` }];
  const head = { ref: branch, sha, repo: { full_name: repoFullName } };
  f.data[releasePrHeadKey(branch)] = [{ number, title, head, base: { ref: baseRef } }];
  f.data[`/pulls/${number}`] = { number, mergeable, base: { ref: baseRef }, head: { ...head, sha: detailSha ?? sha } };
  return sha;
}

test('cadence validator honors configured values', () => {
  for (const minutes of [5, 30, 60, 120]) {
    assert.equal(cadenceMinutes(String(minutes)), minutes);
  }
  assert.throws(() => cadenceMinutes('4'));
  assert.throws(() => cadenceMinutes('invalid'));
});

test('default cadence produces next patch only for new green master work', async () => {
  const f = fixture();
  assert.equal(cadenceMinutes(), 30);
  assert.equal(nextPatch('3.30.0'), '3.30.1');
  assert.deepEqual(await planReleaseCadence(f.input), { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision, ciRunId: 123, ciRunAttempt: 1 });
  assert.deepEqual(await planReleaseCadence({ ...f.input, minutes: 60 }), { due: false, reason: 'cadence-not-due' });
});

test('peel follows an annotation and refuses a commit that is not the candidate', async () => {
  const annotation = 'c'.repeat(40), commit = 'd'.repeat(40);
  const ref = { ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: annotation } };
  const read = (sha) => ({ sha, object: { type: 'commit', sha: commit } });
  assert.equal(peelReleaseTag(ref, read).object.sha, commit);
  await assert.rejects(peeledCommit(async () => ({ sha: 'f'.repeat(40), object: { type: 'commit', sha: commit } }), 'repos/ashlrai/phantom', { type: 'tag', sha: annotation }), /annotation sha mismatches/);
  assert.throws(() => peelReleaseTag(ref, () => ({ sha: annotation, object: { type: 'commit', sha: '' } })), /tag sha mismatches/);
});

test('an annotated tag is peeled to its commit before the cadence compare', async () => {
  const annotation = 'c'.repeat(40);
  const f = fixture({
    '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'tag', sha: annotation } },
    [`/git/tags/${annotation}`]: { sha: annotation, object: { type: 'commit', sha: tagged } },
  });
  assert.equal((await planReleaseCadence(f.input)).due, true);
  const mismatch = fixture({
    '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'tag', sha: annotation } },
    [`/git/tags/${annotation}`]: { sha: annotation, object: { type: 'commit', sha: revision } },
  });
  assert.equal((await planReleaseCadence(mismatch.input)).reason, 'no-new-commits');
});

test('no new commits and an untagged bump never open another version PR', async () => {
  for (const [overrides, reason] of [
    [{ '/git/ref/tags/v3.30.1': null }, 'current-version-awaits-tag'],
    [{ '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: revision } } }, 'no-new-commits'],
  ]) assert.deepEqual(await planReleaseCadence(fixture(overrides).input), { due: false, reason });
});

test('the live master tip is evaluated, not the SHA that woke the workflow', async () => {
  const tip = 'e'.repeat(40), green = 'f'.repeat(40);
  const f = fixture();
  f.data['/branches/master'] = { commit: { sha: tip } };
  f.data[`/contents/package.json?ref=${tip}`] = f.data[`/contents/package.json?ref=${revision}`];
  f.data[`/contents/.release-please-manifest.json?ref=${tip}`] = f.data[`/contents/.release-please-manifest.json?ref=${revision}`];
  f.data[`/compare/${tagged}...${tip}`] = { status: 'ahead', ahead_by: 6 };
  f.data[`/compare/${green}...${tip}`] = { status: 'ahead', ahead_by: 3 };
  // The newest decisive verdict sits on a bounded ancestor of the live tip.
  f.run.head_sha = green;
  assert.deepEqual(await planReleaseCadence(f.input),
    { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision: tip, ciRunId: 123, ciRunAttempt: 1 });
});

test('a bounded fast-forward move mid-check is absorbed at the live tip', async () => {
  const first = 'e'.repeat(40), second = '8'.repeat(40);
  const f = fixture();
  repin(f, first);
  repin(f, second);
  // The newest decisive verdict sits on the fixture run sha, a bounded
  // ancestor of both candidate tips; the evaluated tip stays a bounded
  // ancestor of the live tip, so the pass verifies the move in place.
  f.data[`/compare/${revision}...${first}`] = { status: 'ahead', ahead_by: 2 };
  f.data[`/compare/${revision}...${second}`] = { status: 'ahead', ahead_by: 3 };
  f.data[`/compare/${first}...${second}`] = { status: 'ahead', ahead_by: 1 };
  // Branch reads: the pass evaluates `first`, the closing re-read sees
  // `second`, and the moved-tip verification accepts it without a retry.
  const tips = [first, second, second, second];
  let branchReads = 0;
  const read = path => path.endsWith('/branches/master')
    ? { commit: { sha: tips[Math.min(branchReads++, tips.length - 1)] } }
    : f.read(path);
  assert.deepEqual(await planReleaseCadence({ ...f.input, read }),
    { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision: second, ciRunId: 123, ciRunAttempt: 1 });
});

test('master movement that invalidates the snapshot still refuses, and the bound is validated', async () => {
  assert.equal(CADENCE_MAX_ATTEMPTS, 3);
  const first = 'e'.repeat(40), second = '8'.repeat(40), third = '9'.repeat(40);
  const f = fixture();
  repin(f, first);
  repin(f, second);
  f.data[`/compare/${revision}...${first}`] = { status: 'ahead', ahead_by: 2 };
  f.data[`/compare/${revision}...${second}`] = { status: 'ahead', ahead_by: 3 };
  // Every observed move diverges: the evaluated tip is no longer history,
  // so each pass hands back for a fresh evaluation at the live tip.
  f.data[`/compare/${first}...${second}`] = { status: 'diverged' };
  f.data[`/compare/${second}...${third}`] = { status: 'diverged' };
  // Each pass ends on a newer tip: first to second, second to third.
  const movingRead = () => {
    const tips = [first, second, second, third];
    let branchReads = 0;
    return path => path.endsWith('/branches/master')
      ? { commit: { sha: tips[Math.min(branchReads++, tips.length - 1)] } }
      : f.read(path);
  };
  assert.deepEqual(await planReleaseCadence({ ...f.input, read: movingRead(), attempts: 2 }), { due: false, reason: 'master-moved' });
  // A single pass keeps the pre-retry refusal: an invalidated snapshot still blocks.
  assert.deepEqual(await planReleaseCadence({ ...f.input, read: movingRead(), attempts: 1 }), { due: false, reason: 'master-moved' });
  await assert.rejects(planReleaseCadence({ ...f.input, read: f.read, attempts: 0 }), /attempt bound/);
  await assert.rejects(planReleaseCadence({ ...f.input, read: f.read, attempts: 11 }), /attempt bound/);
});

test('a version bump landing mid-check re-evaluates at the live tip', async () => {
  const first = 'e'.repeat(40), second = '8'.repeat(40);
  const f = fixture();
  repin(f, first);
  repin(f, second);
  // Master merged the release PR mid-check: package.json at the live tip
  // carries the new version, so the pass cannot ship the stale one.
  f.data[`/contents/package.json?ref=${second}`] = { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: '@ashlr/phantom', version: '3.30.2' })).toString('base64') };
  f.data[`/contents/.release-please-manifest.json?ref=${second}`] = { encoding: 'base64', content: Buffer.from('{".":"3.30.2"}').toString('base64') };
  f.data['/git/ref/tags/v3.30.2'] = null;
  f.data[`/compare/${revision}...${first}`] = { status: 'ahead', ahead_by: 2 };
  f.data[`/compare/${first}...${second}`] = { status: 'ahead', ahead_by: 1 };
  const tips = [first, second, second, second, second];
  let branchReads = 0;
  const read = path => path.endsWith('/branches/master')
    ? { commit: { sha: tips[Math.min(branchReads++, tips.length - 1)] } }
    : f.read(path);
  // Attempt one hands back on the version change; attempt two evaluates the
  // live tip, finds v3.30.2 still awaiting its tag, and defers correctly.
  assert.deepEqual(await planReleaseCadence({ ...f.input, read }), { due: false, reason: 'current-version-awaits-tag' });
});

test('moved-tip verification keeps the green-evidence window bounded', async () => {
  const first = 'e'.repeat(40), second = '8'.repeat(40);
  const f = fixture();
  repin(f, first);
  repin(f, second);
  f.data[`/compare/${revision}...${first}`] = { status: 'ahead', ahead_by: GREEN_EVIDENCE_MAX_AHEAD - 1 };
  f.data[`/compare/${first}...${second}`] = { status: 'ahead', ahead_by: 2 };
  const tips = [first, second];
  let branchReads = 0;
  const read = path => path.endsWith('/branches/master')
    ? { commit: { sha: tips[Math.min(branchReads++, tips.length - 1)] } }
    : f.read(path);
  // 99 commits of evidence distance plus a 2-commit move exceeds the bound.
  assert.deepEqual(await planReleaseCadence({ ...f.input, read }), { due: false, reason: 'push-ci-stale' });
  f.data[`/compare/${revision}...${first}`] = { status: 'ahead', ahead_by: GREEN_EVIDENCE_MAX_AHEAD - 2 };
  branchReads = 0;
  assert.equal((await planReleaseCadence({ ...f.input, read })).due, true);
});

test('a tag that is the tip re-checks before declaring no new commits', async () => {
  const first = 'e'.repeat(40), second = '8'.repeat(40);
  const f = fixture({
    '/git/ref/tags/v3.30.1': { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: first } },
    [`/commits/${first}`]: { commit: { committer: { date: '2026-11-05T03:20:00Z' } } },
  });
  repin(f, first);
  repin(f, second);
  f.data[`/compare/${first}...${second}`] = { status: 'ahead', ahead_by: 1 };
  f.data[`/compare/${revision}...${second}`] = { status: 'ahead', ahead_by: 3 };
  const tips = [first, second, second, second, second];
  let branchReads = 0;
  const read = path => path.endsWith('/branches/master')
    ? { commit: { sha: tips[Math.min(branchReads++, tips.length - 1)] } }
    : f.read(path);
  // Pass one sees tagSha === tip but master already moved; pass two finds
  // real commits past the tag and goes due at the live tip.
  assert.deepEqual(await planReleaseCadence({ ...f.input, read }),
    { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision: second, ciRunId: 123, ciRunAttempt: 1 });
});

test('independent pinned inputs are read in parallel so the still-tip window stays small', async () => {
  const f = fixture();
  let inFlight = 0;
  let maxInFlight = 0;
  const read = async path => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      return await f.read(path);
    } finally {
      inFlight -= 1;
    }
  };
  assert.equal((await planReleaseCadence({ ...f.input, read })).due, true);
  assert.equal(maxInFlight, 2);
});

test('the newest decisive master push verdict wins; verdict-less runs never block', async () => {
  const f = fixture();
  f.data[RUNS_KEY] = { total_count: 4, workflow_runs: [
    { ...f.run, id: 120, conclusion: 'success' },
    { ...f.run, id: 130, conclusion: 'failure' },
    { ...f.run, id: 140, status: 'in_progress' },
    { ...f.run, id: 150, conclusion: 'cancelled' },
  ] };
  // id 130 failure is the newest decisive verdict; the cancelled and
  // in-progress runs carry none.
  assert.equal((await planReleaseCadence(f.input)).due, false);
  f.data[RUNS_KEY] = { total_count: 4, workflow_runs: [
    { ...f.run, id: 121, conclusion: 'failure' },
    { ...f.run, id: 124, conclusion: 'success' },
    { ...f.run, id: 125, conclusion: 'neutral' },
    { ...f.run, id: 126, conclusion: 'cancelled' },
  ] };
  // id 124 success is newer than the id 121 failure; neutral and cancelled
  // runs are skipped rather than counted.
  assert.equal((await planReleaseCadence(f.input)).due, true);
  f.data[RUNS_KEY] = { total_count: 2, workflow_runs: [
    f.run,
    { ...f.run, id: 127, conclusion: 'timed_out' },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, false);
});

test('green evidence must cover the live tip within a bounded commit window', async () => {
  const f = fixture();
  const ancestor = 'd'.repeat(40);
  f.run.head_sha = ancestor;
  f.data[RUNS_KEY] = { total_count: 1, workflow_runs: [f.run] };
  f.data[`/compare/${ancestor}...${revision}`] = { status: 'ahead', ahead_by: GREEN_EVIDENCE_MAX_AHEAD };
  assert.equal((await planReleaseCadence(f.input)).due, true);
  f.data[`/compare/${ancestor}...${revision}`] = { status: 'ahead', ahead_by: GREEN_EVIDENCE_MAX_AHEAD + 1 };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-stale' });
  f.data[`/compare/${ancestor}...${revision}`] = { status: 'diverged', ahead_by: 3, behind_by: 1 };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-stale' });
});

test('a whole-run failure still counts when the required checks on its SHA are green', async () => {
  const f = fixture();
  // authority-drift is advisory and off Merge Gate needs: the run concludes
  // failure while the only required context stays green.
  f.run.conclusion = 'failure';
  f.data[CHECK_RUNS_KEY(revision)] = { total_count: 2, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    { name: 'Check authority drift (hermetic)', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input),
    { due: true, reason: 'green-master-cadence-due', version: '3.30.2', revision, ciRunId: 123, ciRunAttempt: 1 });
  const timedOut = fixture();
  timedOut.run.conclusion = 'timed_out';
  timedOut.data[CHECK_RUNS_KEY(revision)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(timedOut.input)).due, true);
});

test('required-check evidence fails closed on pending, red, foreign-app, empty and inconsistent inventories', async () => {
  const green = { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } };
  for (const inventory of [
    { total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } }] },
    { total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'failure', app: { id: 15368 } }] },
    { total_count: 1, check_runs: [{ name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 1 } }] },
    { total_count: 0, check_runs: [] },
    { total_count: 2, check_runs: [green] },
    { total_count: 1 },
  ]) {
    const f = fixture();
    f.run.conclusion = 'failure';
    f.data[CHECK_RUNS_KEY(revision)] = inventory;
    assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-not-green' });
  }
});

test('an empty required-check set or missing names can never prove green evidence', async () => {
  const f = fixture();
  f.run.conclusion = 'failure';
  f.data['/rules/branches/master'] = [];
  f.data[CHECK_RUNS_KEY(revision)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-not-green' });
});

test('branch protection contexts count when the ruleset lists no required checks', async () => {
  const f = fixture();
  f.data['/branches/master'] = { commit: { sha: revision }, protection: { required_status_checks: { contexts: ['Merge Gate'] } } };
  f.data['/rules/branches/master'] = [];
  f.run.conclusion = 'failure';
  f.data[CHECK_RUNS_KEY(revision)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, true);
});

test('required-check evidence pages through the full check-run inventory', async () => {
  const f = fixture();
  f.run.conclusion = 'failure';
  const filler = Array.from({ length: 100 }, (_, i) => ({ name: `advisory-${i}`, status: 'completed', conclusion: 'success', app: { id: 15368 } }));
  f.data[CHECK_RUNS_KEY(revision, 1)] = { total_count: 101, check_runs: filler };
  f.data[CHECK_RUNS_KEY(revision, 2)] = { total_count: 101, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, true);
  f.data[CHECK_RUNS_KEY(revision, 2)] = { total_count: 102, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-not-green' });
});

test('a settled re-run failure does not override an earlier required-check success, but an unsettled one does', async () => {
  const f = fixture();
  f.run.conclusion = 'failure';
  f.data[CHECK_RUNS_KEY(revision)] = { total_count: 2, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    { name: 'Merge Gate', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, true);
  f.data[CHECK_RUNS_KEY(revision)] = { total_count: 2, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
    { name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'push-ci-not-green' });
});

test('an open release PR with in-flight required checks freezes updates before any tip read', async () => {
  const f = fixture();
  const head = openReleasePr(f);
  f.data[CHECK_RUNS_KEY(head)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } },
  ] };
  const reads = [];
  const read = async path => { reads.push(path); return f.read(path); };
  assert.deepEqual(await planReleaseCadence({ ...f.input, read }),
    { due: false, reason: 'release-pr-checks-in-flight' });
  assert.ok(!reads.some(path => path.includes('/contents/package.json')), 'frozen plan must not evaluate tip state');
});

test('green release PR checks stay frozen for the train enqueue; only decisive red releases updates', async () => {
  const green = fixture();
  const greenHead = openReleasePr(green);
  green.data[CHECK_RUNS_KEY(greenHead)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(green.input), { due: false, reason: 'release-pr-checks-in-flight' });

  const red = fixture();
  const redHead = openReleasePr(red);
  red.data[CHECK_RUNS_KEY(redHead)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'failure', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(red.input)).due, true);
});

test('a ghost in_progress check run with a failure conclusion is settled red and releases the freeze', async () => {
  const f = fixture();
  const head = openReleasePr(f);
  f.data[CHECK_RUNS_KEY(head)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: 'failure', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, true);
  // An unsettled row that already claims success is still pending, never green.
  f.data[CHECK_RUNS_KEY(head)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'release-pr-checks-in-flight' });
});

test('a pending verdict freezes only once every required context has reported on the head', async () => {
  const f = fixture();
  const head = openReleasePr(f);
  f.data['/rules/branches/master'] = [{ type: 'required_status_checks', parameters: { required_status_checks: [
    { context: 'Merge Gate' }, { context: 'Fast gate' } ] } }];
  // Merge Gate reported and is running; Fast gate has no check-run row yet —
  // its CI may never have triggered, so the update that can start it stays
  // allowed instead of wedging the freeze on a context that never reports.
  f.data[CHECK_RUNS_KEY(head)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(f.input)).due, true);
  // Once every required context has a row, the same pending verdict freezes.
  f.data[CHECK_RUNS_KEY(head)] = { total_count: 2, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } },
    { name: 'Fast gate', status: 'queued', conclusion: null, app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'release-pr-checks-in-flight' });
});

test('a release PR head whose CI never reported, or reported no required context, is not frozen', async () => {
  const quiet = fixture();
  const quietHead = openReleasePr(quiet);
  quiet.data[CHECK_RUNS_KEY(quietHead)] = { total_count: 0, check_runs: [] };
  assert.equal((await planReleaseCadence(quiet.input)).due, true);

  const unreported = fixture();
  const unreportedHead = openReleasePr(unreported);
  unreported.data[CHECK_RUNS_KEY(unreportedHead)] = { total_count: 1, check_runs: [
    { name: 'advisory-only', status: 'in_progress', conclusion: null, app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(unreported.input)).due, true);

  const unreadable = fixture();
  const unreadableHead = openReleasePr(unreadable);
  unreadable.data[CHECK_RUNS_KEY(unreadableHead)] = { total_count: 3, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(unreadable.input)).due, true);
});

test('a conflicting or non-release pull request never freezes the cadence', async () => {
  const conflicting = fixture();
  const conflictHead = openReleasePr(conflicting, { mergeable: false });
  conflicting.data[CHECK_RUNS_KEY(conflictHead)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'completed', conclusion: 'success', app: { id: 15368 } },
  ] };
  assert.equal((await planReleaseCadence(conflicting.input)).due, true);

  const f = fixture();
  f.data['/git/matching-refs/heads/release-please--'] = [{ ref: `refs/heads/${RELEASE_PR_BRANCH}` }];
  f.data[releasePrHeadKey(RELEASE_PR_BRANCH)] = [
    { number: 1, title: 'feat: unrelated work', head: { ref: RELEASE_PR_BRANCH, sha: revision, repo: { full_name: 'ashlrai/phantom' } }, base: { ref: 'master' } },
    { number: 2, title: 'chore(master): release 3.30.2', head: { ref: RELEASE_PR_BRANCH, sha: revision, repo: { full_name: 'someone/fork' } }, base: { ref: 'master' } },
    { number: 3, title: 'chore(master): release 3.30.2', head: { ref: RELEASE_PR_BRANCH, sha: 'not-a-sha', repo: { full_name: 'ashlrai/phantom' } }, base: { ref: 'master' } },
    { number: 4, title: 'chore(master): release 3.30.2', head: { ref: RELEASE_PR_BRANCH, sha: revision, repo: { full_name: 'ashlrai/phantom' } }, base: { ref: 'dev' } },
  ];
  assert.equal((await planReleaseCadence(f.input)).due, true);
});

test('release PR discovery scans every release-please branch and prefers the fresher detail head', async () => {
  const f = fixture();
  const notesBranch = `${RELEASE_PR_BRANCH}--release-notes`;
  f.data['/git/matching-refs/heads/release-please--'] = [
    { ref: `refs/heads/${RELEASE_PR_BRANCH}` }, { ref: `refs/heads/${notesBranch}` }, { ref: 'refs/heads/release-please--' },
  ];
  f.data[releasePrHeadKey(RELEASE_PR_BRANCH)] = [];
  f.data[releasePrHeadKey(notesBranch)] = [{ number: 7251, title: 'chore(master): release 3.30.2',
    head: { ref: notesBranch, sha: '6'.repeat(40), repo: { full_name: 'ashlrai/phantom' } }, base: { ref: 'master' } }];
  f.data[releasePrHeadKey('release-please--')] = [];
  const detail = '5'.repeat(40);
  f.data['/pulls/7251'] = { number: 7251, mergeable: true, base: { ref: 'master' },
    head: { ref: notesBranch, sha: detail, repo: { full_name: 'ashlrai/phantom' } } };
  f.data[CHECK_RUNS_KEY(detail)] = { total_count: 1, check_runs: [
    { name: 'Merge Gate', status: 'in_progress', conclusion: null, app: { id: 15368 } },
  ] };
  assert.deepEqual(await planReleaseCadence(f.input), { due: false, reason: 'release-pr-checks-in-flight' });
});

test('an unreadable release-PR inventory never blocks the cadence plan', async () => {
  const malformed = fixture();
  malformed.data['/git/matching-refs/heads/release-please--'] = { unexpected: true };
  assert.equal((await planReleaseCadence(malformed.input)).due, true);
  const g = fixture();
  // More candidate branches than the scan bound: the freeze cannot prove anything.
  g.data['/git/matching-refs/heads/release-please--'] = Array.from({ length: 11 }, (_, i) => ({ ref: `refs/heads/release-please--b${i}` }));
  assert.equal((await planReleaseCadence(g.input)).due, true);
  const h = fixture();
  h.data['/git/matching-refs/heads/release-please--'] = [{ ref: `refs/heads/${RELEASE_PR_BRANCH}` }];
  h.data[releasePrHeadKey(RELEASE_PR_BRANCH)] = { unexpected: true };
  assert.equal((await planReleaseCadence(h.input)).due, true);
});

test('rate limits inside the freeze probe still defer the whole plan', async () => {
  const f = fixture();
  let calls = 0;
  const read = createPublicMetadataReader({ now: () => 0, sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return { status: 200, text: async () => JSON.stringify(repo) };
      return { status: 429, headers: { get: () => '0' } };
    } });
  assert.deepEqual(await planReleaseCadenceWhenAvailable({ ...f.input, read }),
    { due: false, reason: 'metadata-rate-limited' });
  assert.equal(calls, 2);
});

test('failed, running, absent, foreign and ambiguous CI evidence fails closed', async () => {
  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'skipped', 'neutral', null]) {
    const f = fixture(); f.run.conclusion = conclusion;
    assert.equal((await planReleaseCadence(f.input)).due, false);
  }
  const f = fixture(); f.run.status = 'in_progress';
  assert.equal((await planReleaseCadence(f.input)).due, false);
  const missing = fixture(); missing.data[RUNS_KEY] = { total_count: 0, workflow_runs: [] };
  assert.equal((await planReleaseCadence(missing.input)).due, false);
  missing.data[RUNS_KEY] = { total_count: 101, workflow_runs: [] };
  await assert.rejects(planReleaseCadence(missing.input), /incomplete/);
  const foreign = fixture();
  foreign.data[RUNS_KEY] = { total_count: 1, workflow_runs: [{ ...foreign.run, repository: { ...repo, id: 1 } }] };
  await assert.rejects(planReleaseCadence(foreign.input));
});

test('a newer failed run cannot inherit an older success; tip rechecked before eligibility', async () => {
  const f = fixture();
  f.data[RUNS_KEY] = { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 124, conclusion: 'failure' }] };
  assert.equal((await planReleaseCadence(f.input)).due, false);
  const g = fixture(); let branches = 0;
  g.data[`/compare/${revision}...${tagged}`] = { status: 'diverged' };
  const read = path => path.endsWith('/branches/master') && ++branches > 1 ? { commit: { sha: tagged } } : g.read(path);
  assert.deepEqual(await planReleaseCadence({ ...g.input, read, attempts: 1 }), { due: false, reason: 'master-moved' });
});

test('invalid cadence, divergent tag and source/manifest drift refuse', async () => {
  for (const value of ['0', '-1', '30x', '1.5', '1441', ' 30', '4']) assert.throws(() => cadenceMinutes(value));
  for (const version of ['3.30', 'v3.30.1', '3.30.01', '3.30.1-beta']) assert.throws(() => nextPatch(version));
  const f = fixture(); f.data[`/compare/${tagged}...${revision}`].status = 'diverged';
  await assert.rejects(planReleaseCadence(f.input), /ancestor/);
  const g = fixture(); g.data[`/contents/.release-please-manifest.json?ref=${revision}`].content = Buffer.from('{".":"3.29.15"}').toString('base64');
  await assert.rejects(planReleaseCadence(g.input), /manifest differ/);
});

function metadataReaderFixture(responses) {
  let clock = 0;
  const calls = [], waits = [], reports = [];
  const read = createPublicMetadataReader({
    now: () => clock,
    sleep: async ms => { waits.push(ms); clock += ms; },
    report: message => reports.push(message),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      assert.ok(response, 'unexpected metadata request');
      if (response.error) throw response.error;
      clock += response.elapsed ?? 0;
      return { status: response.status, headers: { get: name => response.headers?.[name] ?? null }, text: async () => {
        clock += response.bodyElapsed ?? 0;
        return response.text ?? JSON.stringify(response.data ?? {});
      } };
    },
  });
  return { read, calls, waits, reports };
}

test('anonymous GET retries gateway and 500 failures within one bounded read budget', async () => {
  const f = metadataReaderFixture([{ status: 503 }, { status: 504 }, { status: 200, data: repo }]);
  assert.deepEqual(await f.read('repos/ashlrai/phantom'), repo);
  assert.deepEqual(f.waits, [250, 500]);
  assert.deepEqual(f.reports, ['release metadata transient read failure: 503 at repos/ashlrai/phantom']);
  assert.equal(f.calls.length, 3);
  for (const call of f.calls) {
    assert.equal(call.url, 'https://api.github.com/repos/ashlrai/phantom');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.deepEqual(call.options.headers, { Accept: 'application/vnd.github+json' });
    assert.equal(call.options.signal.aborted, false);
  }
});

test('a transient 500 from the GitHub API is retried like a gateway failure', async () => {
  const f = metadataReaderFixture([{ status: 500 }, { status: 200, data: repo }]);
  assert.deepEqual(await f.read('repos/ashlrai/phantom'), repo);
  assert.deepEqual(f.waits, [250]);
  assert.deepEqual(f.reports, ['release metadata transient read failure: 500 at repos/ashlrai/phantom']);
  const persistent = metadataReaderFixture([{ status: 500 }, { status: 500 }, { status: 500 }]);
  await assert.rejects(persistent.read('repos/ashlrai/phantom'), /unavailable \(500\) after 3 read attempts/);
  assert.equal(persistent.calls.length, 3);
});

test('persistent transient failure stops after three reads and retains the original failure', async () => {
  const f = metadataReaderFixture([{ status: 504 }, { status: 502 }, { status: 503 }]);
  await assert.rejects(f.read('repos/ashlrai/phantom'), /503.*after 3 read attempts; first transient 504/);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.waits, [250, 500]);
  assert.equal(f.reports.length, 2);
  assert.match(f.reports[0], /504/);
});

test('exhausted timeouts defer the release without granting eligibility', async () => {
  let calls = 0, clock = 0;
  const reports = [];
  const read = createPublicMetadataReader({ now: () => clock, sleep: async ms => { clock += ms; },
    report: message => reports.push(message), timeoutSignal: () => {
      const controller = new AbortController();
      controller.abort(new DOMException('timed out', 'TimeoutError'));
      return controller.signal;
    }, fetchImpl: async (_url, { signal }) => { calls++; clock += 5_000; throw signal.reason; } });
  assert.deepEqual(await planReleaseCadenceWhenAvailable({ ...fixture().input, read }),
    { due: false, reason: 'metadata-unavailable' });
  assert.equal(calls, 3);
  assert.match(reports[1], /timeout.*after 3 read attempts.*deferring/);
  const gateway = metadataReaderFixture([{ status: 503 }, { status: 502 }, { status: 504 }]);
  assert.deepEqual(await planReleaseCadenceWhenAvailable({ ...fixture().input, read: gateway.read }),
    { due: false, reason: 'metadata-unavailable' });
});

test('a plan that outruns the shared read budget defers instead of failing the job', async () => {
  const f = fixture();
  let clock = 0;
  const reports = [];
  const read = createPublicMetadataReader({ now: () => clock, sleep: async ms => { clock += ms; },
    report: message => reports.push(message),
    fetchImpl: async url => {
      clock += 4_000;
      const data = await f.read(url.slice('https://api.github.com/'.length));
      return { status: 200, text: async () => JSON.stringify(data) };
    } });
  // Eight reads at four seconds each exhaust the thirty-second budget
  // mid-plan; the whole plan defers rather than failing the workflow job.
  assert.deepEqual(await planReleaseCadenceWhenAvailable({ ...f.input, read }),
    { due: false, reason: 'metadata-unavailable' });
});

test('fetch and body timeouts retry within the shared budget without masking other errors', async () => {
  for (const body of [false, true]) {
    let calls = 0, clock = 0;
    const budgets = [], reports = [];
    const read = createPublicMetadataReader({ now: () => clock, sleep: async ms => { clock += ms; },
      report: message => reports.push(message), timeoutSignal: ms => {
        budgets.push(ms);
        const controller = new AbortController();
        if (calls === 0) controller.abort(new DOMException('timed out', 'TimeoutError'));
        return controller.signal;
      }, fetchImpl: async (_url, { signal }) => {
        calls++;
        if (calls === 1) {
          clock += 5_000;
          if (!body) throw signal.reason;
          return { status: 200, text: async () => { throw new DOMException('aborted', 'AbortError'); } };
        }
        return { status: 200, text: async () => JSON.stringify(repo) };
      } });
    assert.deepEqual(await read('repos/ashlrai/phantom'), repo);
    assert.equal(calls, 2);
    assert.deepEqual(budgets, [5_000, 5_000]);
    assert.match(reports[0], /timeout at repos\/ashlrai\/phantom/);
  }
});

test('the fixed thirty-second deadline is shared across endpoints, backoff and body reads', async () => {
  const f = metadataReaderFixture([{ status: 200, elapsed: 14_900 }, { status: 504, elapsed: 14_900 }]);
  await f.read('repos/ashlrai/phantom');
  await assert.rejects(f.read('repos/ashlrai/phantom/branches/master'), /deadline exhausted; first transient 504/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.waits, []);
  const lateBody = metadataReaderFixture([{ status: 200, elapsed: 14_999, bodyElapsed: 15_001 }]);
  await assert.rejects(lateBody.read('repos/ashlrai/phantom'), /deadline exhausted/);
  await assert.rejects(lateBody.read('repos/ashlrai/phantom'), /deadline exhausted/);
  assert.equal(lateBody.calls.length, 1);
});

test('malformed, oversized, permission and transport failures never become retryable', async () => {
  for (const response of [
    { status: 200, text: '{' },
    { status: 200, text: ' '.repeat(4 * 1024 * 1024 + 1) },
    ...[400, 401, 403, 404, 429].map(status => ({ status })),
    { error: new TypeError('transport refused') },
  ]) {
    const f = metadataReaderFixture([response]);
    await assert.rejects(f.read('repos/ashlrai/phantom'));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.waits, []);
    assert.deepEqual(f.reports, []);
  }
  const missingTag = metadataReaderFixture([{ status: 404 }]);
  assert.equal(await missingTag.read('repos/ashlrai/phantom/git/ref/tags/v3.30.1'), null);
  assert.equal(missingTag.calls.length, 1);
  const foreign = metadataReaderFixture([]);
  await assert.rejects(foreign.read('repos/other/phantom'));
  assert.equal(foreign.calls.length, 0);
});

test('confirmed anonymous rate limits defer the release without masking other 403s', async () => {
  for (const status of [403, 429]) {
    const f = metadataReaderFixture([{ status, headers: { 'x-ratelimit-remaining': '0' } }]);
    assert.deepEqual(await planReleaseCadenceWhenAvailable({ ...fixture().input, read: f.read }),
      { due: false, reason: 'metadata-rate-limited' });
    assert.equal(f.calls.length, 1);
    assert.match(f.reports[0], /rate limited at repos\/ashlrai\/phantom/);
  }
  const denied = metadataReaderFixture([{ status: 403, headers: { 'x-ratelimit-remaining': '5' } }]);
  await assert.rejects(planReleaseCadenceWhenAvailable({ ...fixture().input, read: denied.read }),
    /403.*repos\/ashlrai\/phantom/);
});

test('a recovered metadata read still passes every cadence identity and fresh-tip guard', async () => {
  const f = fixture();
  let requests = 0;
  const reports = [];
  const read = createPublicMetadataReader({ now: () => 0, sleep: async () => {}, report: message => reports.push(message),
    fetchImpl: async url => {
      if (++requests === 1) return { status: 504 };
      return { status: 200, text: async () => JSON.stringify(await f.read(url.slice('https://api.github.com/'.length))) };
    } });
  assert.equal((await planReleaseCadence({ ...f.input, read })).due, true);
  assert.equal(reports.length, 1);
  const badIdentity = metadataReaderFixture([{ status: 200, data: { ...repo, id: 1 } }]);
  await assert.rejects(planReleaseCadence({ ...f.input, read: badIdentity.read }));
  assert.equal(badIdentity.calls.length, 1);
  const g = fixture(); let branches = 0;
  g.data[`/compare/${revision}...${tagged}`] = { status: 'diverged' };
  const movedRead = createPublicMetadataReader({ now: () => 0, fetchImpl: async url => {
    const path = url.slice('https://api.github.com/'.length);
    const data = path.endsWith('/branches/master') && ++branches > 1 ? { commit: { sha: tagged } } : await g.read(path);
    return { status: 200, text: async () => JSON.stringify(data) };
  } });
  assert.deepEqual(await planReleaseCadence({ ...g.input, read: movedRead, attempts: 1 }), { due: false, reason: 'master-moved' });
});

test('generated notes normalize below Unreleased without losing previous text', () => {
  const body = '### Fixes\n\n- A meaningful set of changes lands in the release with complete metadata.\n\n';
  const old = '## [3.30.0] — 2026-11-04\n\nOld notes preserved.\n';
  const source = `# Changelog\n\n## [3.30.1](https://github.com/ashlrai/phantom/compare/v3.30.0...v3.30.1) (2026-11-05)\n\n${body}## [Unreleased]\n\nFuture notes.\n\n${old}`;
  const normalized = normalizeReleaseNotes(source, '3.30.1');
  assert.ok(normalized.indexOf('## [Unreleased]') < normalized.indexOf('## [3.30.1]'));
  assert.ok(normalized.includes('## [3.30.1] - 2026-11-05'));
  assert.ok(normalized.includes('Future notes.'));
  assert.ok(normalized.endsWith(old));
  assert.equal(normalizeReleaseNotes(normalized, '3.30.1'), normalized);
  assert.throws(() => normalizeReleaseNotes(source + source, '3.30.1'), /one current/);
  assert.throws(() => normalizeReleaseNotes(source.replace(body, 'tiny\n'), '3.30.1'), /too short/);
});

test('timer cadence keeps the existing permissions and guarded merge route', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const workflow = parse(read('../workflows/release-please.yml'));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs['release-please'].permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.deepEqual(workflow.on.schedule, [{ cron: '*/5 * * * *' }]);
  assert.equal(workflow.on.workflow_run, undefined);
  const steps = workflow.jobs['release-please'].steps;
  assert.equal(steps.find(s => s.id === 'rp').if, "steps.cadence.outputs.due == 'true'");
  assert.match(steps.find(s => s.id === 'cadence').env.RELEASE_CADENCE_MINUTES, /vars.RELEASE_CADENCE_MINUTES/);
  assert.match(read('../scripts/release-cadence.mjs'), /cadenceMinutes\(process\.env\.RELEASE_CADENCE_MINUTES \|\| '5'\)/);
  assert.equal(read('../scripts/release-cadence.mjs').includes('Math.max(60, cadenceMinutes'), false);
  const config = JSON.parse(read('../../release-please-config.json'));
  assert.equal(config.versioning, 'always-bump-patch');
  assert.equal(config['skip-changelog'], false);
  assert.ok(config['changelog-sections'].some(s => s.type === 'bridge' && !s.hidden));
  assert.ok(workflow.jobs['sync-and-refresh'].steps.some(s => s.run?.includes('sync-release-notes.mjs')));
  assert.equal(read('../workflows/release-please.yml').includes('pr merge'), false);
  const tag = parse(read('../workflows/auto-tag.yml'));
  assert.deepEqual(tag.jobs.tag.permissions, { contents: 'read', checks: 'read', actions: 'write' });
  assert.deepEqual(tag.on.schedule, [{ cron: '22,52 * * * *' }]);
  assert.deepEqual(tag.on.workflow_run.workflows, ['CI']);
  assert.ok(tag.jobs.tag.if.includes("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/master'"), 'manual retry must not tag a feature branch');
});


test('external auto-tag clears only backed merged release PR pending labels', async () => {
  const calls = [];
  const content = { encoding: 'base64', content: Buffer.from('{"name":"@ashlr/phantom","version":"3.30.1"}').toString('base64') };
  const read = async path => {
    if (path === 'repos/ashlrai/phantom') return repo;
    if (path.includes('/issues?')) return [{ number: 7, pull_request: {} }, { number: 8 }];
    if (path.endsWith('/pulls/7')) return { merged_at: '2026-11-05', merge_commit_sha: revision, head: { ref: 'release-please--master', repo }, base: { ref: 'master', repo } };
    if (path.includes('/contents/package.json')) return content;
    if (path.includes('/git/ref/tags/')) return { ref: 'refs/tags/v3.30.1', object: { type: 'commit', sha: revision } };
    assert.fail(`unexpected read ${path}`);
  };
  const write = async (...args) => calls.push(args);
  assert.deepEqual(await reconcileTaggedReleasePrs({ repository: repo.full_name, read, write }), { reconciled: 1 });
  assert.deepEqual(calls, [
    ['POST', 'repos/ashlrai/phantom/issues/7/labels', { labels: ['autorelease: tagged'] }],
    ['DELETE', 'repos/ashlrai/phantom/issues/7/labels/autorelease%3A%20pending'],
  ]);
  calls.length = 0;
  await reconcileTaggedReleasePrs({ repository: repo.full_name, write,
    read: async path => path.includes('/git/ref/tags/') ? null : read(path) });
  assert.equal(calls.length, 0, 'missing tag must preserve pending label');
  await assert.rejects(reconcileTaggedReleasePrs({ repository: repo.full_name, write,
    read: async path => path.endsWith('/pulls/7') ? { ...(await read(path)), base: { ref: 'other', repo } } : read(path) }));
  assert.equal(calls.length, 0, 'foreign base must refuse before writes');
});
