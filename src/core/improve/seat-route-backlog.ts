/**
 * Seat-routing shadow decision journal evidence → self-improvement
 * backlog items.
 *
 * Every seat-route evaluation the budget router runs appends one
 * metadata-light record through recordShadowDecision
 * (src/core/routing/budget-store.ts) to ~/.ashlr/routing/decisions.jsonl
 * — {v:1, at, source, request, decision, actual}: the RoutingRequest
 * (task, difficulty, contextTokens, autonomous), the SeatDecision
 * routeSeat (src/core/routing/router.ts) returned over the published
 * capacity snapshot — chosen seatId (null when NO seat was eligible),
 * the ranked candidates, the per-seat exclusions with their structured
 * SeatReason details, the budget mode — and, when the caller knows it,
 * what actually ran. The file rotates once at 2 MiB to
 * decisions.1.jsonl; writes are bounded, secret-scrubbed and never
 * throw into the caller.
 *
 * Producers: the fleet dispatch mirror and the daemon's beside-the-route
 * shadow evals (source 'daemon', src/core/fleet/tick-hooks-live.ts and
 * src/core/daemon/loop.ts), the router gateway's picks (source
 * 'gateway', src/core/router-gateway/deps.ts — the surface outside
 * agents' routing calls land on), the leader seat's own routing
 * (source 'leader', src/core/vision/leader-seat.ts), and the reserved
 * 'best-of-n'/'verse'/'test' spellings. Until now the journal's only
 * readers were point-in-time surfaces — the reserve-breach attributor's
 * bounded scan (src/core/authority/reserve-breach.ts), the Budget
 * panel's newest-50 route (src/core/routing/budget-api.ts) and
 * `phm telemetry`'s newest-50 print (src/cli/telemetry.ts) — so a
 * routing surface that kept finding no eligible seat, or seats that
 * kept being excluded for broken eligibility evidence on the
 * non-dispatch surfaces, looked like ordinary current-state numbers,
 * never work.
 *
 * seatRouteBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue the
 * items exactly like the sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both journal generations are read through
 *    readLedgerTail's bounded no-follow tail; nothing is written and
 *    no network is touched. The writer's path is homedir-rooted
 *    (~/.ashlr/routing — ashlrRoot() in budget-store.ts resolves
 *    homedir()/.ashlr and deliberately ignores $ASHLR_HOME), so the
 *    default here matches it exactly.
 *  - Recorded rows only. A row counts only under the writer's contract
 *    — v:1, a parseable `at`, a known source spelling, a request whose
 *    task/difficulty/autonomous are inside the routing vocabulary, a
 *    decision whose seatId is null or a budget seat id with array
 *    candidates/exclusions and a string why, an optional mode inside
 *    BUDGET_MODES, and an actual that is null or {engine, seatId}.
 *    source 'test' rows are synthetic probe records, never fleet
 *    evidence: they are counted separately and never fold. Malformed
 *    lines are skipped, never guessed.
 *  - 'daemon'-source exclusions never emit here. The fleet dispatch
 *    mirror journals the SAME SeatDecision objects
 *    fleet/runtime/runs.jsonl carries, and runtime-journal-backlog
 *    already folds their evidence-broken exclusion kinds — folding
 *    them again would mint a second item for one observation. This
 *    feed's exclusion cells cover only the surfaces that journal
 *    cannot see: 'gateway', 'leader', 'best-of-n' and 'verse'.
 *    'daemon' rows still count toward the no-seat cells below: a
 *    seatId-null decision is starvation evidence no sibling folds.
 *  - Adverse means evidence-broken, never ordinary capacity. Exclusion
 *    cells count only the kinds that mean the seat's eligibility
 *    EVIDENCE is broken or missing — 'unknown-usage' (the seat's usage
 *    reading is absent so the router fails closed), 'unreachable'
 *    (the reachability probe keeps failing), 'signed-out' (the recorded
 *    auth is gone) and 'other' (unclassified) — the same set
 *    runtime-journal-backlog applies. Capacity-truth kinds (headroom,
 *    spent, reserve, session-ceiling, model-window, context,
 *    spend-cap) and policy kinds (switched-off, grant, lane, demoted,
 *    task-arm) are designed states and count only as quoted context.
 *  - Recurring means recorded across days. A cell emits only at
 *    SEAT_ROUTE_MIN_ROWS adverse observations spanning
 *    SEAT_ROUTE_MIN_DAYS distinct UTC days inside the window, so one
 *    bad afternoon or a single misconfigured seat never queues a
 *    session.
 *  - Truncation is stated, never hidden. When a generation's bounded
 *    tail cut older rows, the cell's counts are a lower bound and the
 *    prompt says so.
 *  - Items emit only for the fleet's own repository — the journal
 *    describes this install's routing and carries no repo column.
 *  - Dedup is downstream. The item id hashes the cell identity — never
 *    the counts or timestamps — so a refresh re-derives the same id
 *    and appendUserBacklogItems adds only what is new; a gap that
 *    closes simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, seat/engine/source strings are
 *    shape-bounded, reason kinds are the closed vocabulary, and the
 *    brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { decisionsLogPath } from '../routing/budget-store.js';
import { BUDGET_SEAT_ID_RE } from '../routing/policy.js';
import { readLedgerTail } from '../router/outcomes.js';
import { BUDGET_MODES, ROUTING_TASKS } from '../routing/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells stay well under this on a real fleet. */
export const SEAT_ROUTE_BACKLOG_MAX_ITEMS = 10;
const SEAT_ROUTE_ITEM_HARD_MAX = 25;
/** Evidence window: a week of routing decisions gives recurring starvation room without letting stale evidence linger. */
export const SEAT_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Bounded tail per journal generation. The writer rotates decisions.jsonl
 * to decisions.1.jsonl once the live file reaches 2 MiB, so 4 MiB covers
 * a full generation plus margin; a larger file means foreign growth and
 * the fold states the cut as a lower bound.
 */
