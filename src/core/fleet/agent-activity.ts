/**
 * `fleet.agent-activity.v1` — per-job launch->finish->publish lifecycle and
 * timing folded from the host metrics ledger (`<runsDir>/metrics/jobs.jsonl`,
 * default `~/.ashlr-runs`). dispatchd (and the outcome reconcilers) already
 * append the structured rows; this module projects them into one bounded,
 * allowlisted snapshot so `phm` status surfaces and the web UI can render
 * live agent activity without scraping worker logs.
 *
 * Follows the src/core/comms projection pattern: a pure `summarize*` fold, an
 * IO `read*` wrapper that never throws, an explicit `sourceState`, and an
 * `*Lines` output projection that re-validates at the boundary. Job ids may
 * repeat across attempts — a queue/launch row observed after a terminal event
 * starts a fresh attempt, and the newest queue or launch time is the attempt
 * boundary: a finish/publish/outcome stamped before it belongs to the older
 * attempt and never advances the requeued job. Only the newest attempt is
 * reported. Read-only: never writes, never touches dispatch or merge
 * authority.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AgentActivityStage = 'queued' | 'running' | 'finished' | 'published' | 'merged' | 'closed' | 'unknown';

export interface AgentActivityEvent {
  at: string;
  event: string;
}

export interface AgentActivityJob {
  job: string;
  lane: string | null;
  repo: string | null;
  tier: string | null;
  model: string | null;
  /** Newest lifecycle stage for the job's latest attempt. */
  stage: AgentActivityStage;
  /** ISO timestamps per lifecycle boundary; null when not observed. */
  queuedAt: string | null;
  launchedAt: string | null;
  finishedAt: string | null;
  publishedAt: string | null;
  outcomeAt: string | null;
  /** Terminal outcome text (MERGED/CLOSED/...) when an outcome row exists. */
  outcome: string | null;
  /** Published PR url, allowlisted to github.com pull links. */
  url: string | null;
  /** Seconds between boundaries; null when an endpoint is missing or reversed. */
  queueWaitS: number | null;
  runS: number | null;
  publishLagS: number | null;
  /** Dispatcher-reported wall_s from the finish row; not derived. */
  wallS: number | null;
  /** Running jobs: seconds since launch; queued jobs: seconds since queue; else null. */
  ageS: number | null;
  tokensTotal: number | null;
  exitCode: number | null;
  /** Bounded structured lifecycle event log, newest last (attempts included). */
  timeline: AgentActivityEvent[];
  lastEventAt: string;
}

export interface VerifiedLaneRollup {
  eligible: number;
  verified: number;
  failed: number;
  pending: number;
}

/**
 * `fleet.verified-completion.v1` — completed tasks passing an independent
 * outcome check vs eligible tasks, plus critical coordination failures.
 * A "claim" is worker/session evidence of completion (a published PR, a
 * batch member reported `done`, or a bare outcome row); the independent
 * check is the PR's reconciled GitHub state (MERGED/CLOSED) — never the
 * worker's own report. `rate` is verified/(verified+failed) over resolved
 * claims; pending claims are unresolved, not failures.
 */
export interface VerifiedCompletionReport {
  v: 1;
  schema: 'fleet.verified-completion.v1';
  generatedAt: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  /** Ledger lines examined after the tail/line clip. */
  scanned: number;
  dropped: number;
  truncated: boolean;
  windowMs: number;
  /** Claims with an independent-checkable artifact. */
  eligible: number;
  /** Claims whose check resolved MERGED. */
  verified: number;
  /** Claims whose every published PR resolved CLOSED — false completions. */
  failed: number;
  /** Claims whose check has not resolved yet. */
  pending: number;
  /** verified / (verified + failed); null when no claim resolved. */
  rate: number | null;
  claims: { published: number; batchMembers: number; outcomes: number };
  /** Finished non-empty jobs that never produced a checkable artifact. */
  completedUnpublished: number;
  duplicates: { multiPrJobs: number; sharedPrUrls: number };
  /** == failed: done-claims contradicted by the independent check. */
  falseCompletions: number;
  /** Publish/outcome rows targeting a repo other than the job's routed repo. */
  unauthorizedActions: number;
  byLane: Record<string, VerifiedLaneRollup>;
  detail: {
    falseCompletionJobs: string[];
    multiPrJobs: string[];
    sharedPrUrls: string[];
    unauthorizedJobs: string[];
  };
}

export interface AgentActivityReport {
  v: 1;
  /** Projection time; event timestamps stay in `jobs`. */
  generatedAt: string;
  windowMs: number;
  sourceState: 'healthy' | 'missing' | 'degraded';
  /** Ledger lines examined after the tail clip. */
  scanned: number;
  /** Lines that failed to parse or lifecycle rows missing job/ts. */
  dropped: number;
  /** True when the tail clip or line cap discarded older ledger content. */
  truncated: boolean;
  jobs: AgentActivityJob[];
  byStage: Record<AgentActivityStage, number>;
  /** Verified-completion metric over the same bounded ledger tail. */
  verified: VerifiedCompletionReport;
}

