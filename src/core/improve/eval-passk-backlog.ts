/**
 * Scheduled pass^k eval run journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm eval passk schedule --install` (src/cli/eval-passk.ts →
 * evalPassKSchedule in src/core/eval/passk-schedule.ts) installs a
 * per-user launchd agent (macOS) or systemd user timer (Linux) that
 * runs `phm eval passk --json` nightly and appends the command's
 * stdout AND stderr to ~/.ashlr/logs/eval-passk.jsonl under the
 * user's home. Each run leaves exactly one terminal record:
 *
 *  - a completed eval prints one pretty-printed
 *    {report, published} document — report is the eval.passk.v1
 *    PassKReport (generatedAt, dataset, trials, k, lanes, alerts)
 *    and published the store paths publishPassKReport wrote;
 *  - a run whose every lane is the loopback-only local family with
 *    no provider up prints one single-line
 *    {"skipped":true,"reason":…} verdict and exits 0 — no report, no
 *    publish, nothing for the lane-scores projection or the
 *    alerts journal to record;
 *  - a run that fails — unreadable dataset, repoPath escapes,
 *    runPassKEval or publishPassKReport throwing, a usage error —
 *    prints `error: …` on stderr and exits nonzero, leaving no
 *    document at all; a run killed mid-write can leave a document
 *    fragment a later column-0 `{` abandons.
 *
 * Until now the journal had no reader at all: the reports' own
 * surfaces are `phm eval passk scores`/`alerts` (reports someone had
 * to run) and the persisted report/alerts/lane-scores stores under
 * ~/.ashlr/eval/passk/ — and passkAlertBacklogItems already folds the
 * alerts journal for capability regressions. What nothing read was
 * the run journal itself: a schedule whose every night skips because
 * the local provider is never up, or whose runs keep dying before a
 * verdict, produces no reports and no alerts — the lane-scores
 * projection `ashlr router rank` consumes silently freezes on the
 * last good report and no fold ever noticed. This feed covers the
 * scheduled eval's own recorded health.
 *
 * evalPasskBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling passk-alert source beside it.
 *
 * The journal mixes dated and undated records, so the fold is
 * anchored on record order, never invented timestamps:
 *
 *  - Report documents carry report.generatedAt — the only dated
 *    evidence. Reports stamped past the clock plus the sibling
 *    feeds' future-skew tolerance are corrupt or replayed and never
 *    become the anchor.
 *  - Skip verdicts and stderr carry no timestamp. Recurrence is
 *    measured in recorded runs since the newest report — the same
 *    "consecutive recorded runs, never days" convention the steward
 *    journal feed applies to its own undated documents — with the
 *    newest report's generatedAt quoted as the honest time bound and
 *    the unit's once-nightly cadence named so a session can sanity-
 *    check the count against real nights.
 *  - stderr is classified, never guessed: a line starting `error:`
 *    is the CLI's own err() verdict — exactly one per failed run by
 *    the handler's return-after-error contract; a cluster of three
 *    or more consecutive stack-shaped lines (`at …` frames, `node:`
 *    internals, `XxxError:`/`XxxException:` lines) is a probable
 *    crashed run's trace; every other non-record line is unverified
 *    noise counted as coverage only.
 *  - A column-0 `{` seen inside an open document means the previous
 *    run died mid-write: the fragment counts as an abandoned (crashed)
 *    run event. A document still open at end of text is a torn tail —
 *    possibly a run in flight — so it counts as one probable crashed
 *    run only when the file's mtime proves it cannot still be writing
 *    (EVAL_PASSK_IN_FLIGHT_MS), and as coverage either way.
 *
 * Three evidence axes, all read off the tail after the newest report
 * (or the whole retained tail when no report exists — a schedule
 * installed but never fed a provider still earns its skip evidence):
 *
 *  - provider skips: EVAL_PASSK_MIN_SKIPS recorded {skipped:true}
 *    verdicts since the newest report — every recent scheduled run
 *    reached the provider probe and declined to measure, so the
 *    lane-scores projection and alerts journal starve together.
 *  - run failures: EVAL_PASSK_MIN_FAILURES recorded failed runs since
 *    the newest report — `error:` verdicts plus crash clusters plus
 *    abandoned document fragments — runs that died before any
 *    verdict could land.
 *  - stale eval: the newest report is at least
 *    EVAL_PASSK_STALE_MS old while the tail still records unmeasured
 *    runs (skips, failures or document fragments) below the
 *    recurring bars — the eval has not landed a report in days and
 *    what little it did record was not a measurement. Pure silence
 *    (a journal that simply ends at the last report) stays silent:
 *    host-off and uninstalled schedule are indistinguishable, the
 *    same unknown-stays-unknown bar the sibling feeds apply.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail read; documents are validated against
 *    the writer's logged contract — the {report, published}
 *    envelope, the eval.passk.v1 schema literal, a parseable
 *    generatedAt, safe-integer trials/k with k <= trials, the
 *    dataset/lane/alerts shapes the CLI prints, and the published
 *    path fields. Malformed blocks, off-contract documents,
 *    single-line records that are not the skip verdict, abandoned
 *    fragments and stray stderr count as coverage, never guessed;
 *    nothing is written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. A missing,
 *    non-file or unreadable journal is the writer's normal state —
 *    the schedule is opt-in --install — and contributes nothing
 *    rather than an error.
 *  - Only the fleet's own repository inherits the items: the
 *    evidence describes this install's eval machinery, so items emit
 *    only when the backlog target's repository name is 'phantom',
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply.
 *  - Dedup is downstream. The ids are stable strings, so a refresh
 *    re-derives the same ids and appendUserBacklogItems adds only
 *    what is new; shifted tallies do not spawn twin items and a
 *    tail that recovers to reports simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the newest report's generatedAt is
 *    the stated time bound, skip reasons pass through the
 *    scrub/flatten/cap rule, and the brief names the journal, the
 *    schedule command, the eval CLI/core modules and the sibling
 *    passk-alert items — with the usual no-change escape when the
 *    window has rolled forward, the schedule was retuned or removed,
 *    or the cause is owner-side or pinned ops machinery.
 */
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit: at most one per evidence axis. */
export const EVAL_PASSK_MAX_ITEMS = 3;
const EVAL_PASSK_ITEM_HARD_MAX = 25;
/**
 * Bounded tail of the journal. A pass^k report document is a
 * pretty-printed eval.passk.v1 report — per-task trialsDetail for the
 * golden set — typically tens of KiB, so 1 MiB covers many runs; a
 * contract-violating larger file still folds its newest records
 * flagged as a lower bound.
 */
