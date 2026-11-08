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
}

export interface AgentActivityOptions {
  /** Runs dir root; defaults to ~/.ashlr-runs. */
  runsDir?: string;
  /** Explicit ledger path; wins over runsDir. */
  jobsPath?: string;
  now?: () => number;
  /** Only jobs with a lifecycle event inside this window are returned. Default 6h. */
  windowMs?: number;
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
    const event = pickString(row, ['event', 'type', 'kind']);
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
  opts: { windowMs?: number; limit?: number } = {},
): { jobs: AgentActivityJob[]; byStage: Record<AgentActivityStage, number>; scanned: number; dropped: number; truncated: boolean } {
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0
    ? Math.min(opts.windowMs!, MAX_WINDOW_MS) : DEFAULT_WINDOW_MS;
  const limit = Number.isSafeInteger(opts.limit) && opts.limit! > 0
    ? Math.min(opts.limit!, MAX_LIMIT) : DEFAULT_LIMIT;
  const { events, scanned, dropped, truncated } = parseLedger(text);
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
  return { jobs: jobs.slice(0, limit), byStage, scanned, dropped, truncated };
}

/** Bounded tail read of the metrics ledger; never throws — missing is a state, not an exception. */
export async function readAgentActivity(opts: AgentActivityOptions = {}): Promise<AgentActivityReport> {
  const now = (opts.now ?? Date.now)();
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs! > 0
    ? Math.min(opts.windowMs!, MAX_WINDOW_MS) : DEFAULT_WINDOW_MS;
  const path = opts.jobsPath ?? join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl');
  const generatedAt = iso(Number.isFinite(now) ? now : Date.now());
  const empty = (sourceState: AgentActivityReport['sourceState'], dropped: number, scanned = 0, truncated = false): AgentActivityReport => ({
    v: 1, generatedAt, windowMs, sourceState, scanned, dropped, truncated, jobs: [],
    byStage: Object.fromEntries(STAGES.map(s => [s, 0])) as Record<AgentActivityStage, number>,
  });
  let text: string;
  let truncated = false;
  try {
    if (opts.reader) text = await opts.reader();
    else {
      const fh = await open(path, 'r');
      try {
        const { size } = await fh.stat();
        const start = Math.max(0, size - TAIL_BYTES);
        truncated = start > 0;
        const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
        await fh.read(buf, 0, buf.length, start);
        text = buf.toString('utf8');
        if (truncated) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
      } finally { await fh.close(); }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return empty(code === 'ENOENT' ? 'missing' : 'degraded', 0, 0, truncated);
  }
  try {
    const fold = summarizeAgentActivity(text, now, { windowMs, limit: opts.limit });
    return {
      v: 1, generatedAt,
      windowMs, sourceState: fold.dropped ? 'degraded' : 'healthy',
      scanned: fold.scanned, dropped: fold.dropped, truncated: truncated || fold.truncated,
      jobs: fold.jobs, byStage: fold.byStage,
    };
  } catch {
    return empty('degraded', 0, 0, truncated);
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
  return [head, ...lines];
}
