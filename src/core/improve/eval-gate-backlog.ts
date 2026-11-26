/**
 * Learn eval-gate decision journal recurring adverse gate evidence →
 * self-improvement backlog items.
 *
 * promoteWithEval (src/core/learn/eval-gate.ts) is the paired, held-out
 * evaluation gate every authorized learning change passes through before
 * it applies: the caller supplies a candidate (kind 'prior', 'prompt' or
 * 'playbook'), the active baseline, the held-out task set and a trusted
 * side-effect-free replay scorer, and the gate replays every task in both
 * arms. A candidate that shows any regression is rejected; a clean sweep
 * is checkpointed as an 'evaluated' row BEFORE apply runs exactly once,
 * then closes as 'promoted' or 'rejected'. Every decision appends one
 * metadata-only row — {at, candidateId, kind, status, reason, pairs} —
 * to learn/eval-gate.jsonl under the learn home (~/.ashlr/learn, the
 * writer's learnDir() resolution, ASHLR_HOME-independent), candidate and
 * task ids scrubbed and capped, never candidate contents, task inputs or
 * errors.
 *
 * Until now the journal's only reader was the writer's own test suite —
 * a write-only audit. A gate path that kept failing never became work:
 * replay scorers that threw on every candidate, apply callbacks that
 * threw or refused stale base revisions, callers that never supplied
 * usable eval inputs, and decisions that checkpointed 'evaluated' and
 * never recorded a terminal row (a crash or hang between the checkpoint
 * and the closing record — the applied-or-not outcome stays unknown)
 * all looked like quiet audit lines, never work.
 *
 * evalGateBacklogItems carries the same rows into discoverBacklog: the
 * recurring adverse cells become one item each once they reach the
 * bars.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail (ROUTER_OUTCOME_LEDGER_LIMIT — the same
 *    bound the sibling feeds apply); nothing is written and no network
 *    is touched. A missing journal is a clean empty source — the
 *    writer creates it lazily on the first recorded decision; an
 *    unreadable or non-file one yields no items rather than folding
 *    partial evidence, and a truncated tail folds lower-bound flagged.
 *  - Rows count only under the writer's own contract: a record object
 *    with a parseable `at`, a non-empty candidateId within the writer's
 *    200-char cap, a known kind, a known status, a known reason and a
 *    pairs array of {taskId, baseline, candidate} score rows. Malformed
 *    lines are counted, never guessed; future-stamped rows beyond the
 *    skew allowance and rows outside the window contribute nothing.
 *  - 'regression' rejections and 'promoted' rows are context, never
 *    cells: a measured regression is the gate working as designed and a
 *    promotion is its success — tallying them keeps the prompts honest
 *    about how much of the journal is the gate doing its job.
 *  - 'evaluated' rows are checkpoints, not decisions: one is unresolved
 *    only when no LATER row for the same candidateId recorded a terminal
 *    status — a same-id retry that later promoted or rejected resolves
 *    every earlier checkpoint, while two crashed attempts stay two
 *    unresolved rows. A checkpoint younger than the grace window may
 *    still be mid-apply, so it never counts.
 *  - Recurring means recorded across days: a cell emits only at
 *    EVAL_GATE_MIN_ADVERSE adverse rows inside the window AND
 *    EVAL_GATE_MIN_DAYS distinct UTC days — one flaky scorer run or one
 *    crashed promotion never queues a session.
 *  - Fleet machinery only: the journal carries no repository column —
 *    every promoteWithEval call site is this install's own learning
 *    pipeline — so items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling feeds
 *    apply. Dedup is downstream: the item id hashes the bucket and the
 *    repository identity, never the counts or timestamps, so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; a gate that stops accruing adverse rows simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { learnDir } from '../config.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the bucket set is closed at four. */
export const EVAL_GATE_BACKLOG_MAX_ITEMS = 4;
const EVAL_GATE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const EVAL_GATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on journal timestamps, same convention the sibling folds apply. */
const EVAL_GATE_FUTURE_SKEW_MS = 60_000;
/**
 * An 'evaluated' checkpoint younger than this may still be mid-apply —
 * apply() is caller-supplied but contractually an atomic local compare
 * and persist, so an hour of silence after the checkpoint means the
 * decision never closed, not that it is slow.
 */