export const SEAT_ROUTE_TAIL_BYTES = 4 * 1024 * 1024;
/** Adverse observations one cell needs inside the window before it counts as recurring. */
export const SEAT_ROUTE_MIN_ROWS = 3;
/** Distinct UTC days those observations must span — recurring means recorded across days. */
export const SEAT_ROUTE_MIN_DAYS = 2;
/** The fleet's own repository label: journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Exclusion (seatId, kind) pairs and per-seat totals one row may contribute. */
const MAX_ROW_EXCLUSION_PAIRS = 64;
/** Candidates one decision may carry before the row is treated as foreign. */
const MAX_CANDIDATES = 64;
/** Exclusions one decision may carry before the row is treated as foreign. */
const MAX_EXCLUSIONS = 64;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;

/** The writer's closed source vocabulary (ShadowDecisionSource in budget-store.ts). */
const SHADOW_SOURCES: ReadonlySet<string> = new Set(['daemon', 'gateway', 'best-of-n', 'leader', 'verse', 'test']);
/** The routing request's closed task/difficulty vocabularies (types.ts). */
const DIFFICULTIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
const MODES: ReadonlySet<string> = new Set(BUDGET_MODES);
const TASKS: ReadonlySet<string> = new Set(ROUTING_TASKS);
/**
 * Exclusion reason kinds that mean the seat's eligibility EVIDENCE is
 * broken or missing — never ordinary capacity or policy states. The same
 * set runtime-journal-backlog applies to the fleet dispatch journal.
 */
export const SEAT_ROUTE_ADVERSE_KINDS: ReadonlySet<string> = new Set([
  'unknown-usage',
  'unreachable',
  'signed-out',
  'other',
]);
/**
 * Sources whose seat decisions no sibling fold can see: the fleet
 * dispatch mirror ('daemon') journals the same SeatDecision objects
 * fleet/runtime/runs.jsonl carries — runtime-journal-backlog owns those
 * exclusion cells — while 'test' rows are synthetic probes that never
 * count as evidence at all.
 */
const SURFACE_SOURCES: ReadonlySet<string> = new Set(['gateway', 'leader', 'best-of-n', 'verse']);
/** Reason kinds are the router's closed lowercase vocabulary; a bounded shape keeps foreign text out of cells. */
const SAFE_REASON_KIND = /^[a-z][a-z0-9-]{0,39}$/;
/** actual.engine names a dispatch backend; bounded shape keeps foreign text out of prompts. */
const SAFE_ENGINE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/;

