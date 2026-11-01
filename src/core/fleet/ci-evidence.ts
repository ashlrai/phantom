import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunResult, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const JOBS_MAX_BYTES = 4 * 1024 * 1024;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MAX_STEPS = 20;
const MAX_EXCERPTS = 20;
const MAX_FIELD = 200;
const MAX_LINE = 400;

export type EvidenceStatus = 'ok' | 'jobs_unavailable' | 'jobs_truncated' | 'jobs_invalid' |
  'job_not_found' | 'job_invalid' | 'log_unavailable' | 'log_truncated';
export interface CiEvidence {
  version: 1;
  repo: string;
  run: number;
  job: number;
  source: { status: EvidenceStatus; truncated: boolean; outputTruncated: boolean };
  headSha: string | null;
  jobName: string | null;
  conclusion: string | null;
  failedSteps: string[];
  excerpts: string[];
}

// Control sequences are removed before scrubbing, so they cannot split a secret.
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return scrubSecrets(stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The only side effects are bounded GETs through the injected argv-only runner. */
export async function readCiEvidence(repo: string, run: number, job: number, runner: GitRunner = defaultGitRunner): Promise<CiEvidence> {
  const result: CiEvidence = {
    version: 1, repo: clean(repo), run, job, source: { status: 'jobs_unavailable', truncated: false, outputTruncated: false },
    headSha: null, jobName: null, conclusion: null, failedSteps: [], excerpts: [],
  };
  const read = async (args: string[], maxStdoutBytes: number): Promise<GitRunResult | null> => {
    try { return await runner('gh', args, { cwd: tmpdir(), timeoutMs: TIMEOUT_MS, maxStdoutBytes }); } catch { return null; }
  };
  const jobs = await read(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${run}/jobs?filter=all&per_page=100`], JOBS_MAX_BYTES);
  if (jobs?.truncated) {
    result.source = { status: 'jobs_truncated', truncated: true, outputTruncated: false };
    return result;
  }
  if (!jobs || jobs.code !== 0 || jobs.timedOut || jobs.missing) return result;
  let pages: unknown;
  try { pages = JSON.parse(jobs.stdout); } catch { result.source.status = 'jobs_invalid'; return result; }
  if (!Array.isArray(pages) || pages.length === 0) { result.source.status = 'jobs_invalid'; return result; }
  const rows: unknown[] = [];
  let total: number | undefined;
  for (const page of pages) {
    const p = record(page);
    if (!p || !Number.isSafeInteger(p['total_count']) || (p['total_count'] as number) < 0 ||
        !Array.isArray(p['jobs']) || (total !== undefined && total !== p['total_count'])) {
      result.source.status = 'jobs_invalid'; return result;
    }
    total = p['total_count'] as number;
    rows.push(...p['jobs']);
  }
  if (rows.length !== total || rows.some((row) => !record(row) || !Number.isSafeInteger(record(row)!['id']))) {
    result.source.status = 'jobs_invalid'; return result;
  }
  const matches = rows.map(record).filter((row) => row?.['id'] === job);
  if (matches.length === 0) { result.source.status = 'job_not_found'; return result; }
  const selected = matches[0]!;
  if (matches.length !== 1 || selected['run_id'] !== run || typeof selected['name'] !== 'string' ||
      !selected['name'] || typeof selected['head_sha'] !== 'string' || !/^[a-f\d]{40,64}$/i.test(selected['head_sha']) ||
      typeof selected['conclusion'] !== 'string' || !Array.isArray(selected['steps']) ||
      selected['steps'].some((step: unknown) => !record(step) || typeof record(step)!['name'] !== 'string' ||
        typeof record(step)!['conclusion'] !== 'string' && record(step)!['conclusion'] !== null)) {
    result.source.status = 'job_invalid'; return result;
  }
  const limit = (value: string, max: number): string => {
    const safe = clean(value).replace(/[\r\n]+/g, ' ');
    if (safe.length > max) result.source.outputTruncated = true;
    return safe.slice(0, max);
  };
  result.headSha = clean(selected['head_sha']);
  result.jobName = limit(selected['name'], MAX_FIELD);
  result.conclusion = limit(selected['conclusion'], MAX_FIELD);
  const failed = (selected['steps'] as unknown[]).map((step) => record(step)!).filter((step) => step['conclusion'] === 'failure');
  result.failedSteps = failed.slice(0, MAX_STEPS).map((step) => limit(step['name'] as string, MAX_FIELD));
  if (failed.length > MAX_STEPS) result.source.outputTruncated = true;
  result.source.status = 'log_unavailable';
  const log = await read(['api', `repos/${repo}/actions/jobs/${job}/logs`], LOG_MAX_BYTES);
  if (!log || log.timedOut || log.missing || (!log.truncated && log.code !== 0)) return result;
  if (log.truncated) { result.source.status = 'log_truncated'; result.source.truncated = true; }
  // Never treat a redirect, HTML error page, or empty response as a healthy log.
  if (!log.stdout.trim() || /^\s*(?:https?:\/\/\S+\s*$|<!doctype html|<html|HTTP\/\d)/i.test(log.stdout)) return result;
  if (!log.truncated) result.source.status = 'ok';
  // A byte cap can cut through a secret: discard the incomplete last line.
  const completeLog = log.truncated ? log.stdout.slice(0, Math.max(0, log.stdout.lastIndexOf('\n') + 1)) : log.stdout;
  const lines = clean(completeLog).split(/\r?\n/);
  const names = result.failedSteps.filter(Boolean).map((name) => name.toLowerCase());
  for (const line of lines) {
    if (!/(?:##\[error\]|\berror\b|\bfailed\b|\bfailure\b|\bexception\b)/i.test(line) &&
        !names.some((name) => line.toLowerCase().includes(name))) continue;
    if (result.excerpts.length >= MAX_EXCERPTS) { result.source.outputTruncated = true; break; }
    result.excerpts.push(limit(line.trim(), MAX_LINE));
  }
  return result;
}
