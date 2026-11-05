import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunResult, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const META_MAX_BYTES = 1024 * 1024;
const JOBS_MAX_BYTES = 4 * 1024 * 1024;
const RERUN_MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_NAMES = 50;
const MAX_FIELD = 200;
const SHA = /^[a-f\d]{40,64}$/i;
/** Job conclusions `gh run rerun --failed` re-runs; everything else is preserved. */
const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

export type CiRetryOutcome = 'planned' | 'submitted' | 'no-op' | 'unavailable' | 'refused';
export interface CiRetryReport {
  version: 1;
  repo: string;
  run: number;
  apply: boolean;
  outcome: CiRetryOutcome;
  reason: string;
  attempt: number | null;
  headSha: string | null;
  runStatus: string | null;
  conclusion: string | null;
  /** Jobs that passed and are preserved untouched (names capped at MAX_NAMES). */
  preserved: { count: number; names: string[] };
  /** Failed jobs the same run's latest attempt would re-run. */
  retry: { count: number; names: string[] };
  /** Skipped/cancelled/unknown-conclusion jobs: neither preserved-passing nor retried. */
  untouched: { count: number; names: string[] };
  mutation: { invoked: boolean; accepted: boolean; detail: string | null };
  truncated: boolean;
}

interface RunMeta { attempt: number; headSha: string; status: string; conclusion: string | null }
type MetaRead = RunMeta | 'unavailable' | 'truncated' | 'invalid' | 'mismatch';

// Control sequences are removed before scrubbing, so they cannot split a secret.
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Plans, and with `apply` submits, `gh run rerun <run> --failed` — failed jobs
 * only, same run, same attempt, same tree. No mutation happens unless the
 * completed latest-attempt metadata and failed-job evidence agree, and the
 * run metadata is re-read immediately before the mutation so an advanced
 * attempt or changed state is refused. Nothing claims GitHub scheduled or
 * finished anything: `submitted` means gh accepted the command.
 */