export const EVAL_GATE_UNRESOLVED_GRACE_MS = 60 * 60 * 1000;
/** Adverse rows one bucket needs before it counts as recurring. */
export const EVAL_GATE_MIN_ADVERSE = 3;
/** Distinct UTC days the adverse rows must span — recurring means recorded across days. */
export const EVAL_GATE_MIN_DAYS = 2;
/** The fleet's own repository label: gate evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded candidate ids are unbounded text; flatten, scrub and cap before use. */
const MAX_FIELD_CHARS = 96;
/** Journal-recorded candidate and task ids are capped at 200 chars by the writer. */
const MAX_LEDGER_ID_CHARS = 200;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Candidate ids quoted inside one unresolved prompt before the remainder is summarized. */
const MAX_PROMPT_IDS = 5;

const EVAL_GATE_KINDS = new Set(['prior', 'prompt', 'playbook']);
const EVAL_GATE_STATUSES = new Set(['rejected', 'promoted', 'evaluated']);
const EVAL_GATE_REASONS = new Set([
  'missing-data',
  'invalid-data',
  'evaluation-failed',
  'regression',
  'stale-baseline',
  'apply-failed',
  'no-regression',
]);

/** The adverse cells the fold emits, one item each at the recurring bars. */
export type EvalGateBucket = 'scorer' | 'apply' | 'input' | 'unresolved';

const BUCKET_OF_REASON: Record<string, EvalGateBucket> = {
  'evaluation-failed': 'scorer',
  'apply-failed': 'apply',
  'stale-baseline': 'apply',
  'missing-data': 'input',
  'invalid-data': 'input',
};

export interface EvalGateItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Evidence window in ms (default EVAL_GATE_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default EVAL_GATE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the unresolved grace (default: now, ms epoch). */
  now?: number;
  /** Journal override (default: <learnDir()>/eval-gate.jsonl — the writer's own resolution). */
  evalGatePath?: string;
  /**
   * Injected journal text (tests); skips the journal read when set —
   * null means missing, matching the read's own 'missing' state.
   */
  evalGateText?: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded ids and kinds are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------
// Fold — one pass over the journal's rows
// ---------------------------------------------------------------------------

/** One contract-valid journal row, in append order. */
export interface EvalGateDecisionRow {
  /** Parsed `at` in ms epoch. */
  atMs: number;
  candidateId: string;
  kind: string;
  status: 'rejected' | 'promoted' | 'evaluated';
  reason: string;
  /** Recorded held-out pair count (pairs.length under the writer's contract). */
  pairs: number;
}

/** Per-bucket adverse evidence before the recurring bars apply. */
export interface EvalGateBucketEvidence {
  /** Adverse rows (or unresolved checkpoints) inside the window. */
  rows: number;
  /** Distinct UTC days the rows landed on. */
  days: Set<string>;
  /** Recorded reason tallies inside the bucket. */
  reasons: Map<string, number>;
  /** Recorded kind tallies inside the bucket. */
  kinds: Map<string, number>;
  /** ISO bounds of the rows; null when the bucket recorded none. */
  firstMs: number | null;
  lastMs: number | null;
  /** Bounded, ordered candidate ids for prompt quotation. */
  ids: string[];
}

const emptyBucket = (): EvalGateBucketEvidence => ({
  rows: 0, days: new Set(), reasons: new Map(), kinds: new Map(),
  firstMs: null, lastMs: null, ids: [],
});

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

export interface EvalGateFold {
  /** Contract-valid rows inside the window (all statuses). */
  rows: number;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
  /** In-window 'promoted' rows — the gate's successes, context only. */
  promoted: number;
  /** In-window 'rejected' rows across every reason — context only. */
  rejected: number;
  /** In-window 'evaluated' checkpoints — context only (unresolved ones are bucketed separately). */
  evaluated: number;
  /** In-window 'regression' rejections — the gate measuring a worse candidate, context only. */
  regression: number;
  /** Per-bucket adverse evidence, keyed by bucket. */
  buckets: Record<EvalGateBucket, EvalGateBucketEvidence>;
}

const EMPTY_BUCKETS = (): Record<EvalGateBucket, EvalGateBucketEvidence> => ({
  scorer: emptyBucket(),
  apply: emptyBucket(),
  input: emptyBucket(),
  unresolved: emptyBucket(),
});

/**
 * Pure: parse eval-gate.jsonl text into contract rows and window them.
 * Only rows under the writer's record() contract count — parseable `at`,
 * a candidateId within the writer's 200-char cap, a known kind, status
 * and reason, and a pairs array whose every element carries a string
 * taskId (within the same cap) and finite baseline/candidate scores.
 * Malformed lines are skipped, never guessed.
 */
export function parseEvalGateRows(text: string): { rows: EvalGateDecisionRow[]; malformed: number } {
  const rows: EvalGateDecisionRow[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!isRecord(value)) {
      malformed += 1;
      continue;
    }
    const at = value['at'];
    const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(atMs)) {
      malformed += 1;
      continue;
    }
    const candidateId = value['candidateId'];
    const kind = value['kind'];
    const status = value['status'];
    const reason = value['reason'];
    const pairs = value['pairs'];
    if (
      typeof candidateId !== 'string' || candidateId.trim() === '' || candidateId.length > MAX_LEDGER_ID_CHARS
      || typeof kind !== 'string' || !EVAL_GATE_KINDS.has(kind)
      || typeof status !== 'string' || !EVAL_GATE_STATUSES.has(status)
      || typeof reason !== 'string' || !EVAL_GATE_REASONS.has(reason)
      || !Array.isArray(pairs)
      || pairs.some((pair) => !isRecord(pair)
        || typeof pair['taskId'] !== 'string' || pair['taskId'].length > MAX_LEDGER_ID_CHARS
        || typeof pair['baseline'] !== 'number' || !Number.isFinite(pair['baseline'])
        || typeof pair['candidate'] !== 'number' || !Number.isFinite(pair['candidate']))
    ) {
      malformed += 1;
      continue;
    }
    rows.push({
      atMs,
      candidateId,
      kind,
      status: status as EvalGateDecisionRow['status'],
      reason,
      pairs: pairs.length,
    });
  }
  return { rows, malformed };
}

