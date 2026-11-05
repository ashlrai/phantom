/**
 * Receipt-artifact await for the RESUME-FROM-FAILURE and t1626u batching
 * orders: a recovery session may block on one exact run/attempt until the
 * explicitly named artifact lands, then bind it through the merged
 * discoverCiReceiptPrior path — the same evidence, the same validated
 * CiResumePrior document out, without relaunching agents.
 *
 * Pending is proven by evidence, never by matching error text: each
 * observation is a bounded GET of the exact attempt's metadata plus the
 * run's artifact list, and only a positively observed running/queued
 * attempt whose named artifact is still absent may sleep and retry. A
 * completed attempt with the artifact missing is unavailable; duplicate,
 * expired, malformed or mismatched evidence is terminal. One observation
 * is in flight at a time — a read that outlives the deadline is reported
 * as the read it was, never as absence — and the wait never substitutes
 * another attempt, guesses a name, synthesizes receipts, dispatches a
 * workflow or mutates a check: every call is a GET.
 */
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { defaultGitRunner, type GitRunner, type GitRunResult } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';
import { CiResumeInputsError } from './ci-resume-inputs.js';
import { abortableSleep, isAwaitMs } from './needs-mason-answer-await.js';
import { artifactNameField, discoverCiReceiptPrior } from './ci-receipt-discovery.js';
import type { CiResumeReceiptsFetch } from './ci-resume-receipts.js';

const GH_TIMEOUT_MS = 30_000;
const META_MAX_BYTES = 1024 * 1024;
const LIST_MAX_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ROWS = 2048;
const SHA40 = /^[0-9a-f]{40}$/i;

/** A wait can never outlast one hour; polling stays a positive sane interval. */
export const CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS = 3_600_000;
export const CI_RECEIPT_AWAIT_MAX_POLL_MS = 3_600_000;
export const CI_RECEIPT_AWAIT_MIN_POLL_MS = 250;
export const CI_RECEIPT_AWAIT_DEFAULT_TIMEOUT_MS = 600_000;
export const CI_RECEIPT_AWAIT_DEFAULT_POLL_MS = 5_000;

/** Attempt statuses GitHub reports while the attempt may still produce artifacts. */
const ATTEMPT_ACTIVE = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

// Function declaration, not a const arrow: the compiler only propagates
// never-returning CFA narrowing through declared functions.
function fail(message: string): never { throw new CiResumeInputsError(message); }
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const jsonOut = (r: GitRunResult, label: string): unknown => {
  try { return JSON.parse(r.stdout); } catch { fail(`${label} returned malformed JSON`); }
};

async function api(gh: GitRunner, args: string[], maxStdoutBytes: number, label: string): Promise<GitRunResult> {
  let r: GitRunResult;
  try { r = await gh('gh', args, { cwd: tmpdir(), timeoutMs: GH_TIMEOUT_MS, maxStdoutBytes }); }
  catch { throw new CiResumeInputsError(`${label} could not run`); }
  if (r.missing) fail('gh is not installed');
  if (r.timedOut) fail(`${label} timed out`);
  if (r.truncated) fail(`${label} output exceeded its bound`);
  if (r.code !== 0) fail(`${label} failed: ${scrubSecrets((r.stderr.split('\n')[0] ?? '').trim()).slice(0, 160)}`);
  return r;
}

/** The attempt must prove itself the exact run/attempt asked for — pending is never inferred. */
function attemptStatus(value: unknown, repo: string, run: number, attempt: number): string {
  const m = record(value) ?? fail('attempt metadata is malformed');
  const repository = record(m['repository']);
  if (m['id'] !== run || m['run_attempt'] !== attempt
    || typeof repository?.['full_name'] !== 'string'
    || repository['full_name'].toLowerCase() !== repo.toLowerCase()) {
    fail('attempt metadata does not match the requested repository, run or attempt');
  }
  if (typeof m['head_sha'] !== 'string' || !SHA40.test(m['head_sha'])) fail('attempt metadata is malformed');
  const status = m['status'];
  if (typeof status !== 'string' || (status !== 'completed' && !ATTEMPT_ACTIVE.has(status))) {
    fail('attempt metadata is malformed');
  }
  return status;
}

interface ArtifactBearer { name: string; expired: boolean; runId: number | null }

