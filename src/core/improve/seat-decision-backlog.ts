/**
 * Seat-routing decision journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `recordShadowDecision` (src/core/routing/budget-store.ts) appends one
 * ShadowDecisionRecord to ~/.ashlr/routing/decisions.jsonl — and its
 * decisions.1.jsonl predecessor after the 2 MB rotation — on every seat
 * routing evaluation the fleet records: the daemon's live routeWorkItem
 * seatDecision beside each dispatch, the beside-dispatch shadow
 * comparison (`actual: { engine, seatId: null }` — what the legacy path
 * ACTUALLY ran while the seat router's capacity-snapshot view decided),
 * and the non-dispatch routing surfaces — the router gateway's API
 * completions and the leader's seat choice — which carry `actual: null`
 * because nothing downstream is known at record time. Every row carries
 * the full SeatDecision: the chosen seatId (null when nothing was
 * eligible), the ranked candidates, every exclusion with its structured
 * reason kinds, the budget mode and the plain-language why.
 *
 * Until now the journal's only readers were display and attribution
 * surfaces — the budget decisions route, the Fleet router decision
 * timeline and `phm telemetry` — plus reserve-breach attribution, none
 * of which queue work. The dispatch path's own per-item evidence already
 * reaches this backlog through runtime-journal-backlog
 * (fleet/runtime/runs.jsonl), so this feed deliberately covers only the
 * evidence that journal cannot see:
 *
 *   - comparison rows (`actual.engine` set with `actual.seatId` null —
 *     the shadow-beside shape no other writer produces): a 'shadow-blind'
 *     cell emits while the seat router's snapshot view kept finding NO
 *     eligible seat (`decision.seatId === null`) on evaluations whose
 *     work ran anyway on the recorded legacy engine — recurring across
 *     distinct UTC days. While this holds the shadow comparison stream
 *     is measuring a router that sees a different fleet than the one
 *     dispatching: the capacity snapshot is stale, its publisher is
 *     down, or every seat's recorded evidence reads unusable while
 *     reality differs — exactly the condition that must be fixed before
 *     any seat-router enforcement decision trusts the stream.
 *   - surface rows (`actual === null` on a non-daemon, non-test source —
 *     routing evaluations that never become dispatches): a 'no-seat'
 *     cell per source emits while that surface keeps finding zero
 *     eligible seats, and a 'seat-excluded' cell per (seatId, reason
 *     kind) emits while a surface keeps excluding one seat for
 *     evidence-broken kinds — the same adverse vocabulary
 *     runtime-journal-backlog applies (unknown-usage, unreachable,
 *     signed-out, other; capacity-truth and policy kinds never emit).
 *     A seat whose usage reading, reachability probe or auth state is
 *     broken on the gateway or leader routing path produces no dispatch
 *     row at all, so without this feed that evidence was invisible.
 *
 * Daemon-source rows that are not comparison rows — the live
 * routeWorkItem seatDecisions and the held dispatch evaluations — are
 * the dispatch path's own record and stay with
 * runtime-journal-backlog; 'test'-source rows are not fleet evidence
 * and never fold. Rows whose `actual` names a seat are live dispatched
 * decisions — the same dispatch-path record — and skip the same way.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both journal generations are read through readLedgerTail's
 *    bounded no-follow tails at the writer's own DECISIONS_LOG_MAX_BYTES
 *    rotation bound; nothing is written and no network is touched. A
 *    missing or unreadable file yields no items; a malformed line is
 *    skipped, never guessed.
 *  - Rows count only under the writer's contract: v:1, a parseable `at`,
 *    a source inside the ShadowDecisionSource vocabulary, a request
 *    inside the RoutingRequest shape and a decision carrying the
 *    SeatDecision contract isDecisionRecord enforces (seatId null or a
 *    bounded seat id, candidates/exclusions arrays, a why string). Rows
 *    failing the contract count as invalid, never partially trusted.
 *  - Recurring means recorded across days: every cell emits only at
 *    SEAT_DECISION_MIN_ROWS evidence rows across SEAT_DECISION_MIN_DAYS
 *    distinct UTC days inside the 7-day window — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply.
 *  - Truncation is stated, never hidden: when either bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling fleet-evidence
 *    sources apply — since the journal describes this install's
 *    routing layer. Dedup is downstream: the item id hashes the cell
 *    identity, never counts or timestamps, so a refresh re-derives the
 *    same id and a recovered cell simply stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import {
  DECISIONS_LOG_MAX_BYTES,
  decisionsLogPath,
} from '../routing/budget-store.js';
import { BUDGET_SEAT_ID_RE } from '../routing/policy.js';
import { RUNTIME_JOURNAL_ADVERSE_KINDS } from './runtime-journal-backlog.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; one blind cell, five surface sources and bounded seat cells stay under this. */
export const SEAT_DECISION_BACKLOG_MAX_ITEMS = 10;
const SEAT_DECISION_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const SEAT_DECISION_WINDOW_HOURS = 168;
/** A cell emits only at this many in-window evidence rows... */
export const SEAT_DECISION_MIN_ROWS = 4;
/** ...across at least this many distinct UTC days — recurring means recorded across days. */
export const SEAT_DECISION_MIN_DAYS = 2;
/** The fleet's own repository label: seat-decision evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Reason-kind and engine tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Exclusion pairs one row may contribute (bounded like the sibling fold). */
const MAX_ROW_EXCLUSION_PAIRS = 64;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;

