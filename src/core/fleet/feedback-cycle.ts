import { join } from 'node:path';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { scrubSecrets } from '../util/scrub-secrets.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, dropJobExists, resolveDropJobRoot, validateDropJob, writeDropJob } from './drop-job-writer.js';
import { ingestFeedback, type FeedbackSnapshot } from './feedback-ingest.js';
import { feedbackJobId, triageFeedback, type FeedbackCoverage } from './feedback-triage.js';

export const FEEDBACK_CYCLE_LIMIT = 5;
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

/** Latest measured job state; a finish is reviewable, never evidence of shipment. */
export function feedbackDigest(snapshot: FeedbackSnapshot, ledger: string, now: number) {
  const latest = new Map<string, { at: number; event: string; state: string; failed: boolean }>();
  const records: Record<string, unknown>[] = [], repos = new Map<string, string>(), jobsByPR = new Map<string, string>();
  let invalidRows = 0;
  for (const line of ledger.split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error();
      records.push(r);
      const id = r.job ?? r.job_id ?? r.jobId, pr = r.url ?? r.prUrl;
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
      const id = r.job ?? r.job_id ?? r.jobId ?? jobsByPR.get(String(r.url ?? r.prUrl));
      if (typeof id !== 'string' || repos.get(id) !== 'phantom') continue;
      const raw = r.ts ?? r.timestamp ?? r.at, at = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : typeof raw === 'string' ? Date.parse(raw) : NaN;
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id) || scrubSecrets(id) !== id || !Number.isFinite(at)) { invalidRows++; continue; }
      if (at > now || at < (latest.get(id)?.at ?? 0)) continue;
      const event = String(r.event ?? '').toLowerCase(), state = String(r.state ?? r.outcome ?? r.status ?? r.result ?? '').toUpperCase();
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
  return { windowHours: 12, shipped: snapshot.shipped.filter(r => r.at >= now - 12 * 3600000 && r.at <= now).map(r => r.ref),
    needsReview, failures, stillRunning, invalidRows, runningEvidence: 'last recorded launch; liveness unverified' };
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
    const digest = feedbackDigest(snapshot, ledger, now);
    if (digest.invalidRows) report.sources.jobs = 'unavailable';
    return { ...report, digest: { ...digest, ...(report.sources.merges === 'unavailable' ? { shipped: null } : {}), ...(report.sources.jobs === 'unavailable' ? { needsReview: null, failures: null, stillRunning: null } : {}) } };
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
    }
  } catch { report.errors.push('queue-unavailable-or-write-failed'); }
  finally { releaseLocalStoreLock(lock); }
  return report;
}
