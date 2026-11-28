/**
 * fleet/runtime/runs.jsonl dispatch rows → self-improvement backlog items.
 *
 * The standing fleet's own dispatch journal: tick-hooks-live's
 * afterDispatch appends one fleet.runtime dispatch row per work-item
 * outcome — dispatched, held or skipped — carrying the route decision
 * behind it (backend, lane, seatId, the full SeatRouter seatDecision
 * with per-seat exclusion details, the RouteHold when the router parked
 * or split the item, the skipReason when dispatch declined it, the
 * route.lane-auto.v1 autoModel receipt when the seat evaluation
 * resolved a lane whose models.json entry is 'auto', and the harness
 * version the attempt ran under). landing rows record merges and
 * reverts. The journal rotates at 2 MB keeping one previous generation.
 *
 * Until now its only readers were display and attribution surfaces: the
 * Fleet live projection (/api/verse/fleet/live behind `phm fleet
 * lane-slots`, `phm lanes`, `phm map` and the console's Fleet screen),
 * the ops board and scheduling's work-history join — none of which queue
 * work. tick.json keeps only the LAST tick's held list, so a repo whose
 * items keep parking, a seat whose eligibility evidence stays broken, or
 * a skip code that keeps declining dispatches was invisible history:
 * recurring adverse dispatch evidence that never became a backlog item.
 * runtimeJournalBacklogItems carries the same rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. runs.jsonl and its rotated predecessor are read through
 *    readLedgerTail's bounded no-follow tails — RUNS_JOURNAL_MAX_BYTES
 *    each, the writer's own rotation bound — and nothing is written and
 *    no network is touched. A missing or unreadable file yields no
 *    items; a malformed line is skipped, never guessed.
 *  - Rows count only under the journal's own contract: v:1 dispatch rows
 *    with a parseable `at` inside the window, a non-empty itemId (the
 *    recurring bars count DISTINCT items — a parked item re-evaluated
 *    every tick is one stuck item, not a pattern) and a boolean
 *    `dispatched`. landing rows and foreign shapes contribute nothing.
 *  - Recurring means recorded across work and days: a cell emits only
 *    at RUNTIME_JOURNAL_MIN_ITEMS distinct itemIds across
 *    RUNTIME_JOURNAL_MIN_DAYS distinct UTC days inside the 7-day window
 *    — the fleet's RECURRING_FAILURES convention the sibling feeds apply.
 *  - Seat-exclusion cells name only evidence-broken kinds
 *    (RUNTIME_JOURNAL_ADVERSE_KINDS): 'unknown-usage' (the seat's usage
 *    reading is missing so the router fails closed), 'unreachable' (the
 *    reachability probe keeps failing), 'signed-out' (the recorded auth
 *    state reads signed out) and 'other' (the reason fit no taxonomy
 *    kind). Capacity-truth exclusions — headroom, spent, reserve,
 *    session-ceiling, model-window, context — and policy exclusions —
 *    grant, lane, switched-off, demoted, task-arm — are the router
 *    working as designed and never emit.
 *  - Hold cells split by the router's own hold.kind: 'park' rows count
 *    only when a seatDecision rides along (the router evaluated seats
 *    and none could produce — policy holds like land-first saturation,
 *    missing repo identity and rollout-stage refusals carry no
 *    seatDecision and are intended backpressure), 'split' rows are work
 *    that fit no seat's context window. Skip cells count only
 *    code-shaped skipReason values on non-dispatched rows with no hold —
 *    sentence reasons never become cells.
 *  - Lane-auto cells fold the autoModel receipts dispatch rows carry:
 *    chooseLaneAuto's route.lane-auto.v1 verdict for a lane whose
 *    models.json entry resolves to 'auto'. 'held' verdicts (no pick —
 *    gated before scoring by the billing/engine/catalog checks, or
 *    scored with no candidate at the sample bar and no eligible prior
 *    default) and 'threshold-fallback' verdicts (nothing reached the
 *    sample bar, so the configured prior default kept serving) each emit
 *    per (lane, tier, via) at the same recurring bars; 'scored' verdicts
 *    are the healthy path and only count as context. Until now the
 *    receipt's only reader was the route decision itself, so a lane
 *    configured 'auto' that never picks — or whose scorer starves for
 *    outcome evidence — parked or silently defaulted work invisibly.
 *  - Truncation is stated, never hidden: when either bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's standing fleet. Dedup is downstream: the item id hashes
 *    the cell identity, never counts or timestamps, so a refresh
 *    re-derives the same id and a recovered cell simply stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { runsJournalPath, RUNS_JOURNAL_MAX_BYTES } from '../fleet/fleet-runtime-journal.js';
import { FLEET_ENGINES } from '../fleet/fleet-types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell kinds are small closed vocabularies. */
export const RUNTIME_JOURNAL_BACKLOG_MAX_ITEMS = 12;
const RUNTIME_JOURNAL_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const RUNTIME_JOURNAL_WINDOW_HOURS = 168;
/** A cell emits only at the fleet's recurring bar of distinct items... */
export const RUNTIME_JOURNAL_MIN_ITEMS = 3;
/** ...across at least this many distinct UTC days. */
export const RUNTIME_JOURNAL_MIN_DAYS = 2;
/** The fleet's own repository label: runtime-journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Exclusion reason kinds that mean the seat's eligibility EVIDENCE is broken or missing — never ordinary capacity or policy states. */
export const RUNTIME_JOURNAL_ADVERSE_KINDS: ReadonlySet<string> = new Set([
  'unknown-usage',
  'unreachable',
  'signed-out',
  'other',
]);
/** Seat ids the capacity snapshot admits (BUDGET_SEAT_ID_RE's shape); anything else is not ours. */
const SAFE_SEAT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** Exclusion reason kinds are the router's closed lowercase vocabulary; a bounded shape keeps foreign text out of cells. */
const SAFE_REASON_KIND = /^[a-z][a-z0-9-]{0,39}$/;
/** skipReason cells need a code, not a sentence: lowercase code-shaped values only. */
const SAFE_SKIP_CODE = /^[a-z0-9][a-z0-9._:-]{1,79}$/;
/** autoModel receipts: the lane vocabulary is the fleet's closed engine set. */
const AUTO_LANES: ReadonlySet<string> = new Set(FLEET_ENGINES);
/** autoModel receipts: tier is ModelRoutingTier's closed vocabulary (model-catalog.ts). */
const SAFE_AUTO_TIERS: ReadonlySet<string> = new Set(['fast', 'mid', 'computer', 'work', 'frontier']);
/** autoModel receipts: `via` is a models.json key — `<lane>[.<tier>]` under lane-models.ts's LANE_RE/TIER_RE shapes. */
const SAFE_AUTO_VIA = /^[a-z][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9_-]{0,31})?$/;
/** Candidate entries one receipt's sample-depth scan reads; the count itself is the array's own length. */
const MAX_AUTO_CANDIDATES = 128;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Repo/source/kind tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example item ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Exclusion pairs one row may contribute per seat (16 exclusions × bounded kinds). */
const MAX_ROW_EXCLUSION_PAIRS = 64;

