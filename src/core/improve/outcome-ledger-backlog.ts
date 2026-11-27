/**
 * Improve outcome-ledger journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm improve register|measure|promote|observe` (src/cli/improve.ts)
 * appends digest-chained events to improve/outcomes.jsonl under the
 * Phantom home (~/.ashlr or $ASHLR_HOME): 'registered' rows carry the
 * proposal's declared metric, 'measured' rows record base/head values
 * (value:null plus a reason when the metric could not produce a
 * number), 'promotion' rows record the gate's merge-queued/refused
 * decision with its reasons, and 'observed' rows record post-merge
 * merged/reverted outcomes. Until now the ledger's readers were
 * `phm improve outcomes` — a report someone had to run — scoreOutcomes
 * and rankByLeverage, which consume per-proposal status but never the
 * recurrence of a failure reason, and the promotion gate itself, which
 * sees only the proposal in front of it. So a metric pipeline that
 * kept failing the same way across proposals, or a gate that kept
 * refusing the same class of proposal, sat in an append-only file
 * nobody folded, never work.
 *
 * outcomeLedgerBacklogItems carries the ledger into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling sources beside it.
 *
 * Three evidence axes, all anchored to the writer's own contract —
 * readLedger verifies the digest chain and validates every event
 * (validateEvent), so the fold reads only records the writer's append
 * path could have produced:
 *   - ledger integrity: readLedger reporting intact:false —
 *     'ledger-too-large' past MAX_LEDGER_BYTES, a chain break, or an
 *     unreadable line. appendLedger refuses to append while the chain
 *     is broken, so measure/promote/observe all fail closed and the
 *     loop's outcome capture is stopped; the verified prefix still
 *     folds and records past the break are invisible to every reader.
 *   - measurement failures: 'measured' events with value:null inside
 *     the window, grouped by a stable reason kind — the writer's own
 *     vocabulary (metric script missing, checkout mismatch, output
 *     contract violations, timeout, non-zero exit) classified by
 *     ordered prefix rules, everything else kept verbatim under an
 *     'other:' key. scoreOutcomes marks these proposals 'unknown' but
 *     nothing counts how often the same failure recurs.
 *   - promotion refusals: 'promotion' events with decision:'refused'
 *     inside the window, each event's reasons classified the same way
 *     (one event counts once per kind it touches). The gate's reasons
 *     are journaled verbatim; nothing counts their recurrence across
 *     proposals.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedger — the
 *     writer's own verified reader — which enforces the digest chain
 *     and per-event validation and returns the verified prefix plus
 *     its intact flag. Nothing is written and no process is inspected.
 *  - Missing or unreadable evidence yields no items. A missing ledger
 *     is the writer's normal state before the first `phm improve
 *     register` — a clean first run — and contributes nothing rather
 *     than an error. A ledger that cannot be read at all is the same
 *     absence the sibling sources treat as no evidence.
 *  - Recurring means recorded, on the fold's own bars. A reason axis
 *     emits only while at least OUTCOME_LEDGER_MIN_ROWS adverse rows
 *     inside the window span at least OUTCOME_LEDGER_MIN_DAYS distinct
 *     UTC days across at least OUTCOME_LEDGER_MIN_PROPOSALS distinct
 *     proposals — one broken proposal or one bad day is an incident,
 *     not a pattern. Rows dated outside the window or beyond the
 *     60-second future-skew tolerance are counted as outsideWindow,
 *     never evidence either way; rows whose timestamp cannot be
 *     parsed count as undatedRows.
 *  - The evidence carries no target-repository dimension for the
 *     machinery axes — the ledger describes this install's
 *     self-improvement loop, though 'pr' events do name the repository
 *     each proposal targeted. Items therefore emit only when the
 *     backlog target's repository name is 'phantom', the same
 *     last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. Every id is a stable string, so a refresh
 *     re-derives the same ids and appendUserBacklogItems adds only
 *     what is new; shifted tallies do not spawn twin items and a quiet
 *     window stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *     quoted only as recorded, the ledger path and its verified-read
 *     contract ride in the evidence, and the brief names the writer
 *     commands, `phm improve outcomes`, measure.ts, promote.ts and
 *     outcomes.ts — with the usual no-change escape when the window
 *     no longer reproduces or the cause is owner-side.
 */
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { outcomesLedgerPath, readLedger, type LedgerRead, type LedgerRecord } from './outcomes.js';