export interface AgentActivityOptions {
  /** Runs dir root; defaults to ~/.ashlr-runs. */
  runsDir?: string;
  /** Explicit ledger path; wins over runsDir. */
  jobsPath?: string;
  now?: () => number;
  /** Only jobs with a lifecycle event inside this window are returned. Default 6h. */
  windowMs?: number;
  /** Verified-completion claim window. Default 24h, capped at 168h. */
  verifiedWindowMs?: number;
  /** Max jobs returned, newest activity first. Default 50, capped 500. */
  limit?: number;
  /** Injected for tests; returns raw ledger text. */
  reader?: () => Promise<string>;
}

const DEFAULT_WINDOW_MS = 6 * 3_600_000;
const MAX_WINDOW_MS = 168 * 3_600_000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const MAX_LINES = 3000;
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_TIMELINE = 12;
const STAGES: readonly AgentActivityStage[] = ['queued', 'running', 'finished', 'published', 'merged', 'closed', 'unknown'];

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;
const PR_URL = /^https:\/\/github\.com\/[a-z\d_.-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*\/?$/i;
const OUTCOME_TEXT = /^[A-Za-z][A-Za-z0-9 ._-]{0,39}$/;
const QUEUE_EVENTS = new Set(['enqueue', 'claim', 'batch_claim', 'queued']);
const LIFECYCLE_EVENTS = new Set([...QUEUE_EVENTS, 'launch', 'finish', 'publish', 'outcome', 'task_outcome']);

type Row = Record<string, unknown>;
const record = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const pickString = (row: Row, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};
const pickNumber = (row: Row, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};
/** An offset is essential: otherwise Date.parse depends on the host timezone. */
const timestamp = (value: string | null): number | null => {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const iso = (ms: number): string => new Date(ms).toISOString();
const bounded = (value: string | null, re: RegExp): string | null =>
  value !== null && re.test(value) ? value : null;
const prUrl = (value: string | null): string | null =>
  value !== null && value.length <= 512 && PR_URL.test(value) ? value : null;
const seconds = (from: number | null, to: number | null): number | null =>
  from !== null && to !== null && to >= from ? Math.round((to - from) / 1000) : null;

interface ParsedEvent {
  job: string;
  event: string;
  ts: number;
  row: Row;
}

/**
 * Eventless producer/reconciler rows still carry lifecycle phase — the same
 * convention foldJobsLedger (eval-report) and batcher.read_rows use: a row
 * with no event/type/kind but outcome/state/status PUBLISHED is a publish,
 * and MERGED/CLOSED/OPEN is a reconciled outcome. `published` normalizes to
 * `publish`.
 */
function inferredEvent(row: Row): string | null {
  const phase = (pickString(row, ['state', 'outcome', 'status']) ?? '').toUpperCase();
  if (phase === 'PUBLISHED') return 'publish';
  if (phase === 'MERGED' || phase === 'CLOSED' || phase === 'OPEN') return 'outcome';
  return null;
}

/** Lifecycle rows only; operational rows (pool/concurrency/autobackoff) are skipped, malformed lines counted. */
function parseLedger(text: string): { events: ParsedEvent[]; scanned: number; dropped: number; truncated: boolean } {
  const lines = text.split('\n');
  const clipped = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
  const events: ParsedEvent[] = [];
  let dropped = 0;
  for (const rawLine of clipped) {
    const line = rawLine.trim();
    if (!line) continue;
    let row: Row | null;
    try { row = record(JSON.parse(line)); } catch { dropped++; continue; }
    if (!row) { dropped++; continue; }
    const named = pickString(row, ['event', 'type', 'kind']);
    const event = named === 'published' ? 'publish' : named ?? inferredEvent(row);
    if (event === null || !LIFECYCLE_EVENTS.has(event)) continue;
    const job = bounded(pickString(row, ['job', 'job_id', 'jobId', 'id']), JOB_ID);
    const ts = timestamp(pickString(row, ['ts', 'at', 'time', 'timestamp', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt']));
    if (job === null || ts === null) { dropped++; continue; }
    events.push({ job, event, ts, row });
  }
  return { events, scanned: clipped.length, dropped, truncated: clipped.length < lines.length };
}

interface Attempt {
  queued: number | null;
  launched: number | null;
  /** Later queue/launch time of this attempt; terminal rows stamped before it are stragglers from the older attempt. */
  boundary: number;
  finished: number | null;
  published: number | null;
  outcomeAt: number | null;
  outcome: string | null;
  url: string | null;
  wallS: number | null;
  tokens: number | null;
  exitCode: number | null;
  lane: string | null;
  repo: string | null;
  tier: string | null;
  model: string | null;
  timeline: AgentActivityEvent[];
}

const freshAttempt = (): Attempt => ({
  queued: null, launched: null, boundary: -Infinity, finished: null, published: null,
  outcomeAt: null, outcome: null, url: null,
  wallS: null, tokens: null, exitCode: null,
  lane: null, repo: null, tier: null, model: null, timeline: [],
});

const terminal = (a: Attempt): boolean =>
  a.finished !== null || a.published !== null || a.outcomeAt !== null;

/** Newest terminal boundary; a later event starts a new attempt, an older one is a straggler. */
const lastBoundary = (a: Attempt): number =>
  Math.max(a.finished ?? 0, a.published ?? 0, a.outcomeAt ?? 0);

/** New attempt: boundary fields reset, but the structured event log keeps the observed history. */
const reset = (a: Attempt): void => { const tl = a.timeline; Object.assign(a, freshAttempt()); a.timeline = tl; };

function mergeMeta(a: Attempt, row: Row): void {
  const lane = bounded(pickString(row, ['lane', 'pool']), LANE_ID);
  const repo = bounded(pickString(row, ['repo']), LABEL);
  const tier = bounded(pickString(row, ['tier']), LABEL);
  const model = bounded(pickString(row, ['model']), LABEL);
  if (a.lane === null && lane) a.lane = lane;
  if (a.repo === null && repo) a.repo = repo;
  if (a.tier === null && tier) a.tier = tier;
  if (a.model === null && model) a.model = model;
}

function pushTimeline(a: Attempt, ev: ParsedEvent): void {
  a.timeline.push({ at: iso(ev.ts), event: ev.event });
  if (a.timeline.length > MAX_TIMELINE) a.timeline.splice(0, a.timeline.length - MAX_TIMELINE);
}

/** Fold lifecycle events into the newest attempt per job, in ledger order. */
export function summarizeAgentActivity(
  text: string,
  now: number,
  opts: { windowMs?: number; verifiedWindowMs?: number; limit?: number } = {},
): { jobs: AgentActivityJob[]; byStage: Record<AgentActivityStage, number>; scanned: number; dropped: number; truncated: boolean; verified: VerifiedCompletionReport } {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0
    ? Math.min(opts.windowMs!, MAX_WINDOW_MS) : DEFAULT_WINDOW_MS;
  const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0
    ? Math.min(opts.limit!, MAX_LIMIT) : DEFAULT_LIMIT;
  const { events, scanned, dropped, truncated } = parseLedger(text);
  const verified = foldVerifiedCompletion(events, now, verifiedWindowMs(opts.verifiedWindowMs), scanned, dropped, truncated);
  const attempts = new Map<string, { a: Attempt; lastEventAt: number }>();
  for (const ev of events) {
    let entry = attempts.get(ev.job);
    if (!entry) { entry = { a: freshAttempt(), lastEventAt: ev.ts }; attempts.set(ev.job, entry); }
    const a = entry.a;
    if (ev.ts > entry.lastEventAt) entry.lastEventAt = ev.ts;
    if (QUEUE_EVENTS.has(ev.event)) {
      if (terminal(a) && ev.ts >= lastBoundary(a)) reset(a);
      a.boundary = Math.max(a.boundary, ev.ts);
      if (a.launched === null && (a.queued === null || ev.ts < a.queued)) a.queued = ev.ts;
      mergeMeta(a, ev.row);
      pushTimeline(a, ev);
    } else if (ev.event === 'launch') {
      if (terminal(a) && ev.ts >= lastBoundary(a)) reset(a);
      a.boundary = Math.max(a.boundary, ev.ts);
      if (a.launched === null || ev.ts >= a.launched) a.launched = ev.ts;
      mergeMeta(a, ev.row);
      // Launch rows carry the authoritative model/repo/tier.
      const model = bounded(pickString(ev.row, ['model']), LABEL);
      if (model) a.model = model;
      pushTimeline(a, ev);
    } else if (ev.event === 'finish') {
      if (a.finished === null && ev.ts >= a.boundary) {
        a.finished = ev.ts;
        a.wallS = pickNumber(ev.row, ['wall_s', 'wallS']);
        a.tokens = pickNumber(ev.row, ['tokens_total', 'tokensTotal']);
        const code = pickNumber(ev.row, ['exit_code', 'exitCode']);
        a.exitCode = code !== null ? Math.trunc(code) : null;
      }
      mergeMeta(a, ev.row);
      pushTimeline(a, ev);
    } else if (ev.event === 'publish') {
      if (a.published === null && (a.finished === null ? ev.ts >= a.boundary : ev.ts >= a.finished)) {
        a.published = ev.ts;
        a.url = prUrl(pickString(ev.row, ['url', 'pr_url', 'prUrl', 'pr'])) ?? a.url;
      }
      mergeMeta(a, ev.row);
      pushTimeline(a, ev);
    } else {
      // outcome / task_outcome — reconciler rows at or after this attempt's
      // queue/launch boundary only; a stale outcome must not close or re-link a
      // requeued or re-launched job. Latest wins.
      if (ev.ts >= a.boundary) {
        if (ev.ts >= (a.outcomeAt ?? -Infinity)) {
          a.outcomeAt = ev.ts;
          a.outcome = bounded(pickString(ev.row, ['outcome', 'state', 'status']), OUTCOME_TEXT) ?? 'recorded';
        }
        const url = prUrl(pickString(ev.row, ['url', 'pr_url', 'prUrl', 'pr']));
        if (a.url === null && url) a.url = url;
      }
      mergeMeta(a, ev.row);
      pushTimeline(a, ev);
    }
  }
  const jobs: AgentActivityJob[] = [];
  const cutoff = Number.isFinite(now) ? now - windowMs : -Infinity;
  for (const [job, entry] of attempts) {
    const a = entry.a;
    if (entry.lastEventAt < cutoff) continue;
    const stage: AgentActivityStage =
      a.outcomeAt !== null ? (/merged/i.test(a.outcome ?? '') ? 'merged' : 'closed')
      : a.published !== null ? 'published'
      : a.finished !== null ? 'finished'
      : a.launched !== null ? 'running'
      : a.queued !== null ? 'queued' : 'unknown';
    jobs.push({
      job, stage,
      lane: a.lane, repo: a.repo, tier: a.tier, model: a.model,
      queuedAt: a.queued !== null ? iso(a.queued) : null,
      launchedAt: a.launched !== null ? iso(a.launched) : null,
      finishedAt: a.finished !== null ? iso(a.finished) : null,
      publishedAt: a.published !== null ? iso(a.published) : null,
      outcomeAt: a.outcomeAt !== null ? iso(a.outcomeAt) : null,
      outcome: a.outcome, url: a.url,
      queueWaitS: seconds(a.queued, a.launched),
      runS: seconds(a.launched, a.finished),
      publishLagS: seconds(a.finished, a.published),
      wallS: a.wallS !== null ? Math.round(a.wallS) : null,
      ageS: stage === 'running' ? seconds(a.launched, now) : stage === 'queued' ? seconds(a.queued, now) : null,
      tokensTotal: a.tokens !== null ? Math.round(a.tokens) : null,
      exitCode: a.exitCode,
      timeline: a.timeline,
      lastEventAt: iso(entry.lastEventAt),
    });
  }
  jobs.sort((x, y) => y.lastEventAt.localeCompare(x.lastEventAt) || x.job.localeCompare(y.job));
  // byStage counts every job inside the window, not just the returned page.
  const byStage = Object.fromEntries(STAGES.map(s => [s, 0])) as Record<AgentActivityStage, number>;
  for (const j of jobs) byStage[j.stage] += 1;
  return { jobs: jobs.slice(0, limit), byStage, scanned, dropped, truncated, verified: verified };
}

/** Bounded tail read of the metrics ledger; never throws — missing is a state, not an exception. */
async function readLedgerTail(opts: AgentActivityOptions): Promise<{ text: string; truncated: boolean; missing: boolean; degraded: boolean }> {
  const path = opts.jobsPath ?? join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl');
  try {
    if (opts.reader) return { text: await opts.reader(), truncated: false, missing: false, degraded: false };
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const truncated = start > 0;
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      await fh.read(buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      if (truncated) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
      return { text, truncated, missing: false, degraded: false };
    } finally { await fh.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { text: '', truncated: false, missing: code === 'ENOENT', degraded: code !== 'ENOENT' };
  }
}

function emptyVerified(generatedAt: string, windowMs: number, sourceState: VerifiedCompletionReport['sourceState'], scanned = 0, dropped = 0, truncated = false): VerifiedCompletionReport {
  return {
    v: 1, schema: 'fleet.verified-completion.v1', generatedAt, sourceState,
    scanned, dropped, truncated, windowMs,
    eligible: 0, verified: 0, failed: 0, pending: 0, rate: null,
    claims: { published: 0, batchMembers: 0, outcomes: 0 },
    completedUnpublished: 0,
    duplicates: { multiPrJobs: 0, sharedPrUrls: 0 },
    falseCompletions: 0, unauthorizedActions: 0,
    byLane: {},
    detail: { falseCompletionJobs: [], multiPrJobs: [], sharedPrUrls: [], unauthorizedJobs: [] },
  };
}

/** Bounded tail read of the metrics ledger; never throws — missing is a state, not an exception. */
export async function readAgentActivity(opts: AgentActivityOptions = {}): Promise<AgentActivityReport> {
  const now = (opts.now ?? Date.now)();
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0
    ? Math.min(opts.windowMs!, MAX_WINDOW_MS) : DEFAULT_WINDOW_MS;
  const vWindowMs = verifiedWindowMs(opts.verifiedWindowMs);
  const generatedAt = iso(Number.isFinite(now) ? now : Date.now());
  const empty = (sourceState: AgentActivityReport['sourceState'], dropped: number, scanned = 0, truncated = false): AgentActivityReport => ({
    v: 1, generatedAt, windowMs, sourceState, scanned, dropped, truncated, jobs: [],
    byStage: Object.fromEntries(STAGES.map(s => [s, 0])) as Record<AgentActivityStage, number>,
    verified: emptyVerified(generatedAt, vWindowMs, sourceState === 'missing' ? 'missing' : 'degraded', scanned, dropped, truncated),
  });
  const tail = await readLedgerTail(opts);
  if (tail.missing || tail.degraded) return empty(tail.missing ? 'missing' : 'degraded', 0, 0, tail.truncated);
  try {
    const fold = summarizeAgentActivity(tail.text, now, { windowMs, verifiedWindowMs: vWindowMs, limit: opts.limit });
    return {
      v: 1, generatedAt,
      windowMs, sourceState: fold.dropped ? 'degraded' : 'healthy',
      scanned: fold.scanned, dropped: fold.dropped, truncated: tail.truncated || fold.truncated,
      jobs: fold.jobs, byStage: fold.byStage, verified: fold.verified,
    };
  } catch {
    return empty('degraded', 0, 0, tail.truncated);
  }
}

/**
 * Verified-completion projection alone — the same bounded ledger tail as
 * readAgentActivity, returned without the per-job activity page. Never
 * throws; a missing ledger reports `missing`, not an error.
 */
export async function readVerifiedCompletion(opts: AgentActivityOptions = {}): Promise<VerifiedCompletionReport> {
  const now = (opts.now ?? Date.now)();
  const windowMs = verifiedWindowMs(opts.verifiedWindowMs);
  const generatedAt = iso(Number.isFinite(now) ? now : Date.now());
  const tail = await readLedgerTail(opts);
  if (tail.missing || tail.degraded) {
    return emptyVerified(generatedAt, windowMs, tail.missing ? 'missing' : 'degraded', 0, 0, tail.truncated);
  }
  try {
    const { events, scanned, dropped, truncated } = parseLedger(tail.text);
    return foldVerifiedCompletion(events, now, windowMs, scanned, dropped, tail.truncated || truncated);
  } catch {
    return emptyVerified(generatedAt, windowMs, 'degraded', 0, 0, tail.truncated);
  }
}

const span = (s: number | null): string | null => {
  if (s === null || !Number.isFinite(s) || s < 0) return null;
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};
const field = (value: string | null): string => value ?? '-';

/** Output-boundary projection: re-validates every value it renders. */
export function agentActivityLines(report: AgentActivityReport): string[] {
  const state = report?.sourceState === 'healthy' || report?.sourceState === 'missing' || report?.sourceState === 'degraded'
    ? report.sourceState : 'unavailable';
  const jobs = Array.isArray(report?.jobs) ? report.jobs : [];
  const windowH = Number.isFinite(report?.windowMs) ? Math.round(report.windowMs / 3_600_000) : 0;
  const head = `Agent activity: ${jobs.length} job${jobs.length === 1 ? '' : 's'} in ${windowH}h window (source ${state}${report?.truncated ? ', ledger tail clipped' : ''})`;
  const lines = jobs.flatMap(j => {
    if (!j || typeof j.job !== 'string' || !JOB_ID.test(j.job)) return [];
    const stage = STAGES.includes(j.stage) ? j.stage : 'unknown';
    const parts = [`${field(bounded(j.lane, LANE_ID))}/${field(bounded(j.repo, LABEL))}`];
    const wait = span(j.queueWaitS), run = span(j.runS), lag = span(j.publishLagS), age = span(j.ageS);
    if (wait) parts.push(`queue ${wait}`);
    if (run) parts.push(`run ${run}`);
    if (lag) parts.push(`lag ${lag}`);
    if (age) parts.push(`age ${age}`);
    if (Number.isSafeInteger(j.exitCode) && j.exitCode !== 0) parts.push(`exit ${j.exitCode}`);
    if (typeof j.url === 'string' && prUrl(j.url)) parts.push(j.url);
    return [`${j.job} ${stage} ${parts.join(' ')}`];
  });
  const v = report?.verified;
  const vWindowH = v && Number.isFinite(v.windowMs) ? Math.round(v.windowMs / 3_600_000) : 0;
  const vRate = v && typeof v.rate === 'number' && Number.isFinite(v.rate) ? `${Math.round(v.rate * 100)}%` : 'n/a';
  const vState = v?.sourceState === 'healthy' ? '' : ` (source ${v?.sourceState ?? 'unavailable'}${v?.truncated ? ', tail clipped' : ''})`;
  const vLine = `Verified completion (${vWindowH}h): ${vRate} — ${v?.verified ?? 0} verified / ${v?.failed ?? 0} failed / ${v?.pending ?? 0} pending of ${v?.eligible ?? 0} claims; false completions ${v?.falseCompletions ?? 0}, duplicates ${v?.duplicates?.multiPrJobs ?? 0}+${v?.duplicates?.sharedPrUrls ?? 0}, unauthorized ${v?.unauthorizedActions ?? 0}${vState}`;
  return [head, ...lines, vLine];
}

// ---------------------------------------------------------------------------
// Verified completion — completed tasks checked by an independent outcome
// ---------------------------------------------------------------------------
//
// Digest item: a task counts as *verified complete* only when an independent
// check confirms it — here, the reconciled GitHub state of the PR the task
// published (MERGED/CLOSED via metrics-outcomes), never the worker's own
// "done" report, a non-empty finish, or a publish event alone. Claims:
//   - `published`: a non-batch job published >=1 github PR url in-window.
//   - `batch-member`: a batch member's latest task_outcome is `done`; the
//     check resolves through the batch session's published PRs.
//   - `outcome`: a bare outcome row (no publish row observed) — the outcome
//     itself is the independent evidence.
// Coordination failures counted alongside:
//   - duplicates: one attempt publishing >1 distinct PRs (multiPrJobs), or
//     the same PR url claimed by >1 distinct job ids (sharedPrUrls);
//   - false completions: claims whose every published PR resolved CLOSED
//     (== `failed`);
//   - unauthorized actions: publish/outcome rows whose PR repo differs from
//     the job's routed repo (owner/name compared when the route carries one,
//     basename otherwise — basename routes cannot detect owner spoofing).
// Batch session jobs (RQ-BATCH-*) are infrastructure, not tasks: their
// publishes resolve member claims but never form claims themselves.
// Mirrors contrib/mac/dispatchd.py `verified_completion()` — keep in sync.

const VERIFIED_WINDOW_MS = 24 * 3_600_000;
const BATCH_PREFIX = 'RQ-BATCH-';
const MAX_DETAIL = 20;
const PR_KEY = /^https:\/\/github\.com\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i;
const RESOLVED_PR_STATES = new Set(['MERGED', 'CLOSED', 'OPEN']);

function verifiedWindowMs(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.min(value!, MAX_WINDOW_MS) : VERIFIED_WINDOW_MS;
}

interface PrRef { key: string; repoLc: string }

/** Canonical PR identity: lowercase owner/repo, bare /pull/N key. */
function prRefOf(row: Row): PrRef | null {
  for (const k of ['url', 'pr_url', 'prUrl', 'pr', 'html_url']) {
    const v = row[k];
    if (typeof v === 'string' && v.length <= 512) {
      const m = PR_KEY.exec(v.trim());
      if (m) return { key: `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/pull/${m[3]}`, repoLc: `${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}` };
    }
  }
  return null;
}

/** Uppercase outcome-ish phase (outcome/state/status), null when absent. */
function prPhase(row: Row): string | null {
  const v = pickString(row, ['outcome', 'state', 'status']);
  return v === null ? null : v.toUpperCase();
}

type VerifiedVerdict = 'verified' | 'failed' | 'pending';

interface VAttempt {
  boundary: number;
  finish: { ts: number; okNonEmpty: boolean } | null;
  publishTs: number | null;
  publishLane: string | null;
  urls: string[];
  urlSet: Set<string>;
  taskOutcome: { outcome: string; batch: string | null; ts: number } | null;
  batchId: string | null;
  jobOutcome: { state: string; ts: number } | null;
  outcomeTs: number | null;
  lane: string | null;
  repo: string | null;
}

const freshVAttempt = (): VAttempt => ({
  boundary: -Infinity, finish: null, publishTs: null, publishLane: null,
  urls: [], urlSet: new Set(), taskOutcome: null, batchId: null,
  jobOutcome: null, outcomeTs: null, lane: null, repo: null,
});

const vTerminal = (a: VAttempt): boolean =>
  a.finish !== null || a.publishTs !== null || a.outcomeTs !== null || a.taskOutcome !== null;

const vLastBoundary = (a: VAttempt): number =>
  Math.max(a.finish?.ts ?? 0, a.publishTs ?? 0, a.outcomeTs ?? 0, a.taskOutcome?.ts ?? 0);

function mergeVMeta(a: VAttempt, row: Row): void {
  const lane = bounded(pickString(row, ['lane', 'pool']), LANE_ID);
  const repo = bounded(pickString(row, ['repo']), LABEL);
  if (a.lane === null && lane) a.lane = lane;
  if (a.repo === null && repo) a.repo = repo;
}

/** MERGED wins; all-CLOSED fails; anything unresolved stays pending. */
function verdictFor(urls: Iterable<string>, urlStates: Map<string, string>): VerifiedVerdict {
  let merged = false, closed = false, unresolved = false;
  for (const u of urls) {
    const s = urlStates.get(u);
    if (s === 'MERGED') merged = true;
    else if (s === 'CLOSED') closed = true;
    else unresolved = true;
  }
  if (merged) return 'verified';
  if (closed && !unresolved) return 'failed';
  return 'pending';
}

/** routed 'owner/name' matches exactly; basename routes match the repo name only. */
function repoMatches(routed: string, urlRepoLc: string): boolean {
  const r = routed.trim().toLowerCase();
  return r.includes('/') ? r === urlRepoLc : r === urlRepoLc.split('/').pop();
}

interface VClaim { job: string; kind: 'published' | 'batch-member' | 'outcome'; lane: string | null; ts: number; verdict: VerifiedVerdict }

function foldVerifiedCompletion(
  events: ParsedEvent[],
  now: number,
  windowMs: number,
  scanned: number,
  dropped: number,
  truncated: boolean,
): VerifiedCompletionReport {
  const generatedAt = iso(Number.isFinite(now) ? now : Date.now());
  const cutoff = now - windowMs;
  const urlStates = new Map<string, string>();
  /** url -> (job -> earliest row ts) claim evidence for duplicate/unauthorized checks. */
  const urlJobs = new Map<string, Map<string, number>>();
  /** job -> every PR url it published (any attempt, any window) for batch-member checks. */
  const claimUrls = new Map<string, Set<string>>();
  const jobs = new Map<string, { attempts: VAttempt[]; current: VAttempt; repo: string | null }>();
  const jobOf = (id: string) => {
    let j = jobs.get(id);
    if (!j) { j = { attempts: [], current: freshVAttempt(), repo: null }; jobs.set(id, j); }
    return j;
  };
  const urlEdge = (url: string, job: string, ts: number): void => {
    let m = urlJobs.get(url);
    if (!m) { m = new Map(); urlJobs.set(url, m); }
    const prev = m.get(job);
    if (prev === undefined || ts < prev) m.set(job, ts);
  };
  for (const ev of events) {
    const j = jobOf(ev.job);
    if (QUEUE_EVENTS.has(ev.event) || ev.event === 'launch') {
      let a = j.current;
      if (vTerminal(a) && ev.ts >= vLastBoundary(a)) { j.attempts.push(a); a = j.current = freshVAttempt(); }
      a.boundary = Math.max(a.boundary, ev.ts);
      mergeVMeta(a, ev.row);
      if (ev.event === 'batch_claim') {
        const b = bounded(pickString(ev.row, ['batch', 'batch_id', 'batchId']), JOB_ID);
        if (b && a.batchId === null) a.batchId = b;
      }
      const repo = bounded(pickString(ev.row, ['repo']), LABEL);
      if (repo) j.repo = repo;
      continue;
    }
    const a = j.current;
    if (ev.event === 'publish') {
      const pr = prRefOf(ev.row);
      const phase = prPhase(ev.row);
      if (phase !== null && RESOLVED_PR_STATES.has(phase)) {
        // Reconciler resolution row: updates the PR's state and claim
        // evidence, never a new completion claim and never attempt state.
        if (pr) { urlStates.set(pr.key, phase); urlEdge(pr.key, ev.job, ev.ts); }
        continue;
      }
      if (ev.ts < a.boundary) continue;
      if (pr) {
        if (!a.urlSet.has(pr.key)) {
          a.urlSet.add(pr.key); a.urls.push(pr.key);
          let s = claimUrls.get(ev.job); if (!s) { s = new Set(); claimUrls.set(ev.job, s); }
          s.add(pr.key);
        }
        urlEdge(pr.key, ev.job, ev.ts);
        if (a.publishTs === null) {
          a.publishTs = ev.ts;
          a.publishLane = bounded(pickString(ev.row, ['lane', 'pool']), LANE_ID);
        }
      }
      mergeVMeta(a, ev.row);
      continue;
    }
    if (ev.event === 'outcome') {
      const pr = prRefOf(ev.row);
      const phase = prPhase(ev.row) ?? 'RECORDED';
      // A url's reconciled state is a fact about the PR, not the attempt:
      // github timestamps can predate a requeue boundary, so urlStates and
      // claim evidence update before the attempt guard. Only the url-less
      // jobOutcome (which attributes to an attempt) stays guarded.
      if (pr) { urlStates.set(pr.key, phase); urlEdge(pr.key, ev.job, ev.ts); }
      if (ev.ts >= a.boundary) {
        if (!pr && ev.ts >= (a.jobOutcome?.ts ?? -Infinity)) a.jobOutcome = { state: phase, ts: ev.ts };
        if (ev.ts >= (a.outcomeTs ?? -Infinity)) a.outcomeTs = ev.ts;
        mergeVMeta(a, ev.row);
      }
      continue;
    }
    if (ev.ts < a.boundary) continue;
    if (ev.event === 'finish') {
      if (a.finish === null) {
        const code = pickNumber(ev.row, ['exit_code', 'exitCode']);
        a.finish = { ts: ev.ts, okNonEmpty: code === 0 && ev.row['empty'] !== true };
      }
      mergeVMeta(a, ev.row);
      continue;
    }
    // task_outcome — batch member result from the session's BRIDGE_NOTES.
    const o = pickString(ev.row, ['outcome']);
    if (o !== null && ev.ts >= (a.taskOutcome?.ts ?? -Infinity)) {
      const b = bounded(pickString(ev.row, ['batch', 'batch_id', 'batchId']), JOB_ID) ?? a.batchId;
      a.taskOutcome = { outcome: o.toLowerCase(), batch: b, ts: ev.ts };
    }
    if (ev.ts >= (a.outcomeTs ?? -Infinity)) a.outcomeTs = ev.ts;
    mergeVMeta(a, ev.row);
  }

  const claims: VClaim[] = [];
  const multiPr = new Set<string>();
  let completedUnpublished = 0;
  for (const [job, j] of jobs) {
    const isBatch = job.startsWith(BATCH_PREFIX);
    const all = [...j.attempts, j.current];
    const wurls = new Set<string>();
    let hasDone = false, hasResolvedOutcome = false, okFinish = false;
    for (const att of all) {
      if (att.publishTs !== null && att.publishTs >= cutoff) att.urls.forEach(u => wurls.add(u));
      if (att.finish?.okNonEmpty && att.finish.ts >= cutoff) okFinish = true;
      if (att.taskOutcome?.outcome === 'done') hasDone = true;
      if (att.jobOutcome && (att.jobOutcome.state === 'MERGED' || att.jobOutcome.state === 'CLOSED')) hasResolvedOutcome = true;
      if (isBatch) continue;   // batch sessions are infrastructure, not tasks
      if (att.publishTs !== null && att.publishTs >= cutoff && att.urls.length > 0) {
        claims.push({ job, kind: 'published', lane: att.publishLane ?? att.lane, ts: att.publishTs, verdict: verdictFor(att.urls, urlStates) });
      }
      if (att.taskOutcome?.outcome === 'done' && att.taskOutcome.ts >= cutoff) {
        const bus = att.taskOutcome.batch ? claimUrls.get(att.taskOutcome.batch) : undefined;
        claims.push({
          job, kind: 'batch-member', lane: att.lane, ts: att.taskOutcome.ts,
          verdict: bus && bus.size > 0 ? verdictFor(bus, urlStates) : 'pending',
        });
      }
      if (att.urls.length === 0 && att.taskOutcome?.outcome !== 'done' && att.jobOutcome
        && (att.jobOutcome.state === 'MERGED' || att.jobOutcome.state === 'CLOSED')
        && att.jobOutcome.ts >= cutoff) {
        claims.push({ job, kind: 'outcome', lane: att.lane, ts: att.jobOutcome.ts, verdict: att.jobOutcome.state === 'MERGED' ? 'verified' : 'failed' });
      }
    }
    if (wurls.size > 1) multiPr.add(job);
    if (!isBatch && okFinish && (claimUrls.get(job)?.size ?? 0) === 0 && !hasDone && !hasResolvedOutcome) completedUnpublished++;
  }

  const byLane: Record<string, VerifiedLaneRollup> = {};
  const falseJobs = new Set<string>();
  const kindCount = { published: 0, batchMembers: 0, outcomes: 0 };
  let eligible = 0, verified = 0, failed = 0, pending = 0;
  for (const c of claims) {
    eligible++;
    if (c.kind === 'published') kindCount.published++;
    else if (c.kind === 'batch-member') kindCount.batchMembers++;
    else kindCount.outcomes++;
    if (c.verdict === 'verified') verified++;
    else if (c.verdict === 'failed') { failed++; falseJobs.add(c.job); }
    else pending++;
    const lane = bounded(c.lane, LANE_ID) ?? 'unknown';
    const r = byLane[lane] ??= { eligible: 0, verified: 0, failed: 0, pending: 0 };
    r.eligible++;
    if (c.verdict === 'verified') r.verified++;
    else if (c.verdict === 'failed') r.failed++;
    else r.pending++;
  }

  // Duplicate + unauthorized evidence: in-window url->job edges.
  const shared = new Map<string, Set<string>>();
  const unauthorizedJobs = new Set<string>();
  let sharedPrUrls = 0, unauthorizedActions = 0;
  for (const [url, byJob] of urlJobs) {
    const jobsInWindow = new Set<string>();
    for (const [job, ts] of byJob) if (ts >= cutoff) jobsInWindow.add(job);
    if (jobsInWindow.size > 1) { sharedPrUrls++; shared.set(url, jobsInWindow); }
    const repoLc = url.slice('https://github.com/'.length, url.lastIndexOf('/pull/'));
    for (const job of jobsInWindow) {
      const routed = jobs.get(job)?.repo;
      if (routed && !repoMatches(routed, repoLc)) { unauthorizedActions++; unauthorizedJobs.add(job); }
    }
  }

  const capped = (xs: Iterable<string>): string[] => [...xs].sort().slice(0, MAX_DETAIL);
  return {
    v: 1, schema: 'fleet.verified-completion.v1', generatedAt,
    sourceState: dropped > 0 || truncated ? 'degraded' : 'healthy',
    scanned, dropped, truncated, windowMs,
    eligible, verified, failed, pending,
    rate: verified + failed > 0 ? Math.round((verified / (verified + failed)) * 1000) / 1000 : null,
    claims: kindCount,
    completedUnpublished,
    duplicates: { multiPrJobs: multiPr.size, sharedPrUrls },
    falseCompletions: failed,
    unauthorizedActions,
    byLane,
    detail: {
      falseCompletionJobs: capped(falseJobs),
      multiPrJobs: capped(multiPr),
      sharedPrUrls: capped(shared.keys()),
      unauthorizedJobs: capped(unauthorizedJobs),
    },
  };
}

/** Text-level fold for tests and callers that already hold ledger text. */
export function summarizeVerifiedCompletion(
  text: string,
  now: number,
  opts: { windowMs?: number } = {},
): VerifiedCompletionReport {
  const windowMs = verifiedWindowMs(opts.windowMs);
  const { events, scanned, dropped, truncated } = parseLedger(text);
  return foldVerifiedCompletion(events, now, windowMs, scanned, dropped, truncated);
}
