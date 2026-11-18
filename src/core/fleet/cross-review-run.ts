/**
 * Orchestration and storage for cross-model review (cross-review.ts): load the
 * owner's policy, take one review in an isolated reviewer process, and decide
 * at the head SHA the caller observes. The review log doubles as the audit
 * log and holds structured records only (CrossReviewRecord /
 * CrossReviewDecision): the decide step looks the review up here by
 * (repo, pr), so a verdict can only ever apply to the SHA it was taken at.
 */
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { defaultHostMergeDeps, readPr, readRequiredChecks, readHeadChecks } from './host-merge.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { runReviewerProcess, type ReviewerRunOptions } from './cross-review-process.js';
import { producerModelFamily, reviewModelFamily } from './reviewer-independence.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  buildCrossReviewPrompt,
  CROSS_REVIEW_SCHEMA_VERSION,
  decideCrossReview,
  diffPathsForReview,
  diffSha256,
  isSelfRepoTarget,
  isCommitSha,
  parseCrossReviewPolicy,
  prUrl,
  scanSensitiveChange,
  selectCrossReviewer,
  type CrossReviewDecision,
  type CrossReviewPolicy,
  type CrossReviewRecord,
  type CrossReviewRequest,
  type CrossReviewer,
  type ReviewOutcome,
  type SensitiveScan,
} from './cross-review.js';
import { assessTier1, type Tier1Assessment } from './tier1-verify.js';

/** Hard ceiling on any file this module reads (diffs, CODEOWNERS, policy, log). */
const MAX_READ_BYTES = 8 * 1024 * 1024;

function ashlrHome(): string {
  const configured = process.env['ASHLR_HOME'];
  return typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured) ? configured : join(homedir(), '.ashlr');
}

export function crossReviewPolicyPath(): string {
  return join(ashlrHome(), 'cross-review.json');
}

export function crossReviewLogPath(): string {
  return join(ashlrHome(), 'fleet', 'cross-review.jsonl');
}

/** The PAUSE file checked before every merge decision. */
export function crossReviewPauseFile(): string {
  return join(ashlrHome(), 'PAUSE');
}

/** Read a regular file up to MAX_READ_BYTES; null when missing, not a regular file, or too large. */
export function readBoundedFile(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buf, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function loadCrossReviewPolicy(path = crossReviewPolicyPath()): { ok: true; policy: CrossReviewPolicy } | { ok: false; errors: string[] } {
  const text = readBoundedFile(path);
  if (text === null) return { ok: false, errors: [`no readable cross-review policy at ${path}`] };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, errors: ['cross-review policy is not valid JSON'] }; }
  return parseCrossReviewPolicy(raw);
}

function appendLog(entry: CrossReviewRecord | CrossReviewDecision): void {
  const path = crossReviewLogPath();
  mkdirSync(join(ashlrHome(), 'fleet'), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on exotic filesystems */ }
}

function isReviewRecord(value: unknown): value is CrossReviewRecord {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v['schemaVersion'] === CROSS_REVIEW_SCHEMA_VERSION && v['kind'] === 'review' && typeof v['repo'] === 'string' &&
    typeof v['pr'] === 'number' && isCommitSha(v['reviewedHeadSha']) && typeof v['diffSha256'] === 'string' &&
    typeof v['outcome'] === 'string' && Array.isArray(v['reasons']) && typeof v['producerPool'] === 'string' &&
    (v['semantic'] === undefined || isSemanticRecord(v['semantic']));
}

/** A tier1-verify semantic pass; a malformed one makes the whole line untrusted (skipped). */
function isSemanticRecord(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return ['approve', 'reject', 'failed', 'skipped'].includes(v['outcome'] as string) && Array.isArray(v['reasons']) &&
    v['reasons'].every((r) => typeof r === 'string') && (v['reviewerPool'] === null || typeof v['reviewerPool'] === 'string');
}

/** The newest review recorded for (repo, pr), or null. Malformed lines are skipped, never trusted. */
export function latestCrossReview(repo: string, pr: number): CrossReviewRecord | null {
  const text = readBoundedFile(crossReviewLogPath());
  if (text === null) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (isReviewRecord(parsed) && parsed.repo === repo.toLowerCase() && parsed.pr === pr) return parsed;
  }
  return null;
}