/** Items one call may emit: one integrity item plus capped cells per axis. */
export const OUTCOME_LEDGER_MAX_ITEMS = 7;
const OUTCOME_LEDGER_ITEM_HARD_MAX = 25;
/**
 * Evidence window: seven days, the same convention the sibling
 * sources apply. The ledger only grows on register/measure/promote/
 * observe calls, so the verified read covers the window many times
 * over; the ledger's own 8 MiB bound is the hard ceiling.
 */
export const OUTCOME_LEDGER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, same convention the sibling folds tolerate. */
export const OUTCOME_LEDGER_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a reason cell needs inside the window before it counts as recurring. */
export const OUTCOME_LEDGER_MIN_ROWS = 3;
/** Those rows must span at least this many separate UTC days — one bad day is an incident, not a pattern. */
export const OUTCOME_LEDGER_MIN_DAYS = 2;
/** And at least this many distinct proposals — one proposal failing repeatedly is its own story. */
export const OUTCOME_LEDGER_MIN_PROPOSALS = 2;
/** Reason cells emitted per axis, strongest first. */
export const OUTCOME_LEDGER_MAX_CELLS_PER_AXIS = 3;
/** Verbatim reasons kept per cell for prompt quoting; the tail is long-tail noise. */
const CELL_REASON_CAP = 25;
/** 'other:' keys and prompt labels stay bounded; writer reasons are already capped at 300 chars. */
const REASON_KEY_CHARS = 120;
const REASON_LABEL_CHARS = 80;
/** The fleet's own repository label: ledger evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;

export interface OutcomeLedgerItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Ledger path override (default: outcomesLedgerPath() — $ASHLR_HOME/improve/outcomes.jsonl). */
  ledgerPath?: string;
  /** Most items one call emits (default OUTCOME_LEDGER_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default OUTCOME_LEDGER_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One recurring reason cell: adverse rows grouped by stable reason kind. */
export interface OutcomeLedgerReasonCell {
  /** Stable grouping key — a writer-vocabulary kind or 'other:<bounded reason>'. */
  key: string;
  /** In-window adverse rows/events touching this kind. */
  events: number;
  /** Distinct UTC days those rows fall on. */
  days: Set<string>;
  /** Distinct proposals those rows belong to. */
  proposalIds: Set<string>;
  /** ISO bounds of the cell's rows; null when none recorded a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Verbatim writer reasons behind the cell, bounded; count desc, then text. */
  reasons: Array<{ text: string; count: number }>;
}

/** The fold's measured evidence; every count is over in-window rows only unless named otherwise. */
export interface OutcomeLedgerEvidence {
  /** readLedger's verified-prefix count and integrity verdict. */
  verifiedRecords: number;
  ledgerIntact: boolean;
  /** readLedger's own reasons when intact is false ('ledger-too-large', 'chain-broken-at-line-N', ...). */
  integrityReasons: string[];
  /** Valid ledger rows inside the window. */
  rows: number;
  /** Valid rows dated outside the window or beyond the future-skew tolerance; not evidence either way. */
  outsideWindow: number;
  /** In-window rows whose timestamp could not be parsed; counted, never guessed. */
  undatedRows: number;
  /** Healthy-path context: in-window rows by event type. */
  registeredRows: number;
  prRows: number;
  measuredRows: number;
  measuredUnknownRows: number;
  promotionRows: number;
  promotionQueuedRows: number;
  observedMergedRows: number;
  observedRevertedRows: number;
  /** Recurring measurement-failure and promotion-refusal cells, strongest first. */
  measureCells: OutcomeLedgerReasonCell[];
  promoteCells: OutcomeLedgerReasonCell[];
  oldestAt: string | null;
  newestAt: string | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Ordered prefix rules over the writer's measurement-failure
 * vocabulary (measure.ts measureAt/parseMetricOutput/standingMetric-
 * Confinement). First match wins; anything else stays verbatim under
 * an 'other:' key so a new failure string is never silently
 * reclassified.
 */
const MEASURE_REASON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^metric script .+ is missing at this commit$/, 'metric-script-missing'],
  [/^checkout did not land/, 'checkout-mismatch'],
  [/^not an exact 40-hex/, 'bad-commit'],
  [/^metric printed nothing$/, 'metric-no-output'],
  [/^last stdout line is not JSON$/, 'metric-not-json'],
  [/^last stdout line does not name metric/, 'metric-wrong-name'],
  [/^metric value is not a finite number$/, 'metric-bad-value'],
  [/^metric timed out$/, 'metric-timeout'],
];

