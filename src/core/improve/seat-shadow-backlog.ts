/**
 * Shadow seat-decision journal recurring live/shadow divergence →
 * self-improvement backlog items.
 *
 * The fleet's seat router (routeSeat, src/core/routing) decides which
 * budget seat — and so which provider engine class — autonomous work
 * may run on. Two writers append one `route-decision`-style v1 record
 * per evaluation to `~/.ashlr/routing/decisions.jsonl` (rotated to
 * `decisions.1.jsonl` at 2 MB) through recordShadowDecision
 * (src/core/routing/budget-store.ts):
 *
 *  - the fleet tick's dispatch path (src/core/fleet/tick-hooks-live.ts
 *    deps.shadow) records the seatDecision routeWorkItem actually
 *    used beside what dispatched — actual.engine is the EngineId that
 *    ran and actual.seatId echoes the pick, so a seat-id difference can
 *    only come from a writer that records the seat that truly ran;
 *  - the daemon loop's shadowSeatRouteBeside (src/core/daemon/loop.ts)
 *    runs routeSeat BESIDE the live backend choice — a genuine
 *    shadow-vs-actual comparison — with actual.seatId null and
 *    actual.engine the backend that ran.
 *
 * budget-store.ts calls the log "the comparison shadow mode exists
 * for", yet its only readers were display and authority surfaces —
 * the budget API's shadow-decisions view, `phm telemetry`, the
 * autonomy ladder's authority status and the FleetRouterPane — reports
 * someone had to run and read. No fold ever turned recurring
 * disagreement between the seat router's pick and what the fleet
 * actually ran into work: a router whose seat model keeps missing what
 * dispatch honors (or dispatch that keeps bypassing the seat layer's
 * answer) stayed invisible history.
 *
 * seatShadowBacklogItems carries the same journal into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both retained generations are tail-read through
 *    readShadowDecisionsChecked — the writer-contract checked reader
 *    (O_NOFOLLOW, bounded tail, envelope validation, scrubbed fields) —
 *    at its 500-record cap per file; nothing is written and no network
 *    is touched. A missing or unreadable file yields no items; a record
 *    the checked reader rejects never reaches the fold.
 *  - Rows count only under the record contract: v:1, an ISO `at`
 *    inside the window plus the sibling folds' skew ceiling, a known
 *    source (the 'test' source is excluded — fixture evidence is not
 *    fleet behavior), a decision object whose seatId is a string or
 *    null, and an `actual` that is null or carries a non-empty engine
 *    string. Anything less is skipped — never guessed, and unknown
 *    stays unknown: an unmapped backend engine, an absent actual seat
 *    and an absent pick are all "cannot compare", not divergence.
 *  - Divergence is recomputed, never trusted from the record: there is
 *    no stored verdict. Three cell kinds, each needing BOTH sides
 *    resolved —
 *      seat:     decision.seatId and actual.seatId are both non-empty
 *                and differ — the seat that ran is not the seat the
 *                router picked;
 *      engine:   the pick's seat class (engineOfSeatId, the router's
 *                own seat→engine rule) differs from the class the
 *                recorded backend maps to — including when the seat
 *                ids agree, which catches a dispatch backend that
 *                contradicts the honored seat pick;
 *      no-seat:  the router picked nothing (seatId null) yet a
 *                budget-class engine or seat still ran — the seat
 *                layer's exclusions and dispatch reality disagree.
 *    Engine-class comparison uses a conservative EngineId→BudgetEngine
 *    crosswalk covering only ids whose class the codebase documents
 *    (devin-cli→devin per grantEngineOfLane, the local runtimes→local,
 *    the cli/api engines by name); every other backend id is unmapped
 *    and its records are skipped rather than guessed.
 *  - Recurring means recorded across days: a cell emits only at
 *    SEAT_SHADOW_MIN_DIVERGENCES records across SEAT_SHADOW_MIN_DAYS
 *    distinct UTC days inside the window — the sibling feeds'
 *    recurring convention.
 *  - Fleet machinery only: the journal describes this install's seat
 *    routing, so items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Truncation is stated, never hidden: when a file's tail hit the
 *    checked reader's byte or record bound, every prompt says the
 *    counts are a lower bound.
 *  - Dedup is downstream: item ids hash the cell identity — never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a cell whose
 *    divergence resolves simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { engineOfSeatId, type BudgetEngine } from '../routing/policy.js';
import {
  decisionsLogPath,
  readShadowDecisionsChecked,
  type ShadowDecisionRecord,
  type ShadowDecisionSource,
} from '../routing/budget-store.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (kind, source, task, pair) cells stay well under this on a real fleet. */
export const SEAT_SHADOW_MAX_ITEMS = 10;
const SEAT_SHADOW_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention, in milliseconds because the journal stamps ISO `at`. */
export const SEAT_SHADOW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const SEAT_SHADOW_FUTURE_SKEW_MS = 300_000;
/** Divergences a cell needs before it counts as recurring. */
export const SEAT_SHADOW_MIN_DIVERGENCES = 3;
/** Distinct UTC days the divergence must span — recurring means recorded across days. */
export const SEAT_SHADOW_MIN_DAYS = 2;
/** Per-file record cap handed to the checked reader (its own maximum). */
const SEAT_SHADOW_READ_LIMIT = 500;
/** The checked reader's byte bound per file tail (4 MiB inside readShadowDecisionsChecked). */
const SEAT_SHADOW_READ_BYTES = 4 * 1024 * 1024;
/** The fleet's own repository label: journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Dispatch backends whose BudgetEngine class the codebase documents; everything else is unmapped, never guessed. */
const BACKEND_ENGINE_CLASS: Readonly<Record<string, BudgetEngine>> = Object.freeze({
  claude: 'claude',
  'claude-api': 'claude-api',
  codex: 'codex',
  grok: 'grok',
  'grok-cli': 'grok',
  // The devin-cli lane is authorized by the grant engine `devin`
  // (grantEngineOfLane, fleet-types.ts) — the same family the seat ids name.
  'devin-cli': 'devin',
  // The local fleet's runtimes are the 'local' seat class: $0, no provider window.
  'local-coder': 'local',
  'llama-server': 'local',
});
/** Record sources that describe real fleet behavior; 'test' rows are fixture evidence. */
const FLEET_SOURCES: ReadonlySet<ShadowDecisionSource> = new Set(['daemon', 'gateway', 'best-of-n', 'leader', 'verse']);