export interface SeatRouteItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /**
   * Path to the live decisions.jsonl; its `decisions.1.jsonl` sibling is
   * read as the rotated generation (the writer renames
   * decisions.jsonl → decisions.1.jsonl past the 2 MiB cap). Default:
   * the writer's own decisionsLogPath() — ~/.ashlr/routing/decisions.jsonl,
   * homedir-rooted; $ASHLR_HOME does not relocate it.
   */
  journalPath?: string;
  /**
   * State home the default journal path resolves under when journalPath is
   * absent: <homeDir>/.ashlr/routing/decisions.jsonl. Default: the writer's
   * own decisionsLogPath() — os.homedir()/.ashlr, which $ASHLR_HOME does
   * not relocate.
   */
  homeDir?: string;
  /** Evidence window in ms (default SEAT_ROUTE_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default SEAT_ROUTE_BACKLOG_MAX_ITEMS, hard-capped). */
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
// Fold — one pass over the journal generations' tails
// ---------------------------------------------------------------------------

/** One row's deduped adverse (seatId, kind) exclusion pairs plus every excluded seatId. */
interface RowExclusions {
  /** (seatId, kind) pairs whose kind is evidence-broken, deduped within the row. */
  adverse: { seatId: string; kind: string }[];
  /** Every seat id the row's exclusions named — the per-seat context denominator. */
  seats: string[];
}

function rowExclusions(decision: Record<string, unknown>): RowExclusions | null {
  const exclusions = decision['exclusions'];
  if (!Array.isArray(exclusions)) return null;
  const adverse: { seatId: string; kind: string }[] = [];
  const seats: string[] = [];
  const seenPairs = new Set<string>();
  const seenSeats = new Set<string>();
  for (const exclusion of exclusions.slice(0, MAX_EXCLUSIONS)) {
    if (!isRecord(exclusion)) continue;
    const seatId = exclusion['seatId'];
    if (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId)) continue;
    if (!seenSeats.has(seatId)) { seenSeats.add(seatId); seats.push(seatId); }
    const details = exclusion['details'];
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      if (!isRecord(detail)) continue;
      const kind = detail['kind'];
      if (typeof kind !== 'string' || !SAFE_REASON_KIND.test(kind)) continue;
      if (!SEAT_ROUTE_ADVERSE_KINDS.has(kind)) continue;
      const pair = `${seatId}${kind}`;
      if (seenPairs.has(pair) || adverse.length >= MAX_ROW_EXCLUSION_PAIRS) continue;
      seenPairs.add(pair);
      adverse.push({ seatId, kind });
    }
  }
  return { adverse, seats };
}

interface ParsedRow {
  atMs: number;
  source: string;
  task: string;
  autonomous: boolean;
  mode: string | null;
  seatId: string | null;
  actualEngine: string | null;
  exclusions: RowExclusions | null;
}

/** The journal's record contract, field by field; null for anything else. */
function parseRow(value: unknown): ParsedRow | null {
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
  if (typeof task !== 'string' || !TASKS.has(task)) return null;
  if (typeof difficulty !== 'string' || !DIFFICULTIES.has(difficulty)) return null;
  if (typeof autonomous !== 'boolean') return null;
  const decision = value['decision'];
  if (!isRecord(decision)) return null;
  const seatId = decision['seatId'];
  if (seatId !== null && (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId))) return null;
  const candidates = decision['candidates'];
  const why = decision['why'];
  if (!Array.isArray(candidates) || candidates.length > MAX_CANDIDATES ||
      candidates.some((c) => typeof c !== 'string' || !BUDGET_SEAT_ID_RE.test(c))) return null;
  if (typeof why !== 'string') return null;
  if (!Array.isArray(decision['exclusions']) || decision['exclusions'].length > MAX_EXCLUSIONS) return null;
  const mode = decision['mode'];
  const actual = value['actual'];
  let actualEngine: string | null = null;
  if (actual !== null && actual !== undefined) {
    if (!isRecord(actual)) return null;
    const engine = actual['engine'];
    if (typeof engine !== 'string' || !SAFE_ENGINE.test(engine)) return null;
    const actualSeat = actual['seatId'];
    if (actualSeat !== null && actualSeat !== undefined &&
        (typeof actualSeat !== 'string' || !BUDGET_SEAT_ID_RE.test(actualSeat))) return null;
    actualEngine = engine;
  }
  return {
    atMs,
    source,
    task,
    autonomous,
    mode: typeof mode === 'string' && MODES.has(mode) ? mode : null,
    seatId: seatId as string | null,
    actualEngine,
    exclusions: rowExclusions(decision),
  };
}