export interface RuntimeJournalItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: runsJournalPath(), the writer's own ~/.ashlr/fleet/runtime/runs.jsonl). */
  journalPath?: string;
  /** Evidence window in hours (default RUNTIME_JOURNAL_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default RUNTIME_JOURNAL_BACKLOG_MAX_ITEMS, hard-capped). */
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
// Fold — one pass over the dispatch rows of the journal tails
// ---------------------------------------------------------------------------

/** One row's adverse (seatId, kind) exclusion pairs plus every reason kind its seatDecision carried. */
interface RowExclusions {
  /** (seatId, kind) pairs whose kind is in RUNTIME_JOURNAL_ADVERSE_KINDS, deduped within the row. */
  adverse: { seatId: string; kind: string }[];
  /** Every bounded-shape reason kind the row's exclusions carried (hold-cell context). */
  kinds: string[];
}

function rowExclusions(seatDecision: unknown): RowExclusions | null {
  if (!isRecord(seatDecision) || !Array.isArray(seatDecision['exclusions'])) return null;
  const adverse: { seatId: string; kind: string }[] = [];
  const kinds = new Set<string>();
  const seen = new Set<string>();
  for (const exclusion of seatDecision['exclusions']) {
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
      if (!RUNTIME_JOURNAL_ADVERSE_KINDS.has(kind)) continue;
      const pair = `${seatId}${kind}`;
      if (seen.has(pair) || adverse.length >= MAX_ROW_EXCLUSION_PAIRS) continue;
      seen.add(pair);
      adverse.push({ seatId, kind });
    }
  }
  return { adverse, kinds: [...kinds] };
}

/** One autoModel receipt's foldable fields — the verdict plus candidate-depth evidence. */
interface ParsedAuto {
  lane: string;
  tier: string;
  /** The models.json key that resolved to 'auto' for this lane/tier. */
  via: string;
  /** The receipt's own verdict; 'threshold-fallback' folds as 'fallback'. */
  verdict: 'scored' | 'threshold-fallback' | 'held';
  /** The picked model on scored/fallback verdicts (null on held, 'unknown' tally when absent). */
  model: string | null;
  /** Candidates the receipt listed — only the empty/non-empty split is folded. */
  candidateCount: number;
  /** Deepest candidate.samples across the scanned entries — starvation depth vs the scorer's bar. */
  maxSamples: number;
}

/** The route.lane-auto.v1 receipt contract, field by field; null for anything else. */
function parseAutoReceipt(value: unknown): ParsedAuto | null {
  if (!isRecord(value) || value['schema'] !== 'route.lane-auto.v1') return null;
  const lane = value['lane'];
  const tier = value['tier'];
  const via = value['via'];
  const reason = value['reason'];
  if (typeof lane !== 'string' || !AUTO_LANES.has(lane)) return null;
  if (typeof tier !== 'string' || !SAFE_AUTO_TIERS.has(tier)) return null;
  if (typeof via !== 'string' || via.length > 96 || !SAFE_AUTO_VIA.test(via)) return null;
  if (reason !== 'scored' && reason !== 'threshold-fallback' && reason !== 'held') return null;
  const minimumSamples = value['minimumSamples'];
  if (typeof minimumSamples !== 'number' || !Number.isFinite(minimumSamples) || minimumSamples <= 0) return null;
  const modelRaw = value['model'];
  const model = typeof modelRaw === 'string' && modelRaw.trim() !== ''
    ? fieldText(modelRaw, 128) || null
    : null;
  const candidates = value['candidates'];
  if (!Array.isArray(candidates)) return null;
  let maxSamples = 0;
  for (const candidate of candidates.slice(0, MAX_AUTO_CANDIDATES)) {
    if (!isRecord(candidate)) continue;
    const samples = candidate['samples'];
    if (typeof samples === 'number' && Number.isFinite(samples) && samples > maxSamples) maxSamples = samples;
  }
  return { lane, tier, via, verdict: reason, model, candidateCount: candidates.length, maxSamples };
}

interface ParsedRow {
  atMs: number;
  itemId: string;
  repo: string;
  source: string;
  dispatched: boolean;
  backend: string | null;
  exclusions: RowExclusions | null;
  holdKind: 'park' | 'split' | null;
  holdReopens: boolean;
  skipCode: string | null;
  autoModel: ParsedAuto | null;
}