export interface SeatShadowItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Routing dir holding decisions.jsonl and its rotated decisions.1.jsonl; default routingDir() (~/.ashlr/routing). */
  dir?: string;
  /** Most items one call emits (default SEAT_SHADOW_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in milliseconds (default SEAT_SHADOW_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window in ms epoch (default: Date.now()). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fold — one pass over both retained journal generations
// ---------------------------------------------------------------------------

interface SeatShadowRecord {
  atMs: number;
  source: ShadowDecisionSource;
  task: string;
  /** The router's seat pick; null when it found nothing eligible. */
  pickedSeat: string | null;
  /** The budget engine class the pick maps to (engineOfSeatId); null when no pick. */
  pickedClass: BudgetEngine | null;
  /** What actually ran: backend EngineId plus the seat id when the writer recorded one. */
  actualEngine: string;
  actualEngineClass: BudgetEngine | null;
  actualSeat: string | null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * One checked-reader record as fold evidence, or null when it cannot be
 * compared honestly. The reader already enforced the v1 envelope (ISO
 * `at`, known source, decision/request objects); this pass re-reads only
 * the fields the comparison needs and refuses anything malformed —
 * unknown stays unknown, never guessed.
 */
function seatShadowRecord(record: ShadowDecisionRecord): SeatShadowRecord | null {
  if (!FLEET_SOURCES.has(record.source)) return null;
  const atMs = Date.parse(record.at);
  if (!Number.isFinite(atMs)) return null;
  const taskValue: unknown = record.request.task;
  const task = typeof taskValue === 'string' && taskValue.trim() !== ''
    ? fieldText(taskValue, 24)
    : 'unknown';
  const rawPick: unknown = record.decision.seatId;
  // seatId is string|null by contract; anything else is malformed evidence.
  if (rawPick !== null && typeof rawPick !== 'string') return null;
  const pickedSeat = nonEmpty(rawPick) ? rawPick.trim() : null;
  const actual = record.actual;
  if (actual === null || actual === undefined || typeof actual !== 'object') return null;
  const engine: unknown = actual.engine;
  if (!nonEmpty(engine)) return null;
  const rawActualSeat: unknown = actual.seatId;
  if (rawActualSeat !== null && rawActualSeat !== undefined && typeof rawActualSeat !== 'string') return null;
  const actualSeat = nonEmpty(rawActualSeat) ? rawActualSeat.trim() : null;
  const actualEngine = engine.trim();
  return {
    atMs,
    source: record.source,
    task,
    pickedSeat,
    pickedClass: pickedSeat === null ? null : engineOfSeatId(pickedSeat),
    actualEngine,
    actualEngineClass: BACKEND_ENGINE_CLASS[actualEngine] ?? null,
    actualSeat,
  };
}

