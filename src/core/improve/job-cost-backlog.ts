/**
 * <runs>/metrics/job-cost-model.jsonl per-run cost verdicts →
 * self-improvement backlog items.
 *
 * Engineering Ops' growth export (growth_exports.py `run_cost`, the same
 * pass that writes growth-cost-hourly.jsonl — docs/GROWTH.md) rewrites
 * this file atomically every export cycle over a 35-day retention,
 * sorted by finish time. Each `ashlr.job-cost-model/v1` row is the
 * export's per-run cost verdict for one jobs.jsonl finish receipt (plus
 * api-spend rows that never joined a finish):
 *
 *   { schema, job, lane, ts, realSpendUsd, modeledValueUsd, method,
 *     inputs, source, confidence, reason }
 *
 * `realSpendUsd` carries verified metered spend joined from
 * api-spend.jsonl; `modeledValueUsd` carries the modeled value of
 * subscription/token lanes (list-price, input-rate or window-share-x-
 * plan-price methods, each with its own confidence). When neither value
 * exists the row still records WHY the run's cost stayed unknowable —
 * the closed reason strings name the missing evidence (no tokens per
 * job, no list price for the model, no usage-reading series, no
 * verified plan price, no ACU figure).
 *
 * Until now the journal had no repository reader at all: the export's
 * own growth-exports-status.json summarizes per-lane modeled totals,
 * and the sibling growth series feed growthBacklogItems — but the
 * per-run verdicts themselves were write-only. A lane whose finishes
 * keep landing unpriced — the fleet's largest lanes included — looked
 * like ordinary absent data: every downstream cost figure simply
 * stayed null. jobCostBacklogItems carries the journal into
 * discoverBacklog:
 *
 *  - cost-gap cells per lane: in-window finish rows where BOTH cost
 *    values are null, recurring at the fleet's bars — enough rows,
 *    across enough distinct UTC days, and a large enough share of the
 *    lane's finishes that the gap is systematic rather than occasional
 *    missing telemetry. The prompt quotes the lane's recorded reasons
 *    verbatim — the export's own account of what evidence is missing —
 *    so a structural unknown (a local model's power-only cost, a
 *    provider with no per-unit price) reads as such instead of being
 *    re-litigated.
 *  - an unmatched-spend cell: `real-spend-unmatched` rows — verified
 *    api-spend figures whose job never produced a finish row the join
 *    could attach to — recurring across days. Orphaned spend evidence
 *    means either finish receipts are being lost or the spend join's
 *    window is missing real runs.
 *  - a corrupt-lines cell: lines failing the writer's row contract —
 *    torn writes, foreign appends, schema drift — once they recur
 *    inside the retained tail.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail at JOB_COST_TAIL_BYTES; nothing is written
 *    and no network is touched. The file is rewritten atomically each
 *    export pass, so the open descriptor pins one consistent snapshot.
 *    A missing, unreadable or non-file journal yields no items — a
 *    clean empty source, never a guessed tally.
 *  - Rows count only under the writer's contract, re-validated field by
 *    field: the schema literal, bounded job/lane identifiers, a
 *    parseable ts, null-or-finite cost values, the closed method and
 *    confidence vocabularies, a record inputs block, and nullable
 *    source/reason strings — all eleven keys the writer always emits.
 *    Malformed lines and off-contract rows are counted, never guessed.
 *  - The export emits one row per jobs.jsonl finish receipt, so
 *    duplicate finish receipts in the source ledger surface as
 *    identical rows; exact-line replays dedupe to one recorded verdict,
 *    matching the sibling folds' replay rule.
 *  - The journal is sorted by finish time, so the bounded tail holds
 *    the newest rows; a truncated tail is stated as a lower bound in
 *    every prompt, never read as the full window.
 *  - Rows window on their finish timestamp `ts` inside the 7-day
 *    window plus the sibling folds' future-skew tolerance; rows whose
 *    ts does not parse or lands outside are context, never cells.
 *  - Unpriced means no recorded value, not zero cost: a row counts
 *    toward a lane's gap only when realSpendUsd AND modeledValueUsd
 *    are both null — a real zero would be a recorded figure, and the
 *    writer never emits one for an unmeasured run.
 *  - `real-spend-unmatched` rows are spend evidence without a finish,
 *    not finishes: they never join a lane's finish totals and tally
 *    only in the unmatched cell.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's lanes. Dedup is downstream: item ids hash the cell
 *    identity, never counts or timestamps, so a refresh re-derives the
 *    same ids and a recovered lane simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are per-lane gaps plus the two file-level ones. */
