/**
 * Scheduled-routine attempt journal recurring adverse evidence →
 * self-improvement backlog items.
 *
 * `phm routines tick` (the launchd agent's 60-second cadence) and
 * `phm routines run <id>` dispatch YAML routines from
 * `<ashlr home>/routines/routines.yaml` through the cheapest eligible
 * executor with failover, and every attempt appends one Attempt row to
 * `<ashlr home>/routines/runs.jsonl` (src/core/routines/scheduler.ts
 * run()):
 *
 *   {routine, executor, at, duration, costEstimate, outcome, slot}
 *
 * outcome is the writer's closed vocabulary — 'success' and 'submitted'
 * are the working states; 'failed' is the classify() fallback for an
 * invocation error that is not quota, rate-limit or unhealthy;
 * 'quota'/'rate-limit'/'unhealthy' are provider-side limits and reach
 * (ENOENT/auth/ECONNREFUSED/unhealthy); 'unavailable' records that no
 * executor was eligible at all (capabilities, tier, daily limit or
 * cooldown), always under the writer's 'none' executor sentinel.
 *
 * Until now the journal's only readers were the scheduler's own
 * point-in-time folds — history() feeding candidates()' cooldowns and
 * daily-limit tallies and status() rendering STATUS.md's last-attempt
 * table — so five adverse evidence kinds never became work: a routine
 * whose attempts keep failing, a routine that keeps finding no eligible
 * executor, and an executor that keeps recording provider-side failures
 * across the routines that use it.
 *
 * routineBacklogItems carries the same journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing journal reads as an empty ledger — a fresh install whose
 *    routines agent never fired is clean, not degraded; an unreadable
 *    or non-file read yields no items rather than folding partial
 *    evidence.
 *  - Rows count only under the writer's contract: routine and executor
 *    matching the scheduler's own id pattern, a parseable `at`, finite
 *    non-negative duration and costEstimate, an outcome inside the
 *    Attempt vocabulary and an optional string slot. Malformed lines
 *    and off-contract rows are skipped, never guessed; extra fields
 *    the writer may add later are ignored.
 *  - Deliberate-off and working states never emit: 'success' and
 *    'submitted' attempts are the pipeline working, and 'unavailable'
 *    rows never form executor cells — the 'none' sentinel names no
 *    executor to blame.
 *  - Two cell families keep attribution honest. Routine cells key on
 *    (routine, outcome) for the routine-side outcomes — 'failed' and
 *    'unavailable' — so a routine that keeps failing or keeps starving
 *    becomes work even when the cause is its own definition. Executor
 *    cells key on (executor, outcome) for the executor-side outcomes —
 *    'failed', 'quota', 'rate-limit', 'unhealthy' — so a provider limit
 *    or a broken executor surfaces once, against the executor every
 *    routine shares, instead of once per routine that happened to try
 *    it. A routine that only ever hits provider limits therefore emits
 *    executor evidence, not a misleading routine-failure item.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a cell emits only when its in-window rows reach
 *    ROUTINE_MIN_UNITS across ROUTINE_MIN_DAYS distinct UTC days — one
 *    bad firing or a single provider blip stays quiet. The window is
 *    anchored on each row's own `at`, with the sibling feeds'
 *    future-skew allowance.
 *  - Unknown stays unknown: the journal records attempt outcomes,
 *    never whether the routine's output was any good; prompts keep the
 *    no-change escape.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older rows, every prompt says the counts are a lower bound.
 *  - Every journal string is untrusted text: ids are pattern-bound but
 *    still scrubbed, flattened and capped before they reach a prompt.
 *  - Dedup is downstream: item ids hash the cell identity (dimension,
 *    id and outcome — never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a routine or executor that recovers simply stops
 *    re-adding.
 *  - The routines store describes this install's own schedules and
 *    executors and carries no repository column, so items emit only
 *    for the fleet's own repository — the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; routine/executor cells are bounded by config diversity. */