/** Same bounded `--paginate --slurp` listing as discovery; refuses partial or drifting counts. */
function listedArtifacts(value: unknown): ArtifactBearer[] {
  if (!Array.isArray(value) || value.length === 0) fail('run artifacts evidence is malformed');
  const rows: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (const page of value) {
    const p = record(page);
    if (!p || !Number.isSafeInteger(p['total_count']) || (p['total_count'] as number) < 0
      || !Array.isArray(p['artifacts']) || (total !== undefined && total !== p['total_count'])) {
      fail('run artifacts evidence is malformed');
    }
    total = p['total_count'] as number;
    for (const row of p['artifacts'] as unknown[]) rows.push(record(row) ?? fail('run artifacts evidence is malformed'));
  }
  if (total === undefined || rows.length !== total || total > MAX_LIST_ROWS) fail('run artifacts pagination is ambiguous');
  return rows.map((a): ArtifactBearer => {
    if (!Number.isSafeInteger(a['id']) || (a['id'] as number) < 1 || typeof a['expired'] !== 'boolean'
      || artifactNameField(a['name']) === null) fail('run artifacts evidence is malformed');
    const wf = a['workflow_run'] === undefined || a['workflow_run'] === null ? null
      : record(a['workflow_run']) ?? fail('run artifacts evidence is malformed');
    const runId = wf === null ? null : Number.isSafeInteger(wf['id']) ? wf['id'] as number
      : fail('run artifacts evidence is malformed');
    return { name: a['name'] as string, expired: a['expired'] as boolean, runId };
  });
}

/** Presence of the exact name. Duplicates and expiry stay terminal — waiting never resolves them. */
function artifactPresent(rows: ArtifactBearer[], run: number, name: string): boolean {
  const bearers = rows.filter((r) => r.name === name);
  if (bearers.length > 1) fail(`artifact name "${name}" has ${bearers.length} bearers in run ${run}`);
  const only = bearers[0];
  if (!only) return false;
  if (only.expired) fail(`artifact "${name}" in run ${run} is expired`);
  if (only.runId !== null && only.runId !== run) fail(`artifact "${name}" does not belong to run ${run}`);
  return true;
}

export interface CiReceiptAwaitOptions {
  repo: string; run: number; attempt: number; artifactName: string;
  /** Total wait bound, at most CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS (one hour). */
  timeoutMs: number;
  /** Delay between observations; each sleep is also capped by the time remaining. */
  pollMs?: number;
  signal?: AbortSignal;
}
export interface CiReceiptAwaitDeps {
  gh?: GitRunner;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Resolves after ms or as soon as the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Wait for the named artifact on one exact attempt, then hand it to the
 * merged discoverCiReceiptPrior binder unchanged. Throws
 * CiResumeInputsError on timeout, abort or any terminal evidence state; a
 * failure never yields a prior document.
 */
export async function awaitCiReceipt(opts: CiReceiptAwaitOptions,
    deps: CiReceiptAwaitDeps = {}): Promise<CiResumeReceiptsFetch> {
  const pollMs = opts.pollMs ?? CI_RECEIPT_AWAIT_DEFAULT_POLL_MS;
  if (!isAwaitMs(opts.timeoutMs, CI_RECEIPT_AWAIT_MAX_TIMEOUT_MS)
    || !isAwaitMs(pollMs, CI_RECEIPT_AWAIT_MAX_POLL_MS) || pollMs < CI_RECEIPT_AWAIT_MIN_POLL_MS
    || artifactNameField(opts.artifactName) !== opts.artifactName) {
    fail('invalid await parameters');
  }
  const gh = deps.gh ?? defaultGitRunner;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? abortableSleep;
  const deadline = now() + opts.timeoutMs;
  const diagnostics: string[] = [];
  // Reads stay sequential — one observation in flight at a time. A read that
  // finishes past the deadline reports itself instead of acting on stale data.
  const read = async (label: string, args: string[], maxBytes: number): Promise<GitRunResult> => {
    const r = await api(gh, args, maxBytes, label);
    if (now() >= deadline) fail(`await timed out during the ${label} read`);
    return r;
  };
  for (let polls = 1; ; polls++) {
    if (opts.signal?.aborted) fail('await aborted');
    if (now() >= deadline) fail(`await timed out after ${opts.timeoutMs}ms`);
    const status = attemptStatus(jsonOut(await read('attempt metadata',
      ['api', `repos/${opts.repo}/actions/runs/${opts.run}/attempts/${opts.attempt}`],
      META_MAX_BYTES), 'attempt metadata'), opts.repo, opts.run, opts.attempt);
    const rows = listedArtifacts(jsonOut(await read('run artifacts',
      ['api', '--paginate', '--slurp', `repos/${opts.repo}/actions/runs/${opts.run}/artifacts?per_page=100`],
      LIST_MAX_BYTES), 'run artifacts'));
    if (artifactPresent(rows, opts.run, opts.artifactName)) {
      diagnostics.push(`poll ${polls}: artifact "${opts.artifactName}" observed; binding through discovery`);
      const found = await discoverCiReceiptPrior(
        { repo: opts.repo, run: opts.run, attempt: opts.attempt, artifactName: opts.artifactName, gh });
      return { prior: found.prior, diagnostics: [...diagnostics, ...found.diagnostics] };
    }
    if (status === 'completed') {
      fail(`run ${opts.run} attempt ${opts.attempt} completed with no artifact named "${opts.artifactName}"`);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      fail(`await timed out after ${opts.timeoutMs}ms with attempt ${opts.attempt} still ${status}`);
    }
    diagnostics.push(`poll ${polls}: attempt ${opts.attempt} ${status}, no artifact "${opts.artifactName}" yet`);
    await sleep(Math.min(pollMs, remaining), opts.signal);
  }
}
