/**
 * Dispatchd guard anomaly evidence → self-improvement backlog items.
 *
 * The live fleet dispatcher's guard pass (dispatchd_guard.py's
 * anomalies()/alert(), imported by ~/.ashlr-runs/bin/dispatchd.py —
 * the ops-side copy; contrib/mac/dispatchd.py carries no guard module)
 * keeps a per-tick anomaly ledger and appends one
 * {ts, job, kind, detail} row per alert to
 * metrics/anomalies.jsonl under the runs directory, at most once per
 * job+kind per hour, plus a point-in-time bus/eo/ANOMALY-<job>-<kind>.md
 * snapshot that the next alert overwrites. Three kinds exist:
 *
 *   - 'no_progress' — a job in the dispatcher's own alive set whose
 *     <job>.log under the runs dir has not been written for over
 *     NO_PROGRESS_S (3600s); detail reads 'log idle NNNm'.
 *   - 'reap_rate' — the job's trailing-hour reap count in the
 *     queue/breaker.json _rate ledger passed REAP_RATE_MAX (10);
 *     detail reads 'NNN reaps in 1h'.
 *   - 'launch_rate' — the same ledger's launch count passed
 *     LAUNCH_RATE_MAX (6); detail reads 'NNN launches in 1h'.
 *
 * Until now the ledger was write-only audit: no report, fold or
 * backlog source read it, and the bus files are per-alert snapshots —
 * a job that keeps tripping the same guard, or a whole fleet going
 * quiet at once, never became work. The sibling stuck-job feed reads
 * the phantom-side reaper's own ledgers (queue/stuck-jobs.jsonl,
 * queue/job-stops.jsonl) — a different evidence class: those record
 * interventions the fleet's stray-stop reaper already made, while
 * anomalies.jsonl records what the launcher's guard still sees as
 * wrong, including jobs that sit outside the phantom-side reaper's
 * view entirely (parked markers, launch→finish handoff gaps, lanes
 * the reaper never scans).
 *
 * anomaliesBacklogItems carries the recorded alerts into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence
 * feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLedgerTail's bounded
 *    no-follow tail and metrics/jobs.jsonl through the same bound
 *    for lane/repo attribution; nothing is written and no network is
 *    touched.
 *  - Recorded rows only. A row counts only when its own fields
 *    validate — a parseable timestamp inside the window, a job id
 *    matching the writer's own JID shape, a kind in the writer's
 *    closed vocabulary, an optional string detail. Malformed lines
 *    are skipped, never guessed. The writer stamps `ts` in host-local
 *    time without a zone ('YYYY-MM-DD HH:MM:SS'); parseLedgerTs reads
 *    it as local time, and UTC-day bucketing follows the parsed
 *    instant — the same convention every sibling fold applies.
 *  - Recurring means recorded and distinct. A (kind, job) cell emits
 *    only at ANOMALY_MIN_ROWS rows across ANOMALY_MIN_DAYS distinct
 *    UTC days inside the window — the guard alerts at most hourly,
 *    so consecutive rows may be one continuous episode; the prompt
 *    quotes the recorded detail (the growing 'log idle' minutes show
 *    whether the silence kept deepening) rather than claiming
 *    independent recurrences. A per-kind fleet cell emits only at
 *    ANOMALY_MIN_JOBS distinct jobs across ANOMALY_MIN_DAYS days —
 *    many jobs alerting together is a different problem than one
 *    job's bad week.
 *  - Independent sources. Each kind folds its own rows: a journal
 *    holding only no_progress alerts can never fabricate a
 *    reap_rate cell, and missing or unreadable evidence yields
 *    nothing rather than throwing into discovery.
 *  - Lane and repo attribution is enrichment, not a gate. The
 *    anomaly rows record no lane; the fold joins metrics/jobs.jsonl
 *    through jobTimelines' canonical dialect for the job ids seen.
 *    A job with no launch/claim row in the bounded tail — or an
 *    unreadable jobs ledger — groups under 'unknown' rather than
 *    being guessed, and items still emit because the anomaly rows
 *    are self-sufficient evidence.
 *  - Truncation is stated, never hidden. When the bounded tail cut
 *    older rows, the cell's counts are a lower bound and the prompt
 *    says so (the fleet-controller feed's convention).
 *  - The guard and the launcher are pinned ops machinery.
 *    ~/.ashlr-runs/bin/dispatchd_guard.py and dispatchd.py are
 *    ops-side files agents never edit; contrib/mac's dispatcher
 *    carries no guard module at all. Items therefore emit only when
 *    the backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply —
 *    and their prompts direct sessions to fix what this repository
 *    owns (the queue/run marker protocol's consumers, the
 *    fleet/queue code in src/, the detectors that read this
 *    evidence) or report no-change naming pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (kind + job-or-fleet + repo — never the counts or timestamps),
 *    so a refresh re-derives the same id and appendUserBacklogItems
 *    adds only what is new; a cell that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the
 *    writer's own id shape before they are quoted, lane and repo
 *    strings are scrubbed, flattened and capped, and the brief
 *    carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { jobTimelines, parseLedgerTs, type JobTimeline } from '../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (kind, job) and per-kind cells are bounded by evidence diversity. */
