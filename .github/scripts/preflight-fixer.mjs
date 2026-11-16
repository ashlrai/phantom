// Preflight fixer. Predict which tests the next scheduled full suite is likely
// to fail, run that set on a GitHub-hosted runner, and file P0 fix-forward
// work before the suite starts. Read-only toward tags, drafts, and releases.
//
// Prediction:
//   - tests selected from paths changed since the last green full run
//     (ci-fast-select: changed tests, name matches, direct importers, Tier-1)
//   - test paths named in the latest full run's annotations
//   - test paths named in open p0-fix-forward issues
// The cloud run is capped. Red jobs from the latest full run are reported;
// a whole matrix shard is not re-executed here.
import { execFileSync, spawn } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { failedTestFiles } from './ci-fast-run.mjs';
import { boundedHistory, ensureCommitReachable, gitRunner } from './preflight-history.mjs';
import {
  changedPaths, classifyPaths, needsDist, selectFallback, selectRelated,
} from './ci-fast-select.mjs';
import { requireProducerEnvironment } from './github-repository-binding.mjs';

export const SCHEMA = 'phantom-preflight-reds/v1';
export const LABEL = 'p0-fix-forward';
export const SUMMARY_TITLE = '[P0 fix-forward] preflight predicted reds';
export const CLOUD_CAP = 40;
export const REPO = 'ashlrai/phantom';
const CAUSES = new Set(['schedule', 'workflow_dispatch']);
const RUNNABLE = /^(?:test\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.ts|\.github\/tests\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.mjs)$/;

export function isRunnableTest(file) {
  return typeof file === 'string' && file.length <= 240 && RUNNABLE.test(file);
}

export function preflightLineId(testPath) {
  assert.ok(isRunnableTest(testPath), 'not a runnable test path');
  const slug = testPath.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+/g, '-');
  let id = `RQ-PREFLIGHT-${slug}`;
  if (id.length <= 120) return id;
  const hash = createHash('sha256').update(testPath).digest('hex').slice(0, 8);
  const prefix = 'RQ-PREFLIGHT-';
  const room = 120 - prefix.length - 1 - hash.length;
  id = `${prefix}${slug.slice(0, room).replace(/[.-]+$/, '')}-${hash}`;
  assert.ok(id.length <= 120 && /^RQ-PREFLIGHT-[A-Za-z0-9]/.test(id));
  return id;
}

export function fixupLine({ id, testPath, sha, runUrl }) {
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.match(runUrl, /^https:\/\/github\.com\/ashlrai\/phantom\/actions\/runs\/[1-9][0-9]*$/);
  const sha7 = sha.slice(0, 7);
  return `- READY ${id} (P0, pool=any, tier=work, repo=phantom, lead=CI-Efficiency, owner=ci-efficiency, test=${testPath}, result=failure, run=${runUrl}, sha=${sha7}): preflight found this test red on master; fix it before the next scheduled full suite.`;
}

