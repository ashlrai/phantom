/**
 * Seat-router shadow decision journal → self-improvement backlog items.
 *
 * The seat router's own shadow log: ~/.ashlr/routing/decisions.jsonl —
 * append-only ShadowDecisionRecords (src/core/routing/budget-store.ts
 * recordShadowDecision, schema v:1) rotated at DECISIONS_LOG_MAX_BYTES
 * keeping one .1 predecessor. Every record is one shadow-mode routeSeat
 * evaluation — the request, the SeatDecision the pure router returned
 * (chosen seatId, ranked candidates, per-seat exclusions with structured
 * reason kinds, the why prose) and, when the caller knows it, what
 * ACTUALLY ran ({engine, seatId}). Shadow mode exists for comparison:
 * the log is the evidence base for moving routing onto the SeatRouter.
 *
 * Producers, and why this feed folds only some of them:
 *  - the daemon's shadowSeatRouteBeside (src/core/daemon/loop.ts) logs
 *    what the SeatRouter would have chosen beside every NON-standing
 *    dispatch — swarm, single and best-of-N runs the standing router
 *    never evaluates — over the published capacity snapshot, with
 *    actual = {engine: <the backend that really ran>, seatId: null};
 *  - the standing fleet tick's own routeWorkItem evaluations
 *    (src/core/fleet/tick-hooks-live.ts deps.shadow) land in the same
 *    journal with source 'daemon' but a different actual shape — null
 *    on holds, {engine, seatId} on dispatches — and their seatDecision
 *    is the SAME object runs.jsonl already journals per dispatch, so
 *    the runtime-journal feed covers them and this feed skips them;
 *  - the agent gateway (src/core/router-gateway/deps.ts, source
 *    'gateway') and the Leader seat (src/core/vision/leader-seat.ts,
 *    source 'leader') log every request they route — interactive and
 *    agent traffic the fleet dispatch journal never sees at all;
 *  - 'best-of-n', 'verse' and 'test' are writer-vocabulary sources with
 *    no live producer today; 'test' rows never count as evidence.
 *
 * Until now the log's only readers were point-in-time surfaces — the
 * budget decisions route (/api/verse/budget/decisions behind the
 * console's budget panel), `phm telemetry`, the reserve-breach
 * attributor and the autonomy ladder — reports of recent decisions,
 * never a recurrence fold. Seat evidence that stays broken on the
 * paths nobody routes by, and routing requests that keep finding no
 * eligible seat, were invisible history that never became work.
 * A sibling feed (seat-shadow-backlog.ts, seatShadowBacklogItems) folds
 * the same journal's live-vs-shadow DIVERGENCE cells — recomputed
 * comparisons between the recorded pick and the actual that ran,
 * which need both sides resolved and so today only see the daemon
 * rows that carry an actual engine or seat. This feed folds the
 * evidence-quality signals divergence cannot see: the adverse
 * exclusion kinds and the empty decisions, including every
 * gateway/leader row whose actual is never recorded at all.
 * seatShadowEvidenceBacklogItems carries the same journal into
 * discoverBacklog as a second, complementary source.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. decisions.jsonl and its rotated .1 predecessor are read
 *    through readLedgerTail's bounded no-follow tails —
 *    DECISIONS_LOG_MAX_BYTES each, the writer's own rotation bound —
 *    and nothing is written and no network is touched. A missing or
 *    unreadable file yields no items; a malformed line is skipped,
 *    never guessed.
 *  - Rows count only under the writer's contract, field by field: v:1,
 *    an ISO-parseable `at`, a source inside the closed vocabulary, a
 *    request whose task/difficulty/autonomous are the router's own
 *    vocabularies, and a decision carrying a nullable seatId, a
 *    candidates array of seat-id strings, an exclusions array and the
 *    why sentence. Exclusion reason kinds come only from the
 *    structured details[] twin — the reasons[] prose is never parsed.
 *    Off-contract rows are counted malformed, never guessed.
 *  - Only the rows no other journal covers fold: 'test' sources and
 *    the standing tick's own daemon evaluations (actual null, or
 *    actual.seatId set — the runs.jsonl duplicates) are skipped and
 *    counted, while beside-dispatch daemon rows (actual records an
 *    engine with a null seatId) and every gateway/leader/best-of-n/
 *    verse row count. Every counted row is already a distinct routing
 *    evaluation — the journal carries no work-item identity to
 *    collapse retries on — so the recurring bar is rows across days:
 *    a cell emits only at SEAT_SHADOW_EVIDENCE_MIN_ROWS rows spanning
 *    SEAT_SHADOW_EVIDENCE_MIN_DAYS distinct UTC days inside the 7-day window,
 *    the sibling feeds' convention.
 *  - Seat-exclusion cells name only evidence-broken kinds
 *    (SEAT_SHADOW_EVIDENCE_ADVERSE_KINDS — the same set the runtime-journal
 *    feed applies): 'unknown-usage', 'unreachable', 'signed-out' and
 *    'other'. Capacity-truth exclusions — headroom, spent, reserve,
 *    session-ceiling, model-window, context, spend-cap — and policy
 *    exclusions — grant, lane, switched-off, demoted, task-arm — are
 *    the router working as designed and never emit. Empty-decision
 *    cells split by what the decision recorded: 'all-excluded' when
 *    the exclusions array is non-empty (seats were evaluated and none
 *    could produce) and 'no-seats' when it is empty (the capacity
 *    view held nothing to evaluate).
 *  - Truncation is stated, never hidden: when either bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: the journal describes this install's seat
 *    routing and carries no repository column, so items emit only when
 *    the backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *    Dedup is downstream: the item id hashes the cell identity, never
 *    counts or timestamps, so a refresh re-derives the same id and a
 *    recovered cell simply stops re-adding.
 *  - Every journal string is untrusted text: seat ids, reason kinds,
 *    source/task labels and the why prose are scrubbed, flattened,
 *    deduped, capped and quoted inside prompts, and cell identity
 *    hashes the raw values so journal text never becomes an
 *    identifier.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { decisionsLogPath, DECISIONS_LOG_MAX_BYTES } from '../routing/budget-store.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is bounded by seat/kind/source/task vocabularies. */
