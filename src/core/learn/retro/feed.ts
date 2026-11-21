/**
 * Local evidence feed for the nightly ONE-TEAM retro — the producer half of
 * the retro-input contract (docs/architecture/context-and-self-improvement.md).
 *
 * `runNightlyRetro` reads `~/.ashlr/learn/retro-input/jobs.jsonl` and
 * `review-blocks.jsonl` once per due night, inside the state lock. This module
 * is the local producer for BOTH files, folding every durable local outcome
 * source into contract rows:
 *
 *   - jobs.jsonl merges the fleet jobs ledger tail (`<runs>/metrics/jobs.jsonl`)
 *     with terminal cloud and Devin task records, so priors and lessons cover
 *     every lane that reports a durable outcome, not only fleet dispatches.
 *   - review-blocks.jsonl is produced from cloud task outcomes: the tracker
 *     records GitHub's review verdict (reviewDecision / changesRequested) at
 *     the terminal transition, and that recorded verdict — never review prose —
 *     becomes a review-block row whose body is a bounded factual summary. An
 *     empty file is written when no local source recorded a review block, so
 *     the file's existence means "the producer looked", not "reviews are
 *     impossible". External producers can still merge rows in; nothing is
 *     clobbered.
 *
 * THE RULES, and why:
 *   - BEST-EFFORT, NEVER FATAL. ensureNightlyInputs() swallows every error;
 *     readNightlyInputs() still decides availability exactly as before. A
 *     missing or unreadable source leaves its file untouched; an unreadable
 *     task store counts as unknown — it suppresses task-derived rows and the
 *     review file, never the fleet-ledger jobs feed.
 *   - MERGE, NEVER CLOBBER. Existing input rows are re-validated and kept by
 *     latest `updatedAt` per (repo,id); a row an external producer supplied is
 *     never dropped. Conflicting same-version rows abort the feed so the run
 *     still fails closed.
 *   - TERMINAL EVIDENCE ONLY. Only explicit terminal outcomes become jobs:
 *     MERGED/succeeded states count as `succeeded`; FAILED/CLOSED-unmerged/
 *     reverted evidence counts as `failed` (revert evidence is the shared
 *     `hasRevertEvidence` vocabulary — a reverted flag, a revert event or
 *     state name, or a parseable reverted_at/revertedAt stamp — and it wins
 *     over merge or success fields on the same row); CANCELLED states count
 *     as `cancelled`. Non-terminal rows (launch, publish, running) contribute
 *     identity fields but never a status. DONE-NOOP/EMPTY and unknown states
 *     stay unknown — they are not emitted. Cloud/devin tasks follow the same
 *     rule, and a merged-then-reverted task is `failed` like a reverted fleet
 *     merge. Tasks superseded by a fleet PR are skipped: the carrying PR
 *     reports its own outcome (the hourly sweep's scope rule).
 *   - ATTRIBUTION MUST BE REAL. A job is emitted only with a qualified
 *     `owner/repo` and a routing arm (fleet lane/pool/arm, `model:<model>`,
 *     `cloud:<seat>` or `devin:<mode>` for task lanes). Rows that cannot prove
 *     either are skipped — unknown stays unknown, never fabricated.
 *   - BOUNDED. The ledger tail read, the task scan, the merged row counts and
 *     the output byte sizes all stay inside the nightly input bounds;
 *     exceeding them aborts that file's feed rather than silently dropping
 *     deduplication evidence.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { listCloudTasks } from '../../cloud/store.js';
import type { CloudTaskOutcome, CloudTaskV1 } from '../../cloud/types.js';
import { listDevinTasks } from '../../devin/store.js';
import type { DevinTaskV1 } from '../../devin/types.js';
import { hasRevertEvidence } from '../../fleet/slot-yield.js';
import { parseLedgerTs } from '../../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../../router/outcomes.js';
import { writePrivateFileAtomicallyAsync } from '../../util/private-file-write.js';
import { extractNightlyJob, extractNightlyReview } from './extract.js';
import type { NightlyJob, NightlyReview } from './nightly-types.js';
import { learnHome, NIGHTLY_MAX_BYTES, NIGHTLY_MAX_RECORDS, readNightlyFile } from './store.js';

const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const STATE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
/**
 * jobs.jsonl timestamp dialect: ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt — the same field set and order dispatchd `_vc_pick`
 * and metrics/loop accept.
 */
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;
const PLAYBOOK_KEYS = ['playbook', 'work_class'] as const;
const URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr'] as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PR_URL_PATTERN = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+\/?$/;

