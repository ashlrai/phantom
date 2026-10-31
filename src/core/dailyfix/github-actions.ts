/**
 * github-actions.ts — GitHub Actions API client for daily fix polling.
 *
 * Uses `gh` CLI for authentication. Supports ETag-based conditional requests
 * so 304 Not Modified responses don't count against the rate limit.
 *
 * NEVER reads, prints, or stores raw tokens. `gh` owns its own auth.
 * All spawns use spawnSync with a tight timeout and no shell.
 */

import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_BIN = 'gh';
const TIMEOUT_MS = 15_000;
const MAX_RUNS = 30; // generous bound for the per_page parameter
const MAX_JOBS = 100;
const MAX_ARTIFACTS = 50;
const MAX_LOG_EXCERPT_BYTES = 8_192;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A failed job extracted from a workflow run. */
export interface FailedJob {
  name: string;
  conclusion: string;
  /** Test names that failed, if identifiable from the job output. */
  testNames: string[];
  /** Key log excerpts (truncated to MAX_LOG_EXCERPT_BYTES total). */
  logExcerpt: string;
  /** Shard identifier if applicable (e.g. "2/4"). */
  shardId: string | null;
}

/** A workflow run from the GitHub Actions API. */
export interface WorkflowRun {
  id: number;
  name: string;
  status: 'completed' | 'in_progress' | 'queued' | 'requested' | 'waiting';
  conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | null;
  event: string;
  created_at: string;
  updated_at: string;
  head_sha: string;
  head_branch: string;
  run_number: number;
}

/** An artifact associated with a workflow run. */
export interface WorkflowArtifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expires_at: string;
}

/** Result of a single repo poll. */
export interface PollResult {
  repo: string;
  etag: string | null;
  /** True if the API returned 304 (not modified). */
  notModified: boolean;
  runs: WorkflowRun[];
}

/** A complete daily fix candidate: run data + failed jobs. */
export interface DailyFixCandidate {
  run: WorkflowRun;
  failedJobs: FailedJob[];
  artifact: WorkflowArtifact | null;
}

// ---------------------------------------------------------------------------
// GitHub Actions API client
// ---------------------------------------------------------------------------

interface GhApiResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  headers: Record<string, string>;
}

/**
 * Call `gh api` for the GitHub Actions API with optional ETag header.
 * Returns parsed JSON and response headers (including ETag).
 * A 304 response returns { notModified: true }.
 *
 * @param repo  Full repo name (e.g. "ashlrai/phantom").
 * @param path  API path (e.g. "/repos/ashlrai/phantom/actions/runs").
 * @param etag  Optional ETag for conditional requests.
 * @returns Parsed response or { notModified: true }.
 */
export function ghApiActions(
  repo: string,
  path: string,
  etag?: string,
): GhApiResult {
  const args: string[] = ['api', path];

  // Add ETag header for conditional requests.
  if (etag) {
    args.push('-H', `If-None-Match: ${etag}`);
  }

  const result = spawnSync(GH_BIN, args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024, // 4 MB
    encoding: 'utf8',
    shell: false,
  });

  const exitCode = result.status ?? result.signal ? null : 0;
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';

  // Extract headers from stderr (gh api prints headers to stderr by default).
  const headers: Record<string, string> = {};
  for (const line of stderr.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key && value) {
        headers[key] = value;
      }
    }
  }

  return { exitCode, stdout, stderr, headers };
}

/**
 * List the most recent workflow runs for a repo, filtered to schedule and
 * workflow_dispatch events. Uses ETag for conditional requests.
 *
 * 304 Not Modified does NOT count against the rate limit.
 */
export function listWorkflowRuns(repo: string, etag?: string): PollResult {
  const path = `/repos/${repo}/actions/runs?event=schedule,workflow_dispatch&per_page=1`;
  const result = ghApiActions(repo, path, etag);

  // 304 = not modified (check both exit code and header).
  if (result.headers['http-status-code'] === '304' || result.exitCode === 304) {
    return { repo, etag: result.headers['etag'] ?? etag ?? null, notModified: true, runs: [] };
  }

  // Parse response.
  const runs: WorkflowRun[] = [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.workflow_runs)) {
      for (const run of parsed.workflow_runs) {
        if (isWorkflowRun(run)) {
          runs.push(run);
        }
      }
    }
  } catch {
    // Malformed response — return empty, caller can retry.
  }

  return {
    repo,
    etag: result.headers['etag'] ?? null,
    notModified: false,
    runs,
  };
}