export const ROUTINE_BACKLOG_MAX_ITEMS = 8;
const ROUTINE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const ROUTINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds tolerate. */
const ROUTINE_FUTURE_SKEW_MS = 60_000;
/** In-window rows a cell needs before its outcome counts as recurring. */
export const ROUTINE_MIN_UNITS = 3;
/** Distinct UTC days the rows must span — recurring means recorded across days. */
export const ROUTINE_MIN_DAYS = 2;
/**
 * Bounded tail for the journal; an attempt row is ~200 bytes, so 512 KiB
 * retains thousands of attempts — far more than a week of cron-driven
 * rows even at per-minute schedules.
 */
const ROUTINE_TAIL_BYTES = 512 * 1024;
/**
 * The journal's path inside the Ashlr home — the writer's own layout:
 * routinesDir() in src/core/routines/scheduler.ts is join(ashlrHome(),
 * 'routines') and run() appends 'runs.jsonl' inside it.
 */
const ROUTINE_JOURNAL_RELATIVE = join('routines', 'runs.jsonl');
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded ids are pattern-bound already; flatten, scrub and cap anyway. */
const MAX_ID_CHARS = 64;
/** Distinct counterparty ids quoted inside one prompt before the rest is summarized. */
const MAX_PARTNERS = 4;
/** The fleet's own repository label: routine evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The scheduler's own id pattern (decodeConfig's `id` in scheduler.ts). */
const ROUTINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The writer's Attempt outcome vocabulary (scheduler.ts Attempt). */
const OUTCOMES = new Set([
  'success', 'submitted', 'quota', 'rate-limit', 'unhealthy', 'failed', 'unavailable',
]);
/** Routine-side adverse outcomes: the routine's own run kept not completing. */
const ROUTINE_OUTCOMES = new Set(['failed', 'unavailable']);
/** Executor-side adverse outcomes: the executor kept failing provider-side. */
const EXECUTOR_OUTCOMES = new Set(['failed', 'quota', 'rate-limit', 'unhealthy']);
/** The writer's sentinel executor on 'unavailable' rows — no executor to blame. */
const NO_EXECUTOR = 'none';

export interface RoutineItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: join(ashlrHome(), 'routines', 'runs.jsonl')). */
  journalPath?: string;
  /** Most items one call emits (default ROUTINE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
  /** Window in ms (default ROUTINE_WINDOW_MS). */
  windowMs?: number;
}

/** One validated Attempt row inside the evidence window. */
export interface RoutineAttemptRow {
  atMs: number;
  utcDay: string;
  routine: string;
  executor: string;
  outcome: string;
  durationMs: number;
  costEstimate: number;
}

/** Journal-recorded ids are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = MAX_ID_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated Attempt rows. Malformed lines,
 * foreign shapes and rows outside the writer's contract — a non-pattern
 * routine or executor id, an unparseable timestamp, negative or
 * non-finite numbers, an outcome outside the Attempt vocabulary — are
 * skipped, never guessed.
 */
export function parseRoutineAttemptRows(text: string): RoutineAttemptRow[] {
  const rows: RoutineAttemptRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    const routine = r['routine'];
    const executor = r['executor'];
    const outcome = r['outcome'];
    const at = r['at'];
    const durationMs = r['duration'];
    const costEstimate = r['costEstimate'];
    const slot = r['slot'];
    if (typeof routine !== 'string' || !ROUTINE_ID_PATTERN.test(routine)) continue;
    if (typeof executor !== 'string' || !ROUTINE_ID_PATTERN.test(executor)) continue;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) continue;
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) continue;
    if (typeof costEstimate !== 'number' || !Number.isFinite(costEstimate) || costEstimate < 0) continue;
    if (slot !== undefined && typeof slot !== 'string') continue;
    rows.push({ atMs, utcDay: utcDayOf(atMs), routine, executor, outcome, durationMs, costEstimate });
  }
  return rows;
}