type DivergenceKind = 'seat' | 'engine' | 'no-seat';

interface SeatShadowCell {
  kind: DivergenceKind;
  key: string;
  source: ShadowDecisionSource;
  task: string;
  /** The disagreement as the prompt quotes it (seat pair, engine pair, or what ran with no pick). */
  detail: string;
  divergences: number;
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface SeatShadowFold {
  /** In-window records that carried a comparable actual. */
  records: number;
  /** In-window records skipped because neither side could be compared. */
  uncompared: number;
  cells: Map<string, SeatShadowCell>;
  /** True when a file tail hit the checked reader's bound — counts are a lower bound. */
  lowerBound: boolean;
}

function addDivergence(fold: SeatShadowFold, kind: DivergenceKind, rec: SeatShadowRecord, detail: string): void {
  const key = `${kind}${rec.source}${rec.task}${detail}`;
  let cell = fold.cells.get(key);
  if (cell === undefined) {
    cell = { kind, key, source: rec.source, task: rec.task, detail, divergences: 0, days: new Set(), firstMs: null, lastMs: null };
    fold.cells.set(key, cell);
  }
  cell.divergences += 1;
  cell.days.add(dayOf(rec.atMs));
  cell.firstMs = cell.firstMs === null ? rec.atMs : Math.min(cell.firstMs, rec.atMs);
  cell.lastMs = cell.lastMs === null ? rec.atMs : Math.max(cell.lastMs, rec.atMs);
}

/**
 * Pure: classify one comparable record into at most one divergence cell.
 * Seat identity beats engine class (the exact seat that ran is the
 * stronger evidence); an agreeing seat pick still gets the engine-class
 * check so a backend that contradicts the honored seat is caught; a
 * null pick counts only when a budget-class engine or a recorded seat
 * still ran. Returns true when the record landed in a cell.
 */
function classify(rec: SeatShadowRecord, fold: SeatShadowFold): boolean {
  const picked = rec.pickedSeat;
  const ranSeat = rec.actualSeat;
  if (picked !== null && ranSeat !== null) {
    if (picked !== ranSeat) {
      addDivergence(fold, 'seat', rec, `${fieldText(picked)}→${fieldText(ranSeat)}`);
      return true;
    }
    // Same seat ran — but the recorded backend can still contradict its class.
    if (rec.actualEngineClass !== null && rec.pickedClass !== null && rec.actualEngineClass !== rec.pickedClass) {
      addDivergence(fold, 'engine', rec, `${fieldText(picked)}:${rec.pickedClass}>${fieldText(rec.actualEngine)}:${rec.actualEngineClass}`);
      return true;
    }
    return false;
  }
  if (picked !== null) {
    // The seat that ran is unrecorded — only the engine class can be compared.
    if (rec.actualEngineClass !== null && rec.pickedClass !== rec.actualEngineClass) {
      addDivergence(fold, 'engine', rec, `${fieldText(picked)}:${rec.pickedClass}>${fieldText(rec.actualEngine)}:${rec.actualEngineClass}`);
      return true;
    }
    return false;
  }
  // The router found no eligible seat — divergence only when a budget-class
  // engine or a recorded seat still ran (an unmapped backend is unknown, not divergence).
  if (rec.actualEngineClass !== null || ranSeat !== null) {
    const ran = ranSeat !== null ? fieldText(ranSeat) : `${fieldText(rec.actualEngine)}:${rec.actualEngineClass}`;
    addDivergence(fold, 'no-seat', rec, ran);
    return true;
  }
  return false;
}

function fileMayBeTruncated(file: string, decisions: number): boolean {
  try {
    if (statSync(file).size > SEAT_SHADOW_READ_BYTES) return true;
  } catch {
    // The checked reader already opened the file; a failed stat cannot prove truncation either way.
  }
  return decisions >= SEAT_SHADOW_READ_LIMIT;
}

/**
 * Fold both retained journal generations into per-cell divergence
 * evidence. Total: unreadable or absent files contribute nothing, and a
 * fold failure yields an empty result rather than throwing into
 * discovery.
 */
export function foldSeatShadowJournal(
  files: readonly string[],
  nowMs: number,
  windowMs: number,
): SeatShadowFold {
  const fold: SeatShadowFold = { records: 0, uncompared: 0, cells: new Map(), lowerBound: false };
  const since = nowMs - windowMs;
  const until = nowMs + SEAT_SHADOW_FUTURE_SKEW_MS;
  for (const file of files) {
    const read = readShadowDecisionsChecked(SEAT_SHADOW_READ_LIMIT, file);
    if (read.state !== 'ok') continue;
    fold.lowerBound = fold.lowerBound || fileMayBeTruncated(file, read.decisions.length);
    for (const record of read.decisions) {
      const rec = seatShadowRecord(record);
      if (rec === null) continue;
      if (rec.atMs < since || rec.atMs > until) continue;
      fold.records += 1;
      if (!classify(rec, fold)) fold.uncompared += 1;
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/routing/decisions.jsonl (and its rotated decisions.1.jsonl predecessor) — the shadow seat-decision log recordShadowDecision appends (src/core/routing/budget-store.ts): one v1 record per seat-router evaluation carrying the request, the SeatDecision (seatId, candidates, exclusions, why) and, when the caller knows it, the actual {engine, seatId} that ran. Writers are the fleet tick dispatch path (src/core/fleet/tick-hooks-live.ts deps.shadow, which records the seatDecision routeWorkItem used beside the dispatched backend) and the daemon loop\'s shadowSeatRouteBeside (src/core/daemon/loop.ts, a genuine routeSeat-beside-backend comparison). Before this fold the log\'s only readers were the budget API\'s shadow-decisions view, `phm telemetry`, the autonomy ladder\'s authority status and the FleetRouterPane — reports someone had to run and read — so recurring disagreement between the seat router\'s pick and what actually ran never became work.';

const NO_CHANGE = 'If the window has rolled forward, the disagreements were a transient routing-state window (a capacity snapshot mid-refresh, a seat that just signed out or reset), the cause is owner-side config or credentials, the seat router is intentionally shadow-only and the divergence is expected until the autonomy ladder promotes it, or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const KIND_TEXT: Readonly<Record<DivergenceKind, { title: string; lead: string; ask: string }>> = {
  seat: {
    title: 'Seat router pick keeps differing from the seat that ran',
    lead: 'the recorded actual.seatId is not the seatId the seat router picked',
    ask: `find which writer recorded the mismatch — a shadow evaluation whose pick the dispatch then overrode for a reason the seat model cannot see (quota, lane pin, hold), or a seat-policy input (capacity snapshot, budget mode, task arm) that is stale or wrong. Replay a few records' requests through routeSeat (src/core/routing) against the capacity snapshot of their day and compare exclusions; fix whichever side is systematically wrong — the router's inputs in src/core/routing or the dispatch override path in src/core/fleet.`,
  },
  engine: {
    title: "Seat router pick's engine class keeps differing from the dispatched backend",
    lead: "the dispatched backend's engine class is not the class the picked seat's id maps to",
    ask: `find why the backend that ran contradicts the seat pick's engine class — a lane override, fallback chain or hold that moved the work to a different engine family after the seat decision, or a backend→seat-class crosswalk assumption that no longer holds. Check the dispatch path that wrote actual.engine (src/core/fleet/tick-hooks-live.ts routeWorkItem backend, or src/core/daemon/loop.ts shadowSeatRouteBeside) against engineOfSeatId's seat→engine rule in src/core/routing/policy.ts; fix whichever side is systematically wrong.`,
  },
  'no-seat': {
    title: 'Seat router finds no eligible seat while provider engines keep running',
    lead: 'the router found no eligible seat yet a budget-class engine or recorded seat still ran',
    ask: `find why dispatch keeps running work the seat router declined — exclusions the seat model applies (signed-out, unknown-usage, reserve, headroom) that the live dispatch path does not honor, or a seat policy/capacity snapshot that excludes every seat while lanes still have quota. Compare the record's decision.exclusions with the dispatch outcome in src/core/fleet/dispatch-router.ts and the capacity snapshot producer; fix whichever side is systematically wrong — the seat model's inputs in src/core/routing or an exclusion the dispatch path should apply.`,
  },
};

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' A journal tail hit the checked reader\'s bound, so the oldest in-window rows may be missing — the counts are a lower bound, not the whole window.' : '';

function cellPrompt(cell: SeatShadowCell, lowerBound: boolean): string {
  const kind = KIND_TEXT[cell.kind];
  const source = fieldText(String(cell.source), MAX_NAME_CHARS);
  const task = fieldText(cell.task, MAX_NAME_CHARS);
  const days = [...cell.days].sort();
  const windowDays = Math.round(SEAT_SHADOW_WINDOW_MS / 86_400_000);
  return [
    `Phantom's shadow seat-decision journal records recurring divergence between the seat router's pick and what the fleet actually ran — ${cell.divergences} ${kind.lead} record(s) inside the ${windowDays}-day window for source '${source}' task '${task}' (${cell.detail}), the self-improvement work this backlog exists for.`,
    '',
    `Each counted record is a v1 shadow decision whose comparison fields were both resolved: the router's seatId pick against the actual {engine, seatId} the writer recorded. ${cell.divergences} records across ${days.length} UTC day(s) (${daysText(days)}), first seen ${cell.firstMs === null ? 'unknown' : new Date(cell.firstMs).toISOString()}, last seen ${cell.lastMs === null ? 'unknown' : new Date(cell.lastMs).toISOString()}.`,
    '',
    EVIDENCE,
    ...(lowerBound ? [boundNote(true)] : []),
    '',
    `Find out which side is wrong: ${kind.ask} ${NO_CHANGE}`,
  ].join('\n');
}

function cellItem(cell: SeatShadowCell, lowerBound: boolean, repo: string): CloudBacklogItem {
  const id = `seat-shadow-${cell.kind}-${sha(cell.key)}`;
  return {
    id,
    title: KIND_TEXT[cell.kind].title.slice(0, MAX_TITLE_CHARS),
    prompt: cellPrompt(cell, lowerBound),
    area: 'seat-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the shadow seat-decision journal's recurring
 * divergence evidence. Total: a missing routing dir, another repository
 * or any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function seatShadowBacklogItems(opts: SeatShadowItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const now = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : SEAT_SHADOW_WINDOW_MS;
    const dir = opts.dir ?? dirname(decisionsLogPath());
    const files = [join(dir, 'decisions.jsonl'), join(dir, 'decisions.1.jsonl')];
    const fold = foldSeatShadowJournal(files, now, windowMs);
    if (fold.cells.size === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? SEAT_SHADOW_MAX_ITEMS, SEAT_SHADOW_ITEM_HARD_MAX));
    const cells = [...fold.cells.values()]
      .filter((cell) => cell.divergences >= SEAT_SHADOW_MIN_DIVERGENCES && cell.days.size >= SEAT_SHADOW_MIN_DAYS)
      .sort((a, b) => b.divergences - a.divergences || a.key.localeCompare(b.key));
    return cells.slice(0, limit).map((cell) => cellItem(cell, fold.lowerBound, repo));
  } catch {
    return [];
  }
}