export const EVAL_PASSK_TAIL_BYTES = 1024 * 1024;
/** Recorded skip verdicts the tail needs before provider starvation counts as recurring. */
export const EVAL_PASSK_MIN_SKIPS = 3;
/** Recorded failed runs (`error:` verdicts + crash clusters + abandoned fragments) the tail needs before failures count as recurring. */
export const EVAL_PASSK_MIN_FAILURES = 3;
/**
 * Age of the newest report at which a still-recording tail counts as
 * a stale eval: the unit runs once nightly, so three days means at
 * least two scheduled nights produced no report.
 */
export const EVAL_PASSK_STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on report timestamps, the sibling feeds' one-minute tolerance for same-host clock drift. */
export const EVAL_PASSK_FUTURE_SKEW_MS = 60_000;
/**
 * How old an unterminated tail document must be before it counts as a
 * crashed run rather than a run in flight: the nightly eval is
 * minutes-to-an-hour of trial work, so a fragment untouched for six
 * hours cannot be the current run's write — it is a torn write, the
 * same crashed-run evidence an abandoned fragment records.
 */
export const EVAL_PASSK_IN_FLIGHT_MS = 6 * 60 * 60 * 1000;
/** The writer's schema literal (PassKReport.schema in src/core/eval/passk.ts). */
const REPORT_SCHEMA = 'eval.passk.v1';
/** The fleet's own repository label: eval evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 160;

export interface EvalPassKItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Home the journal resolves under (default: os.homedir()); the unit writes <home>/.ashlr/logs/eval-passk.jsonl. */
  homeDir?: string;
  /** Journal path override (default: <homeDir>/.ashlr/logs/eval-passk.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default EVAL_PASSK_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring report-skew and eval staleness (default: now). */
  now?: Date;
}

/** The dated fields a journaled report contributes to the fold — the rest of the contract is validated, not carried. */
export interface EvalPassKReportSummary {
  atMs: number;
  utcDay: string;
  /** The report's own id (passk-<base36 ms>), quoted in prompts as recorded. */
  reportId: string;
  datasetTasks: number;
  lanes: number;
  trials: number;
  k: number;
  alerts: number;
}

/** Stderr recorded in the gap before an event: classified, never quoted. */
export interface EvalPassKGap {
  /** Non-record, non-error, non-stack lines — warnings, usage text, unclassified output. */
  strayLines: number;
  /** Lines starting `error:` — the CLI's err() verdict, exactly one per failed run. */
  errorLines: number;
  /** Maximal runs of >=3 consecutive stack-shaped lines — probable crashed-run traces. */
  crashClusters: number;
}