/** Per-(source, task, autonomous) no-seat evidence inside the window. */
interface NoSeatCellFold {
  source: string;
  task: string;
  autonomous: boolean;
  /** Decisions whose seatId was null — the router found no eligible seat. */
  rows: number;
  /** Every valid decision the cell recorded — the share denominator. */
  total: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** What actually ran on the no-seat decisions (engine → count); empty when callers record no actual. */
  actualEngines: Map<string, number>;
  /** Budget modes the no-seat decisions ran under (mode → count). */
  modes: Map<string, number>;
}

/** Per-(seatId, kind) evidence-broken exclusion evidence over the non-dispatch surfaces. */
interface ExclusionCellFold {
  seatId: string;
  kind: string;
  rows: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** Which surface sources observed the pair (source → count). */
  sources: Map<string, number>;
}

export interface SeatRouteFold {
  /** Valid in-window non-test decision records (rows that passed the producer contract). */
  records: number;
  /** Valid-contract rows skipped because source === 'test' — synthetic probes, never evidence. */
  testRows: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  noSeat: Map<string, NoSeatCellFold>;
  exclusions: Map<string, ExclusionCellFold>;
  /** Per-seatId surface-source exclusion observations of ANY kind — the context denominator exclusion prompts quote. */
  seatTotals: Map<string, number>;
}

const noSeatKey = (source: string, task: string, autonomous: boolean): string =>
  `${source}${task}${autonomous ? 'auto' : 'interactive'}`;
const exclusionKey = (seatId: string, kind: string): string => `${seatId}${kind}`;

/**
 * Pure: fold one journal generation's tail into no-seat and
 * evidence-broken-exclusion cells. Rows outside the window, malformed
 * JSON, wrong-schema/foreign-contract records and 'test'-source probes
 * are skipped or counted honestly; only surface-source ('gateway',
 * 'leader', 'best-of-n', 'verse') exclusions feed the exclusion cells —
 * 'daemon' rows mirror fleet/runtime/runs.jsonl evidence
 * runtime-journal-backlog already owns.
 */