/** The journal's dispatch-row contract, field by field; null for anything else. */
function parseDispatchRow(value: unknown): ParsedRow | null {
  if (!isRecord(value) || value['v'] !== 1 || value['type'] !== 'dispatch') return null;
  const at = value['at'];
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const itemId = value['itemId'];
  if (typeof itemId !== 'string' || itemId === '' || itemId.length > 200) return null;
  if (typeof value['dispatched'] !== 'boolean') return null;
  const cleanItemId = fieldText(itemId, MAX_NAME_CHARS);
  if (cleanItemId === '') return null;
  const repoRaw = value['repo'];
  const repo = typeof repoRaw === 'string' && repoRaw.trim() !== ''
    ? fieldText(repoRaw, MAX_NAME_CHARS) || 'unattributed'
    : 'unattributed';
  const sourceRaw = value['source'];
  const source = typeof sourceRaw === 'string' && sourceRaw.trim() !== ''
    ? fieldText(sourceRaw, MAX_NAME_CHARS) || 'unknown'
    : 'unknown';
  const backendRaw = value['backend'];
  const backend = typeof backendRaw === 'string' && backendRaw.trim() !== ''
    ? fieldText(backendRaw, MAX_NAME_CHARS) || null
    : null;
  let holdKind: 'park' | 'split' | null = null;
  let holdReopens = false;
  const hold = value['hold'];
  if (isRecord(hold) && (hold['kind'] === 'park' || hold['kind'] === 'split')) {
    holdKind = hold['kind'];
    const reopen = hold['nextEligibleAt'];
    holdReopens = typeof reopen === 'string' && reopen !== '' && Number.isFinite(Date.parse(reopen));
  }
  const skipRaw = value['skipReason'];
  const skipCode = typeof skipRaw === 'string' && SAFE_SKIP_CODE.test(skipRaw.trim())
    ? skipRaw.trim()
    : null;
  return {
    atMs,
    itemId: cleanItemId,
    repo,
    source,
    dispatched: value['dispatched'],
    backend,
    exclusions: rowExclusions(value['seatDecision']),
    holdKind,
    holdReopens,
    skipCode,
    autoModel: parseAutoReceipt(value['autoModel']),
  };
}

