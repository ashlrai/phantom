/**
 * <runsDir>/metrics/pr-delta.jsonl fleet.delta.v1 daily PR-leverage
 * deltas → self-improvement backlog items.
 *
 * `phm fleet pr-leverage --record-delta` (src/cli/fleet-pr-leverage.ts)
 * ranks the open-PR snapshot by leverage and, only when the flag is
 * passed, appends the day's `delta` block — rankPrLeverage's
 * fleet.delta.v1 record in src/core/fleet/pr-leverage.ts — to this
 * journal, deduped per (day, repos) so a rerun with unchanged numbers
 * writes nothing:
 *
 *   {schema:'fleet.delta.v1', day:'YYYY-MM-DD', repos:[...],
 *    prsMerged, verifiedLines, unmeasuredPrs, jobsCompleted}
 *
 * prsMerged is the day's merged-PR total; verifiedLines sums
 * additions+deletions over the merges the daily eval could verify
 * (clean checkState and non-null diff stats in the snapshot);
 * unmeasuredPrs is prsMerged minus that verified set — merges the
 * leverage computation could not score; jobsCompleted counts distinct
 * fleet jobs that finished clean that day, or null when jobs.jsonl
 * was unreadable at record time.
 *
 * The journal is opt-in — nothing schedules --record-delta — so a
 * host that never runs it has no file and reads clean-empty. When it
 * does record, the fold asks the question no reader ever did: are the
 * merges the factory ships actually verifiable? A delta day whose
 * unmeasuredPrs is positive is a day the leverage ranking merged PRs
 * it could not check — missing clean-CI state or missing diff stats
 * in the open-PR snapshot — so ranking, merge verification and the
 * verified-lines trend are all partially blind on exactly the days
 * that matter. unmeasuredPrs recurring across distinct UTC days is
 * evidence-capture degradation, not one-off snapshot noise; until now
 * the journal's only reader was the writer's own dedupe scan, so the
 * recurrence never became work.
 * prDeltaBacklogItems carries the same rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items; a
 *    malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: schema
 *    'fleet.delta.v1', a real YYYY-MM-DD day that round-trips through
 *    Date, a repos array of bounded owner/name strings, and the four
 *    counters as non-negative safe integers with jobsCompleted
 *    additionally allowed null (the writer's jobs.jsonl-unreadable
 *    sentinel). Foreign shapes are malformed, never folded.
 *  - Each row is one recorded (day, repos) delta as written; the
 *    writer can append a revised row for the same (day, repos) when
 *    numbers change, so the fold dedupes to the latest row per scope
 *    before counting — a recomputed day is scored once at its final
 *    numbers — and the days set dedupes by UTC day regardless of how
 *    many repo-scopes reported it.
 *  - There is no evidence window the way an event stream has one:
 *    recurrence is the distinct UTC days carrying unverified merges,
 *    the fleet's RECURRING_FAILURES convention applied to verification
 *    coverage. firstSeen/lastSeen report the earliest and latest
 *    adverse day honestly, and a truncated tail is stated as a lower
 *    bound.
 *  - jobsCompleted is reported as context, never as its own adverse
 *    cell: merges from outside agents legitimately record no fleet
 *    job, so zero completed jobs beside merges cannot be told apart
 *    from missing finish records — the prompt names both readings
 *    instead of flagging either.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the delta describes this
 *    install's merge pipeline and carries no single target repo.
 *    Dedup is downstream: the item id hashes the constant cell
 *    identity, so a refresh re-derives the same id and a journal
 *    that stops reporting unverified merges simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is the single delta cell. */
export const PR_DELTA_BACKLOG_MAX_ITEMS = 4;
const PR_DELTA_BACKLOG_ITEM_HARD_MAX = 10;
/** A cell emits only at this many distinct UTC days carrying unverified merges... */
export const PR_DELTA_MIN_DAYS = 3;
/** ...whose unmeasuredPrs sum to at least this many merges the delta could not verify. */
export const PR_DELTA_MIN_UNMEASURED = 4;
/** Bounded no-follow tail; daily rows are ~200 bytes, so this retains far more days than the window needs. */
export const PR_DELTA_TAIL_BYTES = 256 * 1024;
/** The fleet's own repository label: delta evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Day field bound; the writer's ISO slice is exactly 10 chars. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** repos entries are owner/name labels; bounded well past any real repo path. */
const MAX_REPO_CHARS = 200;
/** Distinct repo labels quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_REPOS = 6;
/** The writer's schema tag on every persisted row. */
const DELTA_SCHEMA = 'fleet.delta.v1';