interface Inputs { diff: string | null; codeowners: string | null }

/** tier1-verify's deterministic half, or null when the stage does not apply (disabled, or nothing escalates). */
function tier1For(policy: CrossReviewPolicy, request: CrossReviewRequest, diff: string | null, scan: SensitiveScan): Tier1Assessment | null {
  if (policy.tier1?.enabled !== true || scan.codes.length === 0) return null;
  const parsed = diff === null ? null : diffPathsForReview(diff);
  return assessTier1({
    diff: diff ?? '',
    paths: parsed === null || 'error' in parsed ? null : parsed.paths,
    selfRepo: isSelfRepoTarget(request.repo, policy),
    scanCodes: scan.codes,
    contentFlags: scan.contentFlags,
  });
}

function readInputs(request: CrossReviewRequest): Inputs {
  return {
    diff: readBoundedFile(request.diffFile),
    codeowners: request.codeownersFile === null ? null : readBoundedFile(request.codeownersFile),
  };
}

/** Read all exact-SHA CI evidence; required checks alone cannot prove the head green. */
async function observeHeadChecks(repo: string, pr: number, headSha: string): Promise<NonNullable<Parameters<typeof decideCrossReview>[0]['checks']>> {
  const result = (
    code: NonNullable<Parameters<typeof decideCrossReview>[0]['checks']>['code'],
    status: 'ready' | 'wait' | 'hold' = code === null ? 'ready' : 'hold',
    detail?: string,
  ) => ({ headSha, code, status, ...(detail ? { detail: scrubSecrets(detail).replace(/[\p{C}\s]+/gu, ' ').slice(0, 400) } : {}) });
  try {
    const deps = defaultHostMergeDeps();
    const before = await readPr(repo, pr, deps);
    if (typeof before === 'string') return result('checks-unreadable');
    if (before.headSha !== headSha || before.state !== 'open') return result('checks-stale');
    const required = await readRequiredChecks(repo, before.baseRef, deps);
    if (typeof required === 'string') return result('checks-unreadable');
    if (required.required.length === 0) return result('checks-missing');
    const checks = await readHeadChecks(repo, headSha, deps);
    if (typeof checks === 'string') return result('checks-unreadable');
    if (!Array.isArray(checks.runs) || !Array.isArray(checks.statuses)) return result('checks-unreadable');
    const label = (name: string, appId: string | null) => `${scrubSecrets(name).replace(/[\p{C}\s]+/gu, ' ').slice(0, 160)} (${required.required.some(
      (r) => r.context === name && (r.appId === null || r.appId === appId),
    ) ? 'required' : 'non-required'})`;
    // Failures win over pending checks and over later successes. Do not let a
    // green required gate hide a failed advisory run or a different App's run.
    const failed = checks.runs.filter((r) => ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(r.conclusion ?? ''));
    const failedStatuses = checks.statuses.filter((s) => ['failure', 'error'].includes(s.state));
    if (failed.length || failedStatuses.length) return result('checks-not-successful', 'hold', `held: ${[
      ...failed.map((r) => `${label(r.name, r.appId)}: ${r.conclusion}`),
      ...failedStatuses.map((s) => `${label(s.context, null)}: ${s.state}`),
    ].slice(0, 5).join(', ')}`);
    let requiredNotSuccessful = false;
    for (const check of required.required) {
      const runs = checks.runs.filter((r) => r.name === check.context && (check.appId === null || r.appId === check.appId));
      const latest = runs.reduce<(typeof runs)[number] | undefined>((a, b) => !a || b.id > a.id ? b : a, undefined);
      const statuses = check.appId === null ? checks.statuses.filter((s) => s.context === check.context) : [];
      if (!latest && statuses.length === 0) return result('checks-missing');
      if ((latest && (latest.status !== 'completed' || latest.conclusion !== 'success')) ||
        statuses.some((s) => s.state !== 'success')) requiredNotSuccessful = true;
    }
    if (checks.runs.some((r) => !r.name || !Number.isSafeInteger(r.id) || r.id < 1 ||
      !['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed'].includes(r.status) ||
      (r.status === 'completed' && !['success', 'neutral', 'skipped', 'cancelled', 'stale'].includes(r.conclusion ?? ''))) ||
      checks.statuses.some((s) => !s.context || !['success', 'pending', 'expected'].includes(s.state))) {
      return result('checks-unreadable', 'hold', 'held: incomplete or inconclusive check data');
    }
    if (checks.runs.some((r) => ['cancelled', 'stale'].includes(r.conclusion ?? ''))) {
      return result('checks-not-successful', 'hold', 'held: cancelled or stale checks do not prove success');
    }
    const pending = [
      ...checks.runs.filter((r) => r.status !== 'completed').map((r) => label(r.name, r.appId)),
      ...checks.statuses.filter((s) => s.state !== 'success').map((s) => label(s.context, null)),
    ];
    if (pending.length) return result('checks-not-successful', 'wait', `waiting: ${pending.slice(0, 5).join(', ')}`);
    if (requiredNotSuccessful) return result('checks-not-successful');
    const after = await readPr(repo, pr, deps);
    if (typeof after === 'string') return result('checks-unreadable');
    if (after.headSha !== headSha || after.baseRef !== before.baseRef || after.state !== 'open') return result('checks-stale');
    // tier1-verify's full-CI evidence: every check that completed green on this exact head.
    const succeeded = [...new Set([
      ...checks.runs.filter((r) => r.status === 'completed' && r.conclusion === 'success').map((r) => r.name),
      ...checks.statuses.filter((s) => s.state === 'success').map((s) => s.context),
    ])].slice(0, 500);
    return { ...result(null), succeeded };
  } catch {
    return result('checks-unreadable');
  }
}

