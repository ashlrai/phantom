import { join } from 'node:path';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, dropJobExists, resolveDropJobRoot, validateDropJob, writeDropJob } from './drop-job-writer.js';
import { ingestFeedback, type FeedbackSnapshot } from './feedback-ingest.js';
import { feedbackJobId, triageFeedback, type FeedbackCoverage } from './feedback-triage.js';
import {
  readFeedbackQueued,
  recordFeedbackQueued,
  type FeedbackQueuedEntry,
} from './feedback-queue-record.js';
import { isPrecheckSkipRow } from './jobs-ledger-dialect.js';

export const FEEDBACK_CYCLE_LIMIT = 5;
/**
 * jobs.jsonl field dialects: job|job_id|jobId|id, url|prUrl|pr_url|pr|html_url,
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt,
 * event|type|kind and phase|state|outcome|status|result|conclusion —
 * the aliases dispatchd `_vc_*` and the fleet metrics readers accept.
 * `first` keeps `??`-chain semantics: the first non-null spelling wins.
 */
const first = (r: Record<string, unknown>, keys: readonly string[]): unknown => {
  for (const key of keys) {
    const v = r[key];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
};
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const PR_KEYS = ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['phase', 'state', 'outcome', 'status', 'result', 'conclusion'] as const;
export interface FeedbackOptions { command: 'scan' | 'digest'; apply: boolean; days: number; runsDir?: string; now?: number }
export interface FeedbackCycleDeps {
  ingest: typeof ingestFeedback;
  read: (root: string, path: string) => Promise<string>;
}
const defaults: FeedbackCycleDeps = {
  ingest: ingestFeedback,
  read: async (root, path) => {
    const result = readStableRegularFile(join(root, path), { anchorPath: root, maxFileBytes: 4 * 1024 * 1024, remainingBytes: 4 * 1024 * 1024 });
    if (!result.ok) throw new Error('source unavailable');
    return result.text;
  },
};

/** Drop-queue job ids the feedback scan mints: RQ-PHX-FB<24-hex dedupe key>. */
const FB_JOB = /^RQ-PHX-FB[A-Z0-9]{3,40}$/;
const MAX_SUBMISSIONS = 50;
const normalizePrRef = (ref: string): string => ref.trim().toLowerCase().replace(/\/+$/, '');

/** Per-submission outcome states; 'queued' is admitted-but-unresolved, never a guess at progress. */
export type FeedbackSubmissionState = 'queued' | 'under-review' | 'action-required' | 'merged' | 'shipped';
export interface FeedbackSubmission {
  job: string;
  /** Request ref the scan journaled (first signal ref — issue/PR URL or comms receipt), null when none was carried. */
  request: string | null;
  source: string | null;
  kind: string | null;
  state: FeedbackSubmissionState;
  /** PR url the ledger recorded for the job, when one exists. */
  pr: string | null;
  /** Latest recorded activity across journal and ledger rows, ISO; null when undated. */
  at: string | null;
}

interface FbCell {
  at: number;
  gaveUp: boolean; skipped: boolean;
  pr: string | null;
  outcome: string | null; outcomeAt: number;
  finishAt: number | null;
}

/**
 * Fold one FB job's ledger rows into a submission state. Evidence order:
 * a resolved outcome beats a bare publish claim; a recorded PR beats a
 * failed/empty finish; a declined or failed run is action-required; an
 * admitted job with no verdict yet is queued. 'shipped' additionally
 * requires the PR ref inside the ingest's gh-verified merged set — a
 * ledger MERGED claim alone stays 'merged' until gh confirms it.
 */
function submissionState(cell: FbCell, shippedRefs: ReadonlySet<string>): FeedbackSubmissionState {
  if (cell.outcome === 'MERGED') {
    const pr = cell.pr === null ? null : normalizePrRef(cell.pr);
    return pr !== null && shippedRefs.has(pr) ? 'shipped' : 'merged';
  }
  if (cell.outcome === 'CLOSED') return 'action-required';
  if (cell.pr !== null || cell.outcome === 'OPEN') return 'under-review';
  if (cell.gaveUp || cell.skipped) return 'action-required';
  if (cell.finishAt !== null) return 'action-required';
  return 'queued';
}

/** Latest measured job state; a finish is reviewable, never evidence of shipment. */
export function feedbackDigest(snapshot: FeedbackSnapshot, ledger: string, now: number,
    queuedEntries: readonly FeedbackQueuedEntry[] | null = null) {
  const latest = new Map<string, { at: number; event: string; state: string; failed: boolean }>();
  const records: Record<string, unknown>[] = [], repos = new Map<string, string>(), jobsByPR = new Map<string, string>();
  let invalidRows = 0;
  for (const line of ledger.split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error();
      records.push(r);
      const id = first(r, JOB_KEYS), pr = first(r, PR_KEYS);
      if (typeof id !== 'string') continue;
      if (typeof r.repo === 'string') {
        const repo = r.repo.replace(/^ashlrai\//, '');
        repos.set(id, repos.has(id) && repos.get(id) !== repo ? 'ambiguous' : repo);
      }
      if (typeof pr === 'string') jobsByPR.set(pr, id);
    } catch { invalidRows++; }
  }
  for (const r of records) {
    try {
      const id = first(r, JOB_KEYS) ?? jobsByPR.get(String(first(r, PR_KEYS)));
      if (typeof id !== 'string' || repos.get(id) !== 'phantom') continue;
      const raw = first(r, TS_KEYS), at = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || scrubSecrets(id) !== id || !Number.isFinite(at)) { invalidRows++; continue; }
      if (at > now || at < (latest.get(id)?.at ?? 0)) continue;
      const event = String(first(r, EVENT_KEYS) ?? '').toLowerCase(), state = String(first(r, PHASE_KEYS) ?? '').toUpperCase();
      if (!['launch', 'start', 'finish', 'complete', 'outcome', 'result', 'merged', 'failure', 'publish'].includes(event)) continue;
      const previous = latest.get(id);
      if (previous?.at === at && (previous.state === 'MERGED' || previous.event === 'merged' || (!['launch', 'start'].includes(previous.event) && ['launch', 'start'].includes(event)))) continue;
      latest.set(id, { at, event, state, failed: (typeof (r.exit_code ?? r.exitCode) === 'number' && (r.exit_code ?? r.exitCode) !== 0) || Boolean(r.pool_error) || ['FAILED', 'FAILURE', 'ERROR'].includes(state) || event === 'failure' });
    } catch { invalidRows++; }
  }
  const failures: string[] = [], needsReview: string[] = [], stillRunning: string[] = [];
  for (const [id, r] of latest) {
    if (['launch', 'start'].includes(r.event)) stillRunning.push(id);
    else if (r.at >= now - 12 * 3600000 && r.state !== 'MERGED' && r.event !== 'merged') (r.failed ? failures : needsReview).push(id);
  }
  // Per-submission fold: FB job ids are minted only by this pipeline, so the
  // id itself is the repo attribution — no repo field is required. Rows
  // resolve their job the same way the digest does (job key, else the PR
  // url a publish row already tied to a job).
  const fb = new Map<string, FbCell>();
  const cellFor = (id: string): FbCell => {
    let cell = fb.get(id);
    if (cell === undefined) {
      cell = { at: 0, gaveUp: false, skipped: false, pr: null, outcome: null, outcomeAt: -1, finishAt: null };
      fb.set(id, cell);
    }
    return cell;
  };
  for (const r of records) {
    try {
      const prValue = first(r, PR_KEYS);
      const id = first(r, JOB_KEYS) ?? (typeof prValue === 'string' ? jobsByPR.get(prValue) : undefined);
      if (typeof id !== 'string' || !FB_JOB.test(id) || scrubSecrets(id) !== id) continue;
      const raw = first(r, TS_KEYS), at = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (!Number.isFinite(at) || at > now) continue;
      const event = String(first(r, EVENT_KEYS) ?? '').toLowerCase(), state = String(first(r, PHASE_KEYS) ?? '').toUpperCase();
      const cell = cellFor(id);
      if (at > cell.at) cell.at = at;
      if (typeof prValue === 'string' && prValue.trim() !== '' && cell.pr === null) cell.pr = prValue.trim();
      if (['MERGED', 'CLOSED', 'OPEN'].includes(state) && at >= cell.outcomeAt) { cell.outcome = state; cell.outcomeAt = at; }
      if (['finish', 'complete'].includes(event) && at >= (cell.finishAt ?? -1)) cell.finishAt = at;
      if (event === 'launch_failed' && String(r.action ?? '') === 'give_up') cell.gaveUp = true;
      if (isPrecheckSkipRow(r)) cell.skipped = true;
    } catch { /* a malformed row never guesses a submission state */ }
  }
  const journal = new Map<string, FeedbackQueuedEntry>();
  for (const entry of queuedEntries ?? []) if (FB_JOB.test(entry.job)) journal.set(entry.job, entry);
  const shippedRefs = new Set(snapshot.shipped.map(r => normalizePrRef(r.ref)));
  const submissions: FeedbackSubmission[] = [];
  for (const job of journal.keys()) if (!fb.has(job)) cellFor(job);
  for (const [job, cell] of fb) {
    const entry = journal.get(job);
    const journalAt = entry === undefined ? NaN : Date.parse(entry.at);
    const at = Math.max(cell.at, Number.isFinite(journalAt) ? journalAt : 0);
    submissions.push({ job, request: entry?.ref ?? null, source: entry?.source ?? null, kind: entry?.kind ?? null,
      state: submissionState(cell, shippedRefs), pr: cell.pr, at: at > 0 ? new Date(at).toISOString() : null });
  }
  submissions.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.job.localeCompare(b.job));
  return { windowHours: 12, shipped: snapshot.shipped.filter(r => r.at >= now - 12 * 3600000 && r.at <= now).map(r => r.ref),
    needsReview, failures, stillRunning, invalidRows, submissions: submissions.slice(0, MAX_SUBMISSIONS),
    runningEvidence: 'last recorded launch; liveness unverified' };
}