/** Per-label in-window fold before the recurring bars apply. */
export interface SeatExclusionFold {
  seatId: string;
  kind: string;
  /** Distinct items whose evaluation excluded this seat for this kind. */
  items: Set<string>;
  /** Contributing dispatch rows (each row contributes a pair at most once). */
  rows: number;
  /** Distinct UTC days the contributing rows landed on. */
  days: Set<string>;
  /** Repo tallies across the cell's rows. */
  repos: Map<string, number>;
  /** Source tallies across the cell's rows. */
  sources: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** A (hold.kind, repo) cell: recurring route holds of one kind on one repo's items. */
export interface HoldFold {
  holdKind: 'park' | 'split';
  /** Repo label as recorded (lowercased for the cell key). */
  repo: string;
  items: Set<string>;
  /** Contributing dispatch rows. */
  rows: number;
  days: Set<string>;
  sources: Map<string, number>;
  /** Every bounded reason kind the rows' seatDecisions carried — the park cell's dominant-blocker context. */
  kinds: Map<string, number>;
  /** Park rows whose hold named no known reopening — the stuckest parks. */
  noReopen: number;
  firstMs: number | null;
  lastMs: number | null;
}

/** A skipReason-code cell: recurring non-dispatched rows declining on the same code. */
export interface SkipFold {
  code: string;
  items: Set<string>;
  /** Contributing dispatch rows. */
  rows: number;
  days: Set<string>;
  sources: Map<string, number>;
  /** Backend tallies across the cell's rows ('unknown' when the row named none). */
  backends: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** One lane-auto verdict's recurring evidence: 'held' picks or 'fallback' serves per (lane, tier, via). */
export interface LaneAutoVerdictFold {
  /** 'held' or 'fallback' (the receipt's 'threshold-fallback'). */
  verdict: 'held' | 'fallback';
  items: Set<string>;
  /** Contributing dispatch rows. */
  rows: number;
  days: Set<string>;
  repos: Map<string, number>;
  sources: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
  /** Rows whose receipt carried zero candidates — gated before scoring ran. */
  gatedRows: number;
  /** Rows that reached scoring with non-empty candidates yet produced this verdict. */
  evaluatedRows: number;
  /** Deepest candidate.samples across the cell's rows — starvation depth vs the scorer's bar. */
  maxSamples: number;
  /** Fallback verdicts only: which prior-default model kept serving ('unknown' when unnamed). */
  pickedModels: Map<string, number>;
}

/** Every lane-auto verdict recorded for one (lane, tier, via) config key. */
export interface LaneAutoFold {
  lane: string;
  tier: string;
  via: string;
  /** 'scored' verdict rows — the healthy path, context only, never a cell. */
  scoredRows: number;
  held: LaneAutoVerdictFold | null;
  fallback: LaneAutoVerdictFold | null;
}

export interface RuntimeJournalFold {
  /** In-window dispatch rows — the share denominator the prompts quote. */
  rows: number;
  exclusions: Map<string, SeatExclusionFold>;
  holds: Map<string, HoldFold>;
  skips: Map<string, SkipFold>;
  /** Lane-auto verdicts keyed `${lane}${tier}${via}`. */
  laneAutos: Map<string, LaneAutoFold>;
  /** Non-blank lines that were not JSON objects, plus dispatch-shaped failures. */
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
 * undated, malformed, foreign-shaped or missing their itemId are skipped,
 * never guessed.
 */
export function foldRuntimeJournal(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): RuntimeJournalFold {
  const fold: RuntimeJournalFold = {
    rows: 0,
    exclusions: new Map(), holds: new Map(), skips: new Map(), laneAutos: new Map(), malformed: 0,
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { fold.malformed++; continue; }
      // landing rows are the journal's other record kind — real rows,
      // just not dispatch evidence; they are skipped, never "malformed".
      if (isRecord(value) && value['type'] === 'landing') continue;
      const row = parseDispatchRow(value);
      if (row === null) { fold.malformed++; continue; }
      if (row.atMs < since || row.atMs > until) continue;
      fold.rows += 1;
      const day = dayOf(row.atMs);

      // Seat-exclusion cells: every (seatId, adverse-kind) pair the row's
      // seatDecision carried — dispatched or held, the evaluation happened.
      if (row.exclusions !== null) {
        for (const pair of row.exclusions.adverse) {
          const key = `${pair.seatId}${pair.kind}`;
          let cell = fold.exclusions.get(key);
          if (cell === undefined) {
            cell = { seatId: pair.seatId, kind: pair.kind, items: new Set(), rows: 0, days: new Set(), repos: new Map(), sources: new Map(), firstMs: null, lastMs: null };
            fold.exclusions.set(key, cell);
          }
          cell.items.add(row.itemId);
          cell.rows += 1;
          cell.days.add(day);
          bump(cell.repos, row.repo);
          bump(cell.sources, row.source);
          touch(cell, row.atMs);
        }
      }

      // Lane-auto receipts: the route.lane-auto.v1 verdict rides every
      // dispatch row whose seat evaluation resolved a lane configured
      // 'auto' — dispatched rows carry scored/threshold-fallback picks,
      // the parked rows carry 'held'. All three fold; only held and
      // threshold-fallback can become cells.
      if (row.autoModel !== null) {
        const auto = row.autoModel;
        const key = `${auto.lane}${auto.tier}${auto.via}`;
        let group = fold.laneAutos.get(key);
        if (group === undefined) {
          group = { lane: auto.lane, tier: auto.tier, via: auto.via, scoredRows: 0, held: null, fallback: null };
          fold.laneAutos.set(key, group);
        }
        if (auto.verdict === 'scored') {
          group.scoredRows += 1;
        } else {
          const verdict = auto.verdict === 'held' ? 'held' : 'fallback';
          let cell = verdict === 'held' ? group.held : group.fallback;
          if (cell === null) {
            cell = { verdict, items: new Set(), rows: 0, days: new Set(), repos: new Map(), sources: new Map(), firstMs: null, lastMs: null, gatedRows: 0, evaluatedRows: 0, maxSamples: 0, pickedModels: new Map() };
            if (verdict === 'held') group.held = cell; else group.fallback = cell;
          }
          cell.items.add(row.itemId);
          cell.rows += 1;
          cell.days.add(day);
          bump(cell.repos, row.repo);
          bump(cell.sources, row.source);
          touch(cell, row.atMs);
          if (auto.candidateCount === 0) cell.gatedRows += 1; else cell.evaluatedRows += 1;
          cell.maxSamples = Math.max(cell.maxSamples, auto.maxSamples);
          if (verdict === 'fallback') bump(cell.pickedModels, auto.model ?? 'unknown');
        }
      }

      if (row.dispatched) continue;

      // Hold cells: the router's own park/split verdicts. A park counts
      // only with a seatDecision aboard — seat-evaluated parks, not the
      // policy holds (land-first, repo identity, rollout stage) that
      // carry none.
      if (row.holdKind !== null) {
        if (row.holdKind === 'park' && row.exclusions === null) continue;
        const repoKey = row.repo.toLowerCase();
        const key = `${row.holdKind}${repoKey}`;
        let cell = fold.holds.get(key);
        if (cell === undefined) {
          cell = { holdKind: row.holdKind, repo: row.repo, items: new Set(), rows: 0, days: new Set(), sources: new Map(), kinds: new Map(), noReopen: 0, firstMs: null, lastMs: null };
          fold.holds.set(key, cell);
        }
        cell.items.add(row.itemId);
        cell.rows += 1;
        cell.days.add(day);
        bump(cell.sources, row.source);
        if (row.exclusions !== null) for (const kind of row.exclusions.kinds) bump(cell.kinds, kind);
        if (row.holdKind === 'park' && !row.holdReopens) cell.noReopen += 1;
        touch(cell, row.atMs);
        continue;
      }

      // Skip cells: non-dispatched rows no route hold explains, only when
      // the skip reason is a code — sentences never become cells.
      if (row.skipCode === null) continue;
      let cell = fold.skips.get(row.skipCode);
      if (cell === undefined) {
        cell = { code: row.skipCode, items: new Set(), rows: 0, days: new Set(), sources: new Map(), backends: new Map(), firstMs: null, lastMs: null };
        fold.skips.set(row.skipCode, cell);
      }
      cell.items.add(row.itemId);
      cell.rows += 1;
      cell.days.add(day);
      bump(cell.sources, row.source);
      bump(cell.backends, row.backend ?? 'unknown');
      touch(cell, row.atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageTally {
  /** Sanitized recorded text (a repo, source, kind or backend label). */
  text: string;
  count: number;
}

interface CellBase {
  /** Distinct items inside the window. */
  items: number;
  /** Up to MAX_EXAMPLES item ids. */
  examples: string[];
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window dispatch rows the cell's evidence came from. */
  rows: number;
  /** In-window dispatch rows overall — the share denominator. */
  dispatchRows: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when a bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

export interface SeatExclusionCell extends CellBase {
  kind: 'seat-exclusion';
  seatId: string;
  reasonKind: string;
  repos: UsageTally[];
  sources: UsageTally[];
}

export interface HoldCell extends CellBase {
  kind: 'park-hold' | 'split-hold';
  holdKind: 'park' | 'split';
  repo: string;
  sources: UsageTally[];
  /** Every bounded reason kind the rows' seatDecisions carried, most frequent first. */
  reasonKinds: UsageTally[];
  /** Park rows with no known reopening (park cells only; null on split cells). */
  noReopen: number | null;
}

export interface SkipCell extends CellBase {
  kind: 'skip-code';
  code: string;
  sources: UsageTally[];
  backends: UsageTally[];
}

interface LaneAutoCellBase extends CellBase {
  lane: string;
  tier: string;
  /** The models.json key that resolved to 'auto' for this lane/tier. */
  via: string;
  /** 'scored' verdicts on the same (lane, tier, via) in-window — context, never cells. */
  scoredRows: number;
  /** Contributing rows whose receipt carried zero candidates (gated before scoring). */
  gatedRows: number;
  /** Contributing rows that reached scoring with non-empty candidates. */
  evaluatedRows: number;
  /** Deepest candidate sample count seen — how far the best candidate is from the scorer's bar. */
  maxSamples: number;
  repos: UsageTally[];
  sources: UsageTally[];
}

export interface LaneAutoHeldCell extends LaneAutoCellBase {
  kind: 'lane-auto-held';
  /** The receipt verdict this cell folds. */
  verdict: 'held';
  pickedModels: null;
}

export interface LaneAutoFallbackCell extends LaneAutoCellBase {
  kind: 'lane-auto-fallback';
  /** The receipt verdict this cell folds. */
  verdict: 'threshold-fallback';
  /** Which prior-default model kept serving. */
  pickedModels: UsageTally[];
}

export type LaneAutoCell = LaneAutoHeldCell | LaneAutoFallbackCell;

export type RuntimeJournalCell = SeatExclusionCell | HoldCell | SkipCell | LaneAutoCell;

function tallyOf(map: Map<string, number>, max: number): UsageTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const baseOf = (
  items: Set<string>, days: Set<string>, rows: number, firstMs: number | null, lastMs: number | null,
  dispatchRows: number, lowerBound: boolean,
): Omit<CellBase, 'examples'> & { examples: string[] } => ({
  items: items.size,
  examples: [...items].slice(0, MAX_EXAMPLES),
  days: [...days].sort(),
  rows,
  dispatchRows,
  firstSeen: isoOrNull(firstMs),
  lastSeen: isoOrNull(lastMs),
  lowerBound,
});

/**
 * Pure: recurring cells — a (seat, kind) exclusion, a (hold kind, repo)
 * hold group, a skip code or a lane-auto (lane, tier, via) verdict group
 * at the distinct-item and distinct-day bars. Seat-exclusion cells sort
 * by item count; lane-auto, hold and skip cells follow.
 */
export function runtimeJournalCells(fold: RuntimeJournalFold, lowerBound = false): RuntimeJournalCell[] {
  const cells: RuntimeJournalCell[] = [];
  const dispatchRows = fold.rows;
  for (const cell of fold.exclusions.values()) {
    if (cell.items.size < RUNTIME_JOURNAL_MIN_ITEMS || cell.days.size < RUNTIME_JOURNAL_MIN_DAYS) continue;
    cells.push({
      kind: 'seat-exclusion',
      ...baseOf(cell.items, cell.days, cell.rows, cell.firstMs, cell.lastMs, dispatchRows, lowerBound),
      seatId: cell.seatId,
      reasonKind: cell.kind,
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
    });
  }
  for (const cell of fold.holds.values()) {
    if (cell.items.size < RUNTIME_JOURNAL_MIN_ITEMS || cell.days.size < RUNTIME_JOURNAL_MIN_DAYS) continue;
    cells.push({
      kind: cell.holdKind === 'park' ? 'park-hold' : 'split-hold',
      holdKind: cell.holdKind,
      ...baseOf(cell.items, cell.days, cell.rows, cell.firstMs, cell.lastMs, dispatchRows, lowerBound),
      repo: cell.repo,
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      reasonKinds: tallyOf(cell.kinds, MAX_PROMPT_TALLIES),
      noReopen: cell.holdKind === 'park' ? cell.noReopen : null,
    });
  }
  for (const cell of fold.skips.values()) {
    if (cell.items.size < RUNTIME_JOURNAL_MIN_ITEMS || cell.days.size < RUNTIME_JOURNAL_MIN_DAYS) continue;
    cells.push({
      kind: 'skip-code',
      ...baseOf(cell.items, cell.days, cell.rows, cell.firstMs, cell.lastMs, dispatchRows, lowerBound),
      code: cell.code,
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      backends: tallyOf(cell.backends, MAX_PROMPT_TALLIES),
    });
  }
  for (const group of fold.laneAutos.values()) {
    for (const verdict of ['held', 'fallback'] as const) {
      const cell = verdict === 'held' ? group.held : group.fallback;
      if (cell === null || cell.items.size < RUNTIME_JOURNAL_MIN_ITEMS || cell.days.size < RUNTIME_JOURNAL_MIN_DAYS) continue;
      const shared = {
        ...baseOf(cell.items, cell.days, cell.rows, cell.firstMs, cell.lastMs, dispatchRows, lowerBound),
        lane: group.lane,
        tier: group.tier,
        via: group.via,
        scoredRows: group.scoredRows,
        gatedRows: cell.gatedRows,
        evaluatedRows: cell.evaluatedRows,
        maxSamples: cell.maxSamples,
        repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
        sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      };
      cells.push(verdict === 'held'
        ? { kind: 'lane-auto-held', verdict: 'held', ...shared, pickedModels: null }
        : { kind: 'lane-auto-fallback', verdict: 'threshold-fallback', ...shared, pickedModels: tallyOf(cell.pickedModels, MAX_PROMPT_TALLIES) });
    }
  }
  // Worst first inside each kind; kinds ordered seat-exclusion, lane-auto, holds, skips.
  const rank = (c: RuntimeJournalCell): number =>
    c.kind === 'seat-exclusion' ? 0
      : c.kind === 'lane-auto-held' ? 1
        : c.kind === 'lane-auto-fallback' ? 2
          : c.kind === 'park-hold' ? 3
            : c.kind === 'split-hold' ? 4 : 5;
  return cells.sort((a, b) => rank(a) - rank(b) || b.items - a.items || a.kind.localeCompare(b.kind));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is fleet/runtime/runs.jsonl under the ASHLR home (~/.ashlr/fleet/runtime, the writer\'s own path — it does not follow $ASHLR_HOME): the standing fleet\'s append-only dispatch journal. tick-hooks-live\'s afterDispatch (src/core/fleet/tick-hooks-live.ts) appends one fleet.runtime dispatch row per work-item outcome — dispatched, held or skipped — carrying the route decision behind it: backend, lane, seatId, the full SeatRouter seatDecision with per-seat exclusion details (kind per SeatReason), the RouteHold (park|split) when the router held the item, the skipReason when dispatch declined it, the route.lane-auto.v1 autoModel receipt when the seat evaluation resolved a lane whose models.json entry is \'auto\' (the scorer\'s verdict — scored, threshold-fallback or held — the picked model, the sample bar and the eligible candidates\' outcome tallies), and the harness version the attempt ran under. landing rows record merges and reverts. The journal rotates at 2 MB keeping one previous generation. Its only readers until this feed were display and attribution surfaces — the Fleet live projection (/api/verse/fleet/live, behind `phm fleet lane-slots`, `phm lanes`, `phm map` and the console\'s Fleet screen), the ops board and scheduling\'s work-history join — and tick.json keeps only the LAST tick\'s held list, so recurring holds, chronic seat exclusions, repeating skip codes and lane-auto verdicts that never pick or never leave the default were invisible history.';

const REPRO = 'Reproduce the fold by reading the newest dispatch rows — the Fleet live surface (`/api/verse/fleet/live`, or `phm fleet lane-slots --json` / `phm map --json` which build the same snapshot), or the JSONL directly under ~/.ashlr/fleet/runtime/ — and filtering type=\'dispatch\' rows inside the window. The writers and folds this repository owns are src/core/fleet/fleet-runtime-journal.ts (the journal contract and rotation), src/core/fleet/tick-hooks-live.ts (afterDispatch, what each field means), src/core/fleet/dispatch-router.ts (routeWorkItem: the park/split holds, the seatDecision it journals and the autoModel receipt it carries), src/core/fleet/lane-auto-model.ts (chooseLaneAuto: the receipt\'s gates and verdicts), src/core/fleet/lane-models.ts and the runs dir\'s models.json (the \'auto\' entries the via key names), src/core/router/lane-auto-score.ts (the outcome-score index and sample bar), src/core/router/outcomes.ts (the outcome rows the scorer reads) and src/core/routing/router.ts and seat-reasons.ts (routeSeat, the exclusion reason kinds) with src/core/routing/budget-store.ts (the capacity snapshot and shadow decision log the router reads).';

const NO_CHANGE = 'If the window has rolled forward, the pattern was a one-off burst the fleet recovered from, the holds/skips/exclusions reflect intended policy or genuine capacity that has since cleared, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

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

const examplesText = (cell: CellBase): string =>
  cell.examples.length === 0 ? '' : ` Example item ids: ${cell.examples.join(', ')}.`;

/** What each adverse exclusion kind means in the router's own vocabulary. */
const KIND_HINTS: Record<string, string> = {
  'unknown-usage': 'the seat\'s usage reading is missing or unreadable, so the router fails closed rather than guess headroom',
  'unreachable': 'the seat\'s reachability probe keeps failing',
  'signed-out': 'the seat\'s recorded auth state reads signed out',
  'other': 'the exclusion reason did not fit the router\'s reason taxonomy',
};

function seatExclusionPrompt(cell: SeatExclusionCell): string {
  const hint = KIND_HINTS[cell.reasonKind];
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const share = cell.dispatchRows > 0 ? ` (${Math.round((cell.rows / cell.dispatchRows) * 100)}% of the ${cell.dispatchRows} in-window dispatch rows carried this exclusion)` : '';
  return [
    `Phantom's fleet runtime journal keeps recording seat-router evaluations that exclude seat '${cell.seatId}' for '${cell.reasonKind}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each dispatch row's seatDecision lists every ineligible seat with its reason kinds; '${cell.reasonKind}'${hint === undefined ? ' is not one of the usual capacity or policy states' : ` means ${hint}`}.${share}${repos}${sources}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this seat's eligibility evidence stays broken: read the newest dispatch rows and the seat's latest capacity snapshot (~/.ashlr/routing/capacity.json, published by the Verse server's account collector), then check the evidence path the kind names — the usage-capture chain for 'unknown-usage' (the same capture gaps the usage-gap feed tracks at the jobs-ledger layer), the reachability probe for 'unreachable', the auth/session state for 'signed-out', and the reason taxonomy in src/core/routing for 'other'. A seat excluded this way in nearly every evaluation is dead capacity the fleet keeps paying to assess while routing around it — or a probe that misreads a healthy seat.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the eligibility assessment in src/core/routing, the probe or capture path that feeds it, or the taxonomy that leaves reasons unclassified.${PINNED} If the exclusion is genuine and intended — the seat really is off, unreachable or signed out and the fleet correctly routes around it — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function holdPrompt(cell: HoldCell): string {
  const isPark = cell.holdKind === 'park';
  const noReopen = isPark && cell.noReopen !== null && cell.noReopen > 0
    ? ` ${cell.noReopen} of the contributing rows named no known reopening — the park does not lift on its own.`
    : '';
  const kinds = cell.reasonKinds.length === 0 ? '' : ` Reason kinds the rows' seatDecisions carried: ${tallyText(cell.reasonKinds)}.`;
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const share = cell.dispatchRows > 0 ? ` (${Math.round((cell.rows / cell.dispatchRows) * 100)}% of the ${cell.dispatchRows} in-window dispatch rows)` : '';
  return [
    isPark
      ? `Phantom's fleet runtime journal keeps recording seat-evaluated park holds on '${cell.repo}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`
      : `Phantom's fleet runtime journal keeps recording split holds on '${cell.repo}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    isPark
      ? `A park hold means the standing SeatRouter evaluated the item and no producer-eligible seat could take it — policy holds (land-first saturation, missing repo identity, rollout-stage refusals) carry no seatDecision and are not this cell.${noReopen}${kinds}${sources}${share}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`
      : `A split hold means the item needs more context than any seat's window can take — the router never hands oversized work to a local model instead; it waits for someone to slice it.${sources}${share}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    isPark
      ? `Find which blocker dominates the parks: grant-stage or lane-cap refusals, demotions, exhausted capacity windows, or a repo stuck outside the grant's rollout stage — the reason-kind tallies and the seatDecision exclusions on the newest rows name the candidates. Check whether the same items keep re-parking every tick (one stuck item, not a pattern) or distinct items keep arriving unroutable (a producer or admission problem).`
      : `Find why this repo's items keep exceeding every seat's context: whether the producers mint oversized items that should be decomposed at source, whether the context estimates are wrong, or whether a seat's recorded contextWindow is stale.`,
    '',
    `Fix what lives here — the dispatch router's hold logic, the grant/rollout configuration this repository owns, the seat capacity readings, or the producers minting the work.${PINNED} If the holds reflect genuine saturation or intended policy that has since cleared, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function skipPrompt(cell: SkipCell): string {
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const backends = cell.backends.length === 0 ? '' : ` Recorded backends: ${tallyText(cell.backends)}.`;
  const share = cell.dispatchRows > 0 ? ` (${Math.round((cell.rows / cell.dispatchRows) * 100)}% of the ${cell.dispatchRows} in-window dispatch rows)` : '';
  return [
    `Phantom's fleet runtime journal keeps recording dispatch attempts declined on skip reason '${cell.code}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `These are non-dispatched rows no route hold explains — the skip happened outside the SeatRouter's park/split path, so the code names whichever gate declined the launch.${sources}${backends}${share}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which gate emits this code: trace skipReason producers in the daemon loop and tick hooks (authority, backpressure, lane caps, repair authority, standing-policy refusals), check whether the code is a stable machine reason or free text leaking into the field, and whether the declines concentrate on one source, backend or repo — the tallies name the candidates. A code that keeps declining real work is either a stuck gate or a producer minting work the fleet cannot take.`,
    '',
    `Fix what lives here — the skip path or gate in src/core that emits the code, the producer minting the declined work, or the policy that should not be declining it.${PINNED} If the skips are intended refusals (KILL, paused repos, held grants) or a code that already stopped firing, report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function laneAutoHeldPrompt(cell: LaneAutoCell): string {
  const gated = cell.gatedRows > 0
    ? ` ${cell.gatedRows} of the contributing rows carried zero candidates — gated before scoring ever ran (the billing, engine/backend-match or catalog-eligibility checks chooseLaneAuto applies first); the other ${cell.evaluatedRows} reached scoring and still produced no pick.`
    : ` All ${cell.evaluatedRows} contributing rows reached scoring with eligible candidates yet still produced no pick — the prior default was not among them and nothing reached the sample bar.`;
  const scored = cell.scoredRows > 0
    ? ` ${cell.scoredRows} 'scored' verdict(s) on the same lane/tier/via inside the window show the scorer does engage elsewhere.`
    : '';
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const share = cell.dispatchRows > 0 ? ` (${Math.round((cell.rows / cell.dispatchRows) * 100)}% of the ${cell.dispatchRows} in-window dispatch rows carried this verdict)` : '';
  return [
    `Phantom's fleet runtime journal keeps recording lane-auto 'held' verdicts for lane '${cell.lane}' tier '${cell.tier}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `A 'held' verdict means chooseLaneAuto resolved the lane's models.json entry '${cell.via}' to 'auto' but produced no model pick — model is null on the receipt.${gated}${scored}${repos}${sources}${share}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why this lane's auto selection never engages: read the newest dispatch rows' autoModel receipts and the lane's models.json entry (the runs dir's models.json — '${cell.via}' resolving to 'auto'), then walk the gates chooseLaneAuto applies in order — laneAutoBillingAllows (subscription-only currency, on-demand flags, grok freshness), the lane/engine/backend match, the native catalog offer (readLaneAutoNativeModels), the verified-model registry and the docs-deprecated/retired filters. For rows that reached scoring, check whether the eligible candidates' outcome evidence ever approaches the sample bar or the prior default fell out of eligibility. A lane configured 'auto' that never picks is either dead configuration parking real work or an evidence path that never feeds the scorer.`,
    '',
    `Fix what lives here — the lane-models configuration this repository writes, the auto-selection gates in src/core/fleet/lane-auto-model.ts, the outcome-evidence pipeline in src/core/router (outcomes.ts feeding indexLaneAutoScores), or the catalog/registry/docs filters that empty the candidate set.${PINNED} If the holds are intended — the lane's billing posture genuinely admits no auto pick, or a lane like devin-cli whose auto is structurally held pending native admission — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function laneAutoFallbackPrompt(cell: LaneAutoCell): string {
  const picked = cell.pickedModels === null || cell.pickedModels.length === 0
    ? ''
    : ` Prior default(s) that kept serving: ${tallyText(cell.pickedModels)}.`;
  const scored = cell.scoredRows > 0
    ? ` ${cell.scoredRows} 'scored' verdict(s) on the same lane/tier/via inside the window show the scorer does engage elsewhere.`
    : '';
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const sources = cell.sources.length === 0 ? '' : ` Recorded sources: ${tallyText(cell.sources)}.`;
  const share = cell.dispatchRows > 0 ? ` (${Math.round((cell.rows / cell.dispatchRows) * 100)}% of the ${cell.dispatchRows} in-window dispatch rows carried this verdict)` : '';
  return [
    `Phantom's fleet runtime journal keeps recording lane-auto 'threshold-fallback' verdicts for lane '${cell.lane}' tier '${cell.tier}' — ${cell.items} distinct work item(s) inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `A 'threshold-fallback' verdict means the scorer ranked no eligible candidate at the sample bar — so the lane's configured prior default kept serving. The outcome evidence indexLaneAutoScores builds (src/core/router/lane-auto-score.ts) never accumulates enough resolved samples per (lane, tier, work_class, model) for this lane/tier/via: the deepest candidate seen carried ${cell.maxSamples} sample(s).${picked}${scored}${repos}${sources}${share}${seenText(cell)}${examplesText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why the evidence starves: whether router outcomes for this lane/tier are being recorded at all — indexLaneAutoScores skips outcome rows missing lane, model, tier or work_class, or with neither merged nor reverted resolved — whether work classes fragment the samples below the bar, whether outcomes resolve too slowly inside the window, or whether the models the config admits are ones the fleet rarely runs. A fallback streak is not an error — it is the scorer honestly reporting it has no evidence; the fix is feeding it evidence or concluding 'auto' is premature for this lane/tier.`,
    '',
    `Fix what lives here — the outcome capture and attribution in src/core/router (outcomes.ts and its writers, the work-class join), the lane/tier entries in the runs dir's models.json, or the candidate set chooseLaneAuto admits.${PINNED} If the fallback is intended — the lane genuinely lacks outcome volume and the prior default is the right choice — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function runtimeJournalItem(cell: RuntimeJournalCell, repo: string): CloudBacklogItem {
  const prompt = cell.kind === 'seat-exclusion'
    ? seatExclusionPrompt(cell)
    : cell.kind === 'skip-code'
      ? skipPrompt(cell)
      : cell.kind === 'lane-auto-held'
        ? laneAutoHeldPrompt(cell)
        : cell.kind === 'lane-auto-fallback'
          ? laneAutoFallbackPrompt(cell)
          : holdPrompt(cell);
  const title = cell.kind === 'seat-exclusion'
    ? `Seat ${fieldText(cell.seatId, MAX_NAME_CHARS)} keeps failing eligibility evidence: ${cell.reasonKind}`
    : cell.kind === 'skip-code'
      ? `Fleet dispatches keep skipping on ${cell.code}`
      : cell.kind === 'lane-auto-held'
        ? `Lane auto keeps holding ${cell.lane}/${cell.tier} picks (${cell.via})`
        : cell.kind === 'lane-auto-fallback'
          ? `Lane auto keeps falling back on ${cell.lane}/${cell.tier} picks (${cell.via})`
          : cell.holdKind === 'park'
            ? `Fleet work keeps parking after seat evaluation: ${fieldText(cell.repo, MAX_NAME_CHARS)}`
            : `Fleet work keeps exceeding every seat's context: ${fieldText(cell.repo, MAX_NAME_CHARS)}`;
  const idKey = cell.kind === 'seat-exclusion'
    ? `seat-exclusion:${cell.seatId}:${cell.reasonKind}`
    : cell.kind === 'skip-code'
      ? `skip-code:${cell.code}`
      : cell.kind === 'lane-auto-held' || cell.kind === 'lane-auto-fallback'
        ? `${cell.kind}:${cell.lane}:${cell.tier}:${cell.via}`
        : `${cell.holdKind}-hold:${cell.repo}`;
  return {
    id: `runtime-journal-${sha(idKey)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `runtime-${cell.kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the fleet runtime journal's recurring adverse dispatch
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function runtimeJournalBacklogItems(opts: RuntimeJournalItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? RUNTIME_JOURNAL_WINDOW_HOURS;
    const journalPath = opts.journalPath ?? runsJournalPath();
    // The writer rotates at RUNS_JOURNAL_MAX_BYTES keeping one .1
    // predecessor; read both tails so the window reaches back across a
    // rotation, oldest file first.
    const previousPath = journalPath.replace(/\.jsonl$/, '.1.jsonl');
    const [current, previous] = await Promise.all([
      readLedgerTail(journalPath, RUNS_JOURNAL_MAX_BYTES),
      previousPath === journalPath ? Promise.resolve({ state: 'missing' as const }) : readLedgerTail(previousPath, RUNS_JOURNAL_MAX_BYTES),
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
    const fold = foldRuntimeJournal(texts, nowMs, windowHours);
    if (fold.rows === 0) return [];
    const cells = runtimeJournalCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? RUNTIME_JOURNAL_BACKLOG_MAX_ITEMS, RUNTIME_JOURNAL_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => runtimeJournalItem(cell, repo));
  } catch {
    return [];
  }
}