async function decideWithChecks(input: Parameters<typeof decideCrossReview>[0], pauseFile = crossReviewPauseFile()): Promise<CrossReviewDecision> {
  const initial = decideCrossReview(input);
  if (initial.codes[0] !== 'checks-unreadable') return initial;
  const checks = await observeHeadChecks(input.request.repo, input.request.pr, input.currentHeadSha);
  // Recheck stop states after the asynchronous GitHub reads.
  return decideCrossReview({ ...input, checks, killSwitch: killSwitchOn(), paused: input.paused || existsSync(pauseFile) });
}

export interface CrossReviewDeps extends ReviewerRunOptions {
  now?: () => Date;
  /** Test seam; defaults to runReviewerProcess. */
  runReviewer?: typeof runReviewerProcess;
}

/**
 * Take one review of `request` at its headSha and record it. The model is not
 * asked when the change escalates anyway (repo not allowed, sensitive paths,
 * risky content, unreadable diff): its answer could not change the decision.
 */
export async function runCrossReview(
  request: CrossReviewRequest,
  policy: CrossReviewPolicy,
  deps: CrossReviewDeps = {},
): Promise<{ review: CrossReviewRecord; decision: CrossReviewDecision }> {
  const now = deps.now ?? (() => new Date());
  const inputs = readInputs(request);
  const diff = inputs.diff ?? '';
  const record: CrossReviewRecord = {
    schemaVersion: CROSS_REVIEW_SCHEMA_VERSION,
    kind: 'review',
    at: now().toISOString(),
    repo: request.repo,
    pr: request.pr,
    prUrl: prUrl(request.repo, request.pr),
    reviewedHeadSha: request.headSha,
    diffSha256: diffSha256(diff),
    producerPool: request.producer.pool,
    producerFamily: producerModelFamily(request.producer.model),
    reviewerPool: null,
    reviewerFamily: null,
    outcome: 'skipped',
    reasons: [],
    failure: null,
    skippedFor: [],
  };
  const scan = scanSensitiveChange({ diff, repo: request.repo, policy, codeowners: inputs.codeowners });
  if (inputs.diff === null) scan.codes = ['diff-unparseable'];
  const tier1 = tier1For(policy, request, inputs.diff, scan);
  // tier1-verify asks the models only when the deterministic half passed: the floor escalates and a failure rejects anyway.
  const tier1Reviews = tier1 !== null && tier1.floor.length === 0 && tier1.failures.length === 0;
  const runOptions = { ...(deps.parentEnv ? { parentEnv: deps.parentEnv } : {}), ...(deps.onScratch ? { onScratch: deps.onScratch } : {}) };
  const ask = async (reviewer: CrossReviewer, mode: 'standard' | 'tier1-semantic') => {
    const run = await (deps.runReviewer ?? runReviewerProcess)(reviewer, buildCrossReviewPrompt(request, diff, mode), runOptions);
    return run.ok
      ? { outcome: run.verdict.verdict satisfies ReviewOutcome, reasons: run.verdict.reasons, failure: null }
      : { outcome: 'failed' as const, reasons: [], failure: run.failure === 'launch-refused' ? 'spawn-failed' as const : run.failure };
  };

  if (!policy.allowedRepos.includes(request.repo)) {
    record.failure = 'repo-not-allowed';
  } else if (scan.codes.length > 0 && !tier1Reviews) {
    record.skippedFor = [...scan.codes];
  } else {
    const selection = selectCrossReviewer(request.producer, policy.reviewers);
    if (!selection.ok) {
      record.outcome = 'failed';
      record.failure = selection.code;
    } else {
      record.reviewerPool = selection.reviewer.pool;
      record.reviewerFamily = selection.reviewerFamily;
      Object.assign(record, await ask(selection.reviewer, 'standard'));
      if (tier1Reviews) {
        // The second, semantic pass: another seat (pool or family) that is also independent of the producer.
        const first = selection.reviewer;
        const second = selectCrossReviewer(request.producer, policy.reviewers.filter((r) =>
          r.pool.toLowerCase() !== first.pool.toLowerCase() || reviewModelFamily(r.model) !== selection.reviewerFamily));
        record.semantic = second.ok
          ? { reviewerPool: second.reviewer.pool, reviewerFamily: second.reviewerFamily, ...(await ask(second.reviewer, 'tier1-semantic')) }
          : { reviewerPool: null, reviewerFamily: null, outcome: 'failed', reasons: [], failure: 'no-second-reviewer' };
      }
    }
  }
  appendLog(record);
  const decision = await decideWithChecks({
    request, policy, review: record, currentHeadSha: request.headSha, diff, scan, tier1,
    killSwitch: killSwitchOn(), paused: existsSync(crossReviewPauseFile()), now: now(),
  });
  appendLog(decision);
  return { review: record, decision };
}