const SUCCEEDED_STATES = new Set(['MERGED', 'SUCCEEDED', 'SUCCESS', 'PASSED']);
const FAILED_STATES = new Set(['FAILED', 'FAILURE', 'ERROR', 'CLOSED', 'TIMED_OUT', 'TIMEOUT', 'REVERTED', 'REVERT']);
const CANCELLED_STATES = new Set(['CANCELLED', 'CANCELED']);

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** jobs.jsonl stamps arrive as ISO (with or without offset colon) or epoch-ms numbers. */
function ledgerTs(row: Record<string, unknown>): number | null {
  for (const key of TS_KEYS) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const parsed = parseLedgerTs(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function stateOf(row: Record<string, unknown>): string {
  return (firstString(row, STATE_KEYS) ?? '').toUpperCase();
}

/**
 * The job's terminal outcome as one nightly status, or null while the job is
 * still in flight or its end state is not explicit evidence. A recorded revert
 * is a failure: the merge did not hold, so revert evidence wins over any merge
 * or success state on the same row — the shared sticky rule the router outcome
 * fold and the yield readers apply (`hasRevertEvidence`: a reverted flag, a
 * revert event/state name, or a parseable reverted_at/revertedAt stamp).
 */
function terminalStatus(row: Record<string, unknown>): NightlyJob['status'] | null {
  const state = stateOf(row);
  if (hasRevertEvidence(row)) return 'failed';
  if (row['merged'] === true || SUCCEEDED_STATES.has(state)) return 'succeeded';
  if (FAILED_STATES.has(state) || row['merged'] === false || row['failed'] === true) return 'failed';
  if (CANCELLED_STATES.has(state)) return 'cancelled';
  return null;
}

/** owner/repo from the row's repo field, or proven by its GitHub PR URL. */
function repoOf(row: Record<string, unknown>): string | null {
  const repo = firstString(row, ['repo']);
  if (repo && REPO_PATTERN.test(repo)) return repo;
  const url = firstString(row, URL_KEYS);
  const match = url ? PR_URL_PATTERN.exec(url.replace(/\/+$/, '')) : null;
  if (!match) return null;
  const derived = `${match[1]}/${match[2]}`;
  return REPO_PATTERN.test(derived) ? derived : null;
}

/** The routing arm: lane/pool/arm first, then the model as `model:<name>` so namespaces never conflate. */
function armOf(row: Record<string, unknown>): string | null {
  for (const key of LANE_KEYS) {
    const value = firstString(row, [key]);
    if (value && ID_PATTERN.test(value)) return value;
  }
  const model = firstString(row, ['model']);
  if (model) {
    const arm = `model:${model}`;
    if (ID_PATTERN.test(arm)) return arm;
  }
  return null;
}

function playbookOf(row: Record<string, unknown>): string | null {
  const value = firstString(row, PLAYBOOK_KEYS);
  return value && ID_PATTERN.test(value) ? value : null;
}

interface JobAccum {
  repo: string | null;
  arm: string | null;
  playbook: string | null;
  status: NightlyJob['status'] | null;
  at: number;
  updatedAt: string;
}

/**
 * Fold jobs.jsonl text into one contract row per job: the latest terminal
 * observation wins, identity fields fill from any row, and rows that cannot
 * prove repo + arm + a canonical timestamp are dropped. Pure; never throws.
 */
export function foldFleetJobs(text: string, nowMs: number): NightlyJob[] {
  const jobs = new Map<string, JobAccum>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const id = firstString(row, JOB_ID_KEYS);
    if (!id || !ID_PATTERN.test(id)) continue;
    const at = ledgerTs(row);
    if (at === null || at > nowMs) continue;
    let acc = jobs.get(id);
    if (!acc) {
      acc = { repo: null, arm: null, playbook: null, status: null, at: 0, updatedAt: '' };
      jobs.set(id, acc);
    }
    acc.repo ??= repoOf(row);
    acc.arm ??= armOf(row);
    acc.playbook ??= playbookOf(row);
    const status = terminalStatus(row);
    if (status !== null && at >= acc.at) {
      acc.status = status;
      acc.at = at;
      acc.updatedAt = new Date(at).toISOString();
    }
  }
  const out: NightlyJob[] = [];
  for (const [id, acc] of jobs) {
    if (acc.status === null || acc.repo === null || acc.arm === null || !acc.updatedAt) continue;
    out.push({ v: 1, id, repo: acc.repo, arm: acc.arm, playbook: acc.playbook, status: acc.status, updatedAt: acc.updatedAt });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Cloud / Devin task stores — the second durable local outcome source.
// ---------------------------------------------------------------------------

/**
 * Wire row of `retro-input/review-blocks.jsonl` before extraction: the
 * persisted NightlyReview swaps `body` for a classified `cause`, so the feed
 * must write the input shape, never the state shape.
 */
export interface NightlyReviewInput {
  v: 1;
  id: string;
  jobId: string;
  repo: string;
  kind: 'review-block';
  updatedAt: string;
  body: string;
}

const TASK_TERMINAL_STATES = new Set(['merged', 'closed', 'failed', 'expired']);
const REVIEW_BODY_MAX = 16_384;

/** Task-store timestamps normalize to canonical ISO; unparseable or future stamps drop the row. */
function taskTimestamp(raw: unknown, nowMs: number): string | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms > nowMs) return null;
  return new Date(ms).toISOString();
}

function taskPlaybook(ref: { id: string } | null | undefined): string | null {
  const id = ref?.id;
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The review-block body is a bounded factual summary of the recorded GitHub
 * verdict — the tracker stores the decision and counts, never review prose.
 * The wording avoids every extract.ts trigger keyword so the row classifies
 * as cause 'review', which is what a changes-requested verdict is.
 */
function reviewBlockBody(repo: string, prNumber: number | null, outcome: CloudTaskOutcome): string {
  const requests = outcome.changesRequested > 0
    ? ` with ${outcome.changesRequested} recorded change request${outcome.changesRequested === 1 ? '' : 's'}`
    : '';
  const where = prNumber !== null ? ` on ${repo}#${prNumber}` : ` on ${repo}`;
  const head = outcome.headSha ? ` at head ${outcome.headSha.slice(0, 12)}` : '';
  return `Recorded GitHub review verdict${requests}${where}${head}.`.slice(0, REVIEW_BODY_MAX);
}

/**
 * Terminal cloud tasks as nightly jobs, plus one review-block row per task
 * whose recorded outcome shows a reviewer asked for changes (the same
 * predicate the hourly retro uses). A merged-then-reverted task counts as
 * `failed`: the merge did not hold. Superseded tasks are skipped — the fleet
 * PR carrying the change reports its own outcome.
 */
export function foldCloudTasks(
  tasks: readonly CloudTaskV1[],
  nowMs: number,
): { jobs: NightlyJob[]; reviews: NightlyReviewInput[] } {
  const jobs: NightlyJob[] = [];
  const reviews: NightlyReviewInput[] = [];
  for (const task of tasks) {
    if (task.supersededBy) continue;
    if (!ID_PATTERN.test(task.id) || !REPO_PATTERN.test(task.repo)) continue;
    const outcome = task.outcome ?? null;
    if (TASK_TERMINAL_STATES.has(task.state)) {
      const updatedAt = taskTimestamp(task.updatedAt, nowMs);
      if (updatedAt !== null) {
        const status: NightlyJob['status'] = task.state === 'merged' && !outcome?.revertedBy ? 'succeeded' : 'failed';
        const seat = task.seat.trim();
        const arm = seat !== '' && ID_PATTERN.test(seat) ? `cloud:${seat}` : 'cloud';
        jobs.push({ v: 1, id: task.id, repo: task.repo, arm, playbook: taskPlaybook(task.playbookRef), status, updatedAt });
      }
    }
    if (outcome !== null && (outcome.reviewDecision === 'CHANGES_REQUESTED' || outcome.changesRequested > 0)) {
      const observedAt = taskTimestamp(outcome.observedAt, nowMs);
      if (observedAt !== null) {
        reviews.push({
          v: 1, id: `cloud-review:${task.id}`, jobId: task.id, repo: task.repo,
          kind: 'review-block', updatedAt: observedAt,
          body: reviewBlockBody(task.repo, task.pr?.number ?? null, outcome),
        });
      }
    }
  }
  return { jobs: jobs.sort(byId), reviews: reviews.sort(byId) };
}

/**
 * Terminal Devin tasks as nightly jobs. Devin stores no GitHub outcome, so
 * there is no review evidence to fold — and no revert signal, so a merged
 * task stays `succeeded` (unknown stays as recorded). Devin chat sessions
 * without a PR are conversations, not deliveries, and are skipped (the
 * hourly sweep's rule).
 */
export function foldDevinTasks(tasks: readonly DevinTaskV1[], nowMs: number): NightlyJob[] {
  const jobs: NightlyJob[] = [];
  for (const task of tasks) {
    if (!TASK_TERMINAL_STATES.has(task.state) || task.supersededBy) continue;
    if (task.origin === 'chat' && !task.pr) continue;
    if (!ID_PATTERN.test(task.id) || !REPO_PATTERN.test(task.repo)) continue;
    const updatedAt = taskTimestamp(task.updatedAt, nowMs);
    if (updatedAt === null) continue;
    const arm = ID_PATTERN.test(task.devinMode) ? `devin:${task.devinMode}` : 'devin';
    jobs.push({
      v: 1, id: task.id, repo: task.repo, arm,
      playbook: taskPlaybook(task.playbookRef),
      status: task.state === 'merged' ? 'succeeded' : 'failed', updatedAt,
    });
  }
  return jobs.sort(byId);
}

/** Latest observation per (repo,id); ties keep the existing row so inputs stay stable. */
function mergeLatestObservations<T extends { repo: string; id: string; updatedAt: string }>(
  existing: readonly T[], incoming: readonly T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of [...existing, ...incoming]) {
    const key = JSON.stringify([row.repo, row.id]);
    const prior = byKey.get(key);
    if (!prior || row.updatedAt > prior.updatedAt) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) =>
    JSON.stringify([a.repo, a.id]).localeCompare(JSON.stringify([b.repo, b.id])));
}

