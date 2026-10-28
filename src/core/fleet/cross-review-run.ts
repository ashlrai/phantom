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

import { killSwitchOn } from '../sandbox/policy.js';
import { runReviewerProcess, type ReviewerRunOptions } from './cross-review-process.js';
import { producerModelFamily } from './reviewer-independence.js';
import {
  buildCrossReviewPrompt,
  CROSS_REVIEW_SCHEMA_VERSION,
  decideCrossReview,
  diffSha256,
  isCommitSha,
  parseCrossReviewPolicy,
  prUrl,
  scanSensitiveChange,
  selectCrossReviewer,
  type CrossReviewDecision,
  type CrossReviewPolicy,
  type CrossReviewRecord,
  type CrossReviewRequest,
  type ReviewOutcome,
} from './cross-review.js';

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
    typeof v['outcome'] === 'string' && Array.isArray(v['reasons']) && typeof v['producerPool'] === 'string';
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

function readInputs(request: CrossReviewRequest): Inputs {
  return {
    diff: readBoundedFile(request.diffFile),
    codeowners: request.codeownersFile === null ? null : readBoundedFile(request.codeownersFile),
  };
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

  if (!policy.allowedRepos.includes(request.repo)) {
    record.failure = 'repo-not-allowed';
  } else if (scan.codes.length > 0) {
    record.skippedFor = [...scan.codes];
  } else {
    const selection = selectCrossReviewer(request.producer, policy.reviewers);
    if (!selection.ok) {
      record.outcome = 'failed';
      record.failure = selection.code;
    } else {
      record.reviewerPool = selection.reviewer.pool;
      record.reviewerFamily = selection.reviewerFamily;
      const run = await (deps.runReviewer ?? runReviewerProcess)(
        selection.reviewer,
        buildCrossReviewPrompt(request, diff),
        { ...(deps.parentEnv ? { parentEnv: deps.parentEnv } : {}), ...(deps.onScratch ? { onScratch: deps.onScratch } : {}) },
      );
      if (run.ok) {
        record.outcome = run.verdict.verdict satisfies ReviewOutcome;
        record.reasons = run.verdict.reasons;
      } else {
        record.outcome = 'failed';
        record.failure = run.failure === 'launch-refused' ? 'spawn-failed' : run.failure;
      }
    }
  }
  appendLog(record);
  const decision = decideCrossReview({
    request, policy, review: record, currentHeadSha: request.headSha, diff, scan,
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
export function decideCrossReviewAtHead(
  request: CrossReviewRequest,
  policy: CrossReviewPolicy,
  currentHeadSha: string,
  options: { pauseFile?: string; now?: Date } = {},
): CrossReviewDecision {
  const inputs = readInputs(request);
  const diff = inputs.diff ?? '';
  const scan = scanSensitiveChange({ diff, repo: request.repo, policy, codeowners: inputs.codeowners });
  if (inputs.diff === null) scan.codes = ['diff-unparseable'];
  const decision = decideCrossReview({
    request,
    policy,
    review: latestCrossReview(request.repo, request.pr),
    currentHeadSha,
    diff,
    scan,
    killSwitch: killSwitchOn(),
    paused: existsSync(options.pauseFile ?? crossReviewPauseFile()),
    ...(options.now ? { now: options.now } : {}),
  });
  appendLog(decision);
  return decision;
}