export const ANOMALY_MAX_ITEMS = 8;
const ANOMALY_ITEM_HARD_MAX = 25;
/**
 * Rows one (kind, job) cell needs inside the window before it counts
 * as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const ANOMALY_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const ANOMALY_MIN_DAYS = 2;
/** …and, for the shared per-kind cell, across at least this many distinct jobs. */
export const ANOMALY_MIN_JOBS = 3;
/** Evidence window: the fleet's recurring-evidence week the sibling journal folds share. */
export const ANOMALY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const ANOMALY_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail for the ledger. The guard appends at most one ~120-byte
 * row per job+kind per hour while a condition holds, so even a busy
 * fleet stays far under this; 512 KiB retains thousands of alerts.
 */
export const ANOMALY_TAIL_BYTES = 512 * 1024;
/** Ledger file name under <runsDir>/metrics/, the writer's own constant value. */
const ANOMALY_JOURNAL_RELATIVE = join('metrics', 'anomalies.jsonl');
/** The repository name the writer's host install serves; the gate matches on it. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's own job-id shape (dispatchd_guard JID); quoted ids must match it. */
const ANOMALY_JOB_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/repo/detail strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_REPO_CHARS = 120;
const MAX_DETAIL_CHARS = 160;
/** Distinct detail strings quoted inside one prompt before the remainder is summarized. */
const MAX_PROMPT_DETAILS = 3;
/** Detail strings tracked per cell for prompt evidence. */
const MAX_TRACK_DETAILS = 8;
/** Example job ids quoted per kind cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The 'log idle NNNm' detail's minute capture, for the no_progress idle-depth evidence. */
const IDLE_MINUTES = /log idle (\d+)m/;

/** The guard's closed alert vocabulary — the writer's own kind strings, verbatim. */
export type AnomalyKind = 'no_progress' | 'reap_rate' | 'launch_rate';
const ANOMALY_KINDS: ReadonlySet<string> = new Set<AnomalyKind>(['no_progress', 'reap_rate', 'launch_rate']);

export interface AnomaliesItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: the runs-dir locations below). */
  journalPath?: string;
  /** Runs dir override — read alongside the writer's own ~/.ashlr-runs location when it differs. */
  runsDir?: string;
  /** Home for the writer-location default (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default ANOMALY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated anomaly row inside the journal. */
export interface AnomalyRow {
  atMs: number;
  utcDay: string;
  job: string;
  kind: AnomalyKind;
  /** The row's recorded detail text, scrubbed and capped — null when absent or blank. */
  detail: string | null;
  /** Minutes of log silence parsed from a 'log idle NNNm' detail, else null. */
  idleMinutes: number | null;
}