/**
 * True when the merge changed nothing: identical canonical rows in identical
 * order. Skipping the write preserves externally supplied file bytes and
 * avoids a pointless atomic replace every due night.
 */
function unchangedObservations<T extends { repo: string; id: string; updatedAt: string }>(
  merged: readonly T[], existing: readonly T[],
): boolean {
  const sortedExisting = mergeLatestObservations(existing, []);
  return merged.length === sortedExisting.length &&
    merged.every((row, index) => JSON.stringify(row) === JSON.stringify(sortedExisting[index]));
}

/** Same private-directory discipline as the nightly store: no symlinked or shared-writable parents. */
async function ensureRetroInputDir(dir: string): Promise<void> {
  for (const directory of [join(homedir(), '.ashlr'), learnHome(), dir]) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const s = await lstat(directory);
    if (!s.isDirectory() || s.isSymbolicLink() ||
      (typeof process.getuid === 'function' && s.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (s.mode & 0o022) !== 0)) throw new Error('Unsafe nightly input directory');
  }
}

/**
 * Existing jobs.jsonl as validated contract rows. `existed` distinguishes an
 * absent file (the feed must create it, even when it merges to zero rows)
 * from a present one; null means unsafe/unparseable/conflicting — the feed
 * then leaves the file alone and the nightly run fails closed exactly as it
 * would have.
 */