export const SEAT_SHADOW_EVIDENCE_MAX_ITEMS = 12;
const SEAT_SHADOW_EVIDENCE_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const SEAT_SHADOW_EVIDENCE_WINDOW_HOURS = 168;
/** A cell emits only at this many contributing shadow evaluations... */
export const SEAT_SHADOW_EVIDENCE_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days — recurring means recorded across days. */
export const SEAT_SHADOW_EVIDENCE_MIN_DAYS = 2;
/** The fleet's own repository label: seat-shadow evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Exclusion reason kinds that mean the seat's eligibility EVIDENCE is broken or missing — the same set the runtime-journal feed applies, never ordinary capacity or policy states. */
export const SEAT_SHADOW_EVIDENCE_ADVERSE_KINDS: ReadonlySet<string> = new Set([
  'unknown-usage',
  'unreachable',
  'signed-out',
  'other',
]);
/** The writer's closed source vocabulary (ShadowDecisionSource in budget-store.ts). */
const SHADOW_SOURCES: ReadonlySet<string> = new Set(['daemon', 'gateway', 'best-of-n', 'leader', 'verse', 'test']);
/** The router's closed request vocabularies (RoutingTask/RoutingDifficulty in types.ts). */
const ROUTING_TASKS: ReadonlySet<string> = new Set(['code', 'review', 'plan', 'bulk', 'leader']);
const ROUTING_DIFFICULTIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
/** Seat ids the capacity snapshot admits (BUDGET_SEAT_ID_RE's shape); anything else is not ours. */
const SAFE_SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** Exclusion reason kinds are the router's closed lowercase vocabulary; a bounded shape keeps foreign text out of cells. */
const SAFE_REASON_KIND = /^[a-z][a-z0-9-]{0,39}$/;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** The why prose is a sentence; cap wider than a label but still bounded. */
const MAX_WHY_CHARS = 120;
/** Repo/source/task/kind tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Dominant why sentences quoted inside one empty-decision prompt. */
const MAX_PROMPT_WHYS = 3;
/** Adverse (seatId, kind) pairs one row may contribute (16 exclusions × bounded kinds). */
const MAX_ROW_EXCLUSION_PAIRS = 64;

