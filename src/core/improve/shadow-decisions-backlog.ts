/**
 * ~/.ashlr/routing/decisions.jsonl shadow-decision rows → self-improvement
 * backlog items.
 *
 * The seat router's own counterfactual journal: recordShadowDecision
 * (src/core/routing/budget-store.ts) appends one {v:1, at, source, request,
 * decision, actual} row per shadow evaluation — the daemon's
 * shadowSeatRouteBeside beside every dispatched work item, the fleet
 * tick-hooks-live shadow port, the leader-seat route, the router-gateway
 * completion path, best-of-n and the Verse autonomy ladder. Each row
 * carries the full SeatDecision the router WOULD have returned against
 * the published capacity snapshot: the chosen seatId (null when nothing
 * was eligible), the ranked candidates, every ineligible seat with its
 * reason sentences and the structured SeatReason details (kind per
 * exclusion), the plain-language why, and — on daemon rows — what
 * actually ran for the comparison shadow mode exists for. The journal
 * rotates at 2 MB keeping one previous generation.
 *
 * Until now its only readers were display and attribution surfaces:
 * `phm telemetry`'s decision section, the Verse autonomy ladder's shadow
 * projection and the reserve-breach attributor — none of which queue
 * work, and none of which fold a recurrence. A seat whose eligibility
 * evidence stays broken in nearly every shadow evaluation, a work class
 * the seat router keeps declining with broken evidence aboard, or a
 * capacity snapshot that keeps publishing an empty seat table was
 * invisible history: recurring adverse routing evidence that never
 * became a backlog item. shadowDecisionsBacklogItems carries the same
 * rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. decisions.jsonl and its rotated predecessor are read
 *    through readLedgerTail's bounded no-follow tails —
 *    DECISIONS_LOG_MAX_BYTES each, the writer's own rotation bound —
 *    and nothing is written and no network is touched. A missing or
 *    unreadable file yields no items; a malformed line is skipped,
 *    never guessed.
 *  - Rows count only under the journal's own contract: v:1 records with
 *    a parseable `at` inside the window, a source inside the writer's
 *    closed SHADOW_SOURCES vocabulary, an object request and an object
 *    decision carrying the SeatDecision fields the fold reads (seatId,
 *    candidates, exclusions, why). Rows missing them contribute
 *    nothing.
 *  - Recurring means recorded across evaluations and days: a cell emits
 *    only at SHADOW_DECISIONS_MIN_ROWS contributing rows across
 *    SHADOW_DECISIONS_MIN_DAYS distinct UTC days inside the 7-day
 *    window — each row is already one distinct routing evaluation, so
 *    row count (not a re-evaluated item id) is the event count, and the
 *    day bar keeps one dispatch burst from minting a pattern.
 *  - Seat-exclusion cells name only evidence-broken kinds
 *    (SHADOW_DECISIONS_ADVERSE_KINDS): 'unknown-usage', 'unreachable',
 *    'signed-out' and 'other' — the same adverse-vs-designed split the
 *    runtime-journal fold applies, since these rows carry the same
 *    SeatReason vocabulary. Capacity-truth exclusions (headroom, spent,
 *    reserve, session-ceiling, model-window, context) and policy
 *    exclusions (grant, lane, switched-off, demoted, task-arm) are the
 *    router working as designed and never emit. Exclusions without
 *    structured details (older records) contribute nothing.
 *  - No-seat cells count only decisions that found NO eligible seat
 *    while at least one exclusion carried an evidence-broken kind —
 *    a decline explainable purely by capacity or policy is intended
 *    backpressure and never emits. The cell's prompt quotes the full
 *    reason-kind mix so the reader sees how much of the decline is
 *    broken evidence versus genuine capacity.
 *  - Empty-evaluation cells count decisions whose seat table was
 *    literally empty — no candidates and no exclusions — per source:
 *    the router ran blind, which means the published capacity snapshot
 *    carried zero seats or the evaluation degenerated. Whether that is
 *    a broken publisher or a deliberately seatless fleet is exactly
 *    what the item asks the agent to determine.
 *  - The `actual` field is never folded: mapping a chosen seatId to the
 *    engine that ran needs the seat table at decision time, which the
 *    journal does not carry — divergence claims would be guesses.
 *  - Truncation is stated, never hidden: when either bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's routing and carries no repo column. Dedup is downstream:
 *    the item id hashes the cell identity, never counts or timestamps,
 *    so a refresh re-derives the same id and a recovered cell simply
 *    stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { decisionsLogPath, DECISIONS_LOG_MAX_BYTES } from '../routing/budget-store.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell kinds are small closed vocabularies. */