async function readExistingJobs(path: string): Promise<{ rows: NightlyJob[]; existed: boolean } | null> {
  let raw: string;
  try {
    raw = await readNightlyFile(path, true);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { rows: [], existed: false } : null;
  }
  const rows: NightlyJob[] = [];
  const versions = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let job: NightlyJob;
    try {
      job = extractNightlyJob(JSON.parse(line) as unknown);
    } catch {
      return null;
    }
    const version = JSON.stringify([JSON.stringify([job.repo, job.id]), job.updatedAt]);
    const bytes = JSON.stringify(job);
    if (versions.has(version) && versions.get(version) !== bytes) return null;
    versions.set(version, bytes);
    rows.push(job);
  }
  return { rows, existed: true };
}

export interface NightlyFeedOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as router outcomes). */
  runsDir?: string;
  nowMs?: number;
  /** Task-store readers; default to the real cloud/devin stores. Injectable for tests. */
  cloudTasks?: () => readonly CloudTaskV1[];
  devinTasks?: () => readonly DevinTaskV1[];
}

/**
 * Task-store evidence as feed rows, or null when either store cannot be
 * read — unknown stays unknown: the caller then writes no task-derived rows
 * and leaves review-blocks.jsonl untouched rather than asserting "none".
 */
function collectTaskEvidence(
  opts: NightlyFeedOptions, nowMs: number,
): { jobs: NightlyJob[]; reviews: NightlyReviewInput[] } | null {
  try {
    const cloud = (opts.cloudTasks ?? (() => listCloudTasks()))();
    const devin = (opts.devinTasks ?? (() => listDevinTasks()))();
    const folded = foldCloudTasks(cloud, nowMs);
    return { jobs: [...folded.jobs, ...foldDevinTasks(devin, nowMs)], reviews: folded.reviews };
  } catch {
    return null;
  }
}

/**
 * Existing review-blocks.jsonl as validated wire rows, [] when absent, or
 * null when present but unsafe/unparseable/conflicting — same fail-closed
 * contract as readExistingJobs. Rows keep their `body`: the file is the
 * pre-extraction input shape, not the persisted NightlyReview shape.
 */