export interface SeatShadowEvidenceItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: decisionsLogPath(), the writer's own ~/.ashlr/routing/decisions.jsonl). */
  journalPath?: string;
  /** Evidence window in hours (default SEAT_SHADOW_EVIDENCE_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default SEAT_SHADOW_EVIDENCE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the decision rows of the journal tails
// ---------------------------------------------------------------------------

/** One row's adverse (seatId, kind) exclusion pairs plus every reason kind its decision carried. */
interface RowExclusions {
  /** (seatId, kind) pairs whose kind is in SEAT_SHADOW_EVIDENCE_ADVERSE_KINDS, deduped within the row. */
  adverse: { seatId: string; kind: string }[];
  /** Every bounded-shape reason kind the row's exclusions carried (empty-cell context). */
  kinds: string[];
}

function rowExclusions(exclusions: unknown): RowExclusions | null {
  if (!Array.isArray(exclusions)) return null;
  const adverse: { seatId: string; kind: string }[] = [];
  const kinds = new Set<string>();
  const seen = new Set<string>();
  for (const exclusion of exclusions) {
    if (!isRecord(exclusion)) continue;
    const seatId = exclusion['seatId'];
    if (typeof seatId !== 'string' || !SAFE_SEAT_ID.test(seatId)) continue;
    const details = exclusion['details'];
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const kind = detail['kind'];
      if (typeof kind !== 'string' || !SAFE_REASON_KIND.test(kind)) continue;
      kinds.add(kind);
      if (!SEAT_SHADOW_EVIDENCE_ADVERSE_KINDS.has(kind)) continue;
      const pair = `${seatId}:${kind}`;
      if (seen.has(pair) || adverse.length >= MAX_ROW_EXCLUSION_PAIRS) continue;
      seen.add(pair);
      adverse.push({ seatId, kind });
    }
  }
  return { adverse, kinds: [...kinds] };
}

interface ParsedRow {
  atMs: number;
  /** The journal's source label, verbatim ('daemon' rows here are beside-dispatch shadows only). */
  source: string;
  task: string;
  difficulty: string;
  autonomous: boolean;
  /** decision.seatId — null when the router chose nothing. */
  seatId: string | null;
  /** Raw exclusions-array length: non-empty means seats were evaluated and all excluded. */
  exclusionCount: number;
  exclusions: RowExclusions | null;
  /** The engine the caller says actually ran (beside rows), else null → tallied 'unrecorded'. */
  engine: string | null;
  /** The decision's why prose, scrubbed and capped for the dominant-reason tally. */
  why: string;
  /** This feed folds the row: non-test source, and 'daemon' only on the beside-dispatch signature. */
  included: boolean;
}

/**
 * Pure: validate one parsed journal line against the ShadowDecisionRecord
 * contract, field by field. `included` applies this feed's coverage rule:
 * 'test' traffic never counts, and 'daemon' rows count only when `actual`
 * carries an engine with a null seatId — the shadowSeatRouteBeside
 * signature for non-standing dispatches. The standing tick's own daemon
 * rows (actual null on holds, actual.seatId set on dispatches) duplicate
 * the seatDecision runs.jsonl already journals and stay out.
 */
function parseShadowRow(value: unknown): ParsedRow | null {
  if (!isRecord(value) || value['v'] !== 1) return null;
  const at = value['at'];
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const source = value['source'];
  if (typeof source !== 'string' || !SHADOW_SOURCES.has(source)) return null;
  const request = value['request'];
  if (!isRecord(request)) return null;
  const task = request['task'];
  const difficulty = request['difficulty'];
  const autonomous = request['autonomous'];
  if (typeof task !== 'string' || !ROUTING_TASKS.has(task)) return null;
  if (typeof difficulty !== 'string' || !ROUTING_DIFFICULTIES.has(difficulty)) return null;
  if (typeof autonomous !== 'boolean') return null;
  const decision = value['decision'];
  if (!isRecord(decision) || typeof decision['why'] !== 'string') return null;
  const candidates = decision['candidates'];
  const exclusions = decision['exclusions'];
  if (!Array.isArray(candidates) || !Array.isArray(exclusions)) return null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') return null;
  }
  const seatIdRaw = decision['seatId'];
  if (seatIdRaw !== null && (typeof seatIdRaw !== 'string' || seatIdRaw === '')) return null;
  const actual = value['actual'];
  if (actual !== null && actual !== undefined && !isRecord(actual)) return null;
  const actualRecord = isRecord(actual) ? actual : null;
  const actualEngine = actualRecord !== null && typeof actualRecord['engine'] === 'string' && actualRecord['engine'] !== ''
    ? fieldText(actualRecord['engine'], MAX_NAME_CHARS)
    : null;
  const beside = source === 'daemon' && actualRecord !== null
    && actualRecord['seatId'] === null && actualEngine !== null;
  const included = source !== 'test' && (source !== 'daemon' || beside);
  return {
    atMs,
    source,
    task,
    difficulty,
    autonomous,
    seatId: typeof seatIdRaw === 'string' ? seatIdRaw : null,
    exclusionCount: exclusions.length,
    exclusions: rowExclusions(exclusions),
    engine: actualEngine,
    why: fieldText(decision['why'], MAX_WHY_CHARS),
    included,
  };
}