export async function planCiRetryFailed(repo: string, run: number, opts: { apply?: boolean; runner?: GitRunner } = {}): Promise<CiRetryReport> {
  const runner = opts.runner ?? defaultGitRunner;
  const apply = opts.apply === true;
  const report: CiRetryReport = {
    version: 1, repo: clean(repo), run, apply, outcome: 'unavailable', reason: 'run_metadata_unavailable',
    attempt: null, headSha: null, runStatus: null, conclusion: null,
    preserved: { count: 0, names: [] }, retry: { count: 0, names: [] }, untouched: { count: 0, names: [] },
    mutation: { invoked: false, accepted: false, detail: null }, truncated: false,
  };
  const read = async (args: string[], maxStdoutBytes: number): Promise<GitRunResult | null> => {
    try { return await runner('gh', args, { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes }); } catch { return null; }
  };
  const meta = async (): Promise<MetaRead> => {
    const res = await read(['api', `repos/${repo}/actions/runs/${run}`], META_MAX_BYTES);
    if (res?.truncated) return 'truncated';
    if (!res || res.code !== 0 || res.timedOut || res.missing) return 'unavailable';
    let m: Record<string, unknown> | null;
    try { m = record(JSON.parse(res.stdout)); } catch { return 'invalid'; }
    const repository = record(m?.['repository']);
    if (!m || !Number.isSafeInteger(m['id']) || !Number.isSafeInteger(m['run_attempt']) || (m['run_attempt'] as number) < 1 ||
        typeof m['head_sha'] !== 'string' || !SHA.test(m['head_sha']) ||
        typeof m['status'] !== 'string' || !m['status'] ||
        (m['conclusion'] !== null && typeof m['conclusion'] !== 'string') ||
        typeof repository?.['full_name'] !== 'string' || !repository['full_name']) return 'invalid';
    if (m['id'] !== run || repository['full_name'].toLowerCase() !== repo.toLowerCase()) return 'mismatch';
    return {
      attempt: m['run_attempt'] as number, headSha: clean(m['head_sha']), status: clean(m['status']),
      conclusion: m['conclusion'] === null ? null : clean(m['conclusion']),
    };
  };
  const name = (value: string, names: string[]): void => {
    const safe = clean(value).replace(/[\r\n]+/g, ' ');
    if (safe.length > MAX_FIELD || names.length >= MAX_NAMES) report.truncated = true;
    if (names.length < MAX_NAMES) names.push(safe.slice(0, MAX_FIELD));
  };
  const first = await meta();
  if (typeof first === 'string') {
    report.reason = `run_metadata_${first}`;
    if (first === 'truncated') report.truncated = true;
    return report;
  }
  report.attempt = first.attempt; report.headSha = first.headSha;
  report.runStatus = first.status; report.conclusion = first.conclusion;
  if (first.status !== 'completed') { report.outcome = 'refused'; report.reason = 'run_not_completed'; return report; }
  if (first.conclusion === null) { report.outcome = 'refused'; report.reason = 'unknown_conclusion'; return report; }
  const jobs = await read(['api', '--paginate', '--slurp',
    `repos/${repo}/actions/runs/${run}/jobs?filter=latest_attempt&per_page=100`], JOBS_MAX_BYTES);
  if (jobs?.truncated) { report.reason = 'jobs_truncated'; report.truncated = true; return report; }
  if (!jobs || jobs.code !== 0 || jobs.timedOut || jobs.missing) { report.reason = 'jobs_unavailable'; return report; }
  let pages: unknown;
  try { pages = JSON.parse(jobs.stdout); } catch { report.reason = 'jobs_invalid'; return report; }
  if (!Array.isArray(pages) || pages.length === 0) { report.reason = 'jobs_invalid'; return report; }
  const rows: unknown[] = [];
  let total: number | undefined;
  for (const page of pages) {
    const p = record(page);
    if (!p || !Number.isSafeInteger(p['total_count']) || (p['total_count'] as number) < 0 ||
        !Array.isArray(p['jobs']) || (total !== undefined && total !== p['total_count'])) {
      report.reason = 'jobs_invalid'; return report;
    }
    total = p['total_count'] as number;
    rows.push(...p['jobs']);
  }
  if (rows.length !== total) { report.reason = 'jobs_invalid'; return report; }
  for (const row of rows.map(record)) {
    if (!row || !Number.isSafeInteger(row['id']) || typeof row['name'] !== 'string' || !row['name'] ||
        (row['conclusion'] !== null && typeof row['conclusion'] !== 'string')) {
      report.reason = 'jobs_invalid'; return report;
    }
    if (row['run_id'] !== run || row['status'] !== 'completed' ||
        row['head_sha'] !== first.headSha ||
        (row['run_attempt'] !== undefined && row['run_attempt'] !== first.attempt)) {
      report.reason = 'jobs_mismatch'; return report;
    }
    const bucket = FAILED.has(row['conclusion'] as string) ? report.retry
      : row['conclusion'] === 'success' ? report.preserved : report.untouched;
    bucket.count += 1;
    name(row['name'] as string, bucket.names);
  }
  if (report.retry.count === 0) { report.outcome = 'no-op'; report.reason = 'no_failed_jobs'; return report; }
  if (!apply) { report.outcome = 'planned'; report.reason = 'failed_jobs'; return report; }
  // Re-read attempt/state immediately before mutating: a run that advanced an
  // attempt, moved head, reopened or changed conclusion is refused, not retried.
  const again = await meta();
  if (typeof again === 'string') {
    report.outcome = 'refused'; report.reason = 'revalidate_failed';
    if (again === 'truncated') report.truncated = true;
    return report;
  }
  if (again.attempt !== first.attempt || again.headSha !== first.headSha ||
      again.status !== 'completed' || again.conclusion !== first.conclusion) {
    report.outcome = 'refused'; report.reason = 'changed_before_apply'; return report;
  }
  report.mutation.invoked = true;
  const reran = await read(['run', 'rerun', String(run), '--failed', '--repo', repo], RERUN_MAX_BYTES);
  if (!reran || reran.code !== 0 || reran.timedOut || reran.missing || reran.truncated) {
    report.outcome = 'refused'; report.reason = 'rerun_rejected';
    const detail = clean(reran?.stderr || reran?.stdout || '').replace(/[\r\n]+/g, ' ').trim();
    report.mutation.detail = detail ? detail.slice(0, MAX_FIELD) : null;
    return report;
  }
  report.outcome = 'submitted'; report.reason = 'failed_jobs'; report.mutation.accepted = true;
  return report;
}