export interface AnomalyTally {
  /** Sanitized recorded text (a lane or repo label). */
  text: string;
  count: number;
}

/** A (kind, job) cell: one job's recurring alerts of one kind inside the window. */
export interface AnomalyJobCell {
  kind: AnomalyKind;
  job: string;
  /** Sanitized lane label, or 'unknown' when the jobs ledger recorded none for this job. */
  lane: string;
  /** Sanitized recorded repo label, or null when the ledger has none. */
  repo: string | null;
  /** Alert rows recorded for this (kind, job) inside the window. */
  rows: number;
  /** Distinct UTC days those rows landed on. */
  days: number;
  /** Deepest recorded 'log idle' minutes across the cell's no_progress rows, else null. */
  maxIdleMinutes: number | null;
  /** Up to MAX_PROMPT_DETAILS deduped scrubbed detail strings. */
  details: string[];
  /** ISO bounds of the cell's recorded alerts; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** A per-kind fleet cell: one alert kind firing across enough distinct jobs to be systemic. */
export interface AnomalyKindCell {
  kind: AnomalyKind;
  /** Alert rows recorded for this kind inside the window. */
  rows: number;
  /** Distinct UTC days those rows landed on. */
  days: number;
  /** Distinct job ids that alerted for this kind inside the window. */
  jobs: number;
  /** Up to MAX_EXAMPLES fleet-shaped job ids, most-alerted first. */
  examples: string[];
  /** Recorded lane tallies, most frequent first (capped at MAX_EXAMPLES). */
  lanes: AnomalyTally[];
  /** Recorded repo tallies, most frequent first (capped at MAX_EXAMPLES). */
  repos: AnomalyTally[];
  /** ISO bounds of the kind's recorded alerts; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): AnomalyTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated anomaly rows. Malformed
 * lines, rows missing job/kind/ts, job ids outside the writer's own
 * JID shape, kinds outside its closed vocabulary and unparseable
 * timestamps are skipped — never guessed. The writer emits ISO-less
 * host-local `ts` ('YYYY-MM-DD HH:MM:SS'), which parseLedgerTs reads
 * as local time; extra fields are ignored for forward compatibility.
 */
export function parseAnomalyRows(text: string, cutoffMs: number, nowMs: number): AnomalyRow[] {
  const out: AnomalyRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const kind = r['kind'];
    if (typeof kind !== 'string' || !ANOMALY_KINDS.has(kind)) continue;
    const job = r['job'];
    if (typeof job !== 'string' || !ANOMALY_JOB_PATTERN.test(job)) continue;
    const atMs = parseLedgerTs(r['ts']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    const rawDetail = r['detail'];
    const detail = typeof rawDetail === 'string' && rawDetail.trim() !== ''
      ? fieldText(rawDetail, MAX_DETAIL_CHARS) || null
      : null;
    const idleMatch = detail === null ? null : IDLE_MINUTES.exec(detail);
    const idleMinutes = idleMatch === null ? null : Number.parseInt(idleMatch[1]!, 10);
    out.push({
      atMs,
      utcDay: utcDayOf(atMs),
      job,
      kind: kind as AnomalyKind,
      detail,
      idleMinutes: idleMinutes !== null && Number.isFinite(idleMinutes) ? idleMinutes : null,
    });
  }
  return out;
}

/** One (kind, job) track inside the fold: the recurring-alert tally for prompt evidence. */
interface JobTrack {
  kind: AnomalyKind;
  job: string;
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  maxIdleMinutes: number | null;
  details: string[];
}

const newTrack = (kind: AnomalyKind, job: string): JobTrack => ({
  kind,
  job,
  rows: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  maxIdleMinutes: null,
  details: [],
});

function trackRow(track: JobTrack, row: AnomalyRow): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  if (row.idleMinutes !== null && (track.maxIdleMinutes === null || row.idleMinutes > track.maxIdleMinutes)) {
    track.maxIdleMinutes = row.idleMinutes;
  }
  if (row.detail !== null && !track.details.includes(row.detail) && track.details.length < MAX_TRACK_DETAILS) {
    track.details.push(row.detail);
  }
}

/** The fold's output: per-(kind, job) tracks plus each kind's fleet-wide tally. */
export interface AnomalyFold {
  /** 'kind|job' → track. */
  jobs: Map<string, JobTrack>;
  /** kind → fleet-wide track. */
  kinds: Map<AnomalyKind, { rows: number; days: Set<string>; jobs: Map<string, number>; firstMs: number; lastMs: number }>;
}

const newFold = (): AnomalyFold => ({ jobs: new Map(), kinds: new Map() });

/**
 * Pure: fold validated rows into per-(kind, job) tracks and per-kind
 * fleet tallies. The recurring bars are applied by the caller — the
 * fold records everything inside the window so tests can inspect
 * sub-bar evidence too.
 */
export function foldAnomalyRows(
  rows: readonly AnomalyRow[],
  nowMs: number,
  windowMs: number = ANOMALY_WINDOW_MS,
): AnomalyFold {
  const fold = newFold();
  const windowStart = nowMs - windowMs;
  const until = nowMs + ANOMALY_FUTURE_SKEW_MS;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > until) continue;
    const key = `${row.kind}|${row.job}`;
    let track = fold.jobs.get(key);
    if (track === undefined) {
      track = newTrack(row.kind, row.job);
      fold.jobs.set(key, track);
    }
    trackRow(track, row);
    let kindTrack = fold.kinds.get(row.kind);
    if (kindTrack === undefined) {
      kindTrack = { rows: 0, days: new Set(), jobs: new Map(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY };
      fold.kinds.set(row.kind, kindTrack);
    }
    kindTrack.rows += 1;
    kindTrack.days.add(row.utcDay);
    kindTrack.jobs.set(row.job, (kindTrack.jobs.get(row.job) ?? 0) + 1);
    kindTrack.firstMs = Math.min(kindTrack.firstMs, row.atMs);
    kindTrack.lastMs = Math.max(kindTrack.lastMs, row.atMs);
  }
  return fold;
}