export function testPathsInText(text) {
  if (typeof text !== 'string' || text.length > 200_000) return [];
  const found = [];
  const re = /(?:^|[\s`'"(])((?:test|\.github\/tests)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.test\.(?:ts|mjs))\b/g;
  for (const match of text.matchAll(re)) {
    if (isRunnableTest(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

const COVER_MS = 6 * 60 * 60 * 1000;

// Auto-tag is requested every half hour. One preflight per master SHA in that
// window is enough; the six-hour schedule still runs on its own clock.
export function coveredByExistingRun({ runs, selfId, headSha, now, maxAgeMs = COVER_MS }) {
  assert.ok(Array.isArray(runs));
  return runs.some((run) => {
    if (run?.id === selfId || run?.head_sha !== headSha) return false;
    if (run.status !== 'completed') return true;
    const updated = Date.parse(run.updated_at ?? '');
    return Number.isFinite(updated) && now - updated < maxAgeMs;
  });
}

export function releaseOwed({ version, tagExists, releasePublished }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? '')) throw new Error('unexpected version');
  return !(tagExists === true && releasePublished === true);
}

export function affectedFromPaths({ cwd, paths }) {
  const verdict = classifyPaths(paths);
  if (verdict.mode === 'docs') return { ...verdict, tests: [], node: [], deferred: [] };
  if (verdict.mode === 'fallback') {
    const picked = selectFallback({ cwd });
    return { ...verdict, tests: picked.tests, node: picked.node, deferred: [] };
  }
  const selected = selectRelated({ cwd, paths, cap: Number.POSITIVE_INFINITY });
  const deferred = selected.deferred.filter((file) => !needsDist(cwd, file));
  if (selected.tests.length === 0 && selected.node.length === 0 && deferred.length === 0) {
    const picked = selectFallback({ cwd });
    return { mode: 'fallback', reason: 'no test maps to the changed paths', tests: picked.tests, node: picked.node, deferred: [] };
  }
  return { ...verdict, tests: selected.tests, node: selected.node, deferred };
}

export function chooseRunList({ knownReds, candidates, cap = CLOUD_CAP }) {
  assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 200, 'cloud cap out of range');
  const union = [];
  const seen = new Set();
  for (const file of [...knownReds, ...candidates]) {
    if (!isRunnableTest(file) || seen.has(file)) continue;
    seen.add(file);
    union.push(file);
  }
  return { union, ran: union.slice(0, cap), not_run: union.slice(cap) };
}

export function repoTestPath(name) {
  const norm = String(name ?? '').replaceAll('\\', '/');
  if (isRunnableTest(norm)) return norm;
  for (const marker of ['/.github/tests/', '/test/']) {
    const at = norm.lastIndexOf(marker);
    if (at < 0) continue;
    const rel = norm.slice(at + 1);
    if (isRunnableTest(rel)) return rel;
  }
  return null;
}

export function redsFromVitestReport(report) {
  const rows = Array.isArray(report?.testResults) ? report.testResults : [];
  const reds = [];
  for (const row of rows) {
    if (row?.status !== 'failed') continue;
    const rel = repoTestPath(row.name);
    if (rel && !reds.includes(rel)) reds.push(rel);
  }
  return reds;
}

export function interpretRun({ exitCode, log, vitestReport }) {
  if (exitCode === 0) return { exitCode, reds: [], unparsedFailure: false };
  const reds = [...new Set([
    ...redsFromVitestReport(vitestReport),
    ...failedTestFiles(log ?? ''),
  ])].filter(isRunnableTest).sort();
  return { exitCode, reds, unparsedFailure: reds.length === 0 };
}

export function mergeRuns(parts) {
  const reds = [...new Set(parts.flatMap((part) => part.reds))].sort();
  return {
    reds,
    unparsedFailure: parts.some((part) => part.exitCode !== 0 && part.reds.length === 0),
  };
}

export function buildPreflightReport(input) {
  assert.ok(CAUSES.has(input.cause), 'unknown preflight cause');
  assert.match(input.headSha, /^[0-9a-f]{40}$/);
  return {
    schema: SCHEMA,
    cause: input.cause,
    generated_at: input.generatedAt,
    head_sha: input.headSha,
    run_id: input.runId,
    run_url: input.runUrl,
    last_green_full: input.lastGreen,
    latest_full: input.latest,
    changed_since_green: input.changedCount,
    selection: { mode: input.selection.mode, reason: input.selection.reason },
    predicted: {
      affected: input.affected,
      known_reds: input.knownReds,
      union: input.choice.union,
      ran: input.choice.ran,
      not_run: input.choice.not_run,
    },
    reds: input.reds,
    unparsed_failure: input.unparsedFailure === true,
  };
}

export function planSummary(report, openIssues) {
  const body = [
    `Preflight on master ${report.head_sha.slice(0, 7)} selected ${report.predicted.union.length} tests, ran ${report.predicted.ran.length}, red ${report.reds.length}.`,
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
  ].join('\n');
  const existing = openIssues.find((issue) => issue.title === SUMMARY_TITLE);
  return existing
    ? { action: 'comment', number: existing.number, title: SUMMARY_TITLE, body }
    : { action: 'create', title: SUMMARY_TITLE, body };
}

export function planTestIssues({ reds, ran, unparsedFailure, headSha, runUrl, openIssues }) {
  const plans = [];
  const titled = new Map(openIssues
    .filter((issue) => issue.title?.startsWith(`${'[P0 fix-forward] '}RQ-PREFLIGHT-`))
    .map((issue) => [issue.title, issue]));
  for (const testPath of reds) {
    const id = preflightLineId(testPath);
    const title = `[P0 fix-forward] ${id}`;
    const body = [
      fixupLine({ id, testPath, sha: headSha, runUrl }),
      '',
      `Test file: ${testPath}`,
      `Master: ${headSha}`,
    ].join('\n');
    const existing = titled.get(title);
    plans.push(existing
      ? { action: 'comment', number: existing.number, title, body }
      : { action: 'create', title, body });
  }
  if (unparsedFailure) return plans;
  for (const testPath of ran) {
    if (reds.includes(testPath)) continue;
    const title = `[P0 fix-forward] ${preflightLineId(testPath)}`;
    const existing = titled.get(title);
    if (!existing) continue;
    plans.push({
      action: 'close',
      number: existing.number,
      title,
      body: `Preflight reran ${testPath} on ${headSha.slice(0, 7)} and it passed. Closing.`,
    });
  }
  return plans;
}

function workDir() {
  return process.env.RUNNER_TEMP && process.env.RUNNER_TEMP.length > 0 ? process.env.RUNNER_TEMP : tmpdir();
}
function planPath() { return join(workDir(), 'preflight-plan.json'); }
function resultsPath() { return join(workDir(), 'preflight-results.json'); }
function reportPath() { return resolve('preflight-reds.json'); }

function writeOutput(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, pairs.map(([key, value]) => `${key}=${value}\n`).join(''));
}

function gh(args, input) {
  return execFileSync('gh', args, {
    encoding: 'utf8', input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function assertRepoPath(path) {
  assert.ok(path.startsWith(`repos/${REPO}/`) && !path.includes('..') && !/[\s`]/.test(path), 'unreviewed API path');
}