/** Stable cell key for one measurement-failure reason string. */
export function measureReasonKey(reason: string): string {
  for (const [re, key] of MEASURE_REASON_RULES) if (re.test(reason)) return key;
  const exited = /^metric exited (\d+)/.exec(reason);
  if (exited) return `metric-exit-${exited[1]}`;
  return `other:${reason.slice(0, REASON_KEY_CHARS)}`;
}

/**
 * Ordered prefix rules over the promotion gate's refusal vocabulary
 * (promote.ts evaluatePromotion/diffRefusals plus the CLI's own
 * appended reasons). First match wins; anything else stays verbatim
 * under an 'other:' key.
 */
const PROMOTION_REASON_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^the PR changes nothing/, 'empty-diff'],
  [/^touches the promotion gate/, 'promotion-gate'],
  [/^touches .+: /, 'protected-path'],
  [/^changes its own metric script/, 'metric-script-self'],
  [/^changes the file its npm metric script/, 'metric-input-self'],
  [/^could not resolve npm metric script/, 'metric-unresolvable'],
  [/^diff could not be checked/, 'diff-check-failed'],
  [/^weakens tests:/, 'test-weakening'],
  [/^the autonomy kill switch/, 'kill-switch'],
  [/^Phantom is paused/, 'paused'],
  [/^outcome ledger is not intact/, 'ledger-not-intact'],
  [/^no registered proposal/, 'unregistered-proposal'],
  [/^PR is .+, not open$/, 'pr-not-open'],
  [/^PR head is in another repository/, 'cross-repo-head'],
  [/^branch .+ is not owned/, 'foreign-branch'],
  [/^PR targets .+, not the default branch/, 'wrong-base'],
  [/^no checks reported/, 'checks-absent'],
  [/^no check actually passed/, 'checks-none-green'],
  [/^checks still pending:/, 'checks-pending'],
  [/^checks not green:/, 'checks-red'],
  [/^proposal is linked to PR/, 'wrong-pr-link'],
  [/^metric was measured on a different head/, 'stale-head'],
  [/^base branch moved/, 'stale-base'],
  [/^the gate has not re-measured/, 'gate-not-remeasured'],
  [/^gate re-measurement is unknown/, 'gate-remeasure-unknown'],
  [/^recorded (base|head) value/, 'gate-nonreproducible'],
  [/^gate re-measurement shows no improvement/, 'gate-no-improvement'],
  [/^metric .+ is (improved|unchanged|regressed|unknown)/, 'metric-not-improved'],
  [/^auto-merge disabled again/, 'automerge-drift'],
  [/^the PR changed while the gate measured/, 'pr-moved'],
];

/** Stable cell key for one promotion-refusal reason string. */
export function promoteReasonKey(reason: string): string {
  for (const [re, key] of PROMOTION_REASON_RULES) if (re.test(reason)) return key;
  return `other:${reason.slice(0, REASON_KEY_CHARS)}`;
}

interface CellTally {
  events: number;
  days: Set<string>;
  proposalIds: Set<string>;
  firstMs: number;
  lastMs: number;
  reasonCounts: Map<string, number>;
}