export function foldSeatRouteJournal(text: string, nowMs: number, windowMs: number): SeatRouteFold {
  const fold: SeatRouteFold = {
    records: 0, testRows: 0, invalidRows: 0,
    noSeat: new Map(), exclusions: new Map(), seatTotals: new Map(),
  };
  const since = nowMs - windowMs;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    const parsed = parseRow(row);
    if (parsed === null) { fold.invalidRows += 1; continue; }
    if (parsed.atMs < since || parsed.atMs > until) continue;
    if (parsed.source === 'test') { fold.testRows += 1; continue; }
    fold.records += 1;
    const day = dayOf(parsed.atMs);

    // No-seat cells: every non-test source — a seatId-null decision is
    // starvation evidence no sibling fold records.
    const nKey = noSeatKey(parsed.source, parsed.task, parsed.autonomous);
    let nCell = fold.noSeat.get(nKey);
    if (nCell === undefined) {
      nCell = {
        source: parsed.source, task: parsed.task, autonomous: parsed.autonomous,
        rows: 0, total: 0, days: new Set(), firstMs: null, lastMs: null,
        actualEngines: new Map(), modes: new Map(),
      };
      fold.noSeat.set(nKey, nCell);
    }
    nCell.total += 1;
    if (parsed.seatId === null) {
      nCell.rows += 1;
      nCell.days.add(day);
      nCell.firstMs = nCell.firstMs === null ? parsed.atMs : Math.min(nCell.firstMs, parsed.atMs);
      nCell.lastMs = nCell.lastMs === null ? parsed.atMs : Math.max(nCell.lastMs, parsed.atMs);
      if (parsed.actualEngine !== null) {
        nCell.actualEngines.set(parsed.actualEngine, (nCell.actualEngines.get(parsed.actualEngine) ?? 0) + 1);
      }
      if (parsed.mode !== null) {
        nCell.modes.set(parsed.mode, (nCell.modes.get(parsed.mode) ?? 0) + 1);
      }
    }

    // Exclusion cells: surface sources only — 'daemon' mirrors evidence
    // runtime-journal-backlog already folds.
    if (!SURFACE_SOURCES.has(parsed.source) || parsed.exclusions === null) continue;
    for (const seatId of parsed.exclusions.seats) {
      fold.seatTotals.set(seatId, (fold.seatTotals.get(seatId) ?? 0) + 1);
    }
    for (const pair of parsed.exclusions.adverse) {
      const eKey = exclusionKey(pair.seatId, pair.kind);
      let eCell = fold.exclusions.get(eKey);
      if (eCell === undefined) {
        eCell = {
          seatId: pair.seatId, kind: pair.kind,
          rows: 0, days: new Set(), firstMs: null, lastMs: null,
          sources: new Map(),
        };
        fold.exclusions.set(eKey, eCell);
      }
      eCell.rows += 1;
      eCell.days.add(day);
      eCell.sources.set(parsed.source, (eCell.sources.get(parsed.source) ?? 0) + 1);
      eCell.firstMs = eCell.firstMs === null ? parsed.atMs : Math.min(eCell.firstMs, parsed.atMs);
      eCell.lastMs = eCell.lastMs === null ? parsed.atMs : Math.max(eCell.lastMs, parsed.atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring adverse evidence only
// ---------------------------------------------------------------------------

export type SeatRouteCell =
  | {
      kind: 'no-seat';
      source: string;
      task: string;
      autonomous: boolean;
      /** No-eligible-seat decisions inside the window. */
      rows: number;
      /** All decisions the cell recorded — the starvation share's denominator. */
      total: number;
      days: string[];
      firstSeen: string | null;
      lastSeen: string | null;
      /** What actually ran on the no-seat decisions (name → count), bounded and scrubbed. */
      actualEngines: { name: string; count: number }[];
      /** Budget modes the no-seat decisions ran under (name → count). */
      modes: { name: string; count: number }[];
      lowerBound: boolean;
    }
  | {
      kind: 'seat-exclusion';
      seatId: string;
      reasonKind: string;
      /** Adverse (seatId, kind) observations inside the window. */
      rows: number;
      /** Every exclusion observation the journal recorded for this seat on the surfaces — the share's denominator. */
      seatTotal: number;
      days: string[];
      firstSeen: string | null;
      lastSeen: string | null;
      /** Which surface sources observed the pair (name → count). */
      sources: { name: string; count: number }[];
      lowerBound: boolean;
    };

const tallyText = (entries: readonly { name: string; count: number }[]): string =>
  entries.map((e) => `${fieldText(e.name, MAX_NAME_CHARS)}×${e.count}`).join(', ');

/**
 * Pure: the recurring cells the fold justifies. A cell emits only while
 * its adverse observations reach SEAT_ROUTE_MIN_ROWS across
 * SEAT_ROUTE_MIN_DAYS distinct UTC days. Sorted no-seat cells first
 * (starvation is the headline signal), then exclusion cells — each by
 * rows, then identity — deterministic across refreshes.
 */
export function seatRouteCells(fold: SeatRouteFold, lowerBound = false): SeatRouteCell[] {
  const cells: SeatRouteCell[] = [];
  for (const cell of fold.noSeat.values()) {
    if (cell.rows < SEAT_ROUTE_MIN_ROWS || cell.days.size < SEAT_ROUTE_MIN_DAYS) continue;
    cells.push({
      kind: 'no-seat',
      source: cell.source, task: cell.task, autonomous: cell.autonomous,
      rows: cell.rows, total: cell.total,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      actualEngines: [...cell.actualEngines.entries()]
        .map(([engine, count]) => ({ name: engine, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      modes: [...cell.modes.entries()]
        .map(([mode, count]) => ({ name: mode, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      lowerBound,
    });
  }
  for (const cell of fold.exclusions.values()) {
    if (cell.rows < SEAT_ROUTE_MIN_ROWS || cell.days.size < SEAT_ROUTE_MIN_DAYS) continue;
    cells.push({
      kind: 'seat-exclusion',
      seatId: fieldText(cell.seatId, MAX_NAME_CHARS),
      reasonKind: cell.kind,
      rows: cell.rows,
      seatTotal: fold.seatTotals.get(cell.seatId) ?? cell.rows,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      sources: [...cell.sources.entries()]
        .map(([source, count]) => ({ name: source, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      lowerBound,
    });
  }
  cells.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'no-seat' ? -1 : 1;
    if (b.rows !== a.rows) return b.rows - a.rows;
    const ai = a.kind === 'no-seat' ? `${a.source}${a.task}${a.autonomous}` : `${a.seatId}${a.reasonKind}`;
    const bi = b.kind === 'no-seat' ? `${b.source}${b.task}${b.autonomous}` : `${b.seatId}${b.reasonKind}`;
    return ai.localeCompare(bi);
  });
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/routing/decisions.jsonl (plus its one rotated generation decisions.1.jsonl) under the Phantom state home — homedir-rooted, deliberately not $ASHLR_HOME, matching the writer\'s ashlrRoot() in src/core/routing/budget-store.ts. recordShadowDecision appends one {v:1, at, source, request, decision, actual} row per seat-route evaluation: the RoutingRequest (task, difficulty, contextTokens, autonomous), the SeatDecision routeSeat (src/core/routing/router.ts) returned over the published capacity snapshot — chosen seatId (null when no seat was eligible), ranked candidates, per-seat exclusions with structured SeatReason details, the budget mode — and what actually ran when the caller knows it. Producers are the fleet dispatch mirror and daemon shadow evals (\'daemon\'), the router gateway\'s picks (\'gateway\' — the surface agent routing calls land on), the leader seat\'s own routing (\'leader\'), and the reserved \'best-of-n\'/\'verse\'/\'test\' spellings. Until this feed the journal\'s only readers were point-in-time surfaces — the reserve-breach attributor\'s bounded scan, the Budget panel\'s newest-50 route and `phm telemetry`\'s newest-50 print — so recurring starvation and recurring evidence-broken exclusions never became work.';

const NO_CHANGE = 'If the window has rolled forward, the pattern was a one-off capacity crunch or a since-fixed collector outage, the excluded seats were deliberately retired or re-authed, the no-seat decisions reflect a designed hold (KILL, a budget mode the operator set, every seat legitimately spent), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' A journal generation\'s bounded tail was truncated at the read bound, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const cellDays = (cell: { days: readonly string[] }): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

function noSeatPrompt(cell: Extract<SeatRouteCell, { kind: 'no-seat' }>): string {
  const share = cell.total > 0 ? `${((cell.rows / cell.total) * 100).toFixed(1)}%` : 'unknown';
  const scope = cell.autonomous ? 'autonomous' : 'interactive (non-autonomous)';
  const withActual = cell.actualEngines.reduce((n, e) => n + e.count, 0);
  const actual = withActual > 0
    ? `An actual engine was recorded on ${withActual} of them (${tallyText(cell.actualEngines)}); the other ${cell.rows - withActual} recorded no actual — the gateway, leader, best-of-n and verse surfaces log the decision, not what ran, and held fleet dispatches record actual:null.`
    : 'No actual engine was recorded on any of them — the surfaces that produce these rows log the decision, not what ran (held fleet dispatches record actual:null).';
  const modes = cell.modes.length > 0 ? ` Budget modes on the no-seat decisions: ${tallyText(cell.modes)}.` : '';
  return [
    `Phantom's seat-routing shadow journal records recurring decisions with NO eligible seat for ${cell.source}-surface ${cell.task} work (${scope}) — ${cell.rows} of ${cell.total} in-window decisions ${cellDays(cell)} returned decision.seatId === null: routeSeat evaluated the published capacity snapshot's seats and chose nothing.`,
    '',
    `That is ${share} of this cell's recorded decisions. ${actual}${modes}`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Investigate whether this is genuine capacity exhaustion — every seat's windows legitimately spent under the current budget mode — or broken/missing eligibility evidence: the capacity publisher feeding ~/.ashlr/routing/capacity.json (src/core/daemon/capacity-publisher.ts, src/core/routing/capacity-history.ts), the per-seat usage/auth collectors behind headroom.ts's reason kinds, and the budget policy's mode and per-seat settings (src/core/routing/policy.ts, ~/.ashlr/budget.json). A stale or empty snapshot makes every seat read unknown-usage and the router fails closed — that is machinery to fix, not capacity reality. If the snapshot is healthy and the seats really are all spent, the honest outcome may be a capacity/posture item rather than a router fix — say which the evidence supports. ${NO_CHANGE}`,
  ].join('\n');
}

function exclusionPrompt(cell: Extract<SeatRouteCell, { kind: 'seat-exclusion' }>): string {
  const share = cell.seatTotal > 0 ? `${((cell.rows / cell.seatTotal) * 100).toFixed(1)}%` : 'unknown';
  const sources = tallyText(cell.sources);
  return [
    `Phantom's seat-routing shadow journal records seat '${cell.seatId}' kept excluded for the evidence-broken reason kind '${cell.reasonKind}' on the non-dispatch routing surfaces — ${cell.rows} adverse exclusion observations ${cellDays(cell)} (surfaces: ${sources}), against ${cell.seatTotal} total exclusion observations the journal recorded for that seat on those surfaces (${share}).`,
    '',
    `The kind vocabulary is produced by headroom.ts's eligibility fold over the published capacity snapshot: 'unknown-usage' means the seat's usage reading is missing so the router fails closed, 'unreachable' means the reachability probe keeps failing, 'signed-out' means the recorded auth is gone, and 'other' is unclassified. Capacity-truth kinds (spent, reserve, session-ceiling, model-window, headroom, context, spend-cap) and policy kinds (switched-off, grant, lane, demoted, task-arm) are designed states and never counted here.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Note the boundary: fleet-dispatch exclusions of the same seat and kind are already folded from fleet/runtime/runs.jsonl by the runtime-journal feed — this item's evidence is the gateway/leader/best-of-n/verse surfaces that journal never sees, so a seat broken only off the dispatch path still surfaces here. Investigate the seat's evidence pipeline: which collector writes its usage/auth/reachability readings into the capacity snapshot (src/core/routing/capacity-history.ts records the rolling history; the Verse server's budget read and the daemon's capacity publisher are the writers), whether the seat's auth lapsed or its runtime died, and whether the seat should stay in the routing catalog at all (src/core/routing/catalog-*.ts, docs/ROUTER-CATALOG.md). If the exclusion is a designed hold the operator set — switched-off is a different kind and would not land here — or the seat was deliberately retired, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function seatRouteItem(cell: SeatRouteCell, repo: string): CloudBacklogItem {
  const identity = cell.kind === 'no-seat'
    ? `no-seat:${cell.source}:${cell.task}:${cell.autonomous ? 'auto' : 'interactive'}`
    : `seat-exclusion:${cell.seatId}:${cell.reasonKind}`;
  const title = cell.kind === 'no-seat'
    ? `Seat router finds no eligible seat for ${cell.source} ${cell.task} (${cell.autonomous ? 'autonomous' : 'interactive'}) work`.slice(0, MAX_TITLE_CHARS)
    : `Seat '${cell.seatId}' keeps excluded for '${cell.reasonKind}' on routing surfaces`.slice(0, MAX_TITLE_CHARS);
  return {
    id: `seat-route-${sha(identity)}`,
    title,
    prompt: cell.kind === 'no-seat' ? noSeatPrompt(cell) : exclusionPrompt(cell),
    area: 'seat-route',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the seat-routing shadow journal's recurring
 * starvation and evidence-broken exclusions. Total: a missing journal,
 * another repository, a quiet journal (no cell past the row/day bars)
 * or any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function seatRouteBacklogItems(opts: SeatRouteItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? SEAT_ROUTE_WINDOW_MS;
    // The writer's own path function is the default — homedir-rooted,
    // deliberately not $ASHLR_HOME; homeDir exists only so a caller can
    // relocate the whole state home in one option.
    const livePath = opts.journalPath
      ?? (opts.homeDir !== undefined ? join(opts.homeDir, '.ashlr', 'routing', 'decisions.jsonl') : decisionsLogPath());
    // The writer's one rotation: decisions.jsonl → decisions.1.jsonl.
    const rotatedPath = /\.jsonl$/.test(livePath) ? livePath.replace(/\.jsonl$/, '.1.jsonl') : null;
    const reads = await Promise.all(
      [livePath, ...(rotatedPath !== null ? [rotatedPath] : [])]
        .map((path) => readLedgerTail(path, SEAT_ROUTE_TAIL_BYTES)),
    );
    // The fold is order-independent — cells accumulate per row and day
    // bounds come from each row's own `at` — so the generations fold as
    // one text. A missing generation contributes nothing.
    const texts: string[] = [];
    let lowerBound = false;
    for (const read of reads) {
      if (read.state !== 'read') continue;
      if (read.truncated) lowerBound = true;
      texts.push(read.text);
    }
    if (texts.length === 0) return [];
    const fold = foldSeatRouteJournal(texts.join('\n'), nowMs, windowMs);
    const cells = seatRouteCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? SEAT_ROUTE_BACKLOG_MAX_ITEMS, SEAT_ROUTE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => seatRouteItem(cell, repo));
  } catch {
    return [];
  }
}