function apiGet(path) {
  assertRepoPath(path);
  return JSON.parse(gh(['api', '--hostname', 'github.com', path]));
}

function scrub(text) {
  return execFileSync('perl', ['.github/tests/secret-shape/scrub.pl'], { encoding: 'utf8', input: text });
}

function gitText(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function headSha(cwd) {
  const sha = gitText(cwd, ['rev-parse', 'HEAD']).trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  return sha;
}

function trackedTests(cwd) {
  return new Set(gitText(cwd, ['ls-files', '-z', '--', 'test', '.github/tests']).split('\0').filter(isRunnableTest));
}

export function redJobs(jobs) {
  return (jobs ?? [])
    .filter((job) => job.conclusion === 'failure' || job.conclusion === 'cancelled' || job.conclusion === 'timed_out')
    .map((job) => ({ name: String(job.name ?? ''), conclusion: job.conclusion }));
}

function checkRunId(job) {
  const fromUrl = /\/check-runs\/([1-9][0-9]*)$/.exec(job.check_run_url ?? '');
  if (fromUrl) return fromUrl[1];
  return /^[1-9][0-9]*$/.test(String(job.id ?? '')) ? String(job.id) : null;
}

function knownFromRun(run, jobs) {
  const paths = [];
  const add = (text) => { for (const path of testPathsInText(text)) if (!paths.includes(path)) paths.push(path); };
  for (const job of jobs) {
    if (!['failure', 'cancelled', 'timed_out'].includes(job.conclusion)) continue;
    add(job.name);
    const id = checkRunId(job);
    if (!id) continue;
    let notes = [];
    try { notes = apiGet(`repos/${REPO}/check-runs/${id}/annotations`); } catch { notes = []; }
    if (!Array.isArray(notes)) continue;
    for (const note of notes) add(`${note.path ?? ''}\n${note.message ?? ''}`);
  }
  return { paths, jobs: run?.status === 'completed' && run.qualified !== true ? redJobs(jobs) : [] };
}

function openIssues() {
  const issues = [];
  for (let page = 1; page <= 3; page += 1) {
    const batch = apiGet(`repos/${REPO}/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch), 'issue list is not an array');
    for (const issue of batch) if (!issue.pull_request) issues.push(issue);
    if (batch.length < 100) break;
  }
  return issues;
}

function runUrl() {
  const id = process.env.GITHUB_RUN_ID ?? '0';
  assert.match(id, /^[1-9][0-9]*$/);
  return `https://github.com/ashlrai/phantom/actions/runs/${id}`;
}

export async function loadHistory(repo, api = apiGet) {
  try { return await boundedHistory({ repo, api }); } catch (error) {
    console.log(`CI history unavailable (${error?.message ?? 'unknown'}); using fallback selection`);
    return { latest: null, green: null, evidence: [], capped: true };
  }
}

async function planMain(cwd) {
  requireProducerEnvironment(process.env);
  const cause = process.env.PREFLIGHT_CAUSE ?? '';
  assert.ok(CAUSES.has(cause), 'PREFLIGHT_CAUSE must be schedule or workflow_dispatch');
  const head = headSha(cwd);
  // A dispatch from Auto-tag is workflow_dispatch. Skip unless a published
  // release is still owed, and do not stack another run for the same SHA.
  if (cause === 'workflow_dispatch') {
    const owed = await owedRelease(cwd);
    const covered = owed && coveredByExistingRun({
      runs: recentPreflightRuns(head), selfId: Number(process.env.GITHUB_RUN_ID), headSha: head, now: Date.now(),
    });
    if (!owed || covered) {
      const reason = owed ? 'already-covered' : 'release-not-owed';
      const skip = { schema: SCHEMA, cause, skipped: true, reason, head_sha: head, generated_at: new Date().toISOString() };
      writeFileSync(reportPath(), `${JSON.stringify(skip, null, 2)}\n`);
      writeOutput([['run_tests', 'false'], ['report', 'false']]);
      console.log(`preflight skipped: ${reason}`);
      return;
    }
  }
  // Advisory run: a transient CI metadata failure must not fail the job. Without
  // history there is no known green base, so the fallback selection runs.
  const history = await loadHistory(process.env.GITHUB_REPOSITORY);
  const latest = history.latest ?? null;
  const green = history.green ?? null;
  let changed = [];
  let selection;
  if (!green) {
    const picked = selectFallback({ cwd });
    selection = { mode: 'fallback', reason: 'no prior green full run', tests: picked.tests, node: picked.node, deferred: [] };
  } else {
    try {
      const reach = ensureCommitReachable({ git: gitRunner(cwd), sha: green.head_sha });
      console.log(`preflight base: ${reach.mode} deepens=${reach.deepens} unshallow=${reach.unshallow}`);
      changed = changedPaths({ base: green.head_sha, head, cwd });
      selection = affectedFromPaths({ cwd, paths: changed });
    } catch {
      const picked = selectFallback({ cwd });
      selection = { mode: 'fallback', reason: 'changed-path selection failed', tests: picked.tests, node: picked.node, deferred: [] };
    }
  }
  let latestJobs = [];
  if (latest) {
    try {
      const page = apiGet(`repos/${REPO}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=100`);
      latestJobs = page.jobs ?? [];
    } catch { latestJobs = []; }
  }
  const fromRun = knownFromRun(latest, latestJobs);
  const issues = safeOpenIssues();
  const fromIssues = [];
  for (const issue of issues) {
    for (const path of testPathsInText(`${issue.title ?? ''}\n${issue.body ?? ''}`)) {
      if (!fromIssues.includes(path)) fromIssues.push(path);
    }
  }
  const tracked = trackedTests(cwd);
  const knownReds = [...fromRun.paths, ...fromIssues].filter((file) => tracked.has(file));
  const candidates = [...selection.tests, ...selection.node, ...selection.deferred].filter((file) => tracked.has(file));
  const choice = chooseRunList({ knownReds, candidates });
  const plan = {
    cause, headSha: head, runId: Number(process.env.GITHUB_RUN_ID), runUrl: runUrl(),
    generatedAt: new Date().toISOString(),
    lastGreen: green ? { sha: green.head_sha, run_id: green.id, run_attempt: green.run_attempt } : null,
    latest: latest ? {
      sha: latest.head_sha, run_id: latest.id, status: latest.status,
      conclusion: latest.conclusion, qualified: latest.qualified === true, red_jobs: fromRun.jobs,
    } : null,
    changedCount: changed.length,
    selection: { mode: selection.mode, reason: selection.reason },
    affected: candidates.filter((file) => !knownReds.includes(file)),
    knownReds, choice,
  };
  writeFileSync(planPath(), `${JSON.stringify(plan, null, 2)}\n`);
  writeOutput([['run_tests', choice.ran.length ? 'true' : 'false'], ['report', 'true']]);
  console.log(`preflight plan: ${selection.mode} (${selection.reason}), union ${choice.union.length}, run ${choice.ran.length}, not_run ${choice.not_run.length}`);
}

function recentPreflightRuns(head) {
  assert.match(head, /^[0-9a-f]{40}$/);
  try {
    const data = apiGet(`repos/${REPO}/actions/workflows/preflight-fixer.yml/runs?head_sha=${head}&per_page=10`);
    return Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
  } catch { return []; }
}

function safeOpenIssues() {
  try { return openIssues(); } catch { return []; }
}

async function owedRelease(cwd) {
  let version;
  try { version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version; } catch { return true; }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? '')) return true;
  let tagExists = false;
  let releasePublished = false;
  try {
    apiGet(`repos/${REPO}/git/ref/tags/v${version}`);
    tagExists = true;
  } catch { tagExists = false; }
  try {
    const release = apiGet(`repos/${REPO}/releases/tags/v${version}`);
    releasePublished = release?.draft === false && typeof release.published_at === 'string';
  } catch { releasePublished = false; }
  return releaseOwed({ version, tagExists, releasePublished });
}

function spawnLogged(command, args) {
  return new Promise((done) => {
    let log = '';
    const child = spawn(command, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const take = (stream, sink) => stream.on('data', (chunk) => { log += chunk; sink.write(chunk); });
    take(child.stdout, process.stdout);
    take(child.stderr, process.stderr);
    child.on('error', (error) => done({ exitCode: 1, log: `${log}\nspawn error: ${error.message}` }));
    child.on('close', (code) => done({ exitCode: code ?? 1, log }));
  });
}

async function runMain() {
  const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
  const ran = plan.choice.ran.filter(isRunnableTest);
  const vitest = ran.filter((file) => file.startsWith('test/'));
  const nodeTests = ran.filter((file) => file.startsWith('.github/tests/'));
  const jsonPath = join(workDir(), 'preflight-vitest.json');
  const parts = [];
  if (vitest.length) {
    const result = await spawnLogged(process.execPath, ['scripts/test-ci.mjs', '--reporter=json', `--outputFile=${jsonPath}`, ...vitest]);
    let report = null;
    try { report = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { report = null; }
    parts.push(interpretRun({ exitCode: result.exitCode, log: result.log, vitestReport: report }));
  }
  if (nodeTests.length) {
    const result = await spawnLogged(process.execPath, ['--test', ...nodeTests]);
    parts.push(interpretRun({ exitCode: result.exitCode, log: result.log, vitestReport: null }));
  }
  const merged = mergeRuns(parts);
  const reds = merged.reds.filter((file) => ran.includes(file));
  writeFileSync(resultsPath(), `${JSON.stringify({ reds, unparsedFailure: merged.unparsedFailure, ran }, null, 2)}\n`);
  console.log(`preflight run: red ${reds.length}, unparsed ${merged.unparsedFailure}`);
}

function ensureLabel() {
  try {
    apiGet(`repos/${REPO}/labels/${encodeURIComponent(LABEL)}`);
  } catch {
    gh(['api', '--method', 'POST', `repos/${REPO}/labels`, '--input', '-'], JSON.stringify({
      name: LABEL, color: 'b60205', description: 'P0 fix-forward from the full suite or preflight',
    }));
  }
}

function applyPlan(plan) {
  const body = scrub(plan.body);
  assert.ok(plan.title.startsWith('[P0 fix-forward] '), 'unexpected issue title');
  if (plan.action === 'create') {
    gh(['api', '--method', 'POST', `repos/${REPO}/issues`, '--input', '-'], JSON.stringify({ title: plan.title, body, labels: [LABEL] }));
  } else {
    assert.match(String(plan.number), /^[1-9][0-9]*$/);
    gh(['api', '--method', 'POST', `repos/${REPO}/issues/${plan.number}/comments`, '--input', '-'], JSON.stringify({ body }));
    if (plan.action === 'close') {
      gh(['api', '--method', 'PATCH', `repos/${REPO}/issues/${plan.number}`, '--input', '-'], JSON.stringify({ state: 'closed', state_reason: 'completed' }));
    }
  }
  console.log(`${plan.action} ${plan.number ?? plan.title}`);
}

function reportMain() {
  requireProducerEnvironment(process.env);
  const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
  let results = { reds: [], unparsedFailure: false, ran: plan.choice.ran };
  try { results = { ...results, ...JSON.parse(readFileSync(resultsPath(), 'utf8')) }; } catch { /* nothing ran, or the runner died before results */ results = { ...results, unparsedFailure: plan.choice.ran.length > 0 }; }
  const reds = (results.reds ?? []).filter((file) => plan.choice.ran.includes(file) && isRunnableTest(file));
  const report = buildPreflightReport({
    ...plan,
    reds,
    unparsedFailure: results.unparsedFailure === true,
  });
  writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`);
  const issues = openIssues();
  ensureLabel();
  const plans = [planSummary(report, issues), ...planTestIssues({
    reds, ran: plan.choice.ran, unparsedFailure: report.unparsed_failure,
    headSha: plan.headSha, runUrl: plan.runUrl, openIssues: issues,
  })];
  for (const item of plans) applyPlan(item);
  if (report.reds.length || report.unparsed_failure) process.exitCode = 1;
}

const entry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (entry) {
  const command = process.argv[2];
  const cwd = process.cwd();
  const finish = (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; };
  if (command === 'plan') planMain(cwd).catch(finish);
  else if (command === 'run') runMain().catch(finish);
  else if (command === 'report') { try { reportMain(); } catch (error) { finish(error); } }
  else finish(new Error('Usage: preflight-fixer.mjs plan|run|report'));
}
