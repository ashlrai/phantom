/** Read-only, bounded Actions run and attempt evidence; no notification delivery is observed. */
import { tmpdir } from 'node:os';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const USAGE = 'ashlr fleet ci-duplicate-runs --repo <owner/name> --since <UTC ISO timestamp> [--json]';
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const MAX_ATTEMPT_READS = 100;
const MAX_ATTEMPT = 10;

const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

type Output = { log: (message: string) => void; error: (message: string) => void };
export interface FleetCiDuplicateRunsDeps { gh?: CloudGh; now?: () => Date; output?: Output }
type Run = {
  id: number; workflowId: number; name: string; sha: string; attempt: number;
  event: string; branch: string | null; conclusion: string | null; status: string;
  createdAt: string; startedAt: string | null; updatedAt: string | null;
};

// Reject normalized invalid calendar dates and offsets; inputs must explicitly be UTC.
function utc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value.replace(/(?:\.(\d{1,3}))?Z$/, (_, ms: string | undefined) => `.${(ms ?? '').padEnd(3, '0')}Z`);
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const label = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const optionalLabel = (value: unknown): value is string | null => value === null || label(value);
const optionalTime = (value: unknown): value is string | null => value === null || utc(value);
function parseRun(raw: unknown): Run | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!positive(r.id) || !positive(r.workflow_id) || !positive(r.run_attempt) ||
      !label(r.name) || typeof r.head_sha !== 'string' || !/^[a-f\d]{40}$/i.test(r.head_sha) ||
      !label(r.event) || !optionalLabel(r.head_branch) || !optionalLabel(r.conclusion) || !label(r.status) ||
      !utc(r.created_at) || !optionalTime(r.run_started_at) || !optionalTime(r.updated_at)) return null;
  return { id: r.id, workflowId: r.workflow_id, name: r.name, sha: r.head_sha.toLowerCase(), attempt: r.run_attempt,
    event: r.event, branch: r.head_branch, conclusion: r.conclusion, status: r.status,
    createdAt: r.created_at, startedAt: r.run_started_at, updatedAt: r.updated_at };
}

async function read(gh: CloudGh, args: string[]): Promise<unknown> {
  try {
    const result = await gh(args);
    return result.ok ? JSON.parse(result.stdout) as unknown : null;
  } catch { return null; }
}