const WINDOW_DAYS = Math.round(ANOMALY_WINDOW_MS / 86_400_000);

const meetsJobBar = (track: JobTrack): boolean =>
  track.rows >= ANOMALY_MIN_ROWS && track.days.size >= ANOMALY_MIN_DAYS;

const meetsKindBar = (kindTrack: { rows: number; days: Set<string>; jobs: Map<string, number> }): boolean =>
  kindTrack.jobs.size >= ANOMALY_MIN_JOBS && kindTrack.days.size >= ANOMALY_MIN_DAYS;

/** Human label for a kind inside titles and prompts; the raw kind string is quoted as evidence. */
const KIND_LABEL: Record<AnomalyKind, string> = {
  no_progress: 'log-silence',
  reap_rate: 'reap-rate',
  launch_rate: 'launch-rate',
};

const NO_CHANGE = 'If the window has rolled forward, the job finished or was stopped since, the silence was a legitimately long quiet run the guard cannot distinguish from a wedge, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed dispatcher and guard files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-ledger gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/anomalies.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the dispatchd guard\'s own alert ledger, one bounded tail read. The writer is dispatchd_guard.py\'s alert(), imported by the live ~/.ashlr-runs/bin/dispatchd.py (the ops-side copy — contrib/mac/dispatchd.py carries no guard module); it appends at most one {ts, job, kind, detail} row per job+kind per hour while a condition holds and drops a point-in-time bus/eo/ANOMALY-<job>-<kind>.md snapshot that the next alert overwrites. The writer resolves its runs dir as ~/.ashlr-runs via homedir and ignores ASHLR_RUNS_DIR; this feed reads that location plus the env/override location when it differs. Until this feed the ledger had no reader at all — the bus snapshots are per-alert state, not a trend.';