/** Validate a workflow run object from the API. */
function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  return Number.isInteger(run.id) && run.id > 0 &&
    typeof run.name === 'string' &&
    typeof run.status === 'string' &&
    typeof run.event === 'string' &&
    typeof run.created_at === 'string' &&
    typeof run.updated_at === 'string' &&
    (run.conclusion === null || typeof run.conclusion === 'string');
}

/**
 * List failed jobs for a workflow run. Returns only jobs with a non-success
 * conclusion.
 */
export function listFailedJobs(repo: string, runId: number): FailedJob[] {
  const path = `/repos/${repo}/actions/runs/${runId}/jobs?per_page=${MAX_JOBS}`;
  const result = ghApiActions(repo, path);

  if (result.exitCode !== 0) return [];

  const jobs: FailedJob[] = [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) {
      for (const job of parsed.jobs) {
        if (isFailedJob(job)) {
          jobs.push({
            name: job.name,
            conclusion: job.conclusion,
            testNames: extractTestNames(job.steps ?? []),
            logExcerpt: extractLogExcerpt(job.steps ?? []),
            shardId: job.labels?.find((l: string) => l.startsWith('shard')).replace('shard-', null) ?? null,
          });
        }
      }
    }
  } catch {
    // Malformed response — return empty.
  }

  return jobs;
}

/** Validate a failed job object. */
function isFailedJob(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const job = value as Record<string, unknown>;
  const conclusion = job.conclusion;
  return conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'startup_failure';
}

/** Extract test names from job steps. */
function extractTestNames(steps: unknown[]): string[] {
  const names: string[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    if (s.conclusion === 'failure' && typeof s.name === 'string' && s.name) {
      names.push(s.name);
    }
  }
  return names;
}

/** Extract a concise log excerpt from job steps. */
function extractLogExcerpt(steps: unknown[]): string {
  const excerpts: string[] = [];
  let totalBytes = 0;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    if (s.conclusion === 'failure' && typeof s.name === 'string' && s.name) {
      // We can't download logs via the API here (needs separate auth).
      // Instead, note which steps failed.
      const excerpt = `FAILED: ${s.name}`;
      if (totalBytes + Buffer.byteLength(excerpt) <= MAX_LOG_EXCERPT_BYTES) {
        excerpts.push(excerpt);
        totalBytes += Buffer.byteLength(excerpt);
      }
    }
  }
  return excerpts.join('\n');
}

/**
 * List artifacts for a workflow run, looking for the fixup queue artifact.
 */
export function listArtifacts(repo: string, runId: number): WorkflowArtifact[] {
  const path = `/repos/${repo}/actions/runs/${runId}/artifacts?per_page=${MAX_ARTIFACTS}`;
  const result = ghApiActions(repo, path);

  if (result.exitCode !== 0) return [];

  const artifacts: WorkflowArtifact[] = [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.artifacts)) {
      for (const art of parsed.artifacts) {
        if (isWorkflowArtifact(art)) {
          artifacts.push(art);
        }
      }
    }
  } catch {
    // Malformed response — return empty.
  }

  return artifacts;
}

/** Validate an artifact object. */
function isWorkflowArtifact(value: unknown): value is WorkflowArtifact {
  if (!value || typeof value !== 'object') return false;
  const art = value as Record<string, unknown>;
  return Number.isInteger(art.id) && art.id > 0 &&
    typeof art.name === 'string' &&
    typeof art.size_in_bytes === 'number' &&
    typeof art.expires_at === 'string';
}

/**
 * Download artifact contents as JSON. Returns the parsed object or null.
 * The fixup queue artifact is expected to be a JSON file.
 */
export function downloadArtifact(
  repo: string,
  artifactId: number,
): unknown {
  const path = `/repos/${repo}/actions/artifacts/${artifactId}/archive.zip`;
  const result = spawnSync(GH_BIN, ['api', path, '--output', '-'], {
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    encoding: 'utf8',
    shell: false,
  });

  if (result.status !== 0) return null;
  if (!result.stdout || !result.stdout.trim()) return null;

  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}