/** Counterparty tally quoted inside one prompt: ids already pattern-bound, still capped. */
export interface RoutineOutcomeTally {
  text: string;
  count: number;
}

/** One recurring cell: a routine-side or executor-side (id, outcome) group. */
export interface RoutineAttemptCell {
  /** 'routine' cells key routine-side outcomes; 'executor' cells key executor-side ones. */
  dimension: 'routine' | 'executor';
  /** Sanitized recorded id — the routine id or the executor id. */
  id: string;
  outcome: string;
  /** In-window attempt rows the cell recorded. */
  rows: number;
  /** Distinct UTC days the rows span. */
  days: number;
  /** Calendar-day span between first and last row, at least 1. */
  daySpan: number;
  /** Counterparty tallies — executors that ran the routine, or routines that hit the executor. */
  partners: RoutineOutcomeTally[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

interface CellAcc {
  dimension: 'routine' | 'executor';
  id: string;
  outcome: string;
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  partners: Map<string, number>;
}

/**
 * Pure: fold validated rows into per-(dimension, id, outcome) cells.
 * Routine cells take the routine-side outcomes ('failed', 'unavailable')
 * keyed on the routine; executor cells take the executor-side outcomes
 * ('failed', 'quota', 'rate-limit', 'unhealthy') keyed on the executor —
 * 'unavailable' rows never form executor cells because their 'none'
 * sentinel names no executor. Rows outside the window or stamped beyond
 * the future-skew allowance contribute nothing. Partner tallies count
 * the counterparty id per row, capped at MAX_PARTNERS distinct ids.
 */
export function foldRoutineAttemptCells(
  rows: readonly RoutineAttemptRow[],
  nowMs: number,
  windowMs: number = ROUTINE_WINDOW_MS,
  lowerBound = false,
): RoutineAttemptCell[] {
  const cells = new Map<string, CellAcc>();
  const windowStart = nowMs - windowMs;
  const futureLimit = nowMs + ROUTINE_FUTURE_SKEW_MS;
  const acc = (dimension: 'routine' | 'executor', id: string, outcome: string): CellAcc => {
    const key = `${dimension}${id}${outcome}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { dimension, id, outcome, rows: 0, days: new Set(), firstMs: Infinity, lastMs: -Infinity, partners: new Map() };
      cells.set(key, cell);
    }
    return cell;
  };
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > futureLimit) continue;
    const routineCell = ROUTINE_OUTCOMES.has(row.outcome);
    const executorCell = EXECUTOR_OUTCOMES.has(row.outcome) && row.executor !== NO_EXECUTOR;
    if (routineCell) {
      const cell = acc('routine', fieldText(row.routine), row.outcome);
      cell.rows += 1;
      cell.days.add(row.utcDay);
      cell.firstMs = Math.min(cell.firstMs, row.atMs);
      cell.lastMs = Math.max(cell.lastMs, row.atMs);
      if (row.executor !== NO_EXECUTOR) {
        const partner = fieldText(row.executor);
        if (cell.partners.has(partner) || cell.partners.size < MAX_PARTNERS) {
          cell.partners.set(partner, (cell.partners.get(partner) ?? 0) + 1);
        }
      }
    }
    if (executorCell) {
      const cell = acc('executor', fieldText(row.executor), row.outcome);
      cell.rows += 1;
      cell.days.add(row.utcDay);
      cell.firstMs = Math.min(cell.firstMs, row.atMs);
      cell.lastMs = Math.max(cell.lastMs, row.atMs);
      const partner = fieldText(row.routine);
      if (cell.partners.has(partner) || cell.partners.size < MAX_PARTNERS) {
        cell.partners.set(partner, (cell.partners.get(partner) ?? 0) + 1);
      }
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      dimension: cell.dimension,
      id: cell.id,
      outcome: cell.outcome,
      rows: cell.rows,
      days: cell.days.size,
      daySpan: Math.max(1, Math.round((cell.lastMs - cell.firstMs) / 86_400_000)),
      partners: [...cell.partners.entries()]
        .map(([text, count]) => ({ text, count }))
        .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
        .slice(0, MAX_PARTNERS),
      firstSeen: cell.firstMs === Number.POSITIVE_INFINITY ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === Number.NEGATIVE_INFINITY ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.rows - a.rows || a.dimension.localeCompare(b.dimension) || a.id.localeCompare(b.id) || a.outcome.localeCompare(b.outcome));
}

/** The recurring bars a folded cell must clear before it becomes work. */
function isRecurring(cell: RoutineAttemptCell): boolean {
  return cell.rows >= ROUTINE_MIN_UNITS && cell.days >= ROUTINE_MIN_DAYS;
}

const WINDOW_DAYS = Math.round(ROUTINE_WINDOW_MS / 86_400_000);

const NO_CHANGE = 'If the window has rolled forward, the routine was removed, disabled or fixed, the executor was re-authenticated or its quota reset, or the cause is owner-only (credentials, billing, provider-side quota, the routines.yaml definitions themselves which live outside this repository) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is runs.jsonl under the Ashlr home\'s routines directory (~/.ashlr/routines or $ASHLR_HOME) — the scheduled-routines scheduler\'s own attempt journal, one bounded tail read — appended by `phm routines tick` and `phm routines run` (src/core/routines/scheduler.ts run()) on every scheduled firing and manual run. Each row is one Attempt {routine, executor, at, duration, costEstimate, outcome, slot}: outcome \'success\' and \'submitted\' are the working states, \'failed\' is the classify() fallback for an invocation error that is not quota, rate-limit or unhealthy, \'quota\' and \'rate-limit\' are provider limits, \'unhealthy\' is an unreachable or unauthenticated executor (ENOENT/auth/ECONNREFUSED/unhealthy), and \'unavailable\' records that no executor was eligible — capabilities, tier, daily limit or cooldown — always under the \'none\' sentinel. Until this feed the journal\'s only readers were the scheduler\'s own point-in-time folds — history() feeding candidates()\' cooldowns and daily-limit tallies and status() rendering STATUS.md\'s last-attempt table — so recurring failures never became work.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

function partnerText(cell: RoutineAttemptCell, label: string): string {
  if (cell.partners.length === 0) return '';
  return ` ${label}: ${cell.partners.map((p) => `'${p.text}' ×${p.count}`).join(', ')}.`;
}

function seenText(cell: RoutineAttemptCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

const OUTCOME_MEANING: Record<string, string> = {
  failed: 'an invocation error classify() could not attribute to quota, rate-limit or unhealth — ambiguous between the routine\'s own command failing and executor-side breakage',
  unavailable: 'no executor was eligible when the routine came due — capabilities, tier, daily limit or cooldown starvation',
  quota: 'the executor\'s provider quota was exhausted',
  'rate-limit': 'the executor\'s provider rate-limited the call',
  unhealthy: 'the executor was unreachable or unauthenticated — ENOENT, auth failure, ECONNREFUSED or an unhealthy probe',
};

function routineCellPrompt(cell: RoutineAttemptCell, truncated: boolean): string {
  const meaning = OUTCOME_MEANING[cell.outcome] ?? 'a recorded adverse outcome';
  const starved = cell.outcome === 'unavailable';
  return [
    `Phantom's scheduled routine '${cell.id}' keeps ${starved ? 'finding no eligible executor' : `ending '${cell.outcome}'`} — the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${WINDOW_DAYS}-day attempt window the journal recorded ${cell.rows} '${cell.outcome}' attempt row(s) for this routine across ${cell.days} distinct UTC day(s) (${cell.daySpan} day span).${partnerText(cell, 'Executors recorded')}${seenText(cell)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `'${cell.outcome}' means ${meaning}. For a routine cell the evidence is routine-side: the routine's own definition, its command or prompt, or the eligibility fold that decides whether any executor may run it.`,
    '',
    `What is in scope: this repository owns the scheduler — src/core/routines/scheduler.ts (invoke()'s per-kind adapters for codex, claude, devin, omlx and shell; classify()'s outcome mapping; candidates()' eligibility, cooldown and daily-limit fold) — while routines.yaml and the executor definitions are operator configuration outside this repository. Check \`phm routines status\` and the routine's recent output under the routines output directory first, then fix what lives here: a classify() gap that mislabels a real failure, an executor adapter that fails every call, or an eligibility bug that starves a routine its capabilities should cover. If the cause is the operator's YAML, credentials, billing or provider-side quota — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function executorCellPrompt(cell: RoutineAttemptCell, truncated: boolean): string {
  const meaning = OUTCOME_MEANING[cell.outcome] ?? 'a recorded adverse outcome';
  return [
    `Phantom's routine executor '${cell.id}' keeps recording '${cell.outcome}' across the routines that use it — the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${WINDOW_DAYS}-day attempt window the journal recorded ${cell.rows} '${cell.outcome}' attempt row(s) on this executor across ${cell.days} distinct UTC day(s) (${cell.daySpan} day span).${partnerText(cell, 'Routines recorded')}${seenText(cell)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `'${cell.outcome}' means ${meaning}. Executor cells fold provider-side evidence once, against the executor every routine shares — the scheduler's cooldowns (1 hour quota, 1 minute rate-limit, 5 minutes unhealthy) absorb single blips but never resolve a recurring cause, and 'failed' stays ambiguous: it can be executor infra or the routine's own command, so weigh the routine tally.`,
    '',
    `What is in scope: this repository owns the scheduler's executor adapters and outcome mapping — src/core/routines/scheduler.ts invoke() (the codex, claude, devin, omlx and shell paths) and classify() — while executor definitions (kind, codexHome, model, repo, capabilities, dailyLimit) are operator configuration in routines.yaml outside this repository. Check \`phm routines status\` and reproduce one firing first, then fix what lives here — an adapter bug, a classify() gap, an oMLX endpoint or Devin delegation that keeps failing — or report no-change for owner-side auth, billing and provider quota. ${NO_CHANGE}`,
  ].join('\n');
}

function routineAttemptPrompt(cell: RoutineAttemptCell, truncated: boolean): string {
  return cell.dimension === 'routine'
    ? routineCellPrompt(cell, truncated)
    : executorCellPrompt(cell, truncated);
}

function routineAttemptItem(cell: RoutineAttemptCell, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `fleet-routine-${createHash('sha256').update(`${cell.dimension}:${cell.id}:${cell.outcome}`).digest('hex').slice(0, 16)}`;
  const title = cell.dimension === 'routine'
    ? (cell.outcome === 'unavailable'
      ? `Scheduled routine '${cell.id}' keeps finding no eligible executor`
      : `Scheduled routine '${cell.id}' keeps ending '${cell.outcome}'`)
    : `Routine executor '${cell.id}' keeps recording '${cell.outcome}'`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: routineAttemptPrompt(cell, truncated),
    area: 'routines',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the scheduled-routines journal's recurring cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function routineBacklogItems(opts: RoutineItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const journalPath = opts.journalPath ?? join(ashlrHome(), ROUTINE_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? ROUTINE_WINDOW_MS;
    const tail = await readLedgerTail(journalPath, ROUTINE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const rows = parseRoutineAttemptRows(tail.text);
    if (rows.length === 0) return [];
    const cells = foldRoutineAttemptCells(rows, nowMs, windowMs, tail.truncated)
      .filter(isRecurring);
    const limit = Math.max(1, Math.min(opts.limit ?? ROUTINE_BACKLOG_MAX_ITEMS, ROUTINE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => routineAttemptItem(cell, repo, tail.truncated));
  } catch {
    return [];
  }
}