async function readExistingReviews(path: string): Promise<{ rows: NightlyReviewInput[]; existed: boolean } | null> {
  let raw: string;
  try {
    raw = await readNightlyFile(path, true);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { rows: [], existed: false } : null;
  }
  const rows: NightlyReviewInput[] = [];
  const versions = new Map<string, string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    let review: NightlyReview;
    try {
      review = extractNightlyReview(parsed);
    } catch {
      return null;
    }
    const body = (parsed as Record<string, unknown>)['body'];
    if (typeof body !== 'string' || body.length > REVIEW_BODY_MAX) return null;
    const row: NightlyReviewInput = {
      v: 1, id: review.id, jobId: review.jobId, repo: review.repo,
      kind: 'review-block', updatedAt: review.updatedAt, body,
    };
    const version = JSON.stringify([[row.repo, row.id], row.updatedAt]);
    const bytes = JSON.stringify(row);
    if (versions.has(version) && versions.get(version) !== bytes) return null;
    versions.set(version, bytes);
    rows.push(row);
  }
  return { rows, existed: true };
}

/** Refresh retro-input/jobs.jsonl. Runs inside the nightly state lock, once per due night. */
async function feedJobsInput(
  dir: string, runsDir: string, taskJobs: readonly NightlyJob[], nowMs: number,
): Promise<void> {
  const jobsPath = join(dir, 'jobs.jsonl');
  const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE), NIGHTLY_MAX_BYTES);
  if (tail.state !== 'read') return;
  const incoming = [...foldFleetJobs(tail.text, nowMs), ...taskJobs];
  const existing = await readExistingJobs(jobsPath);
  if (existing === null) return;
  const merged = mergeLatestObservations(existing.rows, incoming);
  if (merged.length > NIGHTLY_MAX_RECORDS || (existing.existed && unchangedObservations(merged, existing.rows))) return;
  const text = merged.length ? `${merged.map((job) => JSON.stringify(job)).join('\n')}\n` : '';
  if (Buffer.byteLength(text) > NIGHTLY_MAX_BYTES) return;
  // The nightly state lock is already held by updateNightlyState; the fence is a no-op here.
  await writePrivateFileAtomicallyAsync(
    `${jobsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
    jobsPath,
    text,
    { anchorPath: homedir(), label: 'nightly job feed', beforePublish: () => undefined },
  );
}

/**
 * Refresh retro-input/review-blocks.jsonl from recorded task outcomes. The
 * file is written even when it merges to zero rows: its existence means the
 * local producer ran and found no recorded review blocks, which is what lets
 * a due night complete instead of staying unavailable forever.
 */
async function feedReviewsInput(
  dir: string, taskReviews: readonly NightlyReviewInput[] | null,
): Promise<void> {
  if (taskReviews === null) return;
  const reviewPath = join(dir, 'review-blocks.jsonl');
  const existing = await readExistingReviews(reviewPath);
  if (existing === null) return;
  const merged = mergeLatestObservations(existing.rows, taskReviews);
  if (merged.length > NIGHTLY_MAX_RECORDS || (existing.existed && unchangedObservations(merged, existing.rows))) return;
  const text = merged.length ? `${merged.map((row) => JSON.stringify(row)).join('\n')}\n` : '';
  if (Buffer.byteLength(text) > NIGHTLY_MAX_BYTES) return;
  await writePrivateFileAtomicallyAsync(
    `${reviewPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
    reviewPath,
    text,
    { anchorPath: homedir(), label: 'nightly review feed', beforePublish: () => undefined },
  );
}

/**
 * Refresh both retro-input files from local evidence. Runs inside the
 * nightly state lock, once per due night. Never throws; each file's feed is
 * independent so one bad source cannot suppress the other.
 */
export async function ensureNightlyInputs(opts: NightlyFeedOptions = {}): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now();
  const tasks = collectTaskEvidence(opts, nowMs);
  const dir = join(learnHome(), 'retro-input');
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  try {
    await ensureRetroInputDir(dir);
    await feedJobsInput(dir, runsDir, tasks?.jobs ?? [], nowMs);
  } catch {
    // Best-effort producer: readNightlyInputs() remains the availability gate.
  }
  try {
    await ensureRetroInputDir(dir);
    await feedReviewsInput(dir, tasks === null ? null : tasks.reviews);
  } catch {
    // Same: an unwritable review file leaves the run unavailable, never fatal.
  }
}