/** The writer's source vocabulary (ShadowDecisionSource in budget-store.ts). */
const DECISION_SOURCES: ReadonlySet<string> = new Set(['daemon', 'gateway', 'best-of-n', 'leader', 'verse', 'test']);
/** Exclusion reason kinds are the router's closed lowercase vocabulary; a bounded shape keeps foreign text out of cells. */
const SAFE_REASON_KIND = /^[a-z][a-z0-9-]{0,39}$/;
/** `actual.engine` is the caller's backend name, scrubbed and capped at 64 chars by the writer. */
const SAFE_ENGINE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROUTING_TASKS: ReadonlySet<string> = new Set(['code', 'review', 'plan', 'bulk', 'leader']);
const ROUTING_DIFFICULTIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

export interface SeatDecisionItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: decisionsLogPath(), the writer's own ~/.ashlr/routing/decisions.jsonl). */
  journalPath?: string;
  /** Evidence window in hours (default SEAT_DECISION_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default SEAT_DECISION_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window in ms epoch (default: now). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the decision rows of the journal tails
// ---------------------------------------------------------------------------

/** One row's adverse (seatId, kind) exclusion pairs plus every bounded reason kind its decision carried. */
interface RowExclusions {
  /** (seatId, kind) pairs whose kind is in the shared adverse set, deduped within the row. */
  adverse: { seatId: string; kind: string }[];
  /** Every bounded-shape reason kind the row's exclusions carried (cell context). */
  kinds: Map<string, number>;
}

function rowExclusions(decision: Record<string, unknown>): RowExclusions {
  const adverse: { seatId: string; kind: string }[] = [];
  const kinds = new Map<string, number>();
  const seen = new Set<string>();
  const exclusions = decision['exclusions'];
  if (!Array.isArray(exclusions)) return { adverse, kinds };
  for (const exclusion of exclusions) {
    if (!isRecord(exclusion)) continue;
    const seatId = exclusion['seatId'];
    if (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId)) continue;
    const details = exclusion['details'];
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const kind = detail['kind'];
      if (typeof kind !== 'string' || !SAFE_REASON_KIND.test(kind)) continue;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      if (!RUNTIME_JOURNAL_ADVERSE_KINDS.has(kind)) continue;
      const pair = `${seatId} ${kind}`;
      if (seen.has(pair) || adverse.length >= MAX_ROW_EXCLUSION_PAIRS) continue;
      seen.add(pair);
      adverse.push({ seatId, kind });
    }
  }
  return { adverse, kinds };
}