/** One terminal record a scheduled run left: a dated report, an undated skip verdict, or an abandoned (crashed mid-write) document fragment. */
export type EvalPassKEvent =
  | { kind: 'report'; gap: EvalPassKGap; report: EvalPassKReportSummary }
  | { kind: 'skip'; gap: EvalPassKGap; reason: string }
  | { kind: 'abandoned'; gap: EvalPassKGap };

/** Journal coverage the prompts state: what the bounded read and record parse actually saw. */
export interface EvalPassKCoverage {
  /** Document blocks that closed on contract but failed validation, plus off-contract single-line records. */
  invalidDocs: number;
  /** Non-empty lines outside documents and records — stderr noise, counted never quoted. */
  strayLines: number;
  /** Whether the tail ends inside an unterminated document — a torn final fragment or a run in flight; counts as a crashed run only when the file mtime proves it stale. */
  openTail: boolean;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  truncated: boolean;
  /** The ledger read's own state when it was not 'read'. */
  sourceState: string;
}

/** The fold's measured evidence; every count is over the retained tail only. */
export interface EvalPassKEvidence {
  /** Valid report documents in the retained tail. */
  reports: number;
  /** ISO generatedAt of the newest on-contract, non-skewed report; null when none. */
  lastReportAt: string | null;
  /** Its ms anchor for staleness math; null when none. */
  lastReportMs: number | null;
  /** The report before it, for gap-span context; null when fewer than two. */
  prevReportAt: string | null;
  /** Newest report's recorded shape, quoted as context. */
  lastReport: EvalPassKReportSummary | null;
  /** Skip verdicts recorded after the newest report (all skips when no report exists). */
  tailSkips: number;
  /** The newest tail skip's scrubbed reason, when any. */
  newestSkipReason: string | null;
  /** Abandoned document fragments after the newest report — crashed mid-write runs. */
  tailAbandoned: number;
  /** `error:` stderr lines recorded after the newest report — definite failed runs. */
  tailErrorLines: number;
  /** Crash clusters recorded after the newest report — probable crashed runs. */
  tailCrashClusters: number;
  /** Other stray stderr lines recorded after the newest report — unverified, coverage only. */
  tailStrayLines: number;
  /** The tail ends inside an unterminated document whose file mtime proves it cannot be a run in flight — one probable crashed run. */
  tornTail: boolean;
  /** Definite unmeasured-run count powering the stale axis: skips + failures + fragments + torn tail. */
  tailUnmeasured: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A non-negative safe integer, the shape every recorded count takes. */
function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** A positive safe integer, the shape trials/k take. */
function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** A finite number in [0,1], the shape the lane rates take. */
function unitRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A bounded non-empty string, scrubbed, printable-only, flattened and capped — journal text is untrusted. */
function fieldText(value: unknown, max = FIELD_MAX): string {
  if (typeof value !== 'string') return '';
  return scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: validate one parsed {report, published} document against the
 * shape cmdEvalPassK's --json success path prints — the eval.passk.v1
 * report envelope plus the five published path fields. Lanes and tasks
 * are checked to the depth the fold quotes (counts and rates), never
 * to trialsDetail, which the fold never reads. Anything else is not a
 * journaled report.
 */
export function parseEvalPassKReportDoc(value: unknown): EvalPassKReportSummary | null {
  if (!isRecord(value)) return null;
  const report = value['report'];
  const published = value['published'];
  if (!isRecord(report) || !isRecord(published)) return null;
  if (report['schema'] !== REPORT_SCHEMA) return null;
  const generatedAt = report['generatedAt'];
  const atMs = typeof generatedAt === 'string' ? Date.parse(generatedAt) : NaN;
  if (!Number.isFinite(atMs)) return null;
  const reportId = fieldText(report['id'], 96);
  if (reportId === '') return null;
  const dataset = report['dataset'];
  if (!isRecord(dataset)) return null;
  const datasetSha = dataset['sha256'];
  const datasetTasks = dataset['tasks'];
  if (typeof datasetSha !== 'string' || datasetSha === '' || !nonNegativeInt(datasetTasks)) return null;
  const trials = report['trials'];
  const k = report['k'];
  if (!positiveInt(trials) || !positiveInt(k) || (k as number) > (trials as number)) return null;
  const rawLanes = report['lanes'];
  if (!Array.isArray(rawLanes)) return null;
  for (const raw of rawLanes) {
    if (!isRecord(raw)) return null;
    if (fieldText(raw['lane'], 64) === '' || fieldText(raw['model'], 64) === '') return null;
    if (!nonNegativeInt(raw['trialsTotal']) || !nonNegativeInt(raw['passesTotal'])) return null;
    if (!unitRate(raw['meanPass1'])) return null;
    if (raw['meanPassAtK'] !== null && !unitRate(raw['meanPassAtK'])) return null;
    if (raw['meanPassPowK'] !== null && !unitRate(raw['meanPassPowK'])) return null;
    if (!Array.isArray(raw['tasks'])) return null;
    for (const task of raw['tasks']) {
      if (!isRecord(task)) return null;
      if (fieldText(task['taskId'], 128) === '') return null;
      if (!nonNegativeInt(task['trials']) || !nonNegativeInt(task['passes'])) return null;
      if (!unitRate(task['pass1'])) return null;
      if (task['passAtK'] !== null && !unitRate(task['passAtK'])) return null;
      if (task['passPowK'] !== null && !unitRate(task['passPowK'])) return null;
    }
  }
  if (!Array.isArray(report['alerts'])) return null;
  for (const key of ['report', 'scores', 'alerts', 'dir', 'laneScores'] as const) {
    if (typeof published[key] !== 'string' || published[key] === '') return null;
  }
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    reportId,
    datasetTasks: datasetTasks as number,
    lanes: rawLanes.length,
    trials: trials as number,
    k: k as number,
    alerts: (report['alerts'] as unknown[]).length,
  };
}

/**
 * Pure: validate one parsed single-line record — the {"skipped":true,
 * "reason":…} verdict cmdEvalPassK prints when every lane is the local
 * family and no provider answered the probe. The reason is kept
 * scrubbed for the prompt; anything else is not a journaled skip.
 */
export function parseEvalPassKSkipDoc(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (value['skipped'] !== true) return null;
  const reason = fieldText(value['reason']);
  return reason === '' ? null : reason;
}

/** A line that could be one complete JSON record on its own (the skip verdict's framing). */
const SINGLE_LINE_RECORD = /^\{.*\}\s*$/;
/** A document boundary on its own line — the writer's JSON.stringify(…, null, 2) framing. */
const DOC_OPEN = /^\{\s*$/;
const DOC_CLOSE = /^\}\s*$/;
/** The CLI's err() verdict prefix — exactly one per failed run by the handler's return-after-error contract. */
const ERROR_LINE = /^error:/;
/** Stack-shaped stderr: `at …` frames, `node:` internals and `XxxError:`/`XxxException:` lines — a probable crashed run's trace. */
const STACK_LINE = /^(?:\s+at\s|node:|(?:[A-Za-z]+)?(?:Error|Exception):)/;
/** A crash cluster needs this many consecutive stack lines — one or two `at` mentions are not a trace. */
const CRASH_CLUSTER_MIN_LINES = 3;

interface MutableGap {
  strayLines: number;
  errorLines: number;
  crashClusters: number;
  /** Consecutive stack-line run in progress; >= CRASH_CLUSTER_MIN_LINES closes one cluster. */
  stackRun: number;
}

const newGap = (): MutableGap => ({ strayLines: 0, errorLines: 0, crashClusters: 0, stackRun: 0 });

/** Fold one non-record line into the open gap's classification. */
function absorbStray(gap: MutableGap, line: string): void {
  if (ERROR_LINE.test(line)) {
    gap.errorLines += 1;
    gap.stackRun = 0;
    return;
  }
  if (STACK_LINE.test(line)) {
    gap.stackRun += 1;
    if (gap.stackRun === CRASH_CLUSTER_MIN_LINES) gap.crashClusters += 1;
    return;
  }
  gap.stackRun = 0;
  gap.strayLines += 1;
}

/**
 * Pure: parse one eval-passk.jsonl file's text into the ordered event
 * stream plus coverage. Documents are delimited by column-0 braces —
 * the writer's JSON.stringify(…, null, 2) framing — so a column-0 `{`
 * opens a document and a column-0 `}` closes it; a column-0 `{`
 * inside an open document abandons it as a crashed mid-write run
 * (an 'abandoned' event), an unterminated tail is openTail, and
 * non-empty lines outside documents are stderr absorbed into the
 * gap classification. Outside documents, a line that is one complete
 * JSON record is tried against the skip verdict and then the report
 * envelope; records matching neither count as invalidDocs, and lines
 * that are not records count as strayLines. Closed documents that
 * fail their contract count as invalidDocs — never guessed.
 */
export function parseEvalPassKJournal(text: string): {
  events: EvalPassKEvent[];
  /** Stderr accumulated after the last record — runs that never reached a verdict. */
  tailGap: EvalPassKGap;
  coverage: Omit<EvalPassKCoverage, 'truncated' | 'sourceState'>;
} {
  const events: EvalPassKEvent[] = [];
  const coverage = { invalidDocs: 0, strayLines: 0, openTail: false };
  let gap = newGap();
  let buffer: string[] | null = null;
  const closeGap = (): EvalPassKGap => {
    const out: EvalPassKGap = { strayLines: gap.strayLines, errorLines: gap.errorLines, crashClusters: gap.crashClusters };
    gap = newGap();
    return out;
  };
  const absorbLine = (line: string): void => {
    absorbStray(gap, line);
    coverage.strayLines += 1;
  };
  for (const line of text.split('\n')) {
    if (buffer === null) {
      if (DOC_OPEN.test(line)) { buffer = [line]; continue; }
      if (line.trim() === '') continue;
      if (SINGLE_LINE_RECORD.test(line)) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          absorbLine(line);
          continue;
        }
        const skipReason = parseEvalPassKSkipDoc(value);
        if (skipReason !== null) {
          events.push({ kind: 'skip', gap: closeGap(), reason: skipReason });
          continue;
        }
        const report = parseEvalPassKReportDoc(value);
        if (report !== null) {
          events.push({ kind: 'report', gap: closeGap(), report });
          continue;
        }
        coverage.invalidDocs += 1;
        continue;
      }
      absorbLine(line);
      continue;
    }
    if (DOC_OPEN.test(line)) {
      // A column-0 `{` can only be a new document: the previous one was
      // abandoned mid-write — a crashed run's torn fragment.
      events.push({ kind: 'abandoned', gap: closeGap() });
      buffer = [line];
      continue;
    }
    buffer.push(line);
    if (!DOC_CLOSE.test(line)) continue;
    const docText = buffer.join('\n');
    buffer = null;
    let value: unknown;
    try {
      value = JSON.parse(docText);
    } catch {
      coverage.invalidDocs += 1;
      continue;
    }
    const report = parseEvalPassKReportDoc(value);
    if (report === null) { coverage.invalidDocs += 1; continue; }
    events.push({ kind: 'report', gap: closeGap(), report });
  }
  if (buffer !== null) {
    // The tail ends inside a document: a torn final fragment or a run
    // still in flight — coverage, never a verdict.
    coverage.openTail = true;
  }
  return { events, tailGap: closeGap(), coverage };
}