export const SHADOW_DECISIONS_BACKLOG_MAX_ITEMS = 12;
const SHADOW_DECISIONS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const SHADOW_DECISIONS_WINDOW_HOURS = 168;
/** A cell emits only at this many contributing decision rows... */
export const SHADOW_DECISIONS_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days. */
export const SHADOW_DECISIONS_MIN_DAYS = 2;
/** The fleet's own repository label: shadow-routing evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's closed source vocabulary (budget-store.ts SHADOW_SOURCES; the const itself is module-private). */
const SHADOW_SOURCES: readonly string[] = ['daemon', 'gateway', 'best-of-n', 'leader', 'verse', 'test'];
/** Exclusion reason kinds that mean the seat's eligibility EVIDENCE is broken or missing — never ordinary capacity or policy states. */
export const SHADOW_DECISIONS_ADVERSE_KINDS: ReadonlySet<string> = new Set([
  'unknown-usage',
  'unreachable',
  'signed-out',
  'other',
]);
/** The router's closed task vocabulary (RoutingTask); anything else folds as 'unknown'. */
const SAFE_TASKS: readonly string[] = ['code', 'review', 'plan', 'bulk', 'leader'];
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
/** Source/task/kind tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Exclusion pairs one row may contribute per seat (bounded by the writer's own detail cap). */
const MAX_ROW_EXCLUSION_PAIRS = 64;

export interface ShadowDecisionsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: decisionsLogPath(), the writer's own ~/.ashlr/routing/decisions.jsonl). */
  journalPath?: string;
  /** Evidence window in hours (default SHADOW_DECISIONS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default SHADOW_DECISIONS_BACKLOG_MAX_ITEMS, hard-capped). */
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
  /** (seatId, kind) pairs whose kind is in SHADOW_DECISIONS_ADVERSE_KINDS, deduped within the row. */
  adverse: { seatId: string; kind: string }[];
  /** Every bounded-shape reason kind the row's exclusions carried (no-seat cell context). */
  kinds: string[];
  /** True when at least one exclusion carried an adverse kind. */
  hasAdverse: boolean;
}

function rowExclusions(decision: Record<string, unknown>): RowExclusions | null {
  if (!Array.isArray(decision['exclusions'])) return null;
  const adverse: { seatId: string; kind: string }[] = [];
  const kinds = new Set<string>();
  const seen = new Set<string>();
  let hasAdverse = false;
  for (const exclusion of decision['exclusions']) {
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
      if (!SHADOW_DECISIONS_ADVERSE_KINDS.has(kind)) continue;
      hasAdverse = true;
      const pair = `${seatId}${kind}`;
      if (seen.has(pair) || adverse.length >= MAX_ROW_EXCLUSION_PAIRS) continue;
      seen.add(pair);
      adverse.push({ seatId, kind });
    }
  }
  return { adverse, kinds: [...kinds], hasAdverse };
}

interface ParsedRow {
  atMs: number;
  source: string;
  task: string;
  /** The decision's chosen seat; null when the router found nothing eligible. */
  seatId: string | null;
  candidateCount: number;
  exclusionCount: number;
  exclusions: RowExclusions | null;
}

/** The journal's decision-row contract, field by field; null for anything else. */
function parseDecisionRow(value: unknown): ParsedRow | null {
  if (!isRecord(value) || value['v'] !== 1) return null;
  const at = value['at'];
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const source = value['source'];
  if (typeof source !== 'string' || !SHADOW_SOURCES.includes(source)) return null;
  const request = value['request'];
  if (!isRecord(request)) return null;
  const decision = value['decision'];
  if (!isRecord(decision)) return null;
  const candidates = decision['candidates'];
  const exclusions = decision['exclusions'];
  if (typeof decision['why'] !== 'string' || !Array.isArray(candidates) || !Array.isArray(exclusions)) return null;
  const taskRaw = request['task'];
  const task = typeof taskRaw === 'string' && SAFE_TASKS.includes(taskRaw) ? taskRaw : 'unknown';
  const seatIdRaw = decision['seatId'];
  const seatId = typeof seatIdRaw === 'string' && seatIdRaw !== '' ? fieldText(seatIdRaw, MAX_NAME_CHARS) || null : null;
  return {
    atMs,
    source,
    task,
    seatId,
    candidateCount: candidates.length,
    exclusionCount: exclusions.length,
    exclusions: rowExclusions(decision),
  };
}