/** The row classes this feed reads; everything else is dispatch-path or foreign evidence. */
type RowClass = 'comparison' | 'surface' | 'skip';

interface ParsedRow {
  atMs: number;
  day: string;
  cls: Exclude<RowClass, 'skip'>;
  source: string;
  autonomous: boolean;
  /** decision.seatId — null when the evaluation found nothing eligible. */
  seatId: string | null;
  /** True when the decision saw no seats at all (empty candidates AND exclusions — 'No seats are known'). */
  noSeatsKnown: boolean;
  /** actual.engine on comparison rows; null elsewhere. */
  engine: string | null;
  kinds: Map<string, number>;
  adverse: { seatId: string; kind: string }[];
}

/**
 * One journal line → a classified row, or null. The contract is the
 * writer's own (isDecisionRecord in budget-store.ts) tightened with the
 * field shapes the fold reads; anything less is an invalid row — counted,
 * never partially trusted.
 */
function parseRow(line: string): { row: ParsedRow | null; invalid: boolean } {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { row: null, invalid: true }; }
  if (!isRecord(raw) || raw['v'] !== 1) return { row: null, invalid: true };
  const at = raw['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return { row: null, invalid: true };
  const source = raw['source'];
  if (typeof source !== 'string' || !DECISION_SOURCES.has(source)) return { row: null, invalid: true };
  const request = raw['request'];
  if (!isRecord(request) || typeof request['task'] !== 'string' || !ROUTING_TASKS.has(request['task']) ||
      typeof request['difficulty'] !== 'string' || !ROUTING_DIFFICULTIES.has(request['difficulty']) ||
      typeof request['autonomous'] !== 'boolean') {
    return { row: null, invalid: true };
  }
  const decision = raw['decision'];
  if (!isRecord(decision) || typeof decision['why'] !== 'string' ||
      !Array.isArray(decision['candidates']) || !Array.isArray(decision['exclusions'])) {
    return { row: null, invalid: true };
  }
  const seatId = decision['seatId'];
  if (seatId !== null && (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId))) {
    return { row: null, invalid: true };
  }
  // `actual`: null, or { engine, seatId } — the writer always writes both
  // fields when present. A named seat means a live dispatched decision
  // (dispatch-path evidence); engine + null seat is the shadow-beside
  // comparison shape.
  const actual = raw['actual'];
  let cls: RowClass;
  let engine: string | null = null;
  if (actual === null || actual === undefined) {
    cls = source === 'daemon' || source === 'test' ? 'skip' : 'surface';
  } else if (isRecord(actual)) {
    const actualEngine = actual['engine'];
    const actualSeat = actual['seatId'];
    if (typeof actualEngine !== 'string' || !SAFE_ENGINE.test(actualEngine) ||
        (actualSeat !== null && (typeof actualSeat !== 'string' || !BUDGET_SEAT_ID_RE.test(actualSeat)))) {
      return { row: null, invalid: true };
    }
    if (actualSeat !== null) {
      cls = 'skip'; // live dispatched decision — runtime-journal-backlog's record
    } else {
      cls = 'comparison';
      engine = actualEngine;
    }
  } else {
    return { row: null, invalid: true };
  }
  if (source === 'test' || cls === 'skip') return { row: null, invalid: false };
  const { adverse, kinds } = rowExclusions(decision);
  const exclusions = decision['exclusions'];
  const candidates = decision['candidates'];
  return {
    row: {
      atMs,
      day: new Date(atMs).toISOString().slice(0, 10),
      cls,
      source,
      autonomous: request['autonomous'] as boolean,
      seatId: seatId as string | null,
      noSeatsKnown: Array.isArray(candidates) && candidates.length === 0 &&
        Array.isArray(exclusions) && exclusions.length === 0,
      engine,
      kinds,
      adverse,
    },
    invalid: false,
  };
}