export interface PrDeltaItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal directory override (default: $ASHLR_RUNS_DIR when non-empty, else ~/.ashlr-runs — the producer's own layout under metrics/). */
  runsDir?: string;
  /** Journal override (default: join(runsDir, 'metrics', 'pr-delta.jsonl')). */
  journalPath?: string;
  /** Most items one call emits (default PR_DELTA_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function boundedRepoName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_REPO_CHARS &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** A real calendar day: the writer's ISO slice, round-tripped so '2026-02-30' cannot pass. */
function isRealDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

// ---------------------------------------------------------------------------
// Row contract — one persisted fleet.delta.v1 exactly as --record-delta appends it
// ---------------------------------------------------------------------------

interface PrDeltaRow {
  /** UTC day the delta describes (the writer's `day`, a complete UTC day). */
  day: string;
  /** Repo labels the delta covered; bounded, dedup is not needed for the fold. */
  repos: string[];
  prsMerged: number;
  verifiedLines: number;
  /** Merges the delta could not verify — the adverse count this feed folds. */
  unmeasuredPrs: number;
  /** Null is the writer's jobs.jsonl-unreadable sentinel; reported as context only. */
  jobsCompleted: number | null;
}

/**
 * Structural validation of one persisted line against the writer's
 * fleet.delta.v1 contract. Returns null for a corrupted or foreign row
 * so the caller counts it malformed and skips it rather than let
 * damaged evidence masquerade as a real delta day.
 */
function projectDelta(parsed: unknown): PrDeltaRow | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row['schema'] !== DELTA_SCHEMA) return null;
  if (!isRealDay(row['day'])) return null;
  const repos = row['repos'];
  if (!Array.isArray(repos) || repos.length === 0 || repos.length > 100 || !repos.every(boundedRepoName)) return null;
  const prsMerged = row['prsMerged'];
  const verifiedLines = row['verifiedLines'];
  const unmeasuredPrs = row['unmeasuredPrs'];
  if (!isNonNegInt(prsMerged) || !isNonNegInt(verifiedLines) || !isNonNegInt(unmeasuredPrs)) return null;
  const jobsCompleted = row['jobsCompleted'];
  if (jobsCompleted !== null && !isNonNegInt(jobsCompleted)) return null;
  return { day: row['day'], repos: [...repos], prsMerged, verifiedLines, unmeasuredPrs, jobsCompleted };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

export interface PrDeltaFold {
  /** Distinct (day, repos) delta records retained — revisions collapse to their latest row. */
  rows: number;
  /** Of those, records reporting at least one merge the delta could not verify. */
  unverifiedRows: number;
  /** Distinct UTC days carrying unverified merges. */
  unverifiedDays: Set<string>;
  /** Total unmeasuredPrs across unverified records — the recurrence magnitude. */
  unmeasuredTotal: number;
  /** Total prsMerged across unverified records (context: the denominator the unverified share sits in). */
  mergedOnUnverifiedDays: number;
  /** Total verifiedLines across unverified records (context). */
  verifiedOnUnverifiedDays: number;
  /** Of the unverified records, how many had unmeasuredPrs === prsMerged (every merge that scope unverified). */
  allUnverifiedRows: number;
  /** Of the unverified records, how many had jobsCompleted === null (jobs.jsonl unreadable at record time). */
  jobsUnknownRows: number;
  /** Earliest and latest adverse day (YYYY-MM-DD). */
  firstDay: string | null;
  lastDay: string | null;
  /** Distinct repo labels across unverified rows, capped for the prompt. */
  repos: Set<string>;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
}

/**
 * Pure: fold journal text(s) — oldest first — into unverified-merge
 * evidence. The writer appends a revised row when a (day, repos) delta
 * changes, so records dedupe to the latest row per (day, repos) before
 * any counting — a recomputed day is scored once at its final numbers,
 * never summed across revisions. A record is adverse when its
 * unmeasuredPrs is positive; days dedupe through the set regardless of
 * how many repo-scopes reported them.
 */