/**
 * Pure: fold the ordered event stream into the tail evidence. The
 * anchor is the newest report event whose generatedAt is not past
 * the clock plus the future-skew tolerance — a skewed report is
 * corrupt evidence and cannot bound the tail. Everything after that
 * anchor (or the whole stream when no report qualifies) is the
 * unmeasured tail: skip verdicts, abandoned fragments, and the gap
 * stderr classified between them. Skewed reports count as coverage,
 * never as the anchor.
 */
export function foldEvalPassKEvidence(
  events: readonly EvalPassKEvent[],
  tailGap: EvalPassKGap,
  opts: { nowMs: number; skewMs?: number; tornTail?: boolean },
): { evidence: EvalPassKEvidence; skewedReports: number } {
  const skewMs = opts.skewMs ?? EVAL_PASSK_FUTURE_SKEW_MS;
  const futureCeil = opts.nowMs + skewMs;
  let lastReportIdx = -1;
  let skewedReports = 0;
  const reports: EvalPassKReportSummary[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.kind !== 'report') continue;
    if (event.report.atMs > futureCeil) { skewedReports += 1; continue; }
    reports.push(event.report);
    lastReportIdx = i;
  }
  const tailEvents = lastReportIdx >= 0 ? events.slice(lastReportIdx + 1) : events;
  let tailSkips = 0;
  let tailAbandoned = 0;
  let tailErrorLines = 0;
  let tailCrashClusters = 0;
  let tailStrayLines = 0;
  let newestSkipReason: string | null = null;
  // Only the tail events' own gaps join the count: the anchor report's
  // gap precedes it (pre-report evidence), and each tail event's gap
  // is the stderr recorded between the previous record and it — runs
  // that happened after the newest report.
  const addGap = (gap: EvalPassKGap): void => {
    tailErrorLines += gap.errorLines;
    tailCrashClusters += gap.crashClusters;
    tailStrayLines += gap.strayLines;
  };
  for (const event of tailEvents) {
    addGap(event.gap);
    if (event.kind === 'skip') {
      tailSkips += 1;
      newestSkipReason = event.reason;
    } else if (event.kind === 'abandoned') {
      tailAbandoned += 1;
    }
  }
  // The EOF gap sits after the final record — always inside the tail
  // region (after the newest report, or anywhere when no report
  // exists): stderr of runs that never reached a verdict.
  addGap(tailGap);
  const tornTail = opts.tornTail === true;
  const tailFailures = tailErrorLines + tailCrashClusters + tailAbandoned + (tornTail ? 1 : 0);
  const last = reports.length > 0 ? reports[reports.length - 1]! : null;
  return {
    evidence: {
      reports: reports.length,
      lastReportAt: last === null ? null : new Date(last.atMs).toISOString(),
      lastReportMs: last === null ? null : last.atMs,
      prevReportAt: reports.length > 1 ? new Date(reports[reports.length - 2]!.atMs).toISOString() : null,
      lastReport: last,
      tailSkips,
      newestSkipReason,
      tailAbandoned,
      tailErrorLines,
      tailCrashClusters,
      tailStrayLines,
      tornTail,
      tailUnmeasured: tailSkips + tailFailures,
    },
    skewedReports,
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function coverageNote(coverage: EvalPassKCoverage, skewedReports: number): string {
  const parts: string[] = [];
  if (coverage.invalidDocs > 0) parts.push(`${coverage.invalidDocs} document block(s)/record(s) failed the contract and were not counted`);
  if (coverage.strayLines > 0) parts.push(`${coverage.strayLines} non-record stderr line(s) between records`);
  if (coverage.openTail) parts.push('the tail ends inside an unterminated document (a torn write or a run in flight)');
  if (skewedReports > 0) parts.push(`${skewedReports} report(s) stamped past the clock-skew tolerance and were not counted`);
  if (coverage.truncated) parts.push('the bounded tail cut older records, so counts are a lower bound');
  if (coverage.sourceState !== 'read') parts.push(`the journal read state was '${coverage.sourceState}'`);
  return parts.length === 0 ? '' : ` Journal coverage: ${parts.join('; ')}.`;
}

const EVIDENCE = 'The evidence is ~/.ashlr/logs/eval-passk.jsonl under the user\'s home — the stdout+stderr sink evalPassKSchedule (src/core/eval/passk-schedule.ts) gives the nightly `phm eval passk --json` unit (launchd ai.ashlr.phm.eval-passk / systemd phm-eval-passk.{service,timer}), one terminal record per run: a pretty-printed {report, published} document on success (report is the eval.passk.v1 PassKReport — src/core/eval/passk.ts, printed by cmdEvalPassK in src/cli/eval-passk.ts), a single-line {"skipped":true,"reason":…} verdict when every lane is the loopback-only local family and no provider answered the probe, or `error:`/stack stderr when the run dies before a verdict. Reports and alerts persist under ~/.ashlr/eval/passk/ and passkAlertBacklogItems already folds the alerts journal for capability regressions; until now the run journal itself had no reader. `phm eval passk scores --json` and `phm eval passk alerts --json` read the same stores.';

const NO_CHANGE = 'If the newest report is recent again, the adverse tail was a bounded burst the later runs recovered from, the schedule was retuned or uninstalled, the local provider or host was legitimately down and is back, or the cause is owner-side or pinned ops machinery — report no-change and name the evidence.';

function ageDaysText(ev: EvalPassKEvidence, nowMs: number): string {
  if (ev.lastReportMs === null) return 'no report has ever landed in the retained tail';
  const days = Math.floor((nowMs - ev.lastReportMs) / (24 * 60 * 60 * 1000));
  return `the newest report is ${ev.lastReportAt} (${days} day(s) old)`;
}

function skipPrompt(ev: EvalPassKEvidence, coverage: EvalPassKCoverage, skewed: number, nowMs: number): string {
  const reason = ev.newestSkipReason === null ? '' : ` The newest skip recorded reason: "${ev.newestSkipReason}".`;
  const otherCount = ev.tailAbandoned + ev.tailErrorLines + ev.tailCrashClusters + (ev.tornTail ? 1 : 0);
  const other = otherCount > 0
    ? ` The same tail also recorded ${ev.tailAbandoned} abandoned document fragment(s), ${ev.tailErrorLines} \`error:\` verdict(s), ${ev.tailCrashClusters} crash cluster(s)${ev.tornTail ? ' and a stale unterminated document fragment' : ''} — runs that died without a verdict.`
    : '';
  return [
    `Phantom's scheduled pass^k eval keeps skipping — ${ev.tailSkips} recorded {skipped:true} verdict(s) since the newest report, the self-improvement work this backlog exists for.`,
    '',
    `Each skip is one completed \`phm eval passk --json\` run whose every lane was the loopback-only local family and whose provider probe found no local model answering — the run exited 0 without measuring anything, so no report, no lane-scores update and no alerts reached the eval store. ${ageDaysText(ev, nowMs)}.${reason}${other}${coverageNote(coverage, skewed)}`,
    '',
    EVIDENCE,
    '',
    `Find why the local provider never comes up for the scheduled run: the probe is isLocalEvalProviderUp (src/cli/eval-cli-helpers.ts) and the skip verdict is cmdEvalPassK's all-local-lanes guard (src/cli/eval-passk.ts) — check whether Ollama or LM Studio is installed, whether the unit's environment reaches the loopback endpoint the probe checks (launchd/systemd user units do not inherit the interactive shell's environment), whether the provider port or model name drifted, and whether the schedule should name a non-local lane or stay skipped by design. Reproduce with \`phm eval passk --json\` on the host; if the provider is intentionally absent and the skip is the designed idle state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function failurePrompt(ev: EvalPassKEvidence, coverage: EvalPassKCoverage, skewed: number, nowMs: number): string {
  const parts: string[] = [];
  if (ev.tailErrorLines > 0) parts.push(`${ev.tailErrorLines} \`error:\` verdict(s) — the CLI's own failure line, exactly one per failed run`);
  if (ev.tailCrashClusters > 0) parts.push(`${ev.tailCrashClusters} crash cluster(s) — stack-shaped stderr, probable runs killed mid-eval`);
  if (ev.tailAbandoned > 0) parts.push(`${ev.tailAbandoned} abandoned document fragment(s) — runs that died mid-write`);
  if (ev.tornTail) parts.push('an unterminated tail document untouched for over six hours — a torn write no run in flight can explain');
  const skips = ev.tailSkips > 0 ? ` The same tail also recorded ${ev.tailSkips} skip verdict(s).` : '';
  return [
    `Phantom's scheduled pass^k eval keeps dying before a verdict — ${ev.tailErrorLines + ev.tailCrashClusters + ev.tailAbandoned + (ev.tornTail ? 1 : 0)} recorded failed run(s) since the newest report, the self-improvement work this backlog exists for.`,
    '',
    `Each count is one completed-or-torn scheduled \`phm eval passk --json\` run that left stderr or a document fragment but no report: ${parts.join('; ')}.${skips} ${ageDaysText(ev, nowMs)}.${coverageNote(coverage, skewed)}`,
    '',
    EVIDENCE,
    '',
    `Find why the runs keep failing: the failure exits are cmdEvalPassK's (src/cli/eval-passk.ts) — dataset parse, repoPath confinement, runPassKEval (src/core/eval/passk.ts — per-trial workspaces, the engine runner from buildDefaultRunner in src/core/eval/swe-bench.ts) and publishPassKReport — plus anything that kills the process before the handler returns (an uncaught throw prints a stack, not an \`error:\` line). Check the newest \`error:\` text in the journal tail for the named cause, whether the golden dataset or a task's repoPath moved, whether the local provider dies mid-eval after the probe passes (per-trial errors land inside the report, so a report still publishes — a dead provider mid-run is not this shape), and whether the unit's environment or working directory differs from an interactive run. Reproduce with \`phm eval passk --json\`; fix what lives in this repository and report no-change with the evidence when the cause is owner-side or pinned ops machinery. ${NO_CHANGE}`,
  ].join('\n');
}

function stalePrompt(ev: EvalPassKEvidence, coverage: EvalPassKCoverage, skewed: number, nowMs: number): string {
  const detail: string[] = [];
  if (ev.tailSkips > 0) detail.push(`${ev.tailSkips} skip verdict(s)`);
  if (ev.tailErrorLines > 0) detail.push(`${ev.tailErrorLines} \`error:\` verdict(s)`);
  if (ev.tailCrashClusters > 0) detail.push(`${ev.tailCrashClusters} crash cluster(s)`);
  if (ev.tailAbandoned > 0) detail.push(`${ev.tailAbandoned} abandoned fragment(s)`);
  if (ev.tornTail) detail.push('a stale unterminated document fragment');
  if (ev.tailStrayLines > 0) detail.push(`${ev.tailStrayLines} other stderr line(s)`);
  return [
    `Phantom's scheduled pass^k eval has not landed a report in days — ${ageDaysText(ev, nowMs)}, while the journal still records unmeasured runs, the self-improvement work this backlog exists for.`,
    '',
    `The unit runs once nightly; a report older than ${Math.round(EVAL_PASSK_STALE_MS / (24 * 60 * 60 * 1000))} days means at least two scheduled nights produced no measurement. Since that report the journal recorded only: ${detail.join(', ')} — no completed eval. The lane-scores projection \`ashlr router rank\` consumes stays frozen on the last good report, and the alerts journal sees nothing new.${ev.prevReportAt !== null ? ` The report before it was ${ev.prevReportAt}.` : ''}${coverageNote(coverage, skewed)}`,
    '',
    EVIDENCE,
    '',
    `Find out whether the schedule still runs and why nothing lands: check the unit is still installed and enabled (\`phm eval passk schedule\` prints it; launchctl list / systemctl --user list-timers on the host), whether the host was simply off or asleep through the nightly window (Persistent=true catches up on systemd; launchd runs missed StartCalendarInterval jobs at next wake — verify which missed), whether every recent run skipped on a dead local provider or died on an error the recurring bars below did not reach, and whether the journal path moved. If the eval is intentionally disabled, report no-change and name the evidence — a stale projection is then the designed state. ${NO_CHANGE}`,
  ].join('\n');
}

function evalPassKItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'passk-eval',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the scheduled pass^k eval journal's recurring
 * adverse evidence: provider-starvation skip streaks, run failures
 * and a stale eval still recording unmeasured runs — each read off
 * the tail after the newest report. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function evalPasskBacklogItems(opts: EvalPassKItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(home, '.ashlr', 'logs', 'eval-passk.jsonl');
    const read = await readLedgerTail(journalPath, EVAL_PASSK_TAIL_BYTES);
    // A missing, non-file or unreadable journal is the writer's normal
    // state — the schedule is opt-in --install — and contributes nothing.
    if (read.state !== 'read') return [];
    const parsed = parseEvalPassKJournal(read.text);
    // A journal with no records and no classified stderr is pure noise —
    // nothing to fold. A records-free journal that is ALL `error:`/stack
    // stderr still folds: every run died before any verdict could land.
    if (parsed.events.length === 0
      && parsed.tailGap.strayLines === 0 && parsed.tailGap.errorLines === 0 && parsed.tailGap.crashClusters === 0
      && !parsed.coverage.openTail) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    // An unterminated tail document is a torn write — one probable
    // crashed run — only when the file's mtime proves no run can still
    // be in flight; a fresh fragment stays coverage, never a verdict.
    let tornTail = false;
    if (parsed.coverage.openTail) {
      try {
        const info = await stat(journalPath);
        tornTail = nowMs - info.mtimeMs > EVAL_PASSK_IN_FLIGHT_MS;
      } catch {
        tornTail = false;
      }
    }
    const { evidence, skewedReports } = foldEvalPassKEvidence(parsed.events, parsed.tailGap, { nowMs, tornTail });
    const coverage: EvalPassKCoverage = {
      ...parsed.coverage,
      truncated: read.truncated,
      sourceState: read.state,
    };
    const items: CloudBacklogItem[] = [];
    let emittedRecurring = false;
    if (evidence.tailSkips >= EVAL_PASSK_MIN_SKIPS) {
      items.push(evalPassKItem(
        'eval-passk-skips',
        'Scheduled pass^k eval keeps skipping — no local provider',
        skipPrompt(evidence, coverage, skewedReports, nowMs),
        repo,
      ));
      emittedRecurring = true;
    }
    const tailFailures = evidence.tailErrorLines + evidence.tailCrashClusters + evidence.tailAbandoned + (evidence.tornTail ? 1 : 0);
    if (tailFailures >= EVAL_PASSK_MIN_FAILURES) {
      items.push(evalPassKItem(
        'eval-passk-failures',
        'Scheduled pass^k eval keeps dying before a verdict',
        failurePrompt(evidence, coverage, skewedReports, nowMs),
        repo,
      ));
      emittedRecurring = true;
    }
    const stale = evidence.lastReportMs !== null
      && nowMs - evidence.lastReportMs >= EVAL_PASSK_STALE_MS
      && evidence.tailUnmeasured > 0;
    if (stale && !emittedRecurring) {
      items.push(evalPassKItem(
        'eval-passk-stale',
        'Scheduled pass^k eval has not reported in days',
        stalePrompt(evidence, coverage, skewedReports, nowMs),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? EVAL_PASSK_MAX_ITEMS, EVAL_PASSK_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