export const JOB_COST_BACKLOG_MAX_ITEMS = 8;
const JOB_COST_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const JOB_COST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** ±1-minute future skew, the sibling folds' clock-drift tolerance on ledger timestamps. */
const JOB_COST_FUTURE_SKEW_MS = 60_000;
/**
 * A lane's cost-gap cell emits only at this many unpriced finishes
 * inside the window — about one a day, the recurring bar applied to
 * per-run verdicts rather than failure events.
 */
export const JOB_COST_MIN_UNPRICED = 8;
/** ...recorded across at least this many distinct UTC days. */
export const JOB_COST_MIN_UNPRICED_DAYS = 2;
/**
 * ...and only when unpriced finishes are at least this share of the
 * lane's in-window finishes — a mostly-priced lane with occasional
 * missing telemetry is noise, not a systematic gap.
 */
export const JOB_COST_MIN_UNPRICED_SHARE = 0.25;
/** Unmatched-spend rows a cell needs inside the window. */
export const JOB_COST_MIN_UNMATCHED = 3;
/** ...recorded across at least this many distinct UTC days. */
export const JOB_COST_MIN_UNMATCHED_DAYS = 2;
/** Contract-failing lines the corrupt-lines cell needs inside the retained tail. */
export const JOB_COST_MIN_CORRUPT = 3;
/**
 * Bounded tail of the export file. The journal is ts-ascending and
 * holds ~35 days of finishes (~10 MiB at current fleet volume); 8 MiB
 * retains well over the 7-day window, and a truncated tail is stated
 * as a lower bound rather than silently read as complete.
 */
export const JOB_COST_TAIL_BYTES = 8 * 1024 * 1024;
/** The fleet's own repository label: cost evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Job ids name log files; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Lane ids join in the producer's bounded identifier shape. */
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The writer's schema literal (growth_exports.py run_cost). */
const JOB_COST_SCHEMA = 'ashlr.job-cost-model/v1';
/** The writer's method vocabulary; null survives only as the row's initial value. */
const JOB_COST_METHODS = new Set([
  'real-spend',
  'real-spend-unmatched',
  'tokens-x-list-price',
  'tokens-x-list-input-rate',
  'window-share-x-plan-price',
  'none',
]);
/** The writer's confidence vocabulary. */
const JOB_COST_CONFIDENCE = new Set(['high', 'medium', 'low']);
/** The eleven keys the writer always emits on every row. */
const JOB_COST_KEYS = [
  'schema', 'job', 'lane', 'ts', 'realSpendUsd', 'modeledValueUsd',
  'method', 'inputs', 'source', 'confidence', 'reason',
] as const;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; reasons quote scrubbed and capped. */
const MAX_REASON_CHARS = 160;
/** Lane/reason tallies quoted inside one prompt. */
const MAX_PROMPT_REASONS = 3;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface JobCostItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal override (default: <runsDir>/metrics/job-cost-model.jsonl). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default JOB_COST_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default JOB_COST_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** One validated journal row, reduced to what the fold counts and quotes. */
export interface JobCostRow {
  job: string;
  lane: string;
  /** Window position: the finish (or unmatched spend) timestamp. */
  atMs: number;
  utcDay: string;
  /** realSpendUsd or modeledValueUsd recorded a finite figure. */
  priced: boolean;
  /** method === 'real-spend-unmatched' — spend evidence with no finish to join. */
  unmatchedSpend: boolean;
  realSpendUsd: number | null;
  modeledValueUsd: number | null;
  method: string | null;
  /** The writer's recorded reason the cost stayed unknowable, when it wrote one. */
  reason: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** null-or-finite check that also rejects absent keys via the caller's hasOwnProperty gate. */
const nullOrFinite = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value));