export function foldPrDelta(texts: readonly string[]): PrDeltaFold {
  const latest = new Map<string, PrDeltaRow>();
  let malformed = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      const delta = projectDelta(parsed);
      if (delta === null) { malformed++; continue; }
      const key = `${delta.day}${JSON.stringify([...delta.repos].sort())}`;
      latest.set(key, delta);
    }
  }
  const fold: PrDeltaFold = {
    rows: latest.size, unverifiedRows: 0, unverifiedDays: new Set(), unmeasuredTotal: 0,
    mergedOnUnverifiedDays: 0, verifiedOnUnverifiedDays: 0, allUnverifiedRows: 0,
    jobsUnknownRows: 0, firstDay: null, lastDay: null, repos: new Set(), malformed,
  };
  for (const delta of latest.values()) {
    if (delta.unmeasuredPrs === 0) continue;
    fold.unverifiedRows += 1;
    fold.unverifiedDays.add(delta.day);
    fold.unmeasuredTotal += delta.unmeasuredPrs;
    fold.mergedOnUnverifiedDays += delta.prsMerged;
    fold.verifiedOnUnverifiedDays += delta.verifiedLines;
    if (delta.prsMerged > 0 && delta.unmeasuredPrs === delta.prsMerged) fold.allUnverifiedRows += 1;
    if (delta.jobsCompleted === null) fold.jobsUnknownRows += 1;
    fold.firstDay = fold.firstDay === null || delta.day < fold.firstDay ? delta.day : fold.firstDay;
    fold.lastDay = fold.lastDay === null || delta.day > fold.lastDay ? delta.day : fold.lastDay;
    for (const repo of delta.repos) fold.repos.add(repo);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface PrDeltaCell {
  kind: 'pr-delta-unmeasured';
  /** Distinct (day, repos) delta records retained in the tail. */
  rows: number;
  /** Records reporting at least one unverified merge. */
  unverifiedRows: number;
  /** Sorted distinct UTC days carrying unverified merges. */
  days: string[];
  /** Total merges the delta could not verify across those records. */
  unmeasuredTotal: number;
  /** Total merges recorded on those records (the unverified share's denominator). */
  mergedTotal: number;
  /** Total verified lines recorded on those records. */
  verifiedLines: number;
  /** Records where every recorded merge was unverified. */
  allUnverifiedRows: number;
  /** Records where jobsCompleted was the writer's jobs.jsonl-unreadable null. */
  jobsUnknownRows: number;
  /** Distinct repo count and a capped sample across the unverified records. */
  repos: number;
  repoSample: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * Pure: the recurring bars one cell must clear — unverified merges
 * across distinct UTC days, the fleet's RECURRING_FAILURES convention
 * applied to verification coverage. At most one cell exists: the
 * adverse condition is the delta's verification coverage itself, not
 * any per-repo or per-day attribute.
 */
export function prDeltaCells(
  fold: PrDeltaFold,
  opts: { lowerBound?: boolean } = {},
): PrDeltaCell[] {
  if (fold.unverifiedDays.size < PR_DELTA_MIN_DAYS || fold.unmeasuredTotal < PR_DELTA_MIN_UNMEASURED) return [];
  const sample = [...fold.repos].sort().slice(0, MAX_PROMPT_REPOS);
  return [{
    kind: 'pr-delta-unmeasured',
    rows: fold.rows,
    unverifiedRows: fold.unverifiedRows,
    days: [...fold.unverifiedDays].sort(),
    unmeasuredTotal: fold.unmeasuredTotal,
    mergedTotal: fold.mergedOnUnverifiedDays,
    verifiedLines: fold.verifiedOnUnverifiedDays,
    allUnverifiedRows: fold.allUnverifiedRows,
    jobsUnknownRows: fold.jobsUnknownRows,
    repos: fold.repos.size,
    repoSample: sample,
    firstSeen: fold.firstDay,
    lastSeen: fold.lastDay,
    lowerBound: opts.lowerBound === true,
  }];
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/pr-delta.jsonl under the fleet runs directory (<runsDir>/metrics/pr-delta.jsonl — $ASHLR_RUNS_DIR when set and non-empty, else ~/.ashlr-runs; defaultSnapshotRoot in src/cli/fleet-pr-snapshot.ts resolves the root and this feed treats an empty ASHLR_RUNS_DIR as unset rather than reading a cwd-relative path the way the producer\'s ?? fallback technically would). `phm fleet pr-leverage --record-delta` appends one fleet.delta.v1 record per changed (day, repos) delta — {day, repos, prsMerged, verifiedLines, unmeasuredPrs, jobsCompleted} built by rankPrLeverage in src/core/fleet/pr-leverage.ts over the open-PR snapshot and the jobs ledger. unmeasuredPrs counts that day\'s merges the leverage computation could not verify: no clean checkState or no additions/deletions in the snapshot. Nothing schedules --record-delta, so the journal only exists where someone ran it; its only reader until this feed was the writer\'s own dedupe scan.';

const REPRO = 'Reproduce the fold by reading <runsDir>/metrics/pr-delta.jsonl directly and keeping lines that parse as {schema:\'fleet.delta.v1\', day:\'YYYY-MM-DD\', repos:[...], prsMerged, verifiedLines, unmeasuredPrs, jobsCompleted}, then counting distinct UTC days whose unmeasuredPrs is positive and summing it. The writer and delta shape this repository owns are src/cli/fleet-pr-leverage.ts (--record-delta, the dedupe append) and src/core/fleet/pr-leverage.ts (rankPrLeverage\'s fleet.delta.v1 block: measured = merged PRs with clean checkState and non-null additions/deletions; unmeasuredPrs = daily.merges.total - measured.length; jobsCompleted = null when jobs.jsonl was unreadable).';

const NO_CHANGE = 'If the journal is absent or small on the next read, --record-delta simply was not run again — the recurrence was a bounded recording window, not a standing gap; if the snapshot now carries clean checkState and diff stats for the merges it reports, the unverified share was a transient capture gap that has since closed; if the merges were legitimately outside the fleet\'s own pipeline (community PRs the snapshot never claimed to verify), the unmeasured count reflects coverage scope rather than a defect. In each case report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: PrDeltaCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Earliest unverified day recorded ${cell.firstSeen}.`
    : ` Unverified days recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: PrDeltaCell): string =>
  cell.lowerBound ? ' The bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full journal.' : '';

function prDeltaPrompt(cell: PrDeltaCell): string {
  const share = cell.mergedTotal > 0 ? Math.round((cell.unmeasuredTotal / cell.mergedTotal) * 100) : null;
  const shareText = share === null ? '' : ` That is ${share}% of the ${cell.mergedTotal} merges those days recorded.`;
  const allText = cell.allUnverifiedRows > 0 ? ` ${cell.allUnverifiedRows} of the ${cell.unverifiedRows} unverified record(s) had every recorded merge unverified.` : '';
  const jobsText = cell.jobsUnknownRows > 0 ? ` ${cell.jobsUnknownRows} record(s) recorded jobsCompleted:null — jobs.jsonl was unreadable when that delta ran, so merge-to-job attribution was already unknown.` : '';
  const repoText = cell.repos > 0
    ? ` ${cell.repos} distinct repo(s) appear${cell.repoSample.length > 0 ? ` (${cell.repoSample.join(', ')})` : ''}.`
    : '';
  const detail = [
    'Phantom\'s PR-leverage delta journal keeps reporting merges it cannot verify',
    '',
    `${cell.unmeasuredTotal} merged PR(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) went unverified in the fleet.delta.v1 records of <runsDir>/metrics/pr-delta.jsonl — the self-improvement work this backlog exists for.`,
    '',
    `Each record is one recorded (day, repos) leverage delta at its latest revision: prsMerged merges, of which unmeasuredPrs lacked the clean checkState or the additions/deletions the delta needs to score them, and verifiedLines summed only over the merges it could verify. ${cell.unverifiedRows} record(s) carried unmeasuredPrs>0 out of ${cell.rows} retained.${shareText}${allText}${jobsText}${repoText}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    'Find why merged PRs keep landing without the verification the delta needs: check whether the open-PR snapshot (fleet/open-prs.json via the --input/--jobs flags) carries additions/deletions and checkState for the merges it reports, whether merges from outside the fleet\'s own pipeline legitimately sit outside what the snapshot verifies (community PRs are expected coverage scope, not defects), and whether jobs.jsonl finish records are complete enough that jobsCompleted is meaningful. Fix what lives here — the snapshot capture in src/cli/fleet-pr-snapshot.ts, the delta computation in src/core/fleet/pr-leverage.ts, or the --record-delta invocation that produces the journal — not the symptom. If the unverified share is one stubborn repo or one snapshot gap, name it; if it is fleet-wide, the verification path itself is the work.',
    '',
    NO_CHANGE,
    '',
    REPRO,
  ];
  return detail.join('\n');
}

function prDeltaTitle(): string {
  return 'PR-leverage deltas keep reporting unverified merges'.slice(0, MAX_TITLE_CHARS);
}

function prDeltaItem(cell: PrDeltaCell, repo: string): CloudBacklogItem {
  return {
    id: `pr-delta-${sha('pr-delta-unmeasured')}`,
    title: prDeltaTitle(),
    prompt: prDeltaPrompt(cell),
    area: 'fleet-metrics',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the PR-leverage delta journal's recurring
 * unverified-merge evidence. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function prDeltaBacklogItems(opts: PrDeltaItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(homedir(), '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, 'metrics', 'pr-delta.jsonl');
    const read = await readLedgerTail(journalPath, PR_DELTA_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // Each record is a recorded (day, repos) delta, not pending state:
    // the tail's truncated flag bounds how far back the recurrence can
    // see, so a cut tail is stated as a lower bound on the retained
    // window.
    const fold = foldPrDelta([read.text]);
    const cells = prDeltaCells(fold, { lowerBound: read.truncated });
    const limit = Math.max(1, Math.min(opts.limit ?? PR_DELTA_BACKLOG_MAX_ITEMS, PR_DELTA_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => prDeltaItem(cell, repo));
  } catch {
    return [];
  }
}