const newTally = (): CellTally => ({
  events: 0, days: new Set(), proposalIds: new Set(),
  firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY,
  reasonCounts: new Map(),
});

function bumpCell(tally: CellTally, atMs: number, utcDay: string, proposalId: string, reasons: readonly string[]): void {
  tally.events += 1;
  tally.days.add(utcDay);
  tally.proposalIds.add(proposalId);
  tally.firstMs = Math.min(tally.firstMs, atMs);
  tally.lastMs = Math.max(tally.lastMs, atMs);
  for (const reason of reasons) {
    if (tally.reasonCounts.size >= CELL_REASON_CAP && !tally.reasonCounts.has(reason)) continue;
    tally.reasonCounts.set(reason, (tally.reasonCounts.get(reason) ?? 0) + 1);
  }
}

function finishCell(key: string, tally: CellTally): OutcomeLedgerReasonCell {
  const reasons = [...tally.reasonCounts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, 5);
  return {
    key,
    events: tally.events,
    days: tally.days,
    proposalIds: tally.proposalIds,
    firstSeen: tally.events === 0 ? null : new Date(tally.firstMs).toISOString(),
    lastSeen: tally.events === 0 ? null : new Date(tally.lastMs).toISOString(),
    reasons,
  };
}

function cellPassesBars(cell: OutcomeLedgerReasonCell): boolean {
  return cell.events >= OUTCOME_LEDGER_MIN_ROWS
    && cell.days.size >= OUTCOME_LEDGER_MIN_DAYS
    && cell.proposalIds.size >= OUTCOME_LEDGER_MIN_PROPOSALS;
}

/**
 * Pure: fold verified ledger records into the outcome evidence. Rows
 * outside the window or beyond the future-skew tolerance never join a
 * cell; valid out-of-window rows count as outsideWindow and rows with
 * an unparseable timestamp count as undatedRows. 'measured' rows with
 * value:null join the measure axis under their reason kind;
 * 'promotion' rows with decision:'refused' join the promote axis once
 * per distinct reason kind the event touches.
 */
