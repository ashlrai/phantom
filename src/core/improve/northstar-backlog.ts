/**
 * <runs>/metrics/northstar.jsonl batch-session cutover rows →
 * self-improvement backlog items.
 *
 * `python3 contrib/mac/batch_sessions.py northstar --record` is the
 * fleet's own before/after measurement of the batch-sessions
 * intervention: it projects metrics/jobs.jsonl through
 * batcher.read_rows and appends two ashlr.northstar.v1 rows per call —
 * one 'before' and one 'after' the cutover epoch, both stamped with the
 * same recorded_at — carrying the north-star rates the fleet cares
 * about (tasks finished per session, iterations per hour, merged PRs
 * per iteration). A null rate means the window recorded zero finished
 * sessions: unknown, never zero. The command also writes the one-time
 * human note bus/batch-sessions-first-numbers.md.
 *
 * Until now the journal had no repository reader at all: the bus note
 * was written once and never revisited, and nothing folded the recorded
 * pairs into work. A cutover whose after-window shows the north star
 * falling — or a fleet that recorded zero finished sessions across a
 * meaningful after-window — is exactly the outcome signal the
 * self-improvement loop exists to consume, and it never became work.
 * northstarBacklogItems carries each adverse cutover into
 * discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no command is
 *    run. A missing or unreadable file yields no items; a malformed
 *    line is skipped and counted, never guessed.
 *  - Rows count only under the writer's contract: schema
 *    'ashlr.northstar.v1', phase 'before' or 'after', integer epoch
 *    window_start/window_end/recorded_at with window_end after
 *    window_start, positive finite hours, non-negative integer counts,
 *    and rates that are null or non-negative finite numbers. Foreign
 *    shapes are malformed, never folded.
 *  - Pairing is by recorded_at — the batch key --record stamps on both
 *    rows — and a pair joins only when before.window_end equals
 *    after.window_start, the shared cutover epoch the writer derives
 *    from --cutover. Rows that cannot prove they belong to the same
 *    measurement never pair. When several records measure the same
 *    cutover, only the freshest recorded_at is evaluated: it is the
 *    most complete after-window and the fairest evidence.
 *  - A pair is adverse only when both windows span at least
 *    NORTHSTAR_MIN_WINDOW_HOURS — below that the per-session and
 *    per-hour rates are dominated by single-session granularity — and
 *    either a rate strictly fell (after < before, both non-null) or
 *    the after window recorded zero finished sessions while the before
 *    window had some. Null rates are never treated as zero and
 *    improvements emit nothing.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes every prompt says the fold saw only the retained
 *    window.
 *  - Fleet machinery only: the journal describes this install's
 *    batch-session experiment and carries no repo column, so items
 *    emit only for the fleet's own repository — the same last-segment
 *    rule the sibling fleet-evidence sources apply. The item id hashes
 *    the cutover epoch, so a refresh re-derives the same id and a
 *    re-record of the same cutover refreshes the item in place rather
 *    than spawning a twin.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** The writer's schema tag on every recorded row. */
export const NORTHSTAR_SCHEMA = 'ashlr.northstar.v1';
/** Items one call may emit; the cutover space is bounded by record batches. */
export const NORTHSTAR_BACKLOG_MAX_ITEMS = 4;
const NORTHSTAR_BACKLOG_ITEM_HARD_MAX = 10;
/** Bounded no-follow tail; the journal is append-only and tiny in practice. */
export const NORTHSTAR_TAIL_BYTES = 256 * 1024;
/**
 * Minimum hours each window must span before its rates are comparable:
 * below one hour a per-session or per-hour rate is dominated by
 * single-session granularity rather than measuring the intervention.
 */
export const NORTHSTAR_MIN_WINDOW_HOURS = 1;
/** Contract-failing lines inside the retained tail before the journal itself becomes work. */
export const NORTHSTAR_CORRUPT_MIN_ROWS = 3;
/** The fleet's own repository label: the journal is this install's experiment, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The three rate fields the writer computes; null means the window had no finished sessions. */
const RATE_FIELDS = ['tasks_per_session', 'iterations_per_hour', 'merged_prs_per_iteration'] as const;
type RateField = (typeof RATE_FIELDS)[number];

export interface NorthstarItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal override (default: <runsDir>/metrics/northstar.jsonl). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default NORTHSTAR_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const isoSec = (sec: number): string => new Date(sec * 1000).toISOString();

function isNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegRate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

// ---------------------------------------------------------------------------
// Row contract — one ashlr.northstar.v1 row exactly as --record appends it
// ---------------------------------------------------------------------------

