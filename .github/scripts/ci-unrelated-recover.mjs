#!/usr/bin/env node
/* global process, console */
// Recovers open auto-merge PRs whose Merge Gate or fast-gate failed for a
// reason outside the PR. REST only (gh api); the query API's secondary limits
// are why this stays on REST. A red master check is rerun once per head SHA.
// The merge queue brings a behind branch up to date; this job does not write
// to the branch. Secret-shape, secret scan, generated-file, signing and
// notarization failures are left alone. No admin, no history rewrite, no
// ruleset edits.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO = 'ashlrai/phantom';
export const RECOVERABLE_CHECKS = Object.freeze([
  'Merge Gate',
  'Fast gate (typecheck + affected tests)',
]);
export const PROTECTED_JOBS = Object.freeze([
  'Secret-shape scan',
  'Secret scan (diff)',
  'Check generated files',
]);
export const MAX_MUTATIONS = 8;
export const MAX_PR_ATTEMPTS = 3;
export const SCAN_CAP = 30;
export const PAGE_CAP = 3;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;

const recoverable = new Set(RECOVERABLE_CHECKS);
const protectedNames = new Set(PROTECTED_JOBS);

export function protectedJob(name) {
  return protectedNames.has(name) || /sign|notar|secret|gitleak/i.test(name);
}

export function normalizeState(value, now) {
  const attempts = [];
  const rows = Array.isArray(value?.attempts) ? value.attempts : [];
  for (const row of rows) {
    if (!row || row.kind !== 'rerun') continue;
    if (!Number.isSafeInteger(row.pr) || row.pr < 1) continue;
    if (typeof row.sha !== 'string' || !SHA.test(row.sha)) continue;
    if (!Number.isSafeInteger(row.at) || now - row.at > RETRY_WINDOW_MS || row.at > now) continue;
    attempts.push({ pr: row.pr, sha: row.sha, kind: row.kind, at: row.at });
  }
  return { v: 1, attempts };
}

export function commitAttempts(state, actions, now) {
  return normalizeState({ v: 1, attempts: [...state.attempts, ...actions.map((action) => ({ pr: action.pr, sha: action.sha, kind: action.kind, at: now }))] }, now);
}

function attemptsFor(state, pr, now) {
  return state.attempts.filter((row) => row.pr === pr && now - row.at <= RETRY_WINDOW_MS).length;
}

function seen(state, sha, kind) {
  return state.attempts.some((row) => row.sha === sha && row.kind === kind);
}

export function requiredChecks(rulesBody, branchBody) {
  const names = new Set();
  const add = (context) => {
    if (typeof context === 'string' && context.length > 0 && context.length <= 256) names.add(context);
  };
  if (Array.isArray(rulesBody)) {
    for (const rule of rulesBody) {
      if (rule?.type !== 'required_status_checks' || !Array.isArray(rule.parameters?.required_status_checks)) continue;
      for (const check of rule.parameters.required_status_checks) add(check?.context);
    }
  }
  const classic = branchBody?.protection?.required_status_checks;
  if (classic && classic.enforcement_level !== 'off') {
    for (const check of Array.isArray(classic.checks) ? classic.checks : []) add(check?.context);
    for (const context of Array.isArray(classic.contexts) ? classic.contexts : []) add(context);
  }
  return [...names].sort();
}

function latest(runs, name) {
  let found = null;
  for (const run of runs) {
    if (run.name !== name) continue;
    if (!found || run.id > found.id) found = run;
  }
  return found;
}

const waiting = new Set(['queued', 'in_progress', 'pending', 'waiting']);
const failedConclusion = (run) => run?.status === 'completed' && (run.conclusion === 'failure' || run.conclusion === 'timed_out');

export function chooseFailure(runs, watched) {
  const names = [...watched].filter((name) => recoverable.has(name));
  const current = names.map((name) => latest(runs, name)).filter(Boolean);
  if (current.some((run) => waiting.has(run.status))) return { wait: true };
  const failed = current.filter(failedConclusion);
  if (!failed.length) return null;
  failed.sort((a, b) => (a.name === 'Merge Gate' ? -1 : b.name === 'Merge Gate' ? 1 : a.name.localeCompare(b.name)));
  return { wait: false, name: failed[0].name, runId: failed[0].runId ?? null };
}