const nullOrString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

/**
 * Pure: validate one parsed journal line against the writer's row
 * contract — run_cost emits the fixed eleven-key shape with the schema
 * literal, bounded job/lane identifiers, a parseable ts, null-or-finite
 * cost values, the closed method/confidence vocabularies, a record
 * inputs block and nullable source/reason strings. Extra keys are
 * ignored for forward compatibility; anything else is not a journal
 * row. `priced` derives from the recorded values, never the method
 * label — a 'real-spend' row whose join found no verified spend row
 * carries a reason instead of a figure and counts as unpriced.
 */
export function parseJobCostJournalEntry(value: unknown): JobCostRow | null {
  if (!isRecord(value)) return null;
  for (const key of JOB_COST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
  }
  if (value['schema'] !== JOB_COST_SCHEMA) return null;
  const job = value['job'];
  if (typeof job !== 'string' || !SAFE_JOB_ID.test(job)) return null;
  const lane = value['lane'];
  if (typeof lane !== 'string' || !LANE_ID.test(lane)) return null;
  const ts = value['ts'];
  if (typeof ts !== 'string') return null;
  const atMs = Date.parse(ts);
  if (!Number.isFinite(atMs)) return null;
  const realSpendUsd = value['realSpendUsd'];
  const modeledValueUsd = value['modeledValueUsd'];
  if (!nullOrFinite(realSpendUsd) || !nullOrFinite(modeledValueUsd)) return null;
  const method = value['method'];
  if (method !== null && (typeof method !== 'string' || !JOB_COST_METHODS.has(method))) return null;
  if (!isRecord(value['inputs'])) return null;
  const source = value['source'];
  const reason = value['reason'];
  if (!nullOrString(source) || !nullOrString(reason)) return null;
  const confidence = value['confidence'];
  if (confidence !== null && (typeof confidence !== 'string' || !JOB_COST_CONFIDENCE.has(confidence))) return null;
  return {
    job,
    lane,
    atMs,
    utcDay: utcDayOf(atMs),
    priced: realSpendUsd !== null || modeledValueUsd !== null,
    unmatchedSpend: method === 'real-spend-unmatched',
    realSpendUsd,
    modeledValueUsd,
    method: method as string | null,
    reason,
  };
}

/**
 * Pure: parse one journal file's text into deduped validated rows plus
 * the count of lines that were not on-contract records — malformed JSON
 * and off-contract rows are counted, never guessed. Dedup is by exact
 * line content: the writer serializes canonically, so identical rows
 * are the same recorded verdict surfaced twice when jobs.jsonl carries
 * duplicate finish receipts; replays count once at their first
 * retained position.
 */