/**
 * Pure: fold parsed rows into windowed context tallies and per-bucket
 * adverse evidence. Rejected rows bucket by their reason's failure
 * locus; 'regression' and 'promoted' tally as context only. An
 * 'evaluated' checkpoint is unresolved evidence only when no LATER row
 * for the same candidateId recorded a terminal status and the
 * checkpoint is older than the unresolved grace.
 */
export function foldEvalGateRows(
  rows: readonly EvalGateDecisionRow[],
  nowMs: number,
  windowMs: number,
): EvalGateFold {
  const since = nowMs - windowMs;
  const until = nowMs + EVAL_GATE_FUTURE_SKEW_MS;
  const fold: EvalGateFold = {
    rows: 0,
    malformed: 0,
    promoted: 0,
    rejected: 0,
    evaluated: 0,
    regression: 0,
    buckets: EMPTY_BUCKETS(),
  };

  // A checkpoint is unresolved when no later row for its candidateId
  // recorded a terminal status — scan backwards once, carrying the set
  // of candidate ids a terminal row has already resolved.
  const resolvedLater = new Set<string>();
  const unresolvedRows = new Set<EvalGateDecisionRow>();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    if (row.status === 'promoted' || row.status === 'rejected') {
      resolvedLater.add(row.candidateId);
      continue;
    }
    if (row.status === 'evaluated' && !resolvedLater.has(row.candidateId)) {
      unresolvedRows.add(row);
    }
  }

  const record = (bucket: EvalGateBucket, row: EvalGateDecisionRow): void => {
    const cell = fold.buckets[bucket];
    cell.rows += 1;
    cell.days.add(dayOf(row.atMs));
    bump(cell.reasons, row.reason);
    bump(cell.kinds, row.kind);
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
    if (cell.ids.length < MAX_PROMPT_IDS * 4) cell.ids.push(row.candidateId);
  };

  for (const row of rows) {
    if (row.atMs < since || row.atMs > until) continue;
    fold.rows += 1;
    if (row.status === 'promoted') {
      fold.promoted += 1;
      continue;
    }
    if (row.status === 'rejected') {
      fold.rejected += 1;
      if (row.reason === 'regression') fold.regression += 1;
      const bucket = BUCKET_OF_REASON[row.reason];
      if (bucket !== undefined) record(bucket, row);
      continue;
    }
    // 'evaluated': context tally always; unresolved evidence only past the grace.
    fold.evaluated += 1;
    if (row.atMs <= nowMs - EVAL_GATE_UNRESOLVED_GRACE_MS && unresolvedRows.has(row)) {
      record('unresolved', row);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface EvalGateCell {
  bucket: EvalGateBucket;
  /** Adverse rows inside the window. */
  rows: number;
  /** Sorted distinct UTC days the rows landed on. */
  days: string[];
  /** Recorded reason tallies. */
  reasons: Record<string, number>;
  /** Recorded kind tallies. */
  kinds: Record<string, number>;
  /** ISO bounds of the rows. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Bounded candidate ids, oldest first. */
  ids: string[];
}

const sortedRecord = (map: ReadonlyMap<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

/**
 * Pure: the recurring cells the fold justifies — buckets whose adverse
 * rows reach EVAL_GATE_MIN_ADVERSE across EVAL_GATE_MIN_DAYS distinct
 * UTC days. Fixed bucket order (scorer, apply, input, unresolved).
 */
export function evalGateCells(fold: EvalGateFold): EvalGateCell[] {
  const order: EvalGateBucket[] = ['scorer', 'apply', 'input', 'unresolved'];
  const cells: EvalGateCell[] = [];
  for (const bucket of order) {
    const cell = fold.buckets[bucket];
    if (cell.rows < EVAL_GATE_MIN_ADVERSE || cell.days.size < EVAL_GATE_MIN_DAYS) continue;
    cells.push({
      bucket,
      rows: cell.rows,
      days: [...cell.days].sort(),
      reasons: sortedRecord(cell.reasons),
      kinds: sortedRecord(cell.kinds),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      ids: cell.ids.slice(),
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/learn/eval-gate.jsonl under the OS home (the writer\'s learnDir() resolution in src/core/config.ts — homedir()/.ashlr/learn, ASHLR_HOME-independent): promoteWithEval in src/core/learn/eval-gate.ts appends one metadata-only row per decision — {at, candidateId, kind: prior|prompt|playbook, status: rejected|promoted|evaluated, reason, pairs} — after replaying every held-out task in both arms. Early refusals write a single \'rejected\' row (missing-data, invalid-data, evaluation-failed, regression); a clean sweep first writes an \'evaluated\' checkpoint (reason no-regression) BEFORE apply runs exactly once, then closes \'promoted\' or \'rejected\' (apply-failed, stale-baseline). candidateId and taskId are scrubbed and capped at 200 chars; candidate contents, task inputs and errors are never persisted. The journal\'s only reader until this feed was the writer\'s own test suite (test/learn-eval-gate.test.ts) — a write-only audit.';

const NO_CHANGE = 'If the window has rolled forward, the journal rotated or truncated past the adverse rows, the rejections trace to upstream candidate generation rather than the gate machinery, the evaluated checkpoints were deliberate operator pauses, or the cause is owner-side (credentials, billing, a protected gate, host scheduling or the pinned ops install itself) — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: EvalGateCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const kindText = (kinds: Record<string, number>): string =>
  Object.entries(kinds).map(([kind, count]) => `${count} '${kind}'`).join(', ');

/** The shared in-window context tallies every prompt quotes — recorded counts only. */
function contextText(fold: EvalGateFold, windowDays: number, lowerBound: boolean): string {
  const regressionText = fold.regression > 0 ? `, ${fold.regression} of them 'regression' (the gate measuring a worse candidate — context, not a cell)` : '';
  const malformedText = fold.malformed > 0 ? ` ${fold.malformed} non-blank line(s) failed the writer's row contract and were skipped, never guessed.` : '';
  return `The journal also recorded ${fold.rows} in-window decision row(s) across the ${windowDays}-day window: ${fold.promoted} promoted, ${fold.rejected} rejected${regressionText}, ${fold.evaluated} evaluated checkpoint(s)${lowerBound ? ' — a bounded journal tail was truncated, so these counts cover only the retained bytes and every tally is a lower bound' : ''}.${malformedText}`;
}

function idExamples(cell: EvalGateCell): string {
  const shown = cell.ids.slice(0, MAX_PROMPT_IDS).map((id) => `'${fieldText(id)}'`);
  const rest = cell.ids.length - shown.length;
  return shown.length === 0 ? '' : ` Candidate ids: ${shown.join('; ')}${rest > 0 ? `, and ${rest} more` : ''}.`;
}

function scorerPrompt(cell: EvalGateCell, fold: EvalGateFold, windowDays: number, lowerBound: boolean): string {
  return [
    `Phantom's learn eval gate keeps failing before it can score candidates — ${cell.rows} 'evaluation-failed' rejection(s) inside the ${windowDays}-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every 'evaluation-failed' row is a promoteWithEval call whose trusted replay scorer threw on a held-out task — the gate could not produce baseline/candidate scores, so the candidate was rejected without a measurement. ${contextText(fold, windowDays, lowerBound)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: reproduce the tallies by reading the journal directly, then check whether the replay implementations callers pass to promoteWithEval throw on malformed task inputs or scorer state (the gate catches scorer exceptions as evaluation-failed by design — src/core/learn/eval-gate.ts), whether the held-out task set or baseline values reaching the scorer are corrupt, and whether the failure clusters on one candidate kind (${kindText(cell.kinds)} recorded here). 'regression' rejections are the gate working — a measured worse candidate — they are tallied as context, never as this cell. Fix what lives here — the scorer, the task preparation or the gate's callers in this repository's src/core/learn/ — and keep owner-side harness policy out of scope. ${NO_CHANGE}`,
    '',
    idExamples(cell),
  ].filter((line) => line !== '').join('\n');
}

function applyPrompt(cell: EvalGateCell, fold: EvalGateFold, windowDays: number, lowerBound: boolean): string {
  const stale = cell.reasons['stale-baseline'] ?? 0;
  const threw = cell.reasons['apply-failed'] ?? 0;
  return [
    `Phantom's learn eval gate keeps losing candidates at the apply step — ${cell.rows} rejection(s) inside the ${windowDays}-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}): ${threw} 'apply-failed' (the apply callback threw) and ${stale} 'stale-baseline' (apply refused the write because baseRevision no longer matched).`,
    '',
    `An 'apply-failed' row means a candidate that passed every held-out task could not be persisted — the authorized learning change died between the 'evaluated' checkpoint and the closing record. A 'stale-baseline' row means apply() answered false: the candidate's baseRevision was already superseded when it arrived, so the write was correctly refused — but recurring refusals mean candidates are being generated from bases that keep moving. ${contextText(fold, windowDays, lowerBound)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: reproduce the tallies by reading the journal directly, then check the apply callbacks callers hand promoteWithEval — whether they throw on lock contention, store corruption or revision-compare bugs (apply-failed), and whether candidate generation reads a baseRevision that concurrent learning writes keep superseding before apply lands (stale-baseline — the fix may be regenerating from the active revision at apply time rather than at queue time, in this repository's src/core/learn/). Candidates recorded by kind here: ${kindText(cell.kinds)}. ${NO_CHANGE}`,
    '',
    idExamples(cell),
  ].filter((line) => line !== '').join('\n');
}

function inputPrompt(cell: EvalGateCell, fold: EvalGateFold, windowDays: number, lowerBound: boolean): string {
  const missing = cell.reasons['missing-data'] ?? 0;
  const invalid = cell.reasons['invalid-data'] ?? 0;
  return [
    `Phantom's learn eval gate keeps refusing candidates before evaluation can start — ${cell.rows} rejection(s) inside the ${windowDays}-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}): ${missing} 'missing-data' (no usable tasks, baseline or candidate value) and ${invalid} 'invalid-data' (malformed candidate id, baseRevision, kind, task ids or out-of-range scores).`,
    '',
    `These rows are the gate's input contract holding: the caller never supplied a usable held-out task set, baseline, candidate value or well-formed ids/scores, so no replay ever ran. Recurring refusals mean whatever prepares promoteWithEval's inputs keeps handing it unusable data — the fix is upstream of the gate, not inside it. ${contextText(fold, windowDays, lowerBound)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: reproduce the tallies by reading the journal directly, then check the promoteWithEval call sites and the candidate/task builders feeding them — whether held-out task sets come back empty or null, whether baseline/candidate values fail structuredClone or the score-range contract, and whether candidate ids or task ids arrive blank, duplicated or over the writer's caps. Candidates recorded by kind here: ${kindText(cell.kinds)}. ${NO_CHANGE}`,
    '',
    idExamples(cell),
  ].filter((line) => line !== '').join('\n');
}

function unresolvedPrompt(cell: EvalGateCell, fold: EvalGateFold, windowDays: number, lowerBound: boolean): string {
  return [
    `Phantom's learn eval gate keeps checkpointing 'evaluated' and never recording a decision — ${cell.rows} candidate(s) inside the ${windowDays}-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) reached the pre-apply checkpoint and no later row for the same candidateId ever recorded 'promoted' or 'rejected'.`,
    '',
    `The 'evaluated' row is written BEFORE apply runs exactly once; the closing 'promoted'/'rejected' row follows it. A checkpoint with no terminal row means the process died or hung between the two records — and because apply may or may not have landed, the candidate's real outcome is genuinely unknown, never a recorded failure. Each unresolved row here is older than the one-hour in-flight grace, so it is not a slow apply. ${contextText(fold, windowDays, lowerBound)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which side is wrong: reproduce the tallies by reading the journal directly, then check what runs promoteWithEval's apply step — whether apply callbacks can hang (the gate awaits them with no timeout by design), whether the process hosting the gate is being killed mid-apply (daemon restarts, launchd timeouts, OOM), and whether the terminal record() itself can fail after a successful apply (audit I/O errors propagate by contract, so a thrown append leaves exactly this shape). Checkpoints recorded by kind here: ${kindText(cell.kinds)}. If the unresolved candidates were deliberate operator pauses or one-off crashes already remediated, ${NO_CHANGE}`,
    '',
    idExamples(cell),
  ].filter((line) => line !== '').join('\n');
}

const BUCKET_TITLE: Record<EvalGateBucket, string> = {
  scorer: 'Learn eval gate keeps failing before scoring on',
  apply: 'Learn eval gate keeps losing candidates at apply on',
  input: 'Learn eval gate keeps refusing unusable inputs on',
  unresolved: 'Learn eval gate keeps losing decisions mid-apply on',
};

const BUCKET_PROMPT: Record<EvalGateBucket, (cell: EvalGateCell, fold: EvalGateFold, windowDays: number, lowerBound: boolean) => string> = {
  scorer: scorerPrompt,
  apply: applyPrompt,
  input: inputPrompt,
  unresolved: unresolvedPrompt,
};

function evalGateItem(cell: EvalGateCell, repo: string, fold: EvalGateFold, windowDays: number, lowerBound: boolean): CloudBacklogItem {
  return {
    id: `eval-gate-${cell.bucket}-${sha(`eval-gate:${cell.bucket}:${repo.toLowerCase()}`)}`,
    title: `${BUCKET_TITLE[cell.bucket]} ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: BUCKET_PROMPT[cell.bucket](cell, fold, windowDays, lowerBound),
    area: 'eval-gate',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the learn eval-gate journal's recurring adverse
 * cells. Total: another repository, a missing journal, an unreadable
 * read, or any read failure yields no items rather than throwing into
 * discovery.
 */
export async function evalGateBacklogItems(opts: EvalGateItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = opts.now ?? Date.now();
    if (!Number.isFinite(nowMs)) return [];
    const windowMs = opts.windowMs ?? EVAL_GATE_WINDOW_MS;

    // The journal is the whole evidence: missing means no decision was
    // ever recorded (the writer creates it lazily); unreadable or
    // non-file cannot prove absence, so the source stays quiet.
    let text: string | null;
    let lowerBound = false;
    if (opts.evalGateText !== undefined) {
      text = opts.evalGateText;
    } else {
      const tail = await readLedgerTail(opts.evalGatePath ?? join(learnDir(), 'eval-gate.jsonl'), ROUTER_OUTCOME_LEDGER_LIMIT);
      if (tail.state === 'missing') {
        text = null;
      } else if (tail.state === 'read') {
        text = tail.text;
        lowerBound = tail.truncated === true;
      } else {
        return [];
      }
    }
    if (text === null) return [];

    const { rows, malformed } = parseEvalGateRows(text);
    const fold = foldEvalGateRows(rows, nowMs, windowMs);
    fold.malformed = malformed;
    if (fold.rows === 0) return [];

    const cells = evalGateCells(fold);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? EVAL_GATE_BACKLOG_MAX_ITEMS, EVAL_GATE_ITEM_HARD_MAX));
    const windowDays = Math.round(windowMs / 86_400_000);
    return cells.slice(0, limit).map((cell) => evalGateItem(cell, repo, fold, windowDays, lowerBound));
  } catch {
    return [];
  }
}
