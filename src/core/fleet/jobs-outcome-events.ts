/**
 * jobs-outcome-events.ts — fold `metrics/jobs.jsonl` (plus the
 * `metrics/work-market.jsonl` route decisions) into the ASSIGN/OUTCOME event
 * lines `learnOutcomes` consumes.
 *
 * The dispatcher's text log (`queue/dispatch-events.log`) is not what the
 * fleet writes today; the append-only jobs ledger is. This module is the
 * read-side bridge: it replays ledger rows into the learner's event
 * vocabulary so merge rate, time to merge, usage and breakage posteriors are
 * built from real fleet outcomes instead of an empty log.
 *
 * Mapping rules, all evidence-backed:
 * - ASSIGN comes from `launch`/`batch_claim` rows only — the rows that record
 *   an executor actually starting work. `claim` rows carry no model and
 *   `enqueue` lanes are hints, not assignments, so neither can form one.
 *   When a job id was launched more than once, the newest launch wins: it is
 *   the attempt the terminal outcome belongs to.
 * - OUTCOME comes from terminal PR evidence only: `MERGED`/`CLOSED` states on
 *   `outcome` rows, attached by job id or by an unambiguous PR URL. A merged
 *   record wins over a closed one for the same job (merged is sticky, the
 *   same convention metrics-ingest and job-outcomes use). Jobs with launch
 *   evidence but no terminal row still emit their ASSIGN: they stay pending
 *   and the learner's censor counts them as failures past the horizon —
 *   exactly the stranded-work signal the log learner was designed for.
 * - `usage` is the sum of `tokens_total` across `finish` rows at or after the
 *   chosen launch. When no finish row reports tokens the field is omitted:
 *   unknown stays unknown, never zero.
 * - `minutes` is launch-to-merge wall time, emitted only for merged jobs with
 *   a resolvable merge stamp.
 * - `breakage` has no jobs-ledger evidence, so it is never emitted (the
 *   learner's default applies); post-merge observations are keyed by merge
 *   commit, not job id, and cannot be joined honestly here.
 * - `jobType` is the job-id family prefix (`RQ-PHX-*` -> `PHX`), the same
 *   family notion the batcher uses; the market `work_class` is the fallback,
 *   then `misc`.
 * - `RQ-BATCH-*` bundle ids are session containers, not merge-pipeline work:
 *   members carry their own `batch_claim` rows and outcomes. Emitting an
 *   assign for the bundle would count every batch session as a stranded PR.
 *
 * Nothing here infers a merge from a PR URL alone, fabricates usage, or
 * writes anywhere. Malformed lines and unattachable rows are counted and
 * skipped.
 */
import { join } from 'node:path';
import { readLedgerTail } from '../router/outcomes.js';

export interface JobsOutcomeFoldStats {
  /** Distinct job ids that produced an emitted assign. */
  jobs: number;
  /** Terminal outcome lines emitted (merged or closed). */
  outcomes: number;
  /** Assigns emitted with no terminal outcome; they stay pending for the censor. */
  pending: number;
  /** Job ids dropped: no assign evidence, invalid fields, or batch bundles. */
  skipped: number;
  /** Non-JSON or non-object ledger lines ignored. */
  malformed: number;
}

export interface JobsOutcomeFold {
  /** Learner-compatible JSONL: one `assign` line per job, then its `outcome` line when resolved. */
  text: string;
  stats: JobsOutcomeFoldStats;
}

export interface JobsOutcomeEventsRead extends JobsOutcomeFold {
  jobsState: 'read' | 'missing' | 'unreadable' | 'not-file';
  marketState: 'read' | 'missing' | 'unreadable' | 'not-file';
  /** True when either ledger exceeded the retained tail and older bytes were not read. */
  truncated: boolean;
}

// Same identifier alphabet the learner enforces; kept local so this module
// stays a pure projection.
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const BATCH_BUNDLE = /^RQ-BATCH-/;
const FAMILY = /^RQ-([A-Za-z][A-Za-z0-9]*)/;

type Row = Record<string, unknown>;

const record = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Ledger timestamps are ISO strings; work-market rows carry epoch seconds. */
function stampMs(value: unknown): number | null {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? value * 1000 : value;
  }
  return null;
}

function rowStamp(row: Row): number | null {
  for (const key of ['ts', 'timestamp', 'at']) {
    const ms = stampMs(row[key]);
    if (ms !== null) return ms;
  }
  return null;
}

function jobId(row: Row): string | null {
  return text(row['job']) ?? text(row['job_id']) ?? text(row['jobId']);
}