export interface NorthstarRow {
  phase: 'before' | 'after';
  windowStart: number;
  windowEnd: number;
  hours: number;
  sessions: number;
  bundleSessions: number;
  tasksFinished: number;
  mergedPrs: number;
  tasksPerSession: number | null;
  iterationsPerHour: number | null;
  mergedPrsPerIteration: number | null;
  /** The --record batch key: both rows of one measurement share it. */
  recordedAt: number;
}

/**
 * Structural validation of one persisted line against the writer's row
 * contract. Returns null for a corrupted or foreign row so the caller
 * counts it malformed and skips it rather than let damaged evidence
 * masquerade as a real measurement.
 */
function projectNorthstarRow(parsed: unknown): NorthstarRow | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row['schema'] !== NORTHSTAR_SCHEMA) return null;
  const phase = row['phase'];
  if (phase !== 'before' && phase !== 'after') return null;
  const windowStart = row['window_start'];
  const windowEnd = row['window_end'];
  const recordedAt = row['recorded_at'];
  if (!isNonNegInt(windowStart) || !isNonNegInt(windowEnd) || windowEnd <= windowStart) return null;
  if (!isNonNegInt(recordedAt)) return null;
  const hours = row['hours'];
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) return null;
  const counts = [row['sessions'], row['bundle_sessions'], row['tasks_finished'], row['merged_prs']];
  if (!counts.every(isNonNegInt)) return null;
  const rates = [row['tasks_per_session'], row['iterations_per_hour'], row['merged_prs_per_iteration']];
  if (!rates.every(isNonNegRate)) return null;
  return {
    phase,
    windowStart,
    windowEnd,
    hours,
    sessions: row['sessions'] as number,
    bundleSessions: row['bundle_sessions'] as number,
    tasksFinished: row['tasks_finished'] as number,
    mergedPrs: row['merged_prs'] as number,
    tasksPerSession: rates[0] as number | null,
    iterationsPerHour: rates[1] as number | null,
    mergedPrsPerIteration: rates[2] as number | null,
    recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

export interface NorthstarFold {
  /** Contract-valid rows in file order. */
  rows: NorthstarRow[];
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
}

/**
 * Pure: fold journal text(s) — oldest first — into measured rows.
 * Only lines that fail the writer's row contract are skipped, never
 * guessed.
 */
export function foldNorthstarRows(texts: readonly string[]): NorthstarFold {
  const fold: NorthstarFold = { rows: [], malformed: 0 };
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      const row = projectNorthstarRow(parsed);
      if (row === null) { fold.malformed++; continue; }
      fold.rows.push(row);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Pairing — recorded_at batches into before/after cutover measurements
// ---------------------------------------------------------------------------

export interface NorthstarPair {
  /** The shared cutover epoch: before.window_end === after.window_start. */
  cut: number;
  /** The freshest recorded_at that measured this cutover. */
  recordedAt: number;
  before: NorthstarRow;
  after: NorthstarRow;
}

/**
 * Pure: group contract-valid rows into complete before/after pairs —
 * one per recorded_at batch, joined only when the windows share the
 * cutover epoch — then keep the freshest record per cutover. Incomplete
 * batches (a --record interrupted mid-append, or a foreign row set)
 * never pair and are silently dropped: unpaired rows are not evidence
 * of anything.
 */
export function northstarPairs(rows: readonly NorthstarRow[]): NorthstarPair[] {
  const batches = new Map<number, { before?: NorthstarRow; after?: NorthstarRow }>();
  for (const row of rows) {
    const batch = batches.get(row.recordedAt) ?? {};
    const existing = batch[row.phase];
    // Defensive: --record appends each phase once per batch; if a batch
    // ever carries two, the wider window_end is the later write.
    if (existing === undefined || row.windowEnd > existing.windowEnd) batch[row.phase] = row;
    batches.set(row.recordedAt, batch);
  }
  const freshest = new Map<number, NorthstarPair>();
  for (const [recordedAt, batch] of batches) {
    const { before, after } = batch;
    if (before === undefined || after === undefined) continue;
    if (before.windowEnd !== after.windowStart) continue;
    const pair: NorthstarPair = { cut: before.windowEnd, recordedAt, before, after };
    const prior = freshest.get(pair.cut);
    if (prior === undefined || pair.recordedAt > prior.recordedAt) freshest.set(pair.cut, pair);
  }
  return [...freshest.values()].sort((a, b) => b.cut - a.cut);
}

// ---------------------------------------------------------------------------
// Adverse evaluation — rates that fell, or a dark after-window
// ---------------------------------------------------------------------------

export interface NorthstarRateDelta {
  metric: RateField;
  before: number;
  after: number;
}

export interface NorthstarAdverse {
  pair: NorthstarPair;
  /** Rates that strictly fell, both sides non-null. Empty on a dark after-window. */
  regressions: NorthstarRateDelta[];
  /** The after window recorded zero finished sessions while before had some. */
  darkAfter: boolean;
}

const rateOf = (row: NorthstarRow, metric: RateField): number | null =>
  metric === 'tasks_per_session' ? row.tasksPerSession
    : metric === 'iterations_per_hour' ? row.iterationsPerHour
      : row.mergedPrsPerIteration;

/**
 * Pure: the adverse bars one pair must clear. Both windows must span at
 * least NORTHSTAR_MIN_WINDOW_HOURS before their rates mean anything;
 * below that the pair is insufficient evidence, not a regression.
 * Adverse means a rate strictly fell (both sides non-null — a null is
 * unknown, never zero) or the after window went dark while the before
 * window had finished sessions.
 */
export function northstarAdverse(pair: NorthstarPair): NorthstarAdverse | null {
  const { before, after } = pair;
  if (before.hours < NORTHSTAR_MIN_WINDOW_HOURS || after.hours < NORTHSTAR_MIN_WINDOW_HOURS) return null;
  const regressions: NorthstarRateDelta[] = [];
  for (const metric of RATE_FIELDS) {
    const b = rateOf(before, metric);
    const a = rateOf(after, metric);
    if (b !== null && a !== null && a < b) regressions.push({ metric, before: b, after: a });
  }
  const darkAfter = after.sessions === 0 && before.sessions > 0;
  if (regressions.length === 0 && !darkAfter) return null;
  return { pair, regressions, darkAfter };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs>/metrics/northstar.jsonl (ASHLR_RUNS_DIR or ~/.ashlr-runs) — one ashlr.northstar.v1 row per window, appended in before/after pairs by `python3 contrib/mac/batch_sessions.py northstar --record`, which projects metrics/jobs.jsonl through batcher.read_rows and stamps both rows of a measurement with the same recorded_at. Rates are null when the window recorded zero finished sessions — unknown, never zero — and the only other artifact the command leaves is the one-time human note bus/batch-sessions-first-numbers.md. Until this feed no repository reader folded the recorded pairs, so a cutover whose after-window showed the north star falling never became work.';

const REPRO = 'Reproduce the fold by reading <runs>/metrics/northstar.jsonl directly, keeping ashlr.northstar.v1 rows, grouping the before/after pair each recorded_at batch carries, joining pairs only where before.window_end equals after.window_start (the cutover epoch), keeping the freshest recorded_at per cutover, and comparing the three rate fields only where both sides are non-null with both windows at least an hour. The writer is contrib/mac/batch_sessions.py northstar; the projection it folds is batcher.read_rows over metrics/jobs.jsonl (finish, task_outcome and outcome rows written by contrib/mac/dispatchd.py).';

const NO_CHANGE = 'If a fresher `northstar --record` for the same cutover epoch shows the rates recovered, if the after window was still filling when it was recorded — its hours are quoted above and a partial window makes the rates noisy rather than false — or if the fleet was deliberately paused across the after window, the dip is measurement noise or a planned idle. In each case report no-change and name the evidence.';

const METRIC_LABEL: Record<RateField, string> = {
  tasks_per_session: 'tasks finished per session',
  iterations_per_hour: 'iterations per hour',
  merged_prs_per_iteration: 'merged PRs per iteration',
};

function windowText(row: NorthstarRow): string {
  return `${isoSec(row.windowStart)} → ${isoSec(row.windowEnd)} (${row.hours} h, ${row.sessions} session(s), ${row.tasksFinished} task(s) finished, ${row.mergedPrs} merged PR(s), ${row.bundleSessions} bundle session(s))`;
}

function regressionPrompt(item: NorthstarAdverse, lowerBound: boolean): string {
  const { pair, regressions, darkAfter } = item;
  const bound = lowerBound ? ' The bounded tail cut older bytes, so older cutovers may sit outside the retained window and these counts are a lower bound.' : '';
  const lead = darkAfter && regressions.length === 0
    ? `Phantom's fleet recorded zero finished sessions in the after-window of the batch-session cutover at ${isoSec(pair.cut)} — the north star went dark right where the intervention landed.`
    : `Phantom's batch-session north-star rates fell after the cutover at ${isoSec(pair.cut)} — the self-improvement work this backlog exists for.`;
  const moved = ['What moved:'];
  for (const r of regressions) moved.push(`- ${METRIC_LABEL[r.metric]}: ${r.before} → ${r.after}`);
  if (darkAfter) moved.push(`- finished sessions: ${pair.before.sessions} → 0 (the after window recorded none; its rates are n/a, not zero)`);
  return [
    lead,
    '',
    `A \`batch_sessions.py northstar --record\` pass at ${isoSec(pair.recordedAt)} appended this before/after pair to <runs>/metrics/northstar.jsonl:`,
    '',
    `- before: ${windowText(pair.before)}`,
    `- after:  ${windowText(pair.after)}`,
    '',
    ...moved,
    '',
    EVIDENCE,
    '',
    `Find whether the move is real and what caused it: re-run \`python3 contrib/mac/batch_sessions.py northstar --record --cutover ${pair.cut} --runs <runs>\` for a fresh window on the same cutover and compare, check the jobs.jsonl rows the projection folds (finish, task_outcome and outcome events written by contrib/mac/dispatchd.py and batcher.py) are still being emitted for batch sessions, and weigh the quoted window hours — a short after window makes per-session rates noisy. If batch sessions genuinely regressed throughput the fix lives in the batch path — dispatchd's batch claim/finish handling or batcher.py's read_rows projection — so propose it as a normal PR; contrib/mac changes still need Security review and re-pin before install.${bound}`,
    '',
    NO_CHANGE,
    '',
    REPRO,
  ].join('\n');
}

function northstarTitle(item: NorthstarAdverse): string {
  const date = isoSec(item.pair.cut).slice(0, 10);
  const title = item.darkAfter && item.regressions.length === 0
    ? `Zero finished sessions after the ${date} batch-session cutover`
    : `North-star rates fell after the ${date} batch-session cutover`;
  return title.slice(0, MAX_TITLE_CHARS);
}

function northstarItem(item: NorthstarAdverse, repo: string, lowerBound: boolean): CloudBacklogItem {
  return {
    id: `northstar-${sha(`cut:${item.pair.cut}`)}`,
    title: northstarTitle(item),
    prompt: regressionPrompt(item, lowerBound),
    area: 'growth-metrics',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const CORRUPT_EVIDENCE = 'The evidence is <runs>/metrics/northstar.jsonl (ASHLR_RUNS_DIR or ~/.ashlr-runs) — the append-only journal `python3 contrib/mac/batch_sessions.py northstar --record` owns. Every line should be one complete ashlr.northstar.v1 JSON row; lines that fail the contract are counted malformed and skipped, so a journal accumulating them is degrading evidence nobody was watching.';

const CORRUPT_REPRO = 'Reproduce the fold by reading <runs>/metrics/northstar.jsonl line by line and JSON.parse-ing each non-blank line against the ashlr.northstar.v1 contract (schema, phase before|after, integer epoch window_start/window_end/recorded_at, positive hours, non-negative integer counts, null-or-non-negative rates).';

function corruptPrompt(malformed: number, lowerBound: boolean): string {
  const bound = lowerBound ? ' The bounded tail cut older bytes, so the count covers only the retained window — a lower bound.' : '';
  return [
    `${malformed} line(s) inside the retained tail of <runs>/metrics/northstar.jsonl fail the ashlr.northstar.v1 row contract — the batch-session north-star journal is degrading.`,
    '',
    CORRUPT_EVIDENCE,
    '',
    `Find what keeps writing contract-failing rows: check for foreign appends or hand edits (the writer appends whole sorted-key JSON lines and owns the file), schema drift between contrib/mac/batch_sessions.py's row shape and the validated contract, and encoding damage.${bound} If the failures are a single torn tail line from one interrupted write, report no-change — the next --record pass appends clean rows after it.`,
    '',
    'If the journal is intact on re-read, report no-change and name the evidence.',
    '',
    CORRUPT_REPRO,
  ].join('\n');
}

function corruptItem(malformed: number, repo: string, lowerBound: boolean): CloudBacklogItem {
  return {
    id: `northstar-${sha('corrupt-lines')}`,
    title: 'northstar.jsonl carries contract-failing rows'.slice(0, MAX_TITLE_CHARS),
    prompt: corruptPrompt(malformed, lowerBound),
    area: 'growth-metrics',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for adverse batch-session cutover evidence and journal
 * corruption. Total: any read or fold failure yields no items rather
 * than throwing into discovery.
 */
export async function northstarBacklogItems(opts: NorthstarItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, 'metrics', 'northstar.jsonl');
    const read = await readLedgerTail(journalPath, NORTHSTAR_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const fold = foldNorthstarRows([read.text]);
    const pairs = northstarPairs(fold.rows);
    const adverse = pairs.map((pair) => northstarAdverse(pair)).filter((a): a is NorthstarAdverse => a !== null);
    const limit = Math.max(1, Math.min(opts.limit ?? NORTHSTAR_BACKLOG_MAX_ITEMS, NORTHSTAR_BACKLOG_ITEM_HARD_MAX));
    const items = adverse.map((a) => northstarItem(a, repo, read.truncated));
    if (fold.malformed >= NORTHSTAR_CORRUPT_MIN_ROWS) items.push(corruptItem(fold.malformed, repo, read.truncated));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