export async function cmdFleetCiDuplicateRuns(args: string[], deps: FleetCiDuplicateRunsDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  let repo = '';
  let since = '';
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output.error(`error: duplicate option\nusage: ${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--repo') repo = args[++i] ?? '';
    else if (arg === '--since') since = args[++i] ?? '';
    else if (arg === '--json') json = true;
    else { output.error(`error: invalid argument\nusage: ${USAGE}`); return 2; }
  }
  const collected = (deps.now ?? (() => new Date()))();
  if (!REPO.test(repo) || repo.endsWith('/.') || repo.endsWith('/..') || !utc(since) ||
      !Number.isFinite(collected.getTime()) || Date.parse(since) > collected.getTime()) {
    output.error(`error: explicit repository and valid UTC cutoff no later than collection time required\nusage: ${USAGE}`); return 2;
  }
  const collectedAt = collected.toISOString();
  const gh = deps.gh ?? defaultGh;
  const runs: Run[] = [];
  const ids = new Set<number>();
  const problems: string[] = [];
  let pages = 0;
  let total: number | null = null;
  let reachedEnd = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await read(gh, ['api', '-X', 'GET', `repos/${repo}/actions/runs`, '-f', `per_page=${PAGE_SIZE}`,
      '-f', `page=${page}`, '-f', `created=${since}..${collectedAt}`]);
    if (!data || typeof data !== 'object' || !('workflow_runs' in data) || !Array.isArray(data.workflow_runs) ||
        !('total_count' in data) || !Number.isSafeInteger(data.total_count) || (data.total_count as number) < 0 || data.workflow_runs.length > PAGE_SIZE) {
      problems.push(`page ${page} unavailable or malformed`); break;
    }
    pages++;
    const count = data.total_count as number;
    if (total !== null && count !== total) problems.push('run count changed during collection');
    total = count;
    for (const raw of data.workflow_runs) {
      const run = parseRun(raw);
      if (!run || ids.has(run.id)) { problems.push('malformed or repeated run in pages'); continue; }
      ids.add(run.id);
      if (Date.parse(run.createdAt) < Date.parse(since) || Date.parse(run.createdAt) > collected.getTime()) {
        problems.push('run outside requested creation interval'); continue;
      }
      runs.push(run);
    }
    if (data.workflow_runs.length < PAGE_SIZE) {
      reachedEnd = true;
      if ((page - 1) * PAGE_SIZE + data.workflow_runs.length !== count) problems.push('page length disagrees with reported total');
      break;
    }
  }
  if (!reachedEnd && total !== null && pages * PAGE_SIZE >= total) reachedEnd = true;
  const truncated = !reachedEnd && pages === MAX_PAGES;
  if (truncated) problems.push('run page limit reached');

  const attempts: Run[] = [...runs];
  let attemptReads = 0;
  const incompleteRuns = new Set<number>();
  for (const run of runs) {
    if (run.attempt > MAX_ATTEMPT) { incompleteRuns.add(run.id); problems.push('attempt limit reached'); }
    for (let n = 1; n < Math.min(run.attempt, MAX_ATTEMPT + 1); n++) {
      if (attemptReads >= MAX_ATTEMPT_READS) { incompleteRuns.add(run.id); problems.push('attempt read limit reached'); break; }
      attemptReads++;
      const raw = await read(gh, ['api', `repos/${repo}/actions/runs/${run.id}/attempts/${n}`]);
      const prior = parseRun(raw);
      if (!prior || prior.id !== run.id || prior.workflowId !== run.workflowId || prior.sha !== run.sha || prior.attempt !== n) {
        incompleteRuns.add(run.id); problems.push('attempt unavailable, malformed, or mismatched'); continue;
      }
      attempts.push(prior);
    }
  }
  const grouped = new Map<string, Run[]>();
  for (const run of attempts) {
    const key = `${run.workflowId}:${run.sha}`;
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  const groups = [...grouped.values()].filter((items) => new Set(items.map((r) => r.id)).size > 1 || items.some((r) => r.attempt > 1)).map((items) => {
    items.sort((a, b) => Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt) || a.id - b.id || a.attempt - b.attempt);
    const distinct = new Set(items.map((r) => r.id));
    const pushPr = items.some((a) => a.event === 'push' && items.some((b) => b.event === 'pull_request' && b.id !== a.id));
    const durations = items.map((r) => r.status === 'completed' && r.startedAt && r.updatedAt && Date.parse(r.updatedAt) >= Date.parse(r.startedAt)
      ? (Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 1000 : null);
    const completeAttempts = items.every((r) => !incompleteRuns.has(r.id));
    return {
      workflowId: items[0]!.workflowId, workflowName: items[0]!.name, headSha: items[0]!.sha,
      separateRuns: distinct.size > 1, rerunAttempts: items.some((r) => r.attempt > 1), pushPrDuplicate: pushPr,
      repeatedFailedNotificationEvidence: items.filter((r) => r.conclusion === 'failure').length > 1,
      attemptsComplete: completeAttempts,
      observedRepeatedExecutionSeconds: completeAttempts && durations.every((d) => d !== null)
        ? durations.slice(1).reduce<number>((sum, d) => sum + d!, 0) : null,
      attempts: items.map((r) => ({ runId: r.id, attempt: r.attempt, event: r.event, branch: r.branch,
        status: r.status, conclusion: r.conclusion, startedAt: r.startedAt, updatedAt: r.updatedAt,
        url: `https://github.com/${repo}/actions/runs/${r.id}/attempts/${r.attempt}` })),
    };
  });
  const report = {
    v: 1, repo, collectedAt, coverage: { since, until: collectedAt, basis: 'run creation time', pageSize: PAGE_SIZE,
      maxPages: MAX_PAGES, pagesRead: pages, reportedTotal: total, runsRead: runs.length, attemptReads, truncated,
      complete: reachedEnd && problems.length === 0, problems: [...new Set(problems)] },
    notes: ['Retries of runs created before the cutoff are excluded.', 'Seconds use run_started_at to updated_at for completed attempts; they are observed elapsed time, not billing savings.',
      'Repeated failures are notification evidence only; email delivery is not observed.'], groups,
  };
  // All remotely supplied strings are scrubbed and terminal control/bidi characters escaped.
  const safe = JSON.stringify(sanitizePublicJson(report)).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  if (json) output.log(safe);
  else output.log(`Fleet CI duplicate runs: ${safe}`);
  return report.coverage.complete ? 0 : 1;
}