function prUrl(row: Row): string | null {
  return text(row['url']) ?? text(row['pr_url']) ?? text(row['prUrl']) ?? text(row['pr']);
}

function eventName(row: Row): string | null {
  return (text(row['event']) ?? text(row['type']) ?? text(row['kind']))?.toLowerCase() ?? null;
}

/** Terminal PR state from any of the ledger's state-carrying fields. */
function terminalState(row: Row): 'merged' | 'closed' | null {
  let closed = false;
  for (const key of ['outcome', 'state', 'status', 'result', 'conclusion']) {
    const raw = text(row[key]);
    if (raw === null) continue;
    const value = raw.toLowerCase().replace(/_/g, '-');
    if (value === 'merged' || value === 'merge') return 'merged';
    if (value === 'closed' || value === 'close') closed = true;
  }
  return closed ? 'closed' : null;
}

/** Merge/close stamp when the reconciler recorded one, else the row stamp. */
function resolveStamp(row: Row): number | null {
  for (const key of ['mergedAt', 'closedAt']) {
    const ms = stampMs(row[key]);
    if (ms !== null) return ms;
  }
  const stamp = rowStamp(row);
  if (stamp !== null) return stamp;
  return stampMs(row['reconciledAt']);
}

function ident(value: string): boolean {
  return IDENT.test(value) && !value.includes('..');
}

function parseRows(text_: string, malformed: { count: number }): Row[] {
  const rows: Row[] = [];
  for (const line of text_.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed.count += 1;
      continue;
    }
    if (record(value)) rows.push(value);
    else malformed.count += 1;
  }
  return rows;
}

interface AssignCandidate {
  atMs: number;
  lane: string;
  model: string;
  repo: string;
}

interface FinishSample {
  atMs: number;
  tokens: number | null;
}

interface JobEvidence {
  assigns: AssignCandidate[];
  terminals: { state: 'merged' | 'closed'; atMs: number }[];
  finishes: FinishSample[];
}

function emptyEvidence(): JobEvidence {
  return { assigns: [], terminals: [], finishes: [] };
}

/** work_class per job from work-market.v1 route decisions; latest row wins. */
function marketClasses(rows: Row[]): Map<string, string> {
  const classes = new Map<string, string>();
  for (const row of rows) {
    if (eventName(row) !== 'route_decision') continue;
    const job = jobId(row);
    const workClass = text(row['work_class']);
    if (job !== null && workClass !== null) classes.set(job, workClass);
  }
  return classes;
}

function jobTypeFor(job: string, workClass: string | undefined): string {
  const family = FAMILY.exec(job)?.[1]?.toUpperCase();
  if (family !== undefined && ident(family)) return family;
  if (workClass !== undefined && ident(workClass)) return workClass;
  return 'misc';
}

/**
 * Fold jobs-ledger JSONL text into learner event lines. `marketText` is the
 * optional work-market.jsonl tail supplying `work_class` fallbacks.
 */