export interface SeatDecisionFold {
  /** Valid in-window records the fold classified (comparison + surface). */
  rows: number;
  /** Retained-tail lines that failed JSON parse or the writer's record contract. */
  invalidRows: number;
  /** Valid rows skipped as dispatch-path or test evidence (counted for honesty). */
  skippedRows: number;
  /** Shadow-beside comparison rows (actual.engine ran while the snapshot view decided). */
  comparisons: number;
  /** Comparison rows whose seat router view found no eligible seat while work ran anyway. */
  blind: number;
  /** Blind rows where the view saw no seats at all vs seats that were all excluded. */
  blindNoSeats: number;
  blindAllExcluded: number;
  blindDays: Set<string>;
  blindEngines: Map<string, number>;
  blindKinds: Map<string, number>;
  blindAutonomous: { autonomous: number; interactive: number };
  firstBlindMs: number | null;
  lastBlindMs: number | null;
  /** Non-dispatch surface rows by source. */
  surfaces: Map<string, {
    rows: number;
    noSeat: number;
    days: Set<string>;
    kinds: Map<string, number>;
    autonomous: { autonomous: number; interactive: number };
    firstMs: number | null;
    lastMs: number | null;
  }>;
  /** (seatId, kind) adverse exclusion cells over surface rows. */
  exclusions: Map<string, {
    seatId: string;
    kind: string;
    rows: number;
    days: Set<string>;
    sources: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>;
}

/**
 * Pure: fold the journal tails into the seat-decision evidence fold.
 * Rows outside the window, malformed JSON, foreign sources, dispatch-path
 * records and test rows contribute nothing — never guessed.
 */
export function foldSeatDecisionJournal(texts: readonly string[], nowMs: number, windowHours: number): SeatDecisionFold {
  const fold: SeatDecisionFold = {
    rows: 0, invalidRows: 0, skippedRows: 0,
    comparisons: 0, blind: 0, blindNoSeats: 0, blindAllExcluded: 0,
    blindDays: new Set(), blindEngines: new Map(), blindKinds: new Map(),
    blindAutonomous: { autonomous: 0, interactive: 0 },
    firstBlindMs: null, lastBlindMs: null,
    surfaces: new Map(),
    exclusions: new Map(),
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const { row, invalid } = parseRow(trimmed);
      if (invalid) { fold.invalidRows += 1; continue; }
      if (row === null) { fold.skippedRows += 1; continue; }
      if (row.atMs < since || row.atMs > until) continue;
      fold.rows += 1;
      if (row.cls === 'comparison') {
        fold.comparisons += 1;
        if (row.seatId !== null || row.engine === null) continue;
        fold.blind += 1;
        if (row.noSeatsKnown) fold.blindNoSeats += 1; else fold.blindAllExcluded += 1;
        fold.blindDays.add(row.day);
        if (row.engine !== null) fold.blindEngines.set(row.engine, (fold.blindEngines.get(row.engine) ?? 0) + 1);
        for (const [kind, n] of row.kinds) fold.blindKinds.set(kind, (fold.blindKinds.get(kind) ?? 0) + n);
        if (row.autonomous) fold.blindAutonomous.autonomous += 1; else fold.blindAutonomous.interactive += 1;
        fold.firstBlindMs = fold.firstBlindMs === null ? row.atMs : Math.min(fold.firstBlindMs, row.atMs);
        fold.lastBlindMs = fold.lastBlindMs === null ? row.atMs : Math.max(fold.lastBlindMs, row.atMs);
        continue;
      }
      // surface row
      let surface = fold.surfaces.get(row.source);
      if (surface === undefined) {
        surface = { rows: 0, noSeat: 0, days: new Set(), kinds: new Map(), autonomous: { autonomous: 0, interactive: 0 }, firstMs: null, lastMs: null };
        fold.surfaces.set(row.source, surface);
      }
      surface.rows += 1;
      surface.days.add(row.day);
      if (row.seatId === null) surface.noSeat += 1;
      for (const [kind, n] of row.kinds) surface.kinds.set(kind, (surface.kinds.get(kind) ?? 0) + n);
      if (row.autonomous) surface.autonomous.autonomous += 1; else surface.autonomous.interactive += 1;
      surface.firstMs = surface.firstMs === null ? row.atMs : Math.min(surface.firstMs, row.atMs);
      surface.lastMs = surface.lastMs === null ? row.atMs : Math.max(surface.lastMs, row.atMs);
      for (const pair of row.adverse) {
        const key = `${pair.seatId} ${pair.kind}`;
        let cell = fold.exclusions.get(key);
        if (cell === undefined) {
          cell = { seatId: pair.seatId, kind: pair.kind, rows: 0, days: new Set(), sources: new Map(), firstMs: null, lastMs: null };
          fold.exclusions.set(key, cell);
        }
        cell.rows += 1;
        cell.days.add(row.day);
        cell.sources.set(row.source, (cell.sources.get(row.source) ?? 0) + 1);
        cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
        cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
      }
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export type SeatDecisionCellKind = 'shadow-blind' | 'no-seat' | 'seat-excluded';

export interface SeatDecisionCell {
  kind: SeatDecisionCellKind;
  /** Surface source for 'no-seat'; seat id for 'seat-excluded'; null for 'shadow-blind'. */
  name: string | null;
  /** Reason kind for 'seat-excluded'; null otherwise. */
  reasonKind: string | null;
  /** Evidence rows inside the window. */
  rows: number;
  /** rows / denominator — comparison rows for 'shadow-blind', surface rows for the rest. */
  share: number;
  total: number;
  days: string[];
  /** Context tallies: engine names that ran while blind, reason kinds behind the blindness/starvation, surface names behind an exclusion. */
  engines: { text: string; count: number }[];
  kinds: { text: string; count: number }[];
  sources: { text: string; count: number }[];
  autonomous: number;
  interactive: number;
  /** 'shadow-blind' split: blind rows that saw no seats at all vs seats all excluded. */
  noSeatsKnown: number;
  allExcluded: number;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

const tally = (map: Map<string, number>, max: number = MAX_PROMPT_TALLIES): { text: string; count: number }[] =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([text, count]) => ({ text: fieldText(text), count }));

const daysList = (days: ReadonlySet<string>): string[] => [...days].sort();

/**
 * Pure: the recurring cells the fold justifies. 'shadow-blind' emits
 * while blind comparison rows reach the row/day bars; each surface
 * source's no-seat rows and each (seat, kind) exclusion cell emit under
 * the same bars. Sorted blind-first, then no-seat by rows, then
 * exclusions by rows.
 */
export function seatDecisionCells(fold: SeatDecisionFold, lowerBound = false): SeatDecisionCell[] {
  const cells: SeatDecisionCell[] = [];
  if (fold.comparisons > 0 && fold.blind >= SEAT_DECISION_MIN_ROWS &&
      fold.blindDays.size >= SEAT_DECISION_MIN_DAYS) {
    cells.push({
      kind: 'shadow-blind', name: null, reasonKind: null,
      rows: fold.blind, total: fold.comparisons, share: fold.blind / fold.comparisons,
      days: daysList(fold.blindDays),
      engines: tally(fold.blindEngines), kinds: tally(fold.blindKinds), sources: [],
      autonomous: fold.blindAutonomous.autonomous, interactive: fold.blindAutonomous.interactive,
      noSeatsKnown: fold.blindNoSeats, allExcluded: fold.blindAllExcluded,
      firstSeen: isoOrNull(fold.firstBlindMs), lastSeen: isoOrNull(fold.lastBlindMs),
      lowerBound,
    });
  }
  const noSeat = [...fold.surfaces.entries()]
    .filter(([, s]) => s.noSeat >= SEAT_DECISION_MIN_ROWS && s.days.size >= SEAT_DECISION_MIN_DAYS)
    .sort((a, b) => b[1].noSeat - a[1].noSeat || a[0].localeCompare(b[0]));
  for (const [source, s] of noSeat) {
    cells.push({
      kind: 'no-seat', name: source, reasonKind: null,
      rows: s.noSeat, total: s.rows, share: s.rows > 0 ? s.noSeat / s.rows : 0,
      days: daysList(s.days),
      engines: [], kinds: tally(s.kinds), sources: [],
      autonomous: s.autonomous.autonomous, interactive: s.autonomous.interactive,
      noSeatsKnown: 0, allExcluded: 0,
      firstSeen: isoOrNull(s.firstMs), lastSeen: isoOrNull(s.lastMs),
      lowerBound,
    });
  }
  const surfaceRows = [...fold.surfaces.values()].reduce((n, s) => n + s.rows, 0);
  const excluded = [...fold.exclusions.values()]
    .filter((c) => c.rows >= SEAT_DECISION_MIN_ROWS && c.days.size >= SEAT_DECISION_MIN_DAYS)
    .sort((a, b) => b.rows - a.rows || a.seatId.localeCompare(b.seatId) || a.kind.localeCompare(b.kind));
  for (const c of excluded) {
    cells.push({
      kind: 'seat-excluded', name: c.seatId, reasonKind: c.kind,
      rows: c.rows, total: surfaceRows, share: surfaceRows > 0 ? c.rows / surfaceRows : 0,
      days: daysList(c.days),
      engines: [], kinds: [], sources: tally(c.sources),
      autonomous: 0, interactive: 0,
      noSeatsKnown: 0, allExcluded: 0,
      firstSeen: isoOrNull(c.firstMs), lastSeen: isoOrNull(c.lastMs),
      lowerBound,
    });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/routing/decisions.jsonl (plus its decisions.1.jsonl predecessor after the 2 MB rotation) under the account home: recordShadowDecision in src/core/routing/budget-store.ts appends one ShadowDecisionRecord per seat routing evaluation — v:1, at, source (daemon|gateway|best-of-n|leader|verse|test), the RoutingRequest, the full SeatDecision (seatId, ranked candidates, per-seat exclusions with structured reason kinds, why, mode) and `actual` (what ran, when known). The daemon writes live routeWorkItem seatDecisions beside dispatches and beside-dispatch shadow comparisons (`actual: {engine, seatId: null}`); the router gateway (src/core/router-gateway/complete.ts) and leader seat choice (src/core/vision/leader-seat.ts) record the same decision shape with `actual: null`. Until this feed the journal\'s only readers were the budget decisions route, the Fleet router decision timeline, `phm telemetry` and reserve-breach attribution — reports someone had to run — so recurring adverse routing evidence never became work.';

const PINNED_NOTE = ' contrib/mac/dispatchd.py and the ~/.ashlr-runs/bin machinery are pinned dispatcher files: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives (the routing layer in src/core/routing/, the capacity snapshot publisher in src/core/daemon/, the gateway and leader call sites), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the routing surfaces were too quiet for the bars to mean anything, the cells trace to deliberate operator state (seats disabled in the budget policy, a maintenance pause, seats deliberately parked) or owner-side causes (provider credentials, quota, the capacity collectors, host capacity), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const cellDays = (cell: SeatDecisionCell): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const tallyText = (items: readonly { text: string; count: number }[]): string =>
  items.map((t) => `${t.text} (${t.count})`).join(', ');

function blindPrompt(cell: SeatDecisionCell): string {
  const split = cell.noSeatsKnown > 0 && cell.allExcluded > 0
    ? ` — ${cell.noSeatsKnown} saw no seats at all ('No seats are known') and ${cell.allExcluded} saw seats that were all excluded`
    : cell.noSeatsKnown > 0
      ? ' — every counted row saw no seats at all (\'No seats are known\')'
      : ' — every counted row saw seats that were all excluded';
  return [
    `Phantom's seat router keeps disagreeing with the fleet it routes — the shadow comparison recorded ${cell.rows} evaluation(s) inside the 7-day window where the seat router's capacity-snapshot view found NO eligible seat while the work ran anyway on the legacy path, ${pct(cell.share)} of ${cell.total} comparison row(s) ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `Each counted row is one beside-dispatch shadow evaluation (source 'daemon', \`actual: {engine, seatId: null}\`): routeSeat ran on the capacity snapshot and returned seatId null — nothing the snapshot describes could take the work — yet the item dispatched on the recorded engine regardless. ${split}. While this holds, the shadow stream that exists to validate the seat router before enforcement is measuring a router that sees a different fleet than the one dispatching: the capacity snapshot is stale or its publisher is down, every seat's recorded usage/auth/reachability evidence reads unusable while reality differs, or the snapshot's seat set drifted from the lanes the fleet actually runs.`,
    '',
    `Engines the work ran on while the view was blind: ${cell.engines.length ? tallyText(cell.engines) : 'unknown'}. Exclusion reason kinds behind the blindness: ${cell.kinds.length ? tallyText(cell.kinds) : 'unknown'}. Autonomous requests: ${cell.autonomous}, interactive: ${cell.interactive}. First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Reproduce the comparison first: read the newest decisions.jsonl rows and compare a blind row's decision.exclusions against ~/.ashlr/routing/capacity.json — the snapshot the daemon's capacity publisher (src/core/daemon/capacity-publisher.ts) and the Verse server feed. A snapshot that is stale, missing seats the fleet runs, or carrying exclusion-grade evidence (unknown-usage, unreachable, signed-out) for seats that are actually healthy points at the publisher or the seat evidence collectors (src/core/routing/headroom.ts, src/core/routing/budget-store.ts readCapacitySnapshot); a snapshot that is fresh and accurate means the legacy dispatch path is routing around a correct router — check routeWorkItem's hold logic in src/core/fleet/dispatch-router.ts. If the blind rows trace to deliberate operator state (every seat genuinely spent or disabled) or the window has rolled forward, report no-change and name the evidence.${PINNED_NOTE} ${NO_CHANGE}`,
  ].join('\n');
}

function noSeatPrompt(cell: SeatDecisionCell): string {
  const source = fieldText(cell.name ?? '', MAX_NAME_CHARS);
  return [
    `Phantom's '${source}' routing surface keeps finding no eligible seat — ${cell.rows} evaluation(s) inside the 7-day window returned seatId null, ${pct(cell.share)} of ${cell.total} recorded evaluation(s) on that surface ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `Each counted row is one seat routing evaluation that never became a dispatch — the router gateway's API completions or the leader's seat choice record the same ShadowDecisionRecord shape with \`actual: null\`. A null seatId means every seat in the capacity snapshot was excluded (or none was known): the surface's requests have nowhere to run. These evaluations produce no fleet/runtime dispatch row, so the dispatch journal's park evidence never sees them. Exclusion reason kinds behind the starvation: ${cell.kinds.length ? tallyText(cell.kinds) : 'unknown'}. Autonomous requests: ${cell.autonomous}, interactive: ${cell.interactive}. First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Find why this surface keeps starving: check whether the capacity snapshot it reads (~/.ashlr/routing/capacity.json via readCapacitySnapshot) is fresh and carries the seats the surface needs, whether the exclusions are capacity truth (seats genuinely spent — designed backpressure, report no-change) or broken eligibility evidence (unknown-usage, unreachable, signed-out recurring — the same adverse kinds the seat-excluded cells name), and whether the surface's own call site (src/core/router-gateway/complete.ts for 'gateway', src/core/vision/leader-seat.ts for 'leader') passes a request the seat set cannot serve. Fix what lives here — the routing layer, snapshot publisher and call sites in this repository's src/.${PINNED_NOTE} If the window has rolled forward or the starvation traces to deliberate state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function excludedPrompt(cell: SeatDecisionCell): string {
  const seat = fieldText(cell.name ?? '', MAX_NAME_CHARS);
  const kind = fieldText(cell.reasonKind ?? '', MAX_NAME_CHARS);
  const sources = cell.sources.length ? tallyText(cell.sources) : 'unknown';
  return [
    `Phantom's non-dispatch routing surfaces keep excluding seat '${seat}' for '${kind}' — ${cell.rows} exclusion record(s) inside the 7-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), seen on ${sources}, the self-improvement work this backlog exists for.`,
    '',
    `'${kind}' is an evidence-broken reason kind — the seat's eligibility evidence is missing or unreadable rather than the seat being legitimately busy: 'unknown-usage' means the usage reading never arrived, 'unreachable' means the reachability probe keeps failing, 'signed-out' means the recorded auth state reads signed out, 'other' means the reason fit no taxonomy kind. Capacity-truth kinds (headroom, spent, reserve, session-ceiling, model-window, context) and policy kinds (grant, lane, switched-off, demoted, task-arm) never count here — those are the router working as designed. These rows come from routing evaluations that never become dispatches (the router gateway and leader seat choice record \`actual: null\`), so a seat broken only on those surfaces produces no dispatch-journal evidence at all.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Find why this seat's '${kind}' evidence keeps failing on the routing surfaces: 'unknown-usage' points at the usage collectors feeding the capacity snapshot (the daemon's capacity publisher, src/core/daemon/capacity-publisher.ts, and the per-engine usage readers under src/core/fleet/ and src/core/usage/); 'unreachable' at the reachability probe; 'signed-out' at the recorded auth state. Check whether the same seat also fails on the dispatch path — runtime-journal-backlog's seat-exclusion items cover fleet/runtime/runs.jsonl — and whether one broken collector starves every surface at once. Fix what lives here — the evidence collectors, snapshot publisher and routing layer in this repository's src/ — and keep deliberate operator state (a seat the owner switched off or demoted) out of scope.${PINNED_NOTE} If the window has rolled forward or the kind traces to deliberate state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function seatDecisionItem(cell: SeatDecisionCell, repo: string): CloudBacklogItem {
  const title = cell.kind === 'shadow-blind'
    ? `Seat router shadow view keeps finding no eligible seat while work dispatches`
    : cell.kind === 'no-seat'
      ? `'${fieldText(cell.name ?? '', MAX_NAME_CHARS)}' routing keeps finding no eligible seat`
      : `Routing surfaces keep excluding seat '${fieldText(cell.name ?? '', MAX_NAME_CHARS)}': ${fieldText(cell.reasonKind ?? '', MAX_NAME_CHARS)}`;
  const idKey = cell.kind === 'shadow-blind'
    ? 'shadow-blind'
    : cell.kind === 'no-seat'
      ? `no-seat:${cell.name ?? ''}`
      : `seat-excluded:${cell.name ?? ''}:${cell.reasonKind ?? ''}`;
  return {
    id: `seat-decision-${sha(idKey)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'shadow-blind' ? blindPrompt(cell) : cell.kind === 'no-seat' ? noSeatPrompt(cell) : excludedPrompt(cell),
    area: `seat-decision-${cell.kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the seat-routing decision journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function seatDecisionBacklogItems(opts: SeatDecisionItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : SEAT_DECISION_WINDOW_HOURS;
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
    const fold = foldSeatDecisionJournal(texts, nowMs, windowHours);
    if (fold.rows === 0) return [];
    const cells = seatDecisionCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? SEAT_DECISION_BACKLOG_MAX_ITEMS, SEAT_DECISION_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => seatDecisionItem(cell, repo));
  } catch {
    return [];
  }
}