/** Per-(seatId, kind) in-window fold before the recurring bars apply. */
export interface SeatExclusionFold {
  seatId: string;
  kind: string;
  /** Contributing decision rows (each row contributes a pair at most once). */
  rows: number;
  /** Distinct UTC days the contributing rows landed on. */
  days: Set<string>;
  /** Source tallies across the cell's rows. */
  sources: Map<string, number>;
  /** Task tallies across the cell's rows ('unknown' when the request named no known task). */
  tasks: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** A (source, task) cell: recurring no-eligible-seat decisions with broken evidence aboard. */
export interface NoSeatFold {
  source: string;
  task: string;
  rows: number;
  days: Set<string>;
  /** Every bounded reason kind the rows' exclusions carried — the decline's capacity-vs-evidence mix. */
  kinds: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** A source cell: recurring decisions that evaluated an empty seat table. */
export interface EmptyEvalFold {
  source: string;
  rows: number;
  days: Set<string>;
  /** Task tallies across the cell's rows. */
  tasks: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface ShadowDecisionsFold {
  /** In-window decision rows — the share denominator the prompts quote. */
  rows: number;
  exclusions: Map<string, SeatExclusionFold>;
  noSeat: Map<string, NoSeatFold>;
  emptyEval: Map<string, EmptyEvalFold>;
  /** Non-blank lines that were not decision records. */
  malformed: number;
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

/**
 * Pure: fold journal text(s) — current tail and rotated predecessor, oldest
 * first — into per-cell recurring evidence. Rows outside the window,
 * undated, malformed or foreign-shaped are skipped, never guessed.
 */
export function foldShadowDecisions(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): ShadowDecisionsFold {
  const fold: ShadowDecisionsFold = {
    rows: 0,
    exclusions: new Map(), noSeat: new Map(), emptyEval: new Map(), malformed: 0,
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { fold.malformed++; continue; }
      const row = parseDecisionRow(value);
      if (row === null) { fold.malformed++; continue; }
      if (row.atMs < since || row.atMs > until) continue;
      fold.rows += 1;
      const day = dayOf(row.atMs);

      // Seat-exclusion cells: every (seatId, adverse-kind) pair the row's
      // decision carried — chosen or declined, the evaluation happened.
      if (row.exclusions !== null) {
        for (const pair of row.exclusions.adverse) {
          const key = `${pair.seatId}${pair.kind}`;
          let cell = fold.exclusions.get(key);
          if (cell === undefined) {
            cell = { seatId: pair.seatId, kind: pair.kind, rows: 0, days: new Set(), sources: new Map(), tasks: new Map(), firstMs: null, lastMs: null };
            fold.exclusions.set(key, cell);
          }
          cell.rows += 1;
          cell.days.add(day);
          bump(cell.sources, row.source);
          bump(cell.tasks, row.task);
          touch(cell, row.atMs);
        }
      }

      if (row.seatId !== null) continue;

      // No-seat cells: the router found nothing eligible while broken
      // evidence rode along — designed capacity/policy declines never emit.
      if (row.exclusionCount > 0 && row.exclusions !== null && row.exclusions.hasAdverse) {
        const key = `${row.source}${row.task}`;
        let cell = fold.noSeat.get(key);
        if (cell === undefined) {
          cell = { source: row.source, task: row.task, rows: 0, days: new Set(), kinds: new Map(), firstMs: null, lastMs: null };
          fold.noSeat.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(day);
        for (const kind of row.exclusions.kinds) bump(cell.kinds, kind);
        touch(cell, row.atMs);
        continue;
      }

      // Empty-evaluation cells: no seat chosen, no candidates, no
      // exclusions — the router ran against an empty seat table.
      if (row.candidateCount === 0 && row.exclusionCount === 0) {
        const key = row.source;
        let cell = fold.emptyEval.get(key);
        if (cell === undefined) {
          cell = { source: row.source, rows: 0, days: new Set(), tasks: new Map(), firstMs: null, lastMs: null };
          fold.emptyEval.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(day);
        bump(cell.tasks, row.task);
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
  /** Sanitized recorded text (a source, task or kind label). */
  text: string;
  count: number;
}

interface CellBase {
  /** Contributing decision rows inside the window. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window decision rows overall — the share denominator. */
  decisionRows: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

export interface SeatExclusionCell extends CellBase {
  kind: 'seat-exclusion';
  seatId: string;
  reasonKind: string;
  sources: UsageTally[];
  tasks: UsageTally[];
}

export interface NoSeatCell extends CellBase {
  kind: 'no-seat';
  source: string;
  task: string;
  /** Every bounded reason kind the rows' exclusions carried, most frequent first. */
  reasonKinds: UsageTally[];
}

export interface EmptyEvalCell extends CellBase {
  kind: 'empty-eval';
  source: string;
  tasks: UsageTally[];
}

export type ShadowDecisionsCell = SeatExclusionCell | NoSeatCell | EmptyEvalCell;

function tallyOf(map: Map<string, number>, max: number): UsageTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const baseOf = (
  rows: number, days: Set<string>, firstMs: number | null, lastMs: number | null,
  decisionRows: number, lowerBound: boolean,
): Omit<CellBase, 'days'> & { days: string[] } => ({
  rows,
  days: [...days].sort(),
  decisionRows,
  firstSeen: isoOrNull(firstMs),
  lastSeen: isoOrNull(lastMs),
  lowerBound,
});

const recurring = (cell: { rows: number; days: Set<string> }): boolean =>
  cell.rows >= SHADOW_DECISIONS_MIN_ROWS && cell.days.size >= SHADOW_DECISIONS_MIN_DAYS;

/**
 * Pure: recurring cells — a (seat, kind) adverse exclusion, a (source,
 * task) no-eligible-seat decline with broken evidence aboard, or a
 * source's empty seat-table evaluations — each at the row and day bars.
 */
export function shadowDecisionCells(fold: ShadowDecisionsFold, lowerBound = false): ShadowDecisionsCell[] {
  const cells: ShadowDecisionsCell[] = [];
  const decisionRows = fold.rows;
  for (const cell of fold.exclusions.values()) {
    if (!recurring(cell)) continue;
    cells.push({
      kind: 'seat-exclusion',
      ...baseOf(cell.rows, cell.days, cell.firstMs, cell.lastMs, decisionRows, lowerBound),
      seatId: cell.seatId,
      reasonKind: cell.kind,
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      tasks: tallyOf(cell.tasks, MAX_PROMPT_TALLIES),
    });
  }
  for (const cell of fold.noSeat.values()) {
    if (!recurring(cell)) continue;
    cells.push({
      kind: 'no-seat',
      ...baseOf(cell.rows, cell.days, cell.firstMs, cell.lastMs, decisionRows, lowerBound),
      source: cell.source,
      task: cell.task,
      reasonKinds: tallyOf(cell.kinds, MAX_PROMPT_TALLIES),
    });
  }
  for (const cell of fold.emptyEval.values()) {
    if (!recurring(cell)) continue;
    cells.push({
      kind: 'empty-eval',
      ...baseOf(cell.rows, cell.days, cell.firstMs, cell.lastMs, decisionRows, lowerBound),
      source: cell.source,
      tasks: tallyOf(cell.tasks, MAX_PROMPT_TALLIES),
    });
  }
  // Worst first inside each kind; kinds ordered seat-exclusion, no-seat, empty-eval.
  const rank = (c: ShadowDecisionsCell): number =>
    c.kind === 'seat-exclusion' ? 0 : c.kind === 'no-seat' ? 1 : 2;
  return cells.sort((a, b) => rank(a) - rank(b) || b.rows - a.rows || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/routing/decisions.jsonl under the user\'s home (the writer\'s own path — it does not follow $ASHLR_HOME): the seat router\'s append-only shadow-decision journal. recordShadowDecision (src/core/routing/budget-store.ts) appends one {v:1, at, source, request, decision, actual} row per shadow evaluation — the daemon\'s shadowSeatRouteBeside beside every dispatched work item (src/core/daemon/loop.ts, gated by the seatRouterShadow capacity flag), the fleet tick-hooks-live shadow port, the leader-seat route (src/core/vision/leader-seat.ts), the router-gateway completion path (src/core/router-gateway/deps.ts) and the budget API — each carrying the SeatDecision the router would have returned against the published capacity snapshot (~/.ashlr/routing/capacity.json): chosen seatId, ranked candidates, every ineligible seat with its reason sentences and structured SeatReason details, and what actually ran on daemon rows. The journal rotates at 2 MB keeping one previous generation. Its only readers until this feed were display and attribution surfaces — `phm telemetry`, the Verse autonomy ladder\'s shadow projection and the reserve-breach attributor — which render or attribute rows but never fold a recurrence into work.';

const REPRO = 'Reproduce the fold by reading the newest decision rows — the JSONL directly under ~/.ashlr/routing/ (decisions.jsonl plus the rotated decisions.1.jsonl), or `phm telemetry --json` which renders the same records — and filtering v:1 rows inside the window. The writers and folds this repository owns are src/core/routing/budget-store.ts (the journal contract, rotation and readers), src/core/routing/router.ts and seat-reasons.ts (routeSeat, the exclusion reason kinds), src/core/routing/types.ts (RoutingRequest, SeatDecision, SeatReason) and the producers that call recordShadowDecision: src/core/daemon/loop.ts (shadowSeatRouteBeside), src/core/fleet/tick-hooks-live.ts (the shadow hook), src/core/vision/leader-seat.ts, src/core/router-gateway/deps.ts and src/core/routing/budget-api.ts.';

const NO_CHANGE = 'If the window has rolled forward, the pattern was a one-off burst the fleet recovered from, the exclusions reflect intended policy or genuine capacity that has since cleared, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

const PINNED = ' contrib/mac\'s dispatchd.py, launch.sh and the live copies under ~/.ashlr-runs/bin are pinned ops machinery: Security-reviewed, re-pinned, never edited live — name pinned-side findings for the owner rather than working around them.';

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
  cell.decisionRows > 0 ? ` (${Math.round((cell.rows / cell.decisionRows) * 100)}% of the ${cell.decisionRows} in-window shadow decisions)` : '';

/** What each adverse exclusion kind means in the router's own vocabulary. */
const KIND_HINTS: Record<string, string> = {
  'unknown-usage': 'the seat\'s usage reading is missing or unreadable, so the router fails closed rather than guess headroom',
  'unreachable': 'the seat\'s reachability probe keeps failing',
  'signed-out': 'the seat\'s recorded auth state reads signed out',
  'other': 'the exclusion reason did not fit the router\'s reason taxonomy',
};

function seatExclusionPrompt(cell: SeatExclusionCell): string {
  const hint = KIND_HINTS[cell.reasonKind];
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const tasks = cell.tasks.length === 0 ? '' : ` Recorded request tasks: ${tallyText(cell.tasks)}.`;
  return [
    `Phantom's shadow routing journal keeps recording seat-router evaluations that exclude seat '${cell.seatId}' for '${cell.reasonKind}' — ${cell.rows} contributing decision(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each decision row's SeatDecision lists every ineligible seat with its reason kinds; '${cell.reasonKind}'${hint === undefined ? ' is not one of the usual capacity or policy states' : ` means ${hint}`}.${shareText(cell)}${sources}${tasks}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this seat's eligibility evidence stays broken in the shadow path: read the newest decision rows and the seat's latest capacity snapshot (~/.ashlr/routing/capacity.json, published by the Verse server's account collector), then check the evidence path the kind names — the usage-capture chain for 'unknown-usage' (the same capture gaps the usage-gap feed tracks at the jobs-ledger layer), the reachability probe for 'unreachable', the auth/session state for 'signed-out', and the reason taxonomy in src/core/routing for 'other'. A seat excluded this way in nearly every evaluation is dead capacity the fleet keeps paying to assess while routing around it — or a probe that misreads a healthy seat.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the eligibility assessment in src/core/routing, the probe or capture path that feeds it, or the taxonomy that leaves reasons unclassified.${PINNED} If the exclusion is genuine and intended — the seat really is off, unreachable or signed out and the router correctly routes around it — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function noSeatPrompt(cell: NoSeatCell): string {
  const kinds = cell.reasonKinds.length === 0 ? '' : ` Reason kinds across the contributing rows' exclusions: ${tallyText(cell.reasonKinds)}.`;
  return [
    `Phantom's shadow routing journal keeps recording '${cell.source}' decisions that found NO eligible seat for '${cell.task}' work while broken eligibility evidence rode along — ${cell.rows} contributing decision(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `These are SeatDecisions with seatId null and a non-empty exclusion list where at least one seat was excluded on an evidence-broken kind (unknown-usage, unreachable, signed-out or other) — declines explainable purely by capacity or policy never reach this cell.${kinds}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find whether the seat pool is genuinely saturated or the evidence feeding it is broken: read the newest decision rows for this source and task, compare the exclusion mix against the capacity snapshot's own seat states (~/.ashlr/routing/capacity.json), and check whether one systemic cause — a stale snapshot, a probe outage marking many seats unreachable, a usage capture gap marking them unknown-usage — is declining work the fleet could otherwise seat. A work class the seat router keeps refusing while seats sit idle on broken readings is lost capacity; a class it keeps refusing on true capacity is the pool honestly reporting it is full.`,
    '',
    `Fix what lives here — the capacity snapshot producer or its freshness, the eligibility assessment in src/core/routing, the probe or capture path feeding the snapshot, or the arm/policy configuration steering this task class.${PINNED} If the declines reflect genuine saturation or intended policy that has since cleared, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function emptyEvalPrompt(cell: EmptyEvalCell): string {
  const tasks = cell.tasks.length === 0 ? '' : ` Recorded request tasks: ${tallyText(cell.tasks)}.`;
  return [
    `Phantom's shadow routing journal keeps recording '${cell.source}' decisions that evaluated an EMPTY seat table — no chosen seat, no candidates and no exclusions — ${cell.rows} contributing decision(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `A decision with seatId null, empty candidates and empty exclusions means routeSeat ran against a capacity snapshot carrying zero seats (or the evaluation degenerated before any seat was assessed) — the shadow path produced no routing signal at all for these requests.${tasks}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find out which side is wrong: read the newest decision rows for this source and check ~/.ashlr/routing/capacity.json — if the snapshot publishes zero seats while the fleet's seat configuration expects some, the capacity publisher or its collector is broken and every shadow evaluation is blind; if the fleet genuinely runs seatless, the shadow path is recording noise and the flag or producer should stop. Check the snapshot writer (the Verse server's account collector) and the seatRouterShadow gate that lets these evaluations run.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the seat configuration it publishes, or the shadow-evaluation gate in src/core that keeps spending evaluations on an empty table.${PINNED} If the fleet intentionally runs with no seats and the empty evaluations are harmless, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function shadowDecisionItem(cell: ShadowDecisionsCell, repo: string): CloudBacklogItem {
  const prompt = cell.kind === 'seat-exclusion'
    ? seatExclusionPrompt(cell)
    : cell.kind === 'no-seat'
      ? noSeatPrompt(cell)
      : emptyEvalPrompt(cell);
  const title = cell.kind === 'seat-exclusion'
    ? `Shadow seat routing keeps excluding '${fieldText(cell.seatId, MAX_NAME_CHARS)}': ${cell.reasonKind}`
    : cell.kind === 'no-seat'
      ? `Shadow seat routing keeps declining '${cell.task}' work (${cell.source}): no eligible seat`
      : `Shadow seat routing keeps evaluating an empty seat table (${cell.source})`;
  const idKey = cell.kind === 'seat-exclusion'
    ? `seat-exclusion:${cell.seatId}:${cell.reasonKind}`
    : cell.kind === 'no-seat'
      ? `no-seat:${cell.source}:${cell.task}`
      : `empty-eval:${cell.source}`;
  return {
    id: `shadow-decisions-${sha(idKey)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `shadow-${cell.kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the shadow routing journal's recurring adverse
 * decision evidence. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function shadowDecisionsBacklogItems(opts: ShadowDecisionsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? SHADOW_DECISIONS_WINDOW_HOURS;
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
    const fold = foldShadowDecisions(texts, nowMs, windowHours);
    if (fold.rows === 0) return [];
    const cells = shadowDecisionCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? SHADOW_DECISIONS_BACKLOG_MAX_ITEMS, SHADOW_DECISIONS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => shadowDecisionItem(cell, repo));
  } catch {
    return [];
  }
}