const truncationNote = (lowerBound: boolean): string =>
  lowerBound ? ' The ledger tail was truncated, so these counts are a lower bound.' : '';

const detailsText = (details: readonly string[]): string =>
  details.length === 0
    ? ''
    : ` Recorded detail(s): ${details.slice(0, MAX_PROMPT_DETAILS).map((d) => `'${d}'`).join(', ')}${details.length > MAX_PROMPT_DETAILS ? `, and ${details.length - MAX_PROMPT_DETAILS} more distinct` : ''}.`;

const idleText = (maxIdleMinutes: number | null): string => {
  if (maxIdleMinutes === null) return '';
  const hours = Math.floor(maxIdleMinutes / 60);
  return hours >= 1
    ? ` The deepest recorded silence was ${maxIdleMinutes} minutes (~${hours}h${hours >= 24 ? `, ${Math.floor(hours / 24)}d` : ''}).`
    : ` The deepest recorded silence was ${maxIdleMinutes} minutes.`;
};

function jobPrompt(cell: AnomalyJobCell): string {
  const headline = cell.kind === 'no_progress'
    ? `Phantom's fleet dispatchd guard keeps alerting that job ${cell.job} has gone silent — ${cell.rows} recorded '${cell.kind}' alert(s) across ${cell.days} distinct UTC day(s) inside the ${WINDOW_DAYS}-day window.`
    : `Phantom's fleet dispatchd guard keeps alerting that job ${cell.job} is churning — ${cell.rows} recorded '${cell.kind}' alert(s) across ${cell.days} distinct UTC day(s) inside the ${WINDOW_DAYS}-day window.`;
  const body = cell.kind === 'no_progress'
    ? [
      `Each row is one guard pass that found the job in the dispatcher's own alive set while its <job>.log under the runs dir had been untouched for over an hour; the guard alerts at most once per job+kind per hour, so consecutive rows may be one continuous silence rather than independent recurrences — the recorded detail shows which.${idleText(cell.maxIdleMinutes)}${detailsText(cell.details)}${truncationNote(cell.lowerBound)}`,
      '',
      `The phantom-side stuck reaper's bars (90-minute job age, 30-minute log silence in src/core/fleet/running-stuck.ts) should have killed a genuinely wedged job — a job still alerting days later sits outside that reaper's view: a marker the phantom side already closed while the launcher's alive set still holds it, a parked or held state the silence check cannot distinguish from a wedge, or a legitimately long quiet run.`,
      '',
      `Find which it is: join metrics/jobs.jsonl for what ${cell.job} was doing — lane, model and repo attribution, whether a finish row or marker close ever landed while the guard kept seeing it alive, and whether the job's log path is the one the guard stats. If the cause is a launch→finish handoff gap this repository owns — the marker protocol's consumers, the finish-evidence writers, or the detectors that read this evidence — fix it; if the job legitimately runs quiet, whether the fleet needs a progress signal the silence check can see is this repository's call too. If the cause is pinned/host-side — report no-change and name the evidence. ${NO_CHANGE}`,
    ].join('\n')
    : [
      `Each row is one guard pass whose trailing-hour count in the queue/breaker.json _rate ledger passed the per-hour bar — ${cell.kind === 'reap_rate' ? 'more than 10 reaps' : 'more than 6 launches'} for this one job — alerting at most once per hour while the storm lasts.${detailsText(cell.details)}${truncationNote(cell.lowerBound)}`,
      '',
      `Rate storms mean the launcher keeps churning this job: reap→relaunch loops, finish evidence that never lands so the job looks dead and gets relaunched, or a job spec that fails fast enough to cycle. The _rate ledger lives in queue/breaker.json under the runs dir; metrics/jobs.jsonl holds the launch/finish rows to correlate.`,
      '',
      `Find the loop: join metrics/jobs.jsonl for ${cell.job}'s repeated launch and finish rows — whether finishes are recorded and the reap is spurious, whether the job dies before writing finish evidence (the ghost-close pattern the stuck-job feed covers), or whether the spec itself fails fast. If the cause is pinned/host-side — report no-change and name the evidence. ${NO_CHANGE}`,
    ].join('\n');
  return [
    headline,
    '',
    `Lane attribution: '${cell.lane}'${cell.repo !== null ? `; recorded repository: '${cell.repo}'` : ''}.${cell.firstSeen !== null && cell.lastSeen !== null ? ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.` : ''}`,
    '',
    EVIDENCE,
    '',
    body,
  ].join('\n');
}

function kindPrompt(cell: AnomalyKindCell): string {
  const what = cell.kind === 'no_progress'
    ? 'their logs under the runs dir untouched for over an hour while the dispatcher still counts them alive'
    : cell.kind === 'reap_rate'
      ? 'each accruing more than 10 reaps inside a trailing hour in the breaker ledger'
      : 'each accruing more than 6 launches inside a trailing hour in the breaker ledger';
  return [
    `Phantom's fleet dispatchd guard keeps firing '${cell.kind}' alerts across the fleet — ${cell.rows} recorded alert(s) for ${cell.jobs} distinct job(s) across ${cell.days} distinct UTC day(s) inside the ${WINDOW_DAYS}-day window.`,
    '',
    `Each row is one guard pass; the per-(job, kind) cells name the worst individual offenders, but this many distinct jobs alerting together points at a systemic cause rather than that many independent wedges: ${what}.`,
    '',
    `Recorded lanes: ${cell.lanes.map((t) => `'${t.text}' ×${t.count}`).join(', ') || 'unknown'}. Recorded repositories: ${cell.repos.map((t) => `'${t.text}' ×${t.count}`).join(', ') || 'unknown'}. Example job ids: ${cell.examples.join(', ')}.${cell.firstSeen !== null && cell.lastSeen !== null ? ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.` : ''}${truncationNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    cell.kind === 'no_progress'
      ? `For log silence the systemic suspects are upstream of any one job: the launcher or dispatcher not writing or rotating the per-job logs the guard stats, a host stall that freezes every log mtime at once, or a workload class that legitimately runs quiet by design. Check whether the silent jobs share a lane, model or launch path (metrics/jobs.jsonl attribution above), whether their logs exist and are growing under a different name, and whether the alerting correlates with host load or a dispatcher restart. If the pattern is pinned/host-side — report no-change and name the evidence. ${NO_CHANGE}`
      : `For rate storms the systemic suspects are upstream of any one job: a reap or launch loop in the dispatcher's own bookkeeping (finish evidence dropped fleet-wide, the breaker ledger's _rate counts inflating on retries), or a market/queue condition relaunching work faster than it lands. Check queue/breaker.json's _rate ledger shape and metrics/jobs.jsonl for whether the churned jobs share a lane or a failure signature. If the pattern is pinned/host-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

/** Per-(kind, job) tracks sorted by recorded rows — deterministic across refreshes. */
function sortedJobTracks(map: Map<string, JobTrack>): JobTrack[] {
  return [...map.values()]
    .sort((a, b) => b.rows - a.rows || a.kind.localeCompare(b.kind) || a.job.localeCompare(b.job));
}

function jobCellOf(track: JobTrack, jobs: ReadonlyMap<string, Pick<JobTimeline, 'lane' | 'repo'>>, lowerBound: boolean): AnomalyJobCell {
  const timeline = jobs.get(track.job);
  const lane = timeline?.lane === null || timeline?.lane === undefined || timeline.lane.trim() === ''
    ? 'unknown'
    : fieldText(timeline.lane, MAX_LANE_CHARS) || 'unknown';
  const repo = timeline?.repo === null || timeline?.repo === undefined || timeline.repo.trim() === ''
    ? null
    : fieldText(timeline.repo, MAX_REPO_CHARS) || null;
  return {
    kind: track.kind,
    job: track.job,
    lane,
    repo,
    rows: track.rows,
    days: track.days.size,
    maxIdleMinutes: track.maxIdleMinutes,
    details: [...track.details].slice(0, MAX_PROMPT_DETAILS),
    firstSeen: Number.isFinite(track.firstMs) ? new Date(track.firstMs).toISOString() : null,
    lastSeen: Number.isFinite(track.lastMs) ? new Date(track.lastMs).toISOString() : null,
    lowerBound,
  };
}

function kindCellOf(
  kind: AnomalyKind,
  kindTrack: { rows: number; days: Set<string>; jobs: Map<string, number>; firstMs: number; lastMs: number },
  jobs: ReadonlyMap<string, Pick<JobTimeline, 'lane' | 'repo'>>,
  lowerBound: boolean,
): AnomalyKindCell {
  const lanes = new Map<string, number>();
  const repos = new Map<string, number>();
  const ranked = [...kindTrack.jobs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [job] of ranked) {
    const timeline = jobs.get(job);
    const lane = timeline?.lane === null || timeline?.lane === undefined || timeline.lane.trim() === ''
      ? 'unknown'
      : fieldText(timeline.lane, MAX_LANE_CHARS) || 'unknown';
    bump(lanes, lane);
    const repo = timeline?.repo === null || timeline?.repo === undefined || timeline.repo.trim() === ''
      ? null
      : fieldText(timeline.repo, MAX_REPO_CHARS);
    if (repo !== null) bump(repos, repo);
  }
  return {
    kind,
    rows: kindTrack.rows,
    days: kindTrack.days.size,
    jobs: kindTrack.jobs.size,
    examples: ranked.slice(0, MAX_EXAMPLES).map(([job]) => job),
    lanes: tallyOf(lanes, MAX_EXAMPLES),
    repos: tallyOf(repos, MAX_EXAMPLES),
    firstSeen: Number.isFinite(kindTrack.firstMs) ? new Date(kindTrack.firstMs).toISOString() : null,
    lastSeen: Number.isFinite(kindTrack.lastMs) ? new Date(kindTrack.lastMs).toISOString() : null,
    lowerBound,
  };
}

function kindSlug(kind: AnomalyKind): string {
  return KIND_LABEL[kind];
}

function jobItemId(kind: AnomalyKind, job: string, repo: string): string {
  const hash = createHash('sha256').update(`anomaly:${kind}:${job}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `fleet-anomaly-${kindSlug(kind)}-${hash}`;
}