/** Per-cell in-window fold before the recurring bars apply. */
export interface SeatEvidenceExclusionFold {
  seatId: string;
  kind: string;
  /** Contributing shadow evaluations carrying this (seat, kind) pair. */
  rows: number;
  /** Distinct UTC days the contributing rows landed on. */
  days: Set<string>;
  /** Source tallies across the cell's rows. */
  sources: Map<string, number>;
  /** Request-task tallies across the cell's rows. */
  tasks: Map<string, number>;
  /** 'autonomous' | 'interactive' tallies across the cell's rows. */
  autonomy: Map<string, number>;
  /** Real-engine tallies (the beside rows' actual.engine; 'unrecorded' when absent). */
  engines: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** An empty-decision cell: recurring seatId-null decisions of one (source, task, autonomy, kind). */
export interface SeatEvidenceEmptyFold {
  source: string;
  task: string;
  autonomous: boolean;
  /** 'all-excluded' when the decision's exclusions array was non-empty, else 'no-seats'. */
  subKind: 'all-excluded' | 'no-seats';
  rows: number;
  days: Set<string>;
  /** Every bounded reason kind the rows' exclusions carried (all-excluded context; empty on no-seats). */
  kinds: Map<string, number>;
  /** Real-engine tallies ('unrecorded' when the row named none). */
  engines: Map<string, number>;
  /** Difficulty tallies across the cell's rows. */
  difficulties: Map<string, number>;
  /** Dominant why sentences across the cell's rows. */
  whys: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface SeatShadowEvidenceFold {
  /** In-window rows this feed folds — the share denominator the prompts quote. */
  rows: number;
  /** Contract-valid in-window rows deliberately not folded: 'test' traffic and the standing tick's own daemon evaluations (runs.jsonl already carries their seatDecisions). */
  skippedRows: number;
  exclusions: Map<string, SeatEvidenceExclusionFold>;
  empties: Map<string, SeatEvidenceEmptyFold>;
  /** Non-blank lines that were not on-contract decision records. */
  malformed: number;
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

const autonomyLabel = (autonomous: boolean): string => (autonomous ? 'autonomous' : 'interactive');

/**
 * Pure: fold journal text(s) — current tail and rotated predecessor —
 * into per-cell recurring evidence. Rows outside the window, undated,
 * malformed or off-contract are skipped, never guessed; contract-valid
 * rows this feed does not cover (test traffic, the standing tick's own
 * evaluations) count as skippedRows.
 */
export function foldSeatShadowEvidence(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): SeatShadowEvidenceFold {
  const fold: SeatShadowEvidenceFold = {
    rows: 0,
    skippedRows: 0,
    exclusions: new Map(),
    empties: new Map(),
    malformed: 0,
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { fold.malformed++; continue; }
      const row = parseShadowRow(value);
      if (row === null) { fold.malformed++; continue; }
      if (row.atMs < since || row.atMs > until) continue;
      if (!row.included) { fold.skippedRows++; continue; }
      fold.rows += 1;
      const day = dayOf(row.atMs);
      const engineLabel = row.engine ?? 'unrecorded';

      if (row.seatId === null) {
        // Empty-decision cells: the router chose nothing. 'all-excluded'
        // when the decision evaluated seats and excluded every one;
        // 'no-seats' when the capacity view held nothing to evaluate.
        const subKind = row.exclusionCount > 0 ? 'all-excluded' : 'no-seats';
        const key = `${row.source}:${row.task}:${row.autonomous}:${subKind}`;
        let cell = fold.empties.get(key);
        if (cell === undefined) {
          cell = {
            source: row.source, task: row.task, autonomous: row.autonomous, subKind,
            rows: 0, days: new Set(), kinds: new Map(), engines: new Map(),
            difficulties: new Map(), whys: new Map(), firstMs: null, lastMs: null,
          };
          fold.empties.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(day);
        if (row.exclusions !== null) for (const kind of row.exclusions.kinds) bump(cell.kinds, kind);
        bump(cell.engines, engineLabel);
        bump(cell.difficulties, row.difficulty);
        if (row.why !== '') bump(cell.whys, row.why);
        touch(cell, row.atMs);
        continue;
      }

      // Seat-exclusion cells: every adverse (seatId, kind) pair the
      // decision carried — a chosen seat does not erase the evidence
      // that other seats failed.
      if (row.exclusions === null) continue;
      for (const pair of row.exclusions.adverse) {
        const key = `${pair.seatId}:${pair.kind}`;
        let cell = fold.exclusions.get(key);
        if (cell === undefined) {
          cell = {
            seatId: pair.seatId, kind: pair.kind,
            rows: 0, days: new Set(), sources: new Map(), tasks: new Map(),
            autonomy: new Map(), engines: new Map(), firstMs: null, lastMs: null,
          };
          fold.exclusions.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(day);
        bump(cell.sources, row.source);
        bump(cell.tasks, row.task);
        bump(cell.autonomy, autonomyLabel(row.autonomous));
        bump(cell.engines, engineLabel);
        touch(cell, row.atMs);
      }
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageTally {
  /** Sanitized recorded text (a source, task, kind, engine or why label). */
  text: string;
  count: number;
}

interface CellBase {
  /** Contributing shadow evaluations inside the window. */
  rows: number;
  /** In-window folded rows overall — the share denominator. */
  evalRows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

export interface SeatEvidenceExclusionCell extends CellBase {
  kind: 'exclusion';
  seatId: string;
  reasonKind: string;
  sources: UsageTally[];
  tasks: UsageTally[];
  autonomy: UsageTally[];
  engines: UsageTally[];
}

export interface SeatEvidenceEmptyCell extends CellBase {
  kind: 'empty';
  source: string;
  task: string;
  autonomous: boolean;
  subKind: 'all-excluded' | 'no-seats';
  /** Every bounded reason kind the rows' exclusions carried, most frequent first. */
  kinds: UsageTally[];
  engines: UsageTally[];
  difficulties: UsageTally[];
  /** Dominant why sentences, most frequent first. */
  whys: UsageTally[];
}

export type SeatShadowEvidenceCell = SeatEvidenceExclusionCell | SeatEvidenceEmptyCell;

function tallyOf(map: Map<string, number>, max: number): UsageTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const baseOf = (
  rows: number, days: Set<string>, evalRows: number, firstMs: number | null, lastMs: number | null,
  lowerBound: boolean,
): CellBase => ({
  rows,
  evalRows,
  days: [...days].sort(),
  firstSeen: isoOrNull(firstMs),
  lastSeen: isoOrNull(lastMs),
  lowerBound,
});

/**
 * Pure: recurring cells — a (seat, adverse-kind) exclusion or an
 * empty-decision (source, task, autonomy, sub-kind) group at the
 * row and distinct-day bars. Exclusion cells sort by contributing
 * rows; empty cells follow, worst first inside each group.
 */
export function seatShadowEvidenceCells(fold: SeatShadowEvidenceFold, lowerBound = false): SeatShadowEvidenceCell[] {
  const cells: SeatShadowEvidenceCell[] = [];
  for (const cell of fold.exclusions.values()) {
    if (cell.rows < SEAT_SHADOW_EVIDENCE_MIN_ROWS || cell.days.size < SEAT_SHADOW_EVIDENCE_MIN_DAYS) continue;
    cells.push({
      kind: 'exclusion',
      ...baseOf(cell.rows, cell.days, fold.rows, cell.firstMs, cell.lastMs, lowerBound),
      seatId: cell.seatId,
      reasonKind: cell.kind,
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      tasks: tallyOf(cell.tasks, MAX_PROMPT_TALLIES),
      autonomy: tallyOf(cell.autonomy, MAX_PROMPT_TALLIES),
      engines: tallyOf(cell.engines, MAX_PROMPT_TALLIES),
    });
  }
  for (const cell of fold.empties.values()) {
    if (cell.rows < SEAT_SHADOW_EVIDENCE_MIN_ROWS || cell.days.size < SEAT_SHADOW_EVIDENCE_MIN_DAYS) continue;
    cells.push({
      kind: 'empty',
      ...baseOf(cell.rows, cell.days, fold.rows, cell.firstMs, cell.lastMs, lowerBound),
      source: cell.source,
      task: cell.task,
      autonomous: cell.autonomous,
      subKind: cell.subKind,
      kinds: tallyOf(cell.kinds, MAX_PROMPT_TALLIES),
      engines: tallyOf(cell.engines, MAX_PROMPT_TALLIES),
      difficulties: tallyOf(cell.difficulties, MAX_PROMPT_TALLIES),
      whys: tallyOf(cell.whys, MAX_PROMPT_WHYS),
    });
  }
  cells.sort((a, b) => {
    const rank = (c: SeatShadowEvidenceCell): number => (c.kind === 'exclusion' ? 0 : 1);
    return rank(a) - rank(b) || b.rows - a.rows || a.kind.localeCompare(b.kind);
  });
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is decisions.jsonl under ~/.ashlr/routing — the seat router\'s append-only shadow decision log (recordShadowDecision in src/core/routing/budget-store.ts, schema v:1, rotating at 2 MiB keeping one .1 predecessor). Every record is one shadow-mode routeSeat evaluation — the RoutingRequest, the SeatDecision the pure router returned (chosen seatId, ranked candidates, per-seat exclusions with structured reason kinds, the why prose) and, when the caller knows it, what ACTUALLY ran ({engine, seatId}). Producers: the daemon\'s shadowSeatRouteBeside (src/core/daemon/loop.ts) logs what the SeatRouter would have chosen beside every NON-standing dispatch — swarm, single and best-of-N runs the standing router never evaluates — with actual = {engine, seatId: null}; the standing fleet tick\'s own routeWorkItem evaluations (src/core/fleet/tick-hooks-live.ts) land in the same journal but duplicate the seatDecision runs.jsonl already carries, so this feed skips them; the agent gateway (src/core/router-gateway/deps.ts, source \'gateway\') and the Leader seat (src/core/vision/leader-seat.ts, source \'leader\') log every request they route — interactive and agent traffic the fleet dispatch journal never sees. Until this feed the log\'s only readers were point-in-time surfaces — the budget decisions route (/api/verse/budget/decisions), telemetry, the reserve-breach attributor and the autonomy ladder — never a recurrence fold.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/routing/decisions.jsonl (and its .1 predecessor) as JSONL and filtering v:1 records inside the window. The writers and contracts this repository owns are src/core/routing/budget-store.ts (the journal, its rotation and the ShadowDecisionRecord shape), src/core/routing/router.ts and types.ts (routeSeat, RoutingRequest, SeatDecision, the reason-kind vocabulary), src/core/daemon/loop.ts shadowSeatRouteBeside (the beside-dispatch producer), src/core/fleet/tick-hooks-live.ts (the standing tick\'s own evaluations — the runtime-journal feed\'s evidence instead), src/core/router-gateway/deps.ts and src/core/vision/leader-seat.ts (the gateway and Leader producers), and src/core/improve/runtime-journal-backlog.ts (the sibling feed over runs.jsonl\'s standing-tick seatDecisions).';

const NO_CHANGE = 'If the window has rolled forward, the pattern was a one-off burst the fleet recovered from, the exclusions reflect intended policy or genuine capacity that has since cleared, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

const PINNED = ' contrib/mac\'s dispatchd.py, launch.sh and the live copies under ~/.ashlr-runs/bin are pinned ops machinery: Security-reviewed, re-pinned, never edited live — name pinned-side findings for the owner rather than working around them.';

/** Journal source → the path it names, for prompt readability. */
const SOURCE_LABEL: Record<string, string> = {
  'daemon': 'the daemon beside-dispatch shadow (swarm, single and best-of-N runs)',
  'gateway': 'the agent gateway',
  'leader': 'the Leader seat',
  'best-of-n': 'best-of-N routing',
  'verse': 'Verse routing',
};

const sourceText = (source: string): string => SOURCE_LABEL[source] ?? `'${source}'`;

const tallyText = (tallies: readonly UsageTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: CellBase): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: CellBase): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: CellBase): string =>
  cell.evalRows > 0 ? ` (${Math.round((cell.rows / cell.evalRows) * 100)}% of the ${cell.evalRows} in-window shadow evaluations)` : '';

/** What each adverse exclusion kind means in the router's own vocabulary — the same hints the runtime-journal feed quotes. */
const KIND_HINTS: Record<string, string> = {
  'unknown-usage': 'the seat\'s usage reading is missing or unreadable, so the router fails closed rather than guess headroom',
  'unreachable': 'the seat\'s reachability probe keeps failing',
  'signed-out': 'the seat\'s recorded auth state reads signed out',
  'other': 'the exclusion reason did not fit the router\'s reason taxonomy',
};

function exclusionPrompt(cell: SeatEvidenceExclusionCell): string {
  const hint = KIND_HINTS[cell.reasonKind];
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const tasks = cell.tasks.length === 0 ? '' : ` Request tasks: ${tallyText(cell.tasks)}.`;
  const autonomy = cell.autonomy.length === 0 ? '' : ` Request autonomy: ${tallyText(cell.autonomy)}.`;
  const engines = cell.engines.length === 0 ? '' : ` Engines that actually ran beside these shadows: ${tallyText(cell.engines)}.`;
  return [
    `Phantom's seat-router shadow journal keeps recording evaluations that exclude seat '${cell.seatId}' for '${cell.reasonKind}' — ${cell.rows} shadow decision(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each record is one routeSeat evaluation on a path the standing fleet journal never sees — beside-dispatch shadows for swarm/single/best-of-N runs and the gateway/Leader request paths; the decision's exclusions list every ineligible seat with structured reason kinds, and '${cell.reasonKind}'${hint === undefined ? ' is not one of the usual capacity or policy states' : ` means ${hint}`}.${shareText(cell)}${sources}${tasks}${autonomy}${engines}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this seat's eligibility evidence stays broken on these paths: read the newest decisions and the seat's latest capacity snapshot (~/.ashlr/routing/capacity.json, published by the Verse server's account collector or the daemon's capacity publisher), then check the evidence path the kind names — the usage-capture chain for 'unknown-usage' (the same capture gaps the usage-gap feed tracks at the jobs-ledger layer), the reachability probe for 'unreachable', the auth/session state for 'signed-out', and the reason taxonomy in src/core/routing for 'other'. The standing tick's own evaluations of the same seat land in runs.jsonl — the runtime-journal feed tracks that evidence separately — so a seat broken here AND there is broken everywhere. A seat excluded this way in nearly every evaluation is dead capacity the fleet keeps paying to assess while routing around it — or a probe that misreads a healthy seat.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the eligibility assessment in src/core/routing, the probe or capture path that feeds it, or the taxonomy that leaves reasons unclassified.${PINNED} If the exclusion is genuine and intended — the seat really is off, unreachable or signed out and every path correctly routes around it — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function emptyPrompt(cell: SeatEvidenceEmptyCell): string {
  const requestLabel = cell.autonomous ? 'autonomous (fleet)' : 'interactive';
  const kinds = cell.kinds.length === 0 ? '' : ` Reason kinds the rows' exclusions carried: ${tallyText(cell.kinds)}.`;
  const engines = cell.engines.length === 0 ? '' : ` Engines that actually ran beside these shadows: ${tallyText(cell.engines)}.`;
  const difficulties = cell.difficulties.length === 0 ? '' : ` Request difficulties: ${tallyText(cell.difficulties)}.`;
  const whys = cell.whys.length === 0 ? '' : ` Dominant recorded reasons: ${cell.whys.map((w) => `"${w.text}" ×${w.count}`).join(', ')}.`;
  const isNoSeats = cell.subKind === 'no-seats';
  return [
    isNoSeats
      ? `Phantom's seat-router shadow journal keeps recording routing decisions that chose no seat and excluded nothing — ${cell.rows} decision(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), via ${sourceText(cell.source)} for ${requestLabel} '${cell.task}' requests, the self-improvement work this backlog exists for.`
      : `Phantom's seat-router shadow journal keeps recording routing decisions that chose no seat because every evaluated seat was excluded — ${cell.rows} decision(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), via ${sourceText(cell.source)} for ${requestLabel} '${cell.task}' requests, the self-improvement work this backlog exists for.`,
    '',
    isNoSeats
      ? `A decision with seatId null, no chosen candidate and an empty exclusions array means the router's capacity view held nothing it could evaluate for the request — an empty or stale capacity snapshot, a request shape no seat serves, or a policy that filtered every seat before evaluation.${kinds}${engines}${difficulties}${whys}${shareText(cell)}${seenText(cell)}${boundText(cell)}`
      : `Each record evaluated seats and excluded all of them; seatId null means nothing was eligible.${kinds}${engines}${difficulties}${whys}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    isNoSeats
      ? `Find why these paths keep seeing an empty seat view: check whether the capacity snapshot publisher is running and fresh (~/.ashlr/routing/capacity.json — the Verse server's account collector, or the daemon's capacity publisher when no Verse runs), whether the request's task/difficulty/autonomous flags match any seat's served shape, and whether the budget policy's engine and seat filters emptied the candidate set before routeSeat ran. For beside-dispatch rows the real dispatch proceeded on master's own path regardless — recurring empty shadows mean the SeatRouter's evidence base is blind exactly where dispatch still happens.`
      : `Find which blocker dominates the exclusions: for autonomous requests reserve/session-ceiling/spend-cap kinds are policy working as designed, but recurring all-excluded on interactive requests — or on beside-dispatch shadows where the real path dispatched anyway — means either the fleet's seats are genuinely saturated for this request shape or the eligibility evidence is wrong. Check the capacity snapshot's freshness, the per-seat reason details on the newest rows, and whether one policy filter (grant stage, lane caps, demotion) is excluding everything.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the eligibility assessment and request construction in src/core/routing, the budget policy this repository owns, or the producers minting the requests.${PINNED} If the empty view is correct — genuinely no seat can serve the request and the caller's fallback is intended — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function seatShadowEvidenceItem(cell: SeatShadowEvidenceCell, repo: string): CloudBacklogItem {
  const prompt = cell.kind === 'exclusion' ? exclusionPrompt(cell) : emptyPrompt(cell);
  const title = cell.kind === 'exclusion'
    ? `Seat-router shadow routes keep excluding ${cell.seatId}: ${cell.reasonKind}`
    : cell.subKind === 'no-seats'
      ? `Seat router records an empty seat view for ${cell.autonomous ? 'autonomous' : 'interactive'} ${cell.task} requests via ${cell.source}`
      : `Seat router keeps excluding every seat for ${cell.autonomous ? 'autonomous' : 'interactive'} ${cell.task} requests via ${cell.source}`;
  const idKey = cell.kind === 'exclusion'
    ? `seat-exclusion:${cell.seatId}:${cell.reasonKind}`
    : `empty:${cell.source}:${cell.task}:${cell.autonomous}:${cell.subKind}`;
  return {
    id: `seat-shadow-evidence-${sha(idKey)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: cell.kind === 'exclusion' ? 'seat-shadow-evidence-exclusion' : 'seat-shadow-evidence-empty',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the seat-router shadow journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function seatShadowEvidenceBacklogItems(opts: SeatShadowEvidenceItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? SEAT_SHADOW_EVIDENCE_WINDOW_HOURS;
    const journalPath = opts.journalPath ?? decisionsLogPath();
    // The writer rotates at DECISIONS_LOG_MAX_BYTES keeping one .1
    // predecessor; read both tails so the window reaches back across a
    // rotation, oldest file first.
    const previousPath = journalPath.replace(/\.jsonl$/, '.1.jsonl');
    const [current, previous] = await Promise.all([
      readLedgerTail(journalPath, DECISIONS_LOG_MAX_BYTES),
      previousPath === journalPath ? Promise.resolve({ state: 'missing' as const }) : readLedgerTail(previousPath, DECISIONS_LOG_MAX_BYTES),
    ]);
    const texts: string[] = [];
    let lowerBound = false;
    if (previous.state === 'read') {
      texts.push(previous.text);
      lowerBound = previous.truncated;
    }
    if (current.state === 'read') {
      texts.push(current.text);
      lowerBound = lowerBound || current.truncated;
    } else if (texts.length === 0) {
      return [];
    }
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so both tails fold whole.
    const fold = foldSeatShadowEvidence(texts, nowMs, windowHours);
    if (fold.rows === 0) return [];
    const cells = seatShadowEvidenceCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? SEAT_SHADOW_EVIDENCE_MAX_ITEMS, SEAT_SHADOW_EVIDENCE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => seatShadowEvidenceItem(cell, repo));
  } catch {
    return [];
  }
}