export function foldOutcomeLedgerEvidence(
  records: readonly LedgerRecord[],
  opts: { nowMs: number; windowMs?: number },
): OutcomeLedgerEvidence {
  const windowMs = opts.windowMs ?? OUTCOME_LEDGER_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  let rows = 0;
  let outsideWindow = 0;
  let undatedRows = 0;
  let registeredRows = 0;
  let prRows = 0;
  let measuredRows = 0;
  let measuredUnknownRows = 0;
  let promotionRows = 0;
  let promotionQueuedRows = 0;
  let observedMergedRows = 0;
  let observedRevertedRows = 0;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;
  const measureTallies = new Map<string, CellTally>();
  const promoteTallies = new Map<string, CellTally>();
  for (const rec of records) {
    const atMs = Date.parse(rec.at);
    if (!Number.isFinite(atMs)) { undatedRows += 1; continue; }
    if (atMs < windowStart || atMs > opts.nowMs + OUTCOME_LEDGER_FUTURE_SKEW_MS) {
      outsideWindow += 1;
      continue;
    }
    rows += 1;
    const utcDay = utcDayOf(atMs);
    oldestMs = Math.min(oldestMs, atMs);
    newestMs = Math.max(newestMs, atMs);
    switch (rec.type) {
      case 'registered': registeredRows += 1; break;
      case 'pr': prRows += 1; break;
      case 'measured': {
        measuredRows += 1;
        if (rec.value === null && typeof rec.reason === 'string' && rec.reason !== '') {
          measuredUnknownRows += 1;
          const key = measureReasonKey(rec.reason);
          const tally = measureTallies.get(key) ?? newTally();
          measureTallies.set(key, tally);
          bumpCell(tally, atMs, utcDay, rec.proposalId, [rec.reason]);
        }
        break;
      }
      case 'promotion': {
        promotionRows += 1;
        if (rec.decision === 'merge-queued') { promotionQueuedRows += 1; break; }
        // One refused event counts once per distinct reason kind it
        // touches; its verbatim reasons ride into each touched cell.
        const perKind = new Map<string, string[]>();
        for (const reason of rec.reasons) {
          const key = promoteReasonKey(reason);
          const list = perKind.get(key) ?? [];
          if (!list.includes(reason)) list.push(reason);
          perKind.set(key, list);
        }
        for (const [key, reasons] of perKind) {
          const tally = promoteTallies.get(key) ?? newTally();
          promoteTallies.set(key, tally);
          bumpCell(tally, atMs, utcDay, rec.proposalId, reasons);
        }
        break;
      }
      case 'observed': {
        if (rec.observation === 'merged') observedMergedRows += 1;
        else observedRevertedRows += 1;
        break;
      }
    }
  }
  const sortCells = (a: OutcomeLedgerReasonCell, b: OutcomeLedgerReasonCell) =>
    b.events - a.events || a.key.localeCompare(b.key);
  const measureCells = [...measureTallies.entries()]
    .map(([key, tally]) => finishCell(key, tally))
    .filter(cellPassesBars)
    .sort(sortCells)
    .slice(0, OUTCOME_LEDGER_MAX_CELLS_PER_AXIS);
  const promoteCells = [...promoteTallies.entries()]
    .map(([key, tally]) => finishCell(key, tally))
    .filter(cellPassesBars)
    .sort(sortCells)
    .slice(0, OUTCOME_LEDGER_MAX_CELLS_PER_AXIS);
  return {
    verifiedRecords: records.length,
    ledgerIntact: true,
    integrityReasons: [],
    rows, outsideWindow, undatedRows,
    registeredRows, prRows, measuredRows, measuredUnknownRows,
    promotionRows, promotionQueuedRows,
    observedMergedRows, observedRevertedRows,
    measureCells, promoteCells,
    oldestAt: rows === 0 ? null : new Date(oldestMs).toISOString(),
    newestAt: rows === 0 ? null : new Date(newestMs).toISOString(),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const NO_CHANGE = 'If the window has rolled forward, the failures or refusals were a one-off burst the next runs recovered from, the metric or gate inputs were fixed or retuned since, the ledger break was repaired, or the cause is owner-side or pinned ops machinery (credentials, billing, host state outside this repository, or consumption the loop was never built to measure) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the file, its writer and its verified reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is improve/outcomes.jsonl under the Phantom home (~/.ashlr or $ASHLR_HOME) — the digest-chained ledger `phm improve register|measure|promote|observe` appends ({v:1, at, prev, digest} envelopes around registered/pr/measured/promotion/observed events; src/core/improve/outcomes.ts). Its readers until now were `phm improve outcomes` — a report someone had to run — scoreOutcomes and rankByLeverage, which consume per-proposal status but never reason recurrence, and the promotion gate itself, which sees only the proposal in front of it; this feed is the first recurrence fold. Rows count only as readLedger returns them: the digest chain verified and every event re-validated, the verified prefix kept when the chain breaks.';

function spanText(rows: number, oldestAt: string | null, newestAt: string | null): string {
  if (rows === 0 || oldestAt === null || newestAt === null) return '';
  return oldestAt === newestAt
    ? ` Recorded ${oldestAt}.`
    : ` Recorded ${oldestAt} through ${newestAt}.`;
}

function cellSpanText(cell: OutcomeLedgerReasonCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function reasonListText(cell: OutcomeLedgerReasonCell): string {
  if (cell.reasons.length === 0) return '';
  return cell.reasons
    .map((r) => `\`${r.text.length > 120 ? `${r.text.slice(0, 117)}...` : r.text}\` (${r.count}x)`)
    .join(', ');
}

function coverageNote(ev: OutcomeLedgerEvidence): string {
  const parts: string[] = [];
  if (ev.outsideWindow > 0) parts.push(`${ev.outsideWindow} valid row(s) dated outside the window were not counted`);
  if (ev.undatedRows > 0) parts.push(`${ev.undatedRows} row(s) carried an unparseable timestamp and were not counted`);
  if (!ev.ledgerIntact) parts.push(`the ledger read reported intact:false (${ev.integrityReasons.join(', ')}) — records past the break are invisible to every reader`);
  return parts.length === 0 ? '' : ` Journal coverage: ${parts.join('; ')}.`;
}

function contextText(ev: OutcomeLedgerEvidence): string {
  return ` Of ${ev.rows} in-window rows: ${ev.registeredRows} registered, ${ev.prRows} PR-linked, ${ev.measuredRows} measured (${ev.measuredUnknownRows} unknown), ${ev.promotionRows} promotion decisions (${ev.promotionQueuedRows} merge-queued), ${ev.observedMergedRows} observed merges and ${ev.observedRevertedRows} observed reverts.`;
}

function integrityPrompt(read: LedgerRead, ev: OutcomeLedgerEvidence): string {
  return [
    `Phantom's improve outcome ledger is not intact — readLedger reports ${read.reasons.map((r) => `\`${r}\``).join(', ')}, the self-improvement work this backlog exists for.`,
    '',
    `appendLedger refuses to append while the chain is broken, so \`phm improve measure\`, \`phm improve promote\` and \`phm improve observe\` all fail closed: the loop can still propose but can no longer record measurements, gate decisions or post-merge outcomes, and scoreOutcomes/rankByLeverage see only the verified prefix.${contextText(ev)}${spanText(ev.rows, ev.oldestAt, ev.newestAt)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why the ledger broke: 'ledger-too-large' means the file passed the 8 MiB bound, 'chain-broken-at-line-N' means a record's digest or prev link stopped matching (a hand edit or a torn append), 'unreadable-line-N' means a line failed JSON or event validation. The break reasons name the first bad line; rows after it are invisible to every reader including this fold. Fix what lives in this repository — if the ledger needs rotation, compaction or a bounded tail the append path does not yet have, that is the work; if the file was edited outside the append path or the break is host state, report what the evidence shows. ${NO_CHANGE}`,
  ].join('\n');
}

function cellLabel(key: string): string {
  return key.startsWith('other:') ? key.slice(6, 6 + REASON_LABEL_CHARS) : key;
}

function slugKey(key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug === '' ? 'reason' : slug).slice(0, 80);
}