function kindItemId(kind: AnomalyKind, repo: string): string {
  const hash = createHash('sha256').update(`anomaly:${kind}:fleet:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `fleet-anomaly-${kindSlug(kind)}-fleet-${hash}`;
}

function jobTitle(cell: AnomalyJobCell): string {
  const what = cell.kind === 'no_progress' ? 'log silence' : cell.kind === 'reap_rate' ? 'reap storms' : 'launch storms';
  return `Dispatchd guard keeps alerting ${cell.job} for ${what}`.slice(0, MAX_TITLE_CHARS);
}

function kindTitle(cell: AnomalyKindCell): string {
  const what = cell.kind === 'no_progress' ? 'log-silence' : cell.kind === 'reap_rate' ? 'reap-rate' : 'launch-rate';
  return `Dispatchd ${what} alerts keep firing across ${cell.jobs} fleet jobs`.slice(0, MAX_TITLE_CHARS);
}

function makeItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title,
    prompt,
    area: 'fleet-anomalies',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * The runs dirs metrics/jobs.jsonl can live under: each journal
 * location's grandparent (<runs>/metrics/anomalies.jsonl → <runs>),
 * deduped — the same dirs journalPaths resolved, so a journalPath
 * override attributes against its own runs dir.
 */
function jobsLedgerDirs(opts: AnomaliesItemsOptions): string[] {
  const dirs = new Set<string>();
  for (const journalPath of journalPaths(opts)) {
    dirs.add(resolve(join(journalPath, '..', '..')));
  }
  return [...dirs];
}

/** Bounded tail of metrics/jobs.jsonl under each candidate runs dir, folded through the canonical jobTimelines dialect in one pass; empty on any read failure — attribution degrades to 'unknown', never blocks the anomaly evidence. */
async function readJobTimelines(runsDirs: readonly string[], nowMs: number): Promise<ReadonlyMap<string, JobTimeline>> {
  try {
    const texts: string[] = [];
    for (const runsDir of runsDirs) {
      const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
      if (tail.state === 'read') texts.push(tail.text);
    }
    if (texts.length === 0) return new Map();
    return jobTimelines(texts.join('\n'), nowMs);
  } catch {
    return new Map();
  }
}

/**
 * Every journal location evidence can occupy: the writer's own
 * homedir()/.ashlr-runs resolution (dispatchd.py hardcodes
 * H + "/.ashlr-runs" and ignores ASHLR_RUNS_DIR) plus the
 * env/override runs dir when it differs — covering both the current
 * writer and any later fix aligning it with the siblings.
 * journalPath, when given, is the single override.
 */
function journalPaths(opts: AnomaliesItemsOptions): string[] {
  if (opts.journalPath !== undefined) return [opts.journalPath];
  const home = opts.homeDir ?? homedir();
  const writerRunsDir = join(home, '.ashlr-runs');
  const paths = [join(writerRunsDir, ANOMALY_JOURNAL_RELATIVE)];
  const overrideRunsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'];
  if (overrideRunsDir !== undefined && resolve(overrideRunsDir) !== resolve(writerRunsDir)) {
    paths.push(join(overrideRunsDir, ANOMALY_JOURNAL_RELATIVE));
  }
  return paths;
}

/**
 * Backlog items for the dispatchd guard's recurring anomaly cells —
 * per (kind, job) at the recurring bar of rows across distinct UTC
 * days, plus each kind's fleet-wide cell at the recurring bar of
 * distinct jobs. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function anomaliesBacklogItems(opts: AnomaliesItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - ANOMALY_WINDOW_MS;
    const rows: AnomalyRow[] = [];
    let truncated = false;
    const journalPathsSeen = new Set<string>();
    for (const journalPath of journalPaths(opts)) {
      const resolved = resolve(journalPath);
      if (journalPathsSeen.has(resolved)) continue;
      journalPathsSeen.add(resolved);
      const tail = await readLedgerTail(journalPath, ANOMALY_TAIL_BYTES);
      if (tail.state !== 'read') continue;
      truncated = truncated || tail.truncated;
      rows.push(...parseAnomalyRows(tail.text, cutoffMs, nowMs));
    }
    if (rows.length === 0) return [];
    const fold = foldAnomalyRows(rows, nowMs);
    const jobs = await readJobTimelines(jobsLedgerDirs(opts), nowMs);

    const candidates: CloudBacklogItem[] = [];
    const kindOrder: AnomalyKind[] = ['no_progress', 'reap_rate', 'launch_rate'];
    for (const kind of kindOrder) {
      const kindTrack = fold.kinds.get(kind);
      if (kindTrack === undefined || !meetsKindBar(kindTrack)) continue;
      const cell = kindCellOf(kind, kindTrack, jobs, truncated);
      candidates.push(makeItem(
        kindItemId(kind, repo),
        kindTitle(cell),
        kindPrompt(cell),
        repo,
      ));
    }
    for (const track of sortedJobTracks(fold.jobs)) {
      if (!meetsJobBar(track)) continue;
      const cell = jobCellOf(track, jobs, truncated);
      candidates.push(makeItem(
        jobItemId(track.kind, track.job, repo),
        jobTitle(cell),
        jobPrompt(cell),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? ANOMALY_MAX_ITEMS, ANOMALY_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