export function planRecovery(snapshot) {
  const logs = [];
  const actions = [];
  const watched = new Set((snapshot.required ?? []).filter((name) => recoverable.has(name)));
  if (!watched.size) return { actions, logs: ['recover abort reason=no-recoverable-required-check'], abort: true };
  const state = normalizeState(snapshot.state, snapshot.now);
  const budget = Number.isSafeInteger(snapshot.budget) && snapshot.budget > 0 ? snapshot.budget : MAX_MUTATIONS;
  const log = (number, reason, extra = '') => logs.push(`recover skip pr=${number} reason=${reason}${extra}`);
  for (const pull of [...snapshot.pulls].sort((a, b) => a.number - b.number)) {
    if (!pull.autoMerge || pull.draft || !pull.sameRepo || !SHA.test(pull.headSha ?? '')) continue;
    if (pull.unreadable) { log(pull.number, pull.unreadable); continue; }
    const failure = chooseFailure(snapshot.checks[pull.headSha] ?? [], watched);
    if (!failure) continue;
    if (failure.wait) { log(pull.number, 'in-progress'); continue; }
    const master = latest(snapshot.checks[snapshot.masterSha] ?? [], failure.name);
    const masterRed = failedConclusion(master);
    // A behind head is the merge queue's job. Rerun only when master's same
    // check is red, so a PR's own failure is not retried.
    if (!masterRed) { log(pull.number, 'own-failure', ` check=${failure.name}`); continue; }
    const jobs = failure.runId == null ? null : snapshot.jobs[String(failure.runId)];
    if (!jobs || !Array.isArray(jobs.failed) || !Number.isSafeInteger(jobs.runAttempt)) {
      log(pull.number, 'jobs-unknown', ` check=${failure.name}`);
      continue;
    }
    if (jobs.failed.some(protectedJob)) { log(pull.number, 'protected-job', ` check=${failure.name}`); continue; }
    if (attemptsFor(state, pull.number, snapshot.now) >= MAX_PR_ATTEMPTS) { log(pull.number, 'pr-budget'); continue; }
    if (actions.length >= budget) { log(pull.number, 'budget'); continue; }
    if (seen(state, pull.headSha, 'rerun')) { log(pull.number, 'already-retried'); continue; }
    if (jobs.runAttempt !== 1) { log(pull.number, 'already-retried', ` attempt=${jobs.runAttempt}`); continue; }
    actions.push({ kind: 'rerun', pr: pull.number, sha: pull.headSha, runId: failure.runId, check: failure.name });
    logs.push(`recover rerun pr=${pull.number} sha=${pull.headSha.slice(0, 7)} run=${failure.runId} attempt=1 check=${failure.name}`);
  }
  return { actions, logs, abort: false };
}

export function mutationRequest(repo, action) {
  if (repo !== REPO) throw new Error('unexpected repository');
  switch (action.kind) {
    case 'rerun':
      if (!Number.isSafeInteger(action.runId) || action.runId < 1) throw new Error('invalid rerun');
      return { args: ['api', '--method', 'POST', `repos/${repo}/actions/runs/${action.runId}/rerun-failed-jobs`], body: null };
    default: {
      const never = action.kind;
      throw new Error(`unknown recovery action ${never}`);
    }
  }
}

function parseBody(body) {
  if (body == null || body === '') return null;
  return typeof body === 'string' ? JSON.parse(body) : body;
}

async function apiGet(gh, path) {
  const result = await gh(['api', '--method', 'GET', path]);
  if (!result?.ok) return { ok: false, status: result?.status ?? 0, body: null };
  try { return { ok: true, status: result.status ?? 200, body: parseBody(result.body) }; }
  catch { return { ok: false, status: 0, body: null }; }
}