export function foldJobsOutcomeEvents(jobsText: string, marketText?: string | null): JobsOutcomeFold {
  const malformed = { count: 0 };
  const jobsRows = parseRows(jobsText, malformed);
  const marketRows = marketText ? parseRows(marketText, { count: 0 }) : [];
  const classes = marketClasses(marketRows);

  // PR URL -> job, only when exactly one job claims it (same rule as
  // foldRouterOutcomes): an ambiguous URL attaches to nobody.
  const claims = new Map<string, Set<string>>();
  for (const row of jobsRows) {
    const job = jobId(row);
    const url = prUrl(row);
    if (job !== null && url !== null) claims.set(url, (claims.get(url) ?? new Set()).add(job));
  }
  const urlToJob = new Map<string, string>();
  for (const [url, jobs] of claims) {
    if (jobs.size === 1) urlToJob.set(url, [...jobs][0]!);
  }

  const byJob = new Map<string, JobEvidence>();
  const evidence = (job: string): JobEvidence => {
    let entry = byJob.get(job);
    if (entry === undefined) {
      entry = emptyEvidence();
      byJob.set(job, entry);
    }
    return entry;
  };

  for (const row of jobsRows) {
    const job = jobId(row);
    const url = prUrl(row);
    const resolved = job ?? (url !== null ? urlToJob.get(url) ?? null : null);
    if (resolved === null) continue;
    const entry = evidence(resolved);
    const atMs = rowStamp(row);
    const name = eventName(row);
    if ((name === 'launch' || name === 'batch_claim') && atMs !== null) {
      const lane = text(row['lane']);
      const model = text(row['model']);
      const repo = text(row['repo']);
      if (lane !== null && model !== null && repo !== null) {
        entry.assigns.push({ atMs, lane, model, repo });
      }
      continue;
    }
    if (name === 'finish') {
      if (atMs !== null) {
        const tokens = row['tokens_total'];
        entry.finishes.push({
          atMs,
          tokens: typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
        });
      }
      continue;
    }
    const state = terminalState(row);
    if (state !== null) {
      const stamp = resolveStamp(row);
      if (stamp !== null) entry.terminals.push({ state, atMs: stamp });
    }
  }

  const stats: JobsOutcomeFoldStats = { jobs: 0, outcomes: 0, pending: 0, skipped: 0, malformed: malformed.count };
  const emitted: { assignAt: number; job: string; assign: Record<string, unknown>; outcome: Record<string, unknown> | null }[] = [];

  for (const [job, entry] of byJob) {
    if (BATCH_BUNDLE.test(job) || entry.assigns.length === 0) {
      stats.skipped += 1;
      continue;
    }
    entry.assigns.sort((a, b) => a.atMs - b.atMs);
    const assign = entry.assigns[entry.assigns.length - 1]!;
    const repo = assign.repo.replaceAll('/', '.');
    const jobType = jobTypeFor(job, classes.get(job));
    if (!ident(job) || !ident(repo) || !ident(assign.lane) || !ident(assign.model) || !ident(jobType)) {
      stats.skipped += 1;
      continue;
    }

    // Usage: finish rows at or after the chosen launch, tokens_total only.
    // No qualifying sample means the field is omitted, never zero.
    let usage: number | null = null;
    let sum = 0;
    let known = false;
    for (const finish of entry.finishes) {
      if (finish.atMs < assign.atMs || finish.tokens === null) continue;
      sum += finish.tokens;
      known = true;
    }
    if (known) usage = sum;

    // Terminal: a merged record wins over closed; earliest merge stamp wins.
    const merged = entry.terminals.filter(t => t.state === 'merged').sort((a, b) => a.atMs - b.atMs);
    const closed = entry.terminals.filter(t => t.state === 'closed').sort((a, b) => a.atMs - b.atMs);
    const terminal = merged[0] ?? closed[0] ?? null;

    const assignLine: Record<string, unknown> = {
      event: 'assign',
      job,
      repo,
      resource: assign.lane,
      model: assign.model,
      jobType,
      ts: new Date(assign.atMs).toISOString(),
    };
    let outcomeLine: Record<string, unknown> | null = null;
    if (terminal !== null) {
      outcomeLine = {
        event: 'outcome',
        job,
        state: terminal.state,
        ts: new Date(terminal.atMs).toISOString(),
      };
      if (usage !== null) outcomeLine['usage'] = usage;
      if (terminal.state === 'merged') {
        const minutes = (terminal.atMs - assign.atMs) / 60_000;
        if (Number.isFinite(minutes) && minutes > 0) outcomeLine['minutes'] = Math.round(minutes * 10) / 10;
      }
    }
    emitted.push({ assignAt: assign.atMs, job, assign: assignLine, outcome: outcomeLine });
    stats.jobs += 1;
    if (outcomeLine !== null) stats.outcomes += 1;
    else stats.pending += 1;
  }

  emitted.sort((a, b) => a.assignAt - b.assignAt || a.job.localeCompare(b.job));
  const lines: string[] = [];
  for (const item of emitted) {
    lines.push(JSON.stringify(item.assign));
    if (item.outcome !== null) lines.push(JSON.stringify(item.outcome));
  }
  return { text: lines.length === 0 ? '' : `${lines.join('\n')}\n`, stats };
}

/**
 * Read the bounded tails of `<runsDir>/metrics/jobs.jsonl` and
 * `work-market.jsonl` and fold them. Missing ledgers fold to empty text with
 * their state reported; nothing throws on absent or unreadable files.
 */
export async function readJobsOutcomeEvents(runsDir: string): Promise<JobsOutcomeEventsRead> {
  const [jobs, market] = await Promise.all([
    readLedgerTail(join(runsDir, 'metrics', 'jobs.jsonl')),
    readLedgerTail(join(runsDir, 'metrics', 'work-market.jsonl')),
  ]);
  const base = {
    jobsState: jobs.state,
    marketState: market.state,
    truncated: (jobs.state === 'read' && jobs.truncated === true) || (market.state === 'read' && market.truncated === true),
  };
  if (jobs.state !== 'read') {
    return { text: '', stats: { jobs: 0, outcomes: 0, pending: 0, skipped: 0, malformed: 0 }, ...base };
  }
  const folded = foldJobsOutcomeEvents(jobs.text, market.state === 'read' ? market.text : null);
  return { ...folded, ...base };
}