export async function runFeedback(options: FeedbackOptions, overrides: Partial<FeedbackCycleDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  const root = resolveDropJobRoot(options.runsDir), now = options.now ?? Date.now();
  if (!['scan', 'digest'].includes(options.command) || (options.command === 'digest' && options.apply) ||
      !Number.isSafeInteger(now) || !Number.isInteger(options.days) || options.days < 1 || options.days > 30) throw new Error('invalid options');
  const snapshot = await deps.ingest(now, options.days);
  const report = { schema: 'fleet.feedback.v1', applied: options.apply, sources: { ...snapshot.sources },
    candidates: snapshot.signals.map(s => triageFeedback(s, snapshot.open)), queued: [] as string[],
    deferred: [] as string[], errors: [] as string[] };
  if (options.command === 'digest') {
    let ledger = '';
    try { ledger = await deps.read(root, 'metrics/jobs.jsonl'); report.sources.jobs = 'ok'; }
    catch { report.sources.jobs = 'unavailable'; }
    const queuedRead = await readFeedbackQueued(root);
    report.sources['feedback-queued'] = queuedRead.state === 'unavailable' ? 'unavailable' : 'ok';
    const digest = feedbackDigest(snapshot, ledger, now, queuedRead.state === 'ok' ? queuedRead.entries : null);
    if (digest.invalidRows) report.sources.jobs = 'unavailable';
    return { ...report, digest: { ...digest, ...(report.sources.merges === 'unavailable' ? { shipped: null } : {}),
      ...(report.sources.jobs === 'unavailable' ? { needsReview: null, failures: null, stillRunning: null, submissions: null } : {}) } };
  }
  // A shared lock covers coverage refresh, depth checks and atomic publication.
  const lock = options.apply ? acquireLocalStoreLock(join(root, 'feedback', 'scan.lock'), 0) : null;
  if (options.apply && !lock) { report.errors.push('scan-busy-or-unavailable'); return report; }
  try {
    const coverage: FeedbackCoverage[] = [...snapshot.open];
    try {
      for (const file of ['queue/router-queue.md', 'queue/ready.tsv']) coverage.push({ text: await deps.read(root, file) });
      report.sources.queue = 'ok';
    } catch { report.sources.queue = 'unavailable'; }
    // The lock's durable mtime reserves one apply cycle per minute, including partial/crashed cycles.
    let cooling = false;
    if (options.apply) {
      const marker = join(root, 'feedback', 'cycle');
      try { cooling = now - (await lstat(marker)).mtimeMs < 60000; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (!cooling) {
        await writeFile(marker, '', { flag: 'wx', mode: 0o600 }).catch(async e => {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          await unlink(marker);
          await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
        });
      }
    }
    if (cooling) report.errors.push('cycle-rate-limited');
    if (options.apply && (!snapshot.coverageComplete || report.sources.queue !== 'ok')) report.errors.push('coverage-incomplete');
    report.candidates = [];
    const priority = (signal: typeof snapshot.signals[number]): string => {
      const result = triageFeedback(signal); return result.kind === 'ignore' ? 'P4' : result.priority;
    };
    for (const signal of [...snapshot.signals].sort((a, b) => priority(a).localeCompare(priority(b)))) {
      const result = triageFeedback(signal, coverage); report.candidates.push(result);
      if (result.kind === 'ignore') continue;
      const id = feedbackJobId(result.dedupeKey);
      coverage.push({ text: signal.text, refs: signal.refs, dedupeKey: result.dedupeKey });
      const input = { id, lane: result.suggestedLane, tier: result.suggestedTier, body: result.promptSeed };
      if (result.kind === 'question' || !validateDropJob(input).ok) { report.deferred.push(id); continue; }
      if (await dropJobExists(root, id)) { report.candidates[report.candidates.length - 1] = { kind: 'ignore', reason: 'duplicate' }; continue; }
      if (!options.apply) continue;
      if (cooling || !snapshot.coverageComplete || report.sources.queue !== 'ok' || report.queued.length >= FEEDBACK_CYCLE_LIMIT ||
          await countQueuedDropJobPrompts(root) >= DROP_JOB_QUEUE_LIMIT) { report.deferred.push(id); continue; }
      await writeDropJob(root, input); report.queued.push(`RQ-PHX-${id}`);
      try {
        await recordFeedbackQueued(root, [{ at: new Date(now).toISOString(), job: `RQ-PHX-${id}`,
          source: signal.source, ref: signal.refs[0] ?? null, kind: result.kind }]);
      } catch { if (!report.errors.includes('queue-record-failed')) report.errors.push('queue-record-failed'); }
    }
  } catch { report.errors.push('queue-unavailable-or-write-failed'); }
  finally { releaseLocalStoreLock(lock); }
  return report;
}