function measurePrompt(cell: OutcomeLedgerReasonCell, ev: OutcomeLedgerEvidence): string {
  const reasons = reasonListText(cell);
  return [
    `Phantom's improve metric measurements keep failing the same way — ${cell.events} journaled unknown measurement(s) of kind \`${cellLabel(cell.key)}\` across ${cell.days.size} UTC days and ${cell.proposalIds.size} proposals inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is a \`phm improve measure\` run (or the promote gate's own re-measure) whose metric command produced no usable number: measureAt records value:null with a reason instead of guessing, and this cell groups the rows whose reasons classify to the same kind. ${cellSpanText(cell)} Verbatim reasons: ${reasons}.${contextText(ev)}${spanText(ev.rows, ev.oldestAt, ev.newestAt)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why the metric pipeline keeps failing on this axis: the kind names the writer's own vocabulary — 'metric-script-missing' means the declared node runner path does not exist at the measured commit, 'checkout-mismatch' means the detached worktree did not land on the requested sha, 'metric-no-output'/'metric-not-json'/'metric-wrong-name'/'metric-bad-value' mean the runner's last stdout line broke the {"metric","value"} contract, 'metric-timeout' and 'metric-exit-N' mean the command itself failed under confinement, and 'other:' rows carry the thrown error's first line verbatim (npm ci failures, sandbox open errors, git worktree errors). Check whether the cause is a contract the proposer keeps declaring wrong (a metric spec the runner cannot satisfy), a pipeline defect in measureAt/standingMetricConfinement, or proposals whose metrics genuinely cannot run at their commits — reproduce with \`phm improve outcomes --json\` for the per-proposal status and the ledger rows for the recorded reasons. Fix what lives in this repository; if the cause is owner-side or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function promotePrompt(cell: OutcomeLedgerReasonCell, ev: OutcomeLedgerEvidence): string {
  const reasons = reasonListText(cell);
  return [
    `Phantom's improve promotion gate keeps refusing the same way — ${cell.events} refused \`phm improve promote\` decision(s) touching kind \`${cellLabel(cell.key)}\` across ${cell.days.size} UTC days and ${cell.proposalIds.size} proposals inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is a promotion event whose evaluatePromotion returned admit:false; the gate's reasons are journaled verbatim (bounded) and this cell groups the refusals whose reasons classify to the same kind — one refused event counts once per kind it touches. ${cellSpanText(cell)} Verbatim reasons: ${reasons}.${contextText(ev)}${spanText(ev.rows, ev.oldestAt, ev.newestAt)}${coverageNote(ev)}`,
    '',
    EVIDENCE,
    '',
    `Find why the gate keeps refusing on this axis: the kind names the gate's own vocabulary — 'checks-red'/'checks-pending'/'checks-absent' mean CI on the proposal head is not green, 'metric-not-improved'/'stale-head'/'stale-base'/'gate-*' mean the measured effect or its reproduction failed the gate's own re-measure, 'protected-path'/'promotion-gate'/'metric-*-self' mean the diff touches paths the gate reserves for human review, 'pr-not-open'/'wrong-base'/'foreign-branch'/'cross-repo-head' mean the PR's shape drifted from what the loop owns, and 'kill-switch'/'paused'/'ledger-not-intact' mean an outer guard is holding. Decide whether the refusals are the gate correctly holding real risk (then the work is upstream — better proposals, greener CI, honest metrics), a miscalibrated rule refusing a whole class of valid proposals, or an upstream pipeline defect (unknown measurements the gate must refuse). Reproduce with \`phm improve outcomes --json\` and \`phm improve promote <id> --repo <dir> --json\`. Fix what lives in this repository; if the cause is owner-side policy or pinned ops machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function outcomeLedgerItem(id: string, title: string, prompt: string, repo: string): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'self-improvement',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the improve outcome ledger's recurring adverse
 * evidence: a broken digest chain, measurement failures recurring by
 * reason kind, and promotion refusals recurring by reason kind — each
 * at the recurring bars of rows across distinct UTC days and distinct
 * proposals inside the window. Total: any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function outcomeLedgerBacklogItems(opts: OutcomeLedgerItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const ledgerPath = opts.ledgerPath ?? outcomesLedgerPath();
    let read: LedgerRead;
    try {
      read = readLedger(ledgerPath);
    } catch {
      return [];
    }
    // A missing ledger is the writer's normal state before the first
    // register — a clean first run — unless the read itself reports
    // the chain broken, which is integrity evidence even with an
    // empty verified prefix.
    if (read.records.length === 0 && read.intact) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const ev = foldOutcomeLedgerEvidence(read.records, { nowMs, windowMs: opts.windowMs });
    ev.verifiedRecords = read.records.length;
    ev.ledgerIntact = read.intact;
    ev.integrityReasons = read.reasons;
    const items: CloudBacklogItem[] = [];
    if (!read.intact) {
      items.push(outcomeLedgerItem(
        'outcome-ledger-integrity',
        'Improve outcome ledger is not intact',
        integrityPrompt(read, ev),
        repo,
      ));
    }
    for (const cell of ev.measureCells) {
      items.push(outcomeLedgerItem(
        `outcome-ledger-measure-${slugKey(cell.key)}`,
        `Improve metric measurements keep failing: ${cellLabel(cell.key)}`,
        measurePrompt(cell, ev),
        repo,
      ));
    }
    for (const cell of ev.promoteCells) {
      items.push(outcomeLedgerItem(
        `outcome-ledger-promote-${slugKey(cell.key)}`,
        `Improve promotion gate keeps refusing: ${cellLabel(cell.key)}`,
        promotePrompt(cell, ev),
        repo,
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? OUTCOME_LEDGER_MAX_ITEMS, OUTCOME_LEDGER_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