function checksFrom(body) {
  const runs = Array.isArray(body?.check_runs) ? body.check_runs : null;
  if (!runs) return null;
  const checks = [];
  for (const run of runs) {
    if (!Number.isSafeInteger(run?.id) || typeof run?.name !== 'string') continue;
    const details = typeof run.details_url === 'string' ? run.details_url : '';
    const match = /\/actions\/runs\/(\d+)\/job\/(\d+)$/.exec(details);
    const runId = match ? Number(match[1]) : null;
    checks.push({
      id: run.id,
      name: run.name,
      status: typeof run.status === 'string' ? run.status : '',
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null,
    });
  }
  return { checks, total: body.total_count, page: runs.length };
}

async function checkPages(gh, repo, sha) {
  const checks = [];
  let total = null;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const reply = await apiGet(gh, `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    if (!reply.ok) return { ok: false };
    const parsed = checksFrom(reply.body);
    if (!parsed || (Number.isSafeInteger(parsed.total) && total != null && parsed.total !== total)) return { ok: false };
    total = Number.isSafeInteger(parsed.total) ? parsed.total : null;
    checks.push(...parsed.checks);
    if (parsed.page < 100 || (total != null && checks.length >= total)) return { ok: true, checks, complete: true };
  }
  return { ok: true, checks, complete: false };
}

function pullRow(row) {
  const number = row?.number;
  const headSha = row?.head?.sha;
  if (!Number.isSafeInteger(number) || number < 1 || typeof headSha !== 'string' || !SHA.test(headSha)) return null;
  const headRepo = row?.head?.repo?.full_name;
  const baseRepo = row?.base?.repo?.full_name;
  return {
    number,
    draft: row.draft === true,
    autoMerge: row.auto_merge != null,
    headSha,
    sameRepo: headRepo === REPO && baseRepo === REPO,
  };
}

export async function loadSnapshot(gh, repo) {
  if (repo !== REPO) return { ok: false, reason: 'repository' };
  const rules = await apiGet(gh, `repos/${repo}/rules/branches/master?per_page=100`);
  if (!rules.ok && rules.status !== 404) return { ok: false, reason: 'rules-unreadable' };
  if (rules.ok && !Array.isArray(rules.body)) return { ok: false, reason: 'rules-unreadable' };
  if (Array.isArray(rules.body) && rules.body.length >= 100) return { ok: false, reason: 'rules-truncated' };
  const branch = await apiGet(gh, `repos/${repo}/branches/master`);
  if (!branch.ok || !branch.body) return { ok: false, reason: 'branch-unreadable' };
  const masterSha = branch.body.commit?.sha;
  if (typeof masterSha !== 'string' || !SHA.test(masterSha)) return { ok: false, reason: 'master-sha' };
  const required = requiredChecks(rules.status === 404 ? [] : rules.body, branch.body);
  const pulls = [];
  let capped = false;
  for (let page = 1; page <= PAGE_CAP; page += 1) {
    const reply = await apiGet(gh, `repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`);
    if (!reply.ok || !Array.isArray(reply.body)) return { ok: false, reason: 'pulls-unreadable' };
    for (const row of reply.body) {
      const pull = pullRow(row);
      if (pull?.autoMerge && !pull.draft && pull.sameRepo) pulls.push(pull);
    }
    if (reply.body.length < 100) break;
    // Recovery needs complete checks for each selected PR, not every open PR.
    // Keep this pass bounded even when the repository has a large backlog.
    if (page === PAGE_CAP) capped = true;
  }
  const watched = required.filter((name) => recoverable.has(name));
  if (!watched.length) return { ok: true, snapshot: { required, masterSha, pulls: [], checks: {}, jobs: {} }, capped: false };
  const masterChecks = await checkPages(gh, repo, masterSha);
  if (!masterChecks.ok || !masterChecks.complete) return { ok: false, reason: 'master-checks-unreadable' };
  const checks = { [masterSha]: masterChecks.checks };
  const jobs = {};
  const selected = pulls.slice(0, SCAN_CAP);
  for (const pull of selected) {
    const head = await checkPages(gh, repo, pull.headSha);
    if (!head.ok || !head.complete) { pull.unreadable = 'checks-unreadable'; checks[pull.headSha] = []; continue; }
    checks[pull.headSha] = head.checks;
    const failure = chooseFailure(head.checks, watched);
    if (!failure || failure.wait || failure.runId == null) continue;
    const jobReply = await apiGet(gh, `repos/${repo}/actions/runs/${failure.runId}/jobs?per_page=100&filter=latest`);
    const list = Array.isArray(jobReply.body?.jobs) ? jobReply.body.jobs : null;
    const total = jobReply.body?.total_count;
    if (!jobReply.ok || !list || !Number.isSafeInteger(total) || total > list.length) continue;
    const attempt = list.find((job) => Number.isSafeInteger(job?.run_attempt) && job.run_attempt > 0)?.run_attempt ?? null;
    if (attempt == null) continue;
    jobs[String(failure.runId)] = {
      runAttempt: attempt,
      failed: list.filter((job) => job?.conclusion === 'failure' || job?.conclusion === 'timed_out').map((job) => job.name).filter((name) => typeof name === 'string'),
    };
  }
  return {
    ok: true,
    snapshot: { required, masterSha, pulls: selected, checks, jobs },
    capped: capped || pulls.length > SCAN_CAP,
  };
}

function defaultGh(args, input) {
  try {
    const body = execFileSync('gh', args, {
      encoding: 'utf8', input, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, status: 200, body };
  } catch (error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr : `${error.stderr ?? ''}`;
    const stdout = typeof error.stdout === 'string' ? error.stdout : `${error.stdout ?? ''}`;
    return { ok: false, status: Number(/HTTP (\d{3})/.exec(stderr)?.[1] ?? 0), body: stdout };
  }
}

function readState(path, now) {
  if (!existsSync(path)) return normalizeState(null, now);
  return normalizeState(JSON.parse(readFileSync(path, 'utf8')), now);
}

function writeState(path, state) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function main(options = {}) {
  const log = options.log ?? ((line) => console.log(line));
  const env = options.env ?? process.env;
  if (options.allowLocal !== true && env.GITHUB_ACTIONS !== 'true') {
    log('recover refuse reason=not-actions');
    return 2;
  }
  const repo = options.repo ?? env.GITHUB_REPOSITORY;
  if (repo !== REPO) { log('recover refuse reason=repository'); return 2; }
  const statePath = options.statePath ?? process.env.RECOVER_STATE;
  if (typeof statePath !== 'string' || statePath.length === 0 || statePath.includes('\0')) {
    log('recover abort reason=state-path');
    return 1;
  }
  const now = options.now ?? Date.now();
  const gh = options.gh ?? defaultGh;
  let state;
  try { state = readState(statePath, now); }
  catch { log('recover abort reason=state-unreadable'); return 1; }
  try { writeState(statePath, state); }
  catch { log('recover abort reason=state-unwritable'); return 1; }
  const loaded = await loadSnapshot(gh, repo);
  if (!loaded.ok) { log(`recover abort reason=${loaded.reason}`); return 1; }
  if (loaded.capped) log(`recover note scan-capped kept=${loaded.snapshot.pulls.length}`);
  const plan = planRecovery({ ...loaded.snapshot, state, now, budget: MAX_MUTATIONS });
  for (const line of plan.logs) log(line);
  if (plan.abort) return 1;
  const applied = [];
  let fatal = false;
  for (const action of plan.actions) {
    const request = mutationRequest(repo, action);
    let result;
    try { result = await gh(request.args, request.body == null ? undefined : JSON.stringify(request.body)); }
    catch { result = { ok: false, status: 0 }; }
    const status = Number.isSafeInteger(result?.status) ? result.status : 0;
    log(`recover result ${action.kind} pr=${action.pr} ok=${result?.ok ? 'true' : 'false'} status=${status}`);
    if (result?.ok || status === 422) applied.push(action);
    else if (status === 0 || status === 401 || status === 403 || status >= 500) fatal = true;
  }
  try { writeState(statePath, commitAttempts(state, applied, now)); }
  catch { log('recover abort reason=state-unwritable'); return 1; }
  log(`recover done actions=${applied.length}`);
  return fatal ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