export function parseJobCostJournal(text: string): {
  rows: JobCostRow[];
  invalidRows: number;
  replayedRows: number;
} {
  const seen = new Set<string>();
  const rows: JobCostRow[] = [];
  let invalidRows = 0;
  let replayedRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (seen.has(trimmed)) { replayedRows += 1; continue; }
    seen.add(trimmed);
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseJobCostJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows, replayedRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-lane finish tallies inside the window. */
export interface JobCostLaneCell {
  lane: string;
  /** In-window finish rows (unmatched spend rows excluded). */
  finishes: number;
  /** Finishes with neither cost value recorded. */
  unpriced: number;
  /** Priced finishes, for the prompt's coverage context. */
  priced: number;
  /** Distinct UTC days the unpriced finishes were recorded on. */
  unpricedDays: Set<string>;
  /** Recorded reasons on unpriced rows, most frequent first. */
  reasons: Map<string, number>;
  /** First/last unpriced finish timestamps — Infinity/-Infinity until one lands. */
  firstMs: number;
  lastMs: number;
}

/** In-window `real-spend-unmatched` evidence: spend that never joined a finish. */
export interface JobCostUnmatched {
  rows: number;
  /** Summed recorded realSpendUsd across those rows (finite figures only). */
  usd: number;
  days: Set<string>;
  lanes: Set<string>;
  firstMs: number;
  lastMs: number;
}

export interface JobCostFold {
  /** In-window finish rows across all lanes — the share denominator. */
  finishes: number;
  /** In-window finish rows carrying at least one cost value. */
  pricedFinishes: number;
  lanes: Map<string, JobCostLaneCell>;
  unmatched: JobCostUnmatched | null;
  /** On-contract rows outside the window. */
  outsideWindow: number;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** Exact-line replay rows collapsed by dedup — context only. */
  replayedRows: number;
}

const emptyUnmatched = (): JobCostUnmatched => ({
  rows: 0, usd: 0, days: new Set(), lanes: new Set(), firstMs: Infinity, lastMs: -Infinity,
});

/**
 * Pure: fold journal text into the cost-verdict evidence. Only rows
 * whose ts lands inside the window join cells; `real-spend-unmatched`
 * rows tally separately since they are spend evidence without a
 * finish, never lane finishes.
 */
export function foldJobCostRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): JobCostFold {
  const parsed = parseJobCostJournal(text);
  const fold: JobCostFold = {
    finishes: 0, pricedFinishes: 0, lanes: new Map(), unmatched: null,
    outsideWindow: 0, invalidRows: parsed.invalidRows, replayedRows: parsed.replayedRows,
  };
  const windowMs = opts.windowMs ?? JOB_COST_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + JOB_COST_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    if (row.unmatchedSpend) {
      const u = fold.unmatched ?? (fold.unmatched = emptyUnmatched());
      u.rows += 1;
      u.usd += row.realSpendUsd ?? 0;
      u.days.add(row.utcDay);
      u.lanes.add(row.lane);
      u.firstMs = Math.min(u.firstMs, row.atMs);
      u.lastMs = Math.max(u.lastMs, row.atMs);
      continue;
    }
    fold.finishes += 1;
    if (row.priced) fold.pricedFinishes += 1;
    let cell = fold.lanes.get(row.lane);
    if (cell === undefined) {
      cell = {
        lane: row.lane, finishes: 0, unpriced: 0, priced: 0,
        unpricedDays: new Set(), reasons: new Map(), firstMs: Infinity, lastMs: -Infinity,
      };
      fold.lanes.set(row.lane, cell);
    }
    cell.finishes += 1;
    if (row.priced) {
      cell.priced += 1;
    } else {
      cell.unpriced += 1;
      cell.unpricedDays.add(row.utcDay);
      cell.firstMs = Math.min(cell.firstMs, row.atMs);
      cell.lastMs = Math.max(cell.lastMs, row.atMs);
      if (row.reason !== null) cell.reasons.set(row.reason, (cell.reasons.get(row.reason) ?? 0) + 1);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface JobCostGapCell {
  kind: 'cost-gap';
  lane: string;
  /** In-window finish rows for the lane. */
  finishes: number;
  /** Of those, finishes with neither cost value recorded. */
  unpriced: number;
  /** unpriced / finishes, rounded to 3 decimals. */
  share: number;
  /** Sorted distinct UTC days the unpriced finishes span. */
  days: string[];
  /** The lane's top recorded unpriced reasons, most frequent first. */
  reasons: { reason: string; rows: number }[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

export interface JobCostUnmatchedCell {
  kind: 'unmatched-spend';
  rows: number;
  /** Summed recorded spend USD across the rows, rounded to 6 decimals. */
  usd: number;
  days: string[];
  lanes: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface JobCostCorruptCell {
  kind: 'corrupt-lines';
  invalidRows: number;
  lowerBound: boolean;
}

export type JobCostCell = JobCostGapCell | JobCostUnmatchedCell | JobCostCorruptCell;

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Scrub and bound one recorded reason for quoting inside a prompt. */
const reasonText = (reason: string): string => {
  const flat = scrubSecrets(reason).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
};

/**
 * Pure: the emittable cells — per-lane cost gaps at the row/day/share
 * bars, the unmatched-spend cell at its own bars, and corrupt-lines at
 * the contract-failure bar. Gap cells sort by unpriced count, then lane,
 * for a stable order.
 */
export function jobCostCells(fold: JobCostFold, lowerBound = false): JobCostCell[] {
  const cells: JobCostCell[] = [];
  const gaps: JobCostGapCell[] = [];
  for (const cell of fold.lanes.values()) {
    if (cell.unpriced < JOB_COST_MIN_UNPRICED) continue;
    if (cell.unpricedDays.size < JOB_COST_MIN_UNPRICED_DAYS) continue;
    if (cell.finishes === 0 || cell.unpriced / cell.finishes < JOB_COST_MIN_UNPRICED_SHARE) continue;
    const reasons = [...cell.reasons.entries()]
      .map(([reason, rows]) => ({ reason: reasonText(reason), rows }))
      .sort((a, b) => b.rows - a.rows || a.reason.localeCompare(b.reason))
      .slice(0, MAX_PROMPT_REASONS);
    gaps.push({
      kind: 'cost-gap',
      lane: cell.lane,
      finishes: cell.finishes,
      unpriced: cell.unpriced,
      share: Math.round((cell.unpriced / cell.finishes) * 1000) / 1000,
      days: [...cell.unpricedDays].sort(),
      reasons,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  gaps.sort((a, b) => b.unpriced - a.unpriced || a.lane.localeCompare(b.lane));
  cells.push(...gaps);

  const u = fold.unmatched;
  if (u !== null && u.rows >= JOB_COST_MIN_UNMATCHED && u.days.size >= JOB_COST_MIN_UNMATCHED_DAYS) {
    cells.push({
      kind: 'unmatched-spend',
      rows: u.rows,
      usd: Math.round(u.usd * 1e6) / 1e6,
      days: [...u.days].sort(),
      lanes: [...u.lanes].sort(),
      firstSeen: isoOrNull(u.firstMs),
      lastSeen: isoOrNull(u.lastMs),
      lowerBound,
    });
  }

  if (fold.invalidRows >= JOB_COST_MIN_CORRUPT) {
    cells.push({ kind: 'corrupt-lines', invalidRows: fold.invalidRows, lowerBound });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs>/metrics/job-cost-model.jsonl (ASHLR_RUNS_DIR or ~/.ashlr-runs) — one ashlr.job-cost-model/v1 row per jobs.jsonl finish the Engineering Ops growth export prices each cycle (growth_exports.py run_cost; docs/GROWTH.md): realSpendUsd for metered lanes joined to api-spend.jsonl, modeledValueUsd for token-priced lanes under the list-price, input-rate or window-share-x-plan-price methods, and a recorded reason when the run\'s cost stayed unknowable. The file is atomically rewritten over a 35-day retention, sorted by finish time; this fold reads the newest bounded tail through readLedgerTail and re-validates the writer\'s eleven-key row contract. Until this feed the journal had no repository reader — the export\'s own growth-exports-status.json only summarizes per-lane modeled totals — so lanes whose finishes keep landing unpriced never became work.';

const REPRO = 'Reproduce the fold by reading <runs>/metrics/job-cost-model.jsonl directly, keeping on-contract ashlr.job-cost-model/v1 rows whose ts lands inside the window, deduped by exact line, split into finish rows and real-spend-unmatched rows, grouped per lane, and treating lines failing the contract as counted invalid evidence. The writer is Engineering Ops\' growth_exports.py run_cost — outside this repository — while the finish-row usage fields it prices (tokens_total/acus/usage_source/usage_missing) are written by this install\'s dispatcher usage capture.';

const NO_CHANGE = 'If the window has rolled forward, the lane\'s unpriced finishes were a transient capture outage that already recovered, the recorded reason is structural — the lane has no per-job cost by design (local hardware power-only, a provider with no per-unit price, a plan whose quota share cannot be attributed) — the missing input lives export-side in Engineering Ops\' price table, plan prices or usage series, or this checkout is not the fleet install the journal describes — report no-change and name the evidence.';

const WINDOW_DAYS = Math.round(JOB_COST_WINDOW_MS / 86_400_000);

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

const boundText = (lowerBound: boolean): string =>
  lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (share: number): string => `${Math.round(share * 100)}%`;

function jobCostGapPrompt(cell: JobCostGapCell): string {
  const reasons = cell.reasons.length === 0
    ? 'The unpriced rows recorded no reason.'
    : ` Recorded reasons, most frequent first: ${cell.reasons.map((r) => `"${r.reason}" (${r.rows})`).join('; ')}.`;
  return [
    `Phantom's per-run cost model keeps recording finishes it cannot price — lane '${cell.lane}' has ${cell.unpriced} of ${cell.finishes} in-window finish verdicts (${shareText(cell.share)}) carrying neither realSpendUsd nor modeledValueUsd across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Every ashlr.job-cost-model/v1 row is the export's verdict on one jobs.jsonl finish: verified metered spend, a modeled token/plan value, or an honest unknown with the reason it stayed unknowable. A lane whose finishes keep landing unpriced means the fleet's cost-per-run evidence has a systematic hole — cost-per-merge figures built on this journal undercount that lane's true spend share, and any routing or budgeting that reads cost coverage sees a lane that looks free because its cost was never measured.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    reasons,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the finish-row usage evidence the verdicts price — jobs.jsonl finish rows' tokens_total/acus/usage_source/usage_missing fields written by the dispatcher usage capture (contrib/mac/dispatchd.py job_usage; usage-gap-backlog already files recurring usage_missing labels), the usage readings and plan-price inputs the window-share method joins (src/core/usage/**), and the growth reader dialect (src/core/growth/read.ts). The price table, verified plan prices, the usage-reading series and the export pass itself are Engineering Ops outside this repository. Check which side the recorded reason points to before changing anything — a missing tokens_total on finish rows is a capture gap this fleet can close; a lane with no per-job usage by design is an honest unknown. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function jobCostUnmatchedPrompt(cell: JobCostUnmatchedCell): string {
  const usdText = cell.usd === 0 ? 'no recorded spend total' : `a recorded spend total of $${cell.usd.toFixed(2)}`;
  return [
    `Phantom's per-run cost model keeps recording metered spend it cannot attribute — ${cell.rows} real-spend-unmatched row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, ${usdText}, on lane(s) ${cell.lanes.join(', ')}, the self-improvement work this backlog exists for.`,
    '',
    `A real-spend-unmatched row is a verified api-spend.jsonl figure (total_cost_usd, cost_estimated false) whose job produced no finish receipt the export's join could attach within its slack — spend the fleet paid for that no per-run cost verdict accounts. Orphaned spend recurring across days means either finish receipts are being lost before the export reads them, jobs are spending without reaching a finish boundary, or the join window itself is missing real runs. Whichever it is, the cost model's real-spend coverage has a hole exactly where metered spend is concerned.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the jobs.jsonl finish lifecycle the join depends on — finish receipts and their timestamps under the dispatcher's finish path, the api-spend.jsonl producer's job labels, and the usage-gap evidence already filed for missing usage fields. The export's join rule itself (first finish at or after the spend row, 60-second slack) is Engineering Ops outside this repository. Check whether the orphaned jobs have finish receipts at all — a job that spends but never finishes is a different defect than a join that misses an existing finish. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function jobCostCorruptPrompt(invalidRows: number): string {
  return [
    `Phantom's per-run cost model journal keeps accumulating rows its own contract cannot trust — ${invalidRows} line(s) failing the ashlr.job-cost-model/v1 row shape inside the retained tail, the self-improvement work this backlog exists for.`,
    '',
    `The export rewrites the file atomically each pass, so contract-failing lines mean either a torn write the atomic rename did not prevent, a foreign or hand edit appended after the export's own rows, or schema drift between the writer's eleven-key row shape and what this fold validates. Recurring contract failures mean the cost-verdict evidence stream itself is degrading — lanes' priced/unpriced tallies built on it undercount whatever the bad lines carried.`,
    '',
    EVIDENCE,
    '',
    `Find what keeps writing contract-failing rows to <runs>/metrics/job-cost-model.jsonl: check for foreign appends or hand edits (the writer owns the whole file each pass — anything it did not write is suspect), schema drift between growth_exports.py's row shape and the validated contract, and encoding damage. If the failures are a single torn tail line from one interrupted write, report no-change — the next export pass rewrites the file clean. The writer is Engineering Ops outside this repository; this repository owns only the read-side contract.`,
    '',
    `If the window has rolled forward, the retained tail now parses clean, the corrupt rows were a one-off torn write already superseded by the next export pass, or this checkout is not the fleet install the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function jobCostItem(cell: JobCostCell, repo: string): CloudBacklogItem {
  const hash = createHash('sha256').update(`job-cost:${repo.trim().toLowerCase()}`).digest('hex').slice(0, 16);
  if (cell.kind === 'cost-gap') {
    return {
      id: `job-cost-gap-${cell.lane}-${hash}`,
      title: `Job cost model: lane '${cell.lane}' keeps finishing unpriced`.slice(0, MAX_TITLE_CHARS),
      prompt: jobCostGapPrompt(cell),
      area: 'job-cost-model',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    };
  }
  if (cell.kind === 'unmatched-spend') {
    return {
      id: `job-cost-unmatched-spend-${hash}`,
      title: 'Job cost model: metered spend keeps missing its finish'.slice(0, MAX_TITLE_CHARS),
      prompt: jobCostUnmatchedPrompt(cell),
      area: 'job-cost-model',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    };
  }
  return {
    id: `job-cost-corrupt-${hash}`,
    title: 'Job cost model: journal rows keep failing the row contract'.slice(0, MAX_TITLE_CHARS),
    prompt: jobCostCorruptPrompt(cell.invalidRows),
    area: 'job-cost-model',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the job-cost-model journal's recurring unpriced
 * lanes, orphaned spend and contract failures. Total: a missing,
 * unreadable or non-file journal, another repository, or any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function jobCostBacklogItems(opts: JobCostItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || (repo.split('/').pop() ?? repo).trim().toLowerCase() !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : JOB_COST_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling growth fold applies: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, 'metrics', 'job-cost-model.jsonl');
    const read = await readLedgerTail(journalPath, JOB_COST_TAIL_BYTES);
    // Healthy-only evidence bar: a missing, unreadable or non-file
    // journal is unknown, never a guessed tally — the same rule the
    // sibling sources apply to their own degraded corpora.
    if (read.state !== 'read' || read.text.trim() === '') return [];
    const fold = foldJobCostRows(read.text, { nowMs, windowMs });
    if (fold.finishes === 0 && fold.unmatched === null && fold.invalidRows < JOB_COST_MIN_CORRUPT) return [];
    const cells = jobCostCells(fold, read.truncated);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_COST_BACKLOG_MAX_ITEMS, JOB_COST_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => jobCostItem(cell, repo));
  } catch {
    return [];
  }
}