/**
 * The deterministic step the bridge runs immediately before
 * `gh pr merge --auto --match-head-commit <sha>`: re-reads the diff at the
 * head it observes now and decides against the newest recorded review.
 */
export async function decideCrossReviewAtHead(
  request: CrossReviewRequest,
  policy: CrossReviewPolicy,
  currentHeadSha: string,
  options: { pauseFile?: string; now?: Date } = {},
): Promise<CrossReviewDecision> {
  const inputs = readInputs(request);
  const diff = inputs.diff ?? '';
  const scan = scanSensitiveChange({ diff, repo: request.repo, policy, codeowners: inputs.codeowners });
  if (inputs.diff === null) scan.codes = ['diff-unparseable'];
  const decision = await decideWithChecks({
    request,
    policy,
    review: latestCrossReview(request.repo, request.pr),
    currentHeadSha,
    diff,
    scan,
    tier1: tier1For(policy, request, inputs.diff, scan),
    killSwitch: killSwitchOn(),
    paused: existsSync(options.pauseFile ?? crossReviewPauseFile()),
    ...(options.now ? { now: options.now } : {}),
  }, options.pauseFile);
  appendLog(decision);
  return decision;
}

/**
 * Append a tier1-verify fix job to the router queue (`--queue`), once per id:
 * a failed Tier-1 PR becomes queued work, never a PR parked for a human.
 * Returns whether a line was written.
 */
export function enqueueTier1FixJob(queuePath: string, line: string): { queued: boolean; id: string | null } {
  const id = /^- READY (RQ-T1FIX-[A-Za-z0-9._-]+) /.exec(line)?.[1] ?? null;
  if (id === null || line.includes('\n') || !isAbsolute(queuePath)) return { queued: false, id };
  const existing = readBoundedFile(queuePath) ?? '';
  if (existing.split('\n').some((row) => row.includes(` ${id} `))) return { queued: false, id };
  appendFileSync(queuePath, `${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${line}\n`, { encoding: 'utf8', mode: 0o600 });
  return { queued: true, id };
}
