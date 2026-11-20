/**
 * Fleet-ledger feed for the nightly ONE-TEAM retro — the local producer half
 * of the retro-input contract (docs/architecture/context-and-self-improvement.md).
 *
 * `runNightlyRetro` reads `~/.ashlr/learn/retro-input/jobs.jsonl` and
 * `review-blocks.jsonl` once per due night, inside the state lock. Nothing else
 * in the repository wrote those files, so the mining path stayed 'unavailable'
 * on every machine. This module closes that gap: each due night it folds the
 * tail of the fleet jobs ledger (`<runs>/metrics/jobs.jsonl`) into contract
 * rows and merges them into `retro-input/jobs.jsonl`.
 *
 * review-blocks.jsonl is deliberately NOT produced here: review bodies have
 * no local source, and an empty file would fabricate "no reviews" where the
 * real producer may simply be absent — a missing review input stays
 * unavailable until its producer supplies it.
 *
 * THE RULES, and why:
 *   - BEST-EFFORT, NEVER FATAL. ensureNightlyInputs() swallows every error;
 *     readNightlyInputs() still decides availability exactly as before. A
 *     missing or unreadable fleet ledger leaves inputs untouched.
 *   - MERGE, NEVER CLOBBER. Existing input rows are re-validated through
 *     extractNightlyJob and kept by latest `updatedAt` per (repo,id); a row an
 *     external producer supplied is never dropped. Conflicting same-version
 *     rows abort the feed so the run still fails closed.
 *   - TERMINAL EVIDENCE ONLY. Only explicit terminal outcomes become jobs:
 *     MERGED/succeeded states count as `succeeded`; FAILED/CLOSED-unmerged/
 *     reverted evidence counts as `failed`; CANCELLED states count as
 *     `cancelled`. Non-terminal rows (launch, publish, running) contribute
 *     identity fields but never a status. DONE-NOOP/EMPTY and unknown states
 *     stay unknown — they are not emitted.
 *   - ATTRIBUTION MUST BE REAL. A job is emitted only with a qualified
 *     `owner/repo` (the row's repo field, or a github.com PR URL) and a
 *     routing arm (lane/pool/arm, else `model:<model>`). Rows that cannot
 *     prove either are skipped — unknown stays unknown, never fabricated.
 *   - BOUNDED. The ledger tail read, the merged row count and the output byte
 *     size all stay inside the nightly input bounds; exceeding them aborts the
 *     feed rather than silently dropping deduplication evidence.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseLedgerTs } from '../../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../../router/outcomes.js';
import { writePrivateFileAtomicallyAsync } from '../../util/private-file-write.js';
import { extractNightlyJob } from './extract.js';
import type { NightlyJob } from './nightly-types.js';
import { learnHome, NIGHTLY_MAX_BYTES, NIGHTLY_MAX_RECORDS, readNightlyFile } from './store.js';

const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const STATE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'mergedAt', 'closedAt'] as const;
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
 * is a failure: the merge did not hold.
 */
function terminalStatus(row: Record<string, unknown>): NightlyJob['status'] | null {
  const state = stateOf(row);
  if (row['merged'] === true || SUCCEEDED_STATES.has(state)) return 'succeeded';
  if (row['reverted'] === true || FAILED_STATES.has(state) || row['merged'] === false || row['failed'] === true) return 'failed';
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

/** Latest observation per (repo,id); ties keep the existing row so inputs stay stable. */
function mergeNightlyJobs(existing: readonly NightlyJob[], incoming: readonly NightlyJob[]): NightlyJob[] {
  const byKey = new Map<string, NightlyJob>();
  for (const row of [...existing, ...incoming]) {
    const key = JSON.stringify([row.repo, row.id]);
    const prior = byKey.get(key);
    if (!prior || row.updatedAt > prior.updatedAt) byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) =>
    JSON.stringify([a.repo, a.id]).localeCompare(JSON.stringify([b.repo, b.id])));
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
 * Existing jobs.jsonl as validated contract rows, [] when absent, or null when
 * present but unsafe/unparseable/conflicting — the feed then leaves the file
 * alone and the nightly run fails closed exactly as it would have.
 */
async function readExistingJobs(path: string): Promise<NightlyJob[] | null> {
  let raw: string;
  try {
    raw = await readNightlyFile(path, true);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
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
  return rows;
}

export interface NightlyFeedOptions {
  /** Fleet runs dir; defaults to ASHLR_RUNS_DIR then ~/.ashlr-runs (same as router outcomes). */
  runsDir?: string;
  nowMs?: number;
}

/**
 * Refresh retro-input/jobs.jsonl from the fleet jobs ledger. Runs inside the
 * nightly state lock, once per due night. Never throws and never writes when
 * the ledger is unreadable.
 */
export async function ensureNightlyInputs(opts: NightlyFeedOptions = {}): Promise<void> {
  try {
    const dir = join(learnHome(), 'retro-input');
    await ensureRetroInputDir(dir);
    const jobsPath = join(dir, 'jobs.jsonl');
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
    const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE), NIGHTLY_MAX_BYTES);
    if (tail.state !== 'read') return;
    const incoming = foldFleetJobs(tail.text, opts.nowMs ?? Date.now());
    const existing = await readExistingJobs(jobsPath);
    if (existing === null) return;
    const merged = mergeNightlyJobs(existing, incoming);
    if (merged.length > NIGHTLY_MAX_RECORDS) return;
    const text = merged.length ? `${merged.map((job) => JSON.stringify(job)).join('\n')}\n` : '';
    if (Buffer.byteLength(text) > NIGHTLY_MAX_BYTES) return;
    // The nightly state lock is already held by updateNightlyState; the fence is a no-op here.
    await writePrivateFileAtomicallyAsync(
      `${jobsPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
      jobsPath,
      text,
      { anchorPath: homedir(), label: 'nightly job feed', beforePublish: () => undefined },
    );
  } catch {
    // Best-effort producer: readNightlyInputs() remains the availability gate.
  }
}
