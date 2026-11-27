/**
 * Dispatch-production backlog source.
 *
 * The daemon records one sanitized event per dispatched work item's
 * production outcome in ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl —
 * the append-only ledger written by recordDispatchProduction /
 * recordRepairHandoffs in src/core/daemon/loop.ts and read by
 * readDispatchProductionEventsDetailed for the repair lifecycle,
 * generated-repair ledgers, yield summaries and fleet status. Until
 * this feed, no backlog source folded recurring adverse production
 * outcomes back into discovery: an engine that keeps failing, a
 * sandbox that keeps erroring, proposals that keep coming back
 * empty, or outcomes the writer cannot classify could recur for
 * weeks while every consumer answered lifecycle questions only.
 *
 * This module folds the retained events into per-(repo, outcome,
 * backend) cells and emits a CloudBacklogItem for each cell whose
 * distinct work items recur across distinct UTC days inside the
 * evidence window — the same recurrence bar the repair-handoff feed
 * applies to its journal rows.
 *
 * Coverage honesty:
 *  - 'missing' source state is the writer's normal fresh-install
 *    state and yields no items; 'degraded' reads and bounded-tail
 *    truncations fold what was retained and mark every cell's
 *    counts as a lower bound rather than pretending completeness.
 *  - Events the repair machinery already owns are excluded when
 *    handoffs are actually being recorded under the live config
 *    (foundry.proposalRepair !== false and fleet.sharedQueue.mode
 *    !== 'filesystem', mirroring the daemon loop's own gate):
 *    repairHandoffFromDispatchEvent returning an observation means
 *    the repair-handoff journal — and therefore
 *    repair-handoff-backlog.ts — already counts that failure, so
 *    this feed stays silent on it. When repair is disabled or the
 *    shared queue bypasses handoff minting, those same events are
 *    uncovered and this feed counts them.
 *  - Only aggregate counts, closed vocabularies and sanitized
 *    bounded fields ever reach a prompt. Item ids, attempt ids,
 *    machine ids, titles, assignedBy/routeReason/reason digests and
 *    the canonical repo path itself are counted or hashed, never
 *    emitted — the repo checkout path can sit under a private home
 *    directory.
 */

import { createHash } from 'node:crypto';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { loadConfigReadOnly } from '../config.js';
import {
  readDispatchProductionEventsDetailed,
  type DispatchProductionEvent,
} from '../fleet/dispatch-production-ledger.js';
import { repairHandoffFromDispatchEvent } from '../fleet/repair-handoff-journal.js';

/** Evidence window: one week of dated partitions, matching sibling feeds. */
const DISPATCH_PRODUCTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Recurrence bar: at least this many distinct work items... */
const DISPATCH_PRODUCTION_MIN_UNITS = 3;
/** ...across at least this many distinct UTC days inside the window. */
const DISPATCH_PRODUCTION_MIN_DAYS = 2;
const DISPATCH_PRODUCTION_BACKLOG_MAX_ITEMS = 8;
const DISPATCH_PRODUCTION_ITEM_HARD_MAX = 25;
/** Clock skew tolerated for events timestamped just past the read instant. */
const DISPATCH_PRODUCTION_FUTURE_SKEW_MS = 60_000;
const MAX_TITLE_CHARS = 200;
/** Distinct tally rows quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;

/**
 * Outcomes this feed treats as adverse production evidence. The
 * remaining closed-vocabulary outcomes — 'proposal-created'
 * (success), 'cancelled' (deliberate stop) and 'shadow-observation'
 * (designed observation) — are context tallies only, never cells.
 */
const ADVERSE_OUTCOMES = new Set<DispatchProductionEvent['outcome']>([
  'engine-failed',
  'sandbox-failed',
  'proposal-capture-error',
  'gate-blocked',
  'empty-diff',
  'proposal-disabled',
  'unknown',
]);

export interface DispatchProductionBacklogItemsOptions {
  /** Backlog target in owner/name form; cells emit only when the event repo basename matches its name. */
  repo: string;
  /** Most items one call emits (default DISPATCH_PRODUCTION_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default DISPATCH_PRODUCTION_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

export interface DispatchProductionTally {
  /** Sanitized closed-vocabulary label. */
  text: string;
  count: number;
}

/** One (repo, outcome, backend) cell of recurring adverse production outcomes. */
export interface DispatchProductionCell {
  repoName: string;
  outcome: DispatchProductionEvent['outcome'];
  /** Recorded backend label, or 'unreported' when the event carries none. */
  backend: string;
  /** Distinct itemIds inside the window. */
  units: number;
  /** In-window adverse rows in the cell (one item can recur across retries). */
  rows: number;
  /** Distinct UTC days the rows fall on. */
  days: Set<string>;
  /** Recorded work sources, most frequent first. */
  sources: DispatchProductionTally[];
  /** Recorded event bases, most frequent first. */
  bases: DispatchProductionTally[];
  /** Recorded tiers, most frequent first. */
  tiers: DispatchProductionTally[];
  /** ISO bounds of the cell's adverse rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Recorded spend across the cell's rows, when any row reported it. */
  spentUsd: number | null;
  /** True when a bounded read tail was truncated: counts are a lower bound. */
  lowerBound: boolean;
}

/** File-level read tallies every prompt states alongside the per-cell bound note. */
export interface DispatchProductionCoverage {
  /** In-window events the fold saw before repo/outcome filtering. */
  events: number;
  proposalCreated: number;
  cancelled: number;
  shadowObservation: number;
  /** Adverse events skipped because live repair-handoff machinery already counts them. */
  handoffCovered: number;
  invalidRows: number;
  unreadableFiles: number;
  degraded: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + DISPATCH_PRODUCTION_FUTURE_SKEW_MS;

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): DispatchProductionTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/** The event repo's last path segment — the checkout's directory name, lowercased for matching. */
function repoNameOfPath(repo: string): string {
  const trimmed = repo.replace(/[\\/]+$/, '');
  const segment = trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
  return segment.trim().toLowerCase();
}

function backendLabelOf(event: DispatchProductionEvent): string {
  return event.backend === null || event.backend === undefined
    ? 'unreported'
    : event.backend;
}

/**
 * Pure: fold sanitized ledger events into per-(repo, outcome, backend)
 * cells. Events outside the window, events for other repositories,
 * non-adverse outcomes and events opts.handoffCovered marks as
 * already owned by the repair-handoff feed never join a cell.
 * backendLabel groups unreported backends under 'unreported' — the
 * evidence still counts, the producer detail is just unknown.
 */
export function foldDispatchProductionCells(
  events: readonly DispatchProductionEvent[],
  opts: {
    nowMs: number;
    windowMs?: number;
    repoName: string;
    handoffCovered?: (event: DispatchProductionEvent) => boolean;
  },
  lowerBound = false,
): DispatchProductionCell[] {
  const windowMs = opts.windowMs ?? DISPATCH_PRODUCTION_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const covered = opts.handoffCovered ?? (() => false);
  const cells = new Map<string, {
    repoName: string;
    outcome: DispatchProductionEvent['outcome'];
    backend: string;
    items: Set<string>;
    rows: number;
    days: Set<string>;
    sources: Map<string, number>;
    bases: Map<string, number>;
    tiers: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
    spentUsd: number;
    spentReported: boolean;
  }>();
  for (const event of events) {
    if (!ADVERSE_OUTCOMES.has(event.outcome)) continue;
    const atMs = Date.parse(event.ts);
    if (!Number.isFinite(atMs) || !inWindow(atMs, windowStart, opts.nowMs)) continue;
    const repoName = repoNameOfPath(event.repo);
    if (repoName === '' || repoName !== opts.repoName) continue;
    if (covered(event)) continue;
    const backend = backendLabelOf(event);
    const key = JSON.stringify([repoName, event.outcome, backend]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        repoName,
        outcome: event.outcome,
        backend,
        items: new Set(),
        rows: 0,
        days: new Set(),
        sources: new Map(),
        bases: new Map(),
        tiers: new Map(),
        firstMs: null,
        lastMs: null,
        spentUsd: 0,
        spentReported: false,
      };
      cells.set(key, cell);
    }
    cell.items.add(event.itemId);
    cell.rows += 1;
    cell.days.add(utcDayOf(atMs));
    bump(cell.sources, event.source);
    bump(cell.bases, event.basis);
    if (event.tier !== null && event.tier !== undefined) bump(cell.tiers, event.tier);
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    if (Number.isFinite(event.spentUsd)) {
      cell.spentUsd += event.spentUsd;
      cell.spentReported = true;
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      repoName: cell.repoName,
      outcome: cell.outcome,
      backend: cell.backend,
      units: cell.items.size,
      rows: cell.rows,
      days: cell.days,
      sources: tallyOf(cell.sources, MAX_PROMPT_TALLIES),
      bases: tallyOf(cell.bases, MAX_PROMPT_TALLIES),
      tiers: tallyOf(cell.tiers, MAX_PROMPT_TALLIES),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      spentUsd: cell.spentReported ? cell.spentUsd : null,
      lowerBound,
    }))
    .sort((a, b) => b.units - a.units || b.rows - a.rows || a.backend.localeCompare(b.backend) || a.outcome.localeCompare(b.outcome));
}

const EVIDENCE = 'The evidence is ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl (or $ASHLR_HOME/dispatch-production when set) — the append-only ledger recordDispatchProduction appends one sanitized event per dispatched work item\'s production outcome. The daemon loop in src/core/daemon/loop.ts writes it on every dispatch outcome while foundry machinery runs, and readDispatchProductionEventsDetailed in src/core/fleet/dispatch-production-ledger/ feeds the repair lifecycle, generated-repair ledgers, yield summaries and fleet status — lifecycle and status surfaces answering "what happened to this attempt", never a recurrence fold. repair-handoff-backlog.ts folds only the repair-handoff journals\' three eligible outcome classes; this feed folds every other recurring adverse outcome the ledger retains.';

const NO_CHANGE = 'If the window has rolled forward, the rows were a one-off burst an engine or ops fix already resolved, the failures were legitimate holds on work that is genuinely unworkable, the outcome labels reflect designed behavior (a disabled proposal path, a shadow observation), or the cause is owner-side or pinned ops machinery (credentials, billing, host resources, the installed schedules, the Security-reviewed files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

function tallyText(tallies: readonly DispatchProductionTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: DispatchProductionCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function detailText(cell: DispatchProductionCell): string {
  const parts: string[] = [];
  if (cell.sources.length > 0) parts.push(`Recorded sources: ${tallyText(cell.sources)}.`);
  if (cell.bases.length > 0) parts.push(`Recorded bases: ${tallyText(cell.bases)}.`);
  if (cell.tiers.length > 0) parts.push(`Recorded tiers: ${tallyText(cell.tiers)}.`);
  if (cell.spentUsd !== null) parts.push(`Recorded spend across the cell: $${cell.spentUsd.toFixed(2)}.`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

function boundText(cell: DispatchProductionCell, coverage: DispatchProductionCoverage): string {
  const notes: string[] = [];
  if (cell.lowerBound || coverage.degraded) notes.push('a bounded read tail was truncated or the source read degraded, so these counts are a lower bound');
  if (coverage.invalidRows > 0) notes.push(`${coverage.invalidRows} malformed or off-contract rows dropped`);
  if (coverage.unreadableFiles > 0) notes.push(`${coverage.unreadableFiles} partition file(s) unreadable`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function backendPhrase(cell: DispatchProductionCell): string {
  return cell.backend === 'unreported' ? 'an unreported backend' : `backend '${cell.backend}'`;
}

const OUTCOME_LABEL: Record<DispatchProductionCell['outcome'], string> = {
  'engine-failed': 'engine-failed',
  'sandbox-failed': 'sandbox-failed',
  'proposal-capture-error': 'proposal-capture-error',
  'gate-blocked': 'gate-blocked',
  'empty-diff': 'empty-diff',
  'proposal-disabled': 'proposal-disabled',
  'unknown': 'unknown',
  'proposal-created': 'proposal-created',
  'cancelled': 'cancelled',
  'shadow-observation': 'shadow-observation',
};

function promptFor(cell: DispatchProductionCell, coverage: DispatchProductionCoverage): string {
  const outcome = OUTCOME_LABEL[cell.outcome];
  const context = [
    `Inside the same window the ledger retained ${coverage.events} in-window event(s) for this repository: ${coverage.proposalCreated} proposal-created, ${coverage.cancelled} cancelled, ${coverage.shadowObservation} shadow-observation, and ${coverage.handoffCovered} adverse event(s) already owned by the repair-handoff feed.`,
  ].join(' ');
  const shared = [
    `Phantom's dispatch production keeps finishing '${outcome}' — ${cell.units} distinct work items recorded ${cell.rows} adverse row(s) on ${backendPhrase(cell)} inside the window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one dispatched work item's sanitized production outcome in the dispatch-production ledger.${detailText(cell)}${seenText(cell)}${boundText(cell, coverage)}`,
    '',
    EVIDENCE,
    '',
    context,
  ];
  const tail = [
    '',
    `Join the cell's outcome and backend to metrics/jobs.jsonl under the fleet runs directory for the dispatched items' recorded reasons, and read the outcome writers in src/core/daemon/loop.ts plus the outcome vocabulary in src/core/fleet/dispatch-production-ledger/constants.ts to see which stage emits '${outcome}'. Check whether the failures cluster on a task shape the intake keeps minting, on the recorded tier/source tallies, on a ${cell.backend === 'unreported' ? 'producer the ledger predates backend provenance for' : `'${cell.backend}'`} output shape the pipeline cannot absorb, or on a stage that throws before recording why. dispatchd, launch.sh and publish.sh are pinned ops machinery; the proposal pipeline, gate thresholds, sandbox wiring and outcome classification are this repository's own.`,
    '',
    `Decide whether the pattern is producer quality, pipeline machinery this repo owns, or legitimately blocked work — and fix what lives here. ${NO_CHANGE}`,
  ];
  return [...shared, ...tail].join('\n');
}

const TITLES: Record<DispatchProductionCell['outcome'], (backend: string) => string> = {
  'engine-failed': (backend) => `Dispatched work keeps engine-failing on ${backend}`,
  'sandbox-failed': (backend) => `Dispatched work keeps sandbox-failing on ${backend}`,
  'proposal-capture-error': (backend) => `Proposal capture keeps erroring on ${backend}`,
  'gate-blocked': (backend) => `The proposal gate keeps blocking work on ${backend}`,
  'empty-diff': (backend) => `Dispatched work keeps producing empty diffs on ${backend}`,
  'proposal-disabled': (backend) => `Proposal creation keeps being disabled on ${backend}`,
  'unknown': (backend) => `Dispatch production outcomes keep coming back unclassified on ${backend}`,
  'proposal-created': () => 'proposal-created',
  'cancelled': () => 'cancelled',
  'shadow-observation': () => 'shadow-observation',
};

function dispatchProductionItem(cell: DispatchProductionCell, repo: string, coverage: DispatchProductionCoverage): CloudBacklogItem {
  const backend = cell.backend === 'unreported' ? 'unreported-backend' : cell.backend;
  const id = `fleet-dispatch-production-${createHash('sha256').update(`dispatch-production:${cell.repoName}:${cell.outcome}:${backend}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: TITLES[cell.outcome](cell.backend).slice(0, MAX_TITLE_CHARS),
    prompt: promptFor(cell, coverage),
    area: 'dispatch-production',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Whether live repair-handoff machinery already counts this event:
 * the daemon loop mints handoff journal rows only when
 * foundry.proposalRepair stays enabled and the fleet is not in
 * shared-queue filesystem mode, and only for events
 * repairHandoffFromDispatchEvent accepts. A disabled or bypassed
 * repair path leaves those failures uncovered, so this feed counts
 * them instead of staying silent.
 */
function liveHandoffCoverage(): (event: DispatchProductionEvent) => boolean {
  let enabled = false;
  try {
    const cfg = loadConfigReadOnly();
    const proposalRepair = (cfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'];
    const sharedQueueMode = cfg.fleet?.sharedQueue?.mode === 'filesystem';
    enabled = proposalRepair !== false && !sharedQueueMode;
  } catch {
    enabled = false;
  }
  if (!enabled) return () => false;
  return (event) => {
    try {
      return repairHandoffFromDispatchEvent(event) !== null;
    } catch {
      return false;
    }
  };
}

/**
 * Backlog items for the dispatch-production ledger's recurring
 * adverse (repo, outcome, backend) cells. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function dispatchProductionBacklogItems(
  opts: DispatchProductionBacklogItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const targetName = fleetRepoName(repo);
    if (targetName === '') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? DISPATCH_PRODUCTION_WINDOW_MS;

    const read = readDispatchProductionEventsDetailed({
      sinceMs: nowMs - windowMs,
      inspectionOnly: true,
      canonicalTimestamps: true,
    });
    if (read.sourceState === 'missing') return [];

    // Window/context tallies cover every in-window event for the
    // target repo — including non-adverse outcomes — so prompts can
    // state the adverse share honestly instead of implying the
    // ledger held only failures.
    const repoNameOf = (event: DispatchProductionEvent): string => repoNameOfPath(event.repo);
    const windowStart = nowMs - windowMs;
    const inWindowEvents = read.events.filter((event) => {
      const atMs = Date.parse(event.ts);
      return Number.isFinite(atMs) && inWindow(atMs, windowStart, nowMs) && repoNameOf(event) === targetName;
    });
    const covered = liveHandoffCoverage();
    const coverage: DispatchProductionCoverage = {
      events: inWindowEvents.length,
      proposalCreated: inWindowEvents.filter((e) => e.outcome === 'proposal-created').length,
      cancelled: inWindowEvents.filter((e) => e.outcome === 'cancelled').length,
      shadowObservation: inWindowEvents.filter((e) => e.outcome === 'shadow-observation').length,
      handoffCovered: inWindowEvents.filter(
        (event) => ADVERSE_OUTCOMES.has(event.outcome) && covered(event),
      ).length,
      invalidRows: read.invalidRows,
      unreadableFiles: read.unreadableFiles,
      degraded: read.sourceState === 'degraded' || !read.complete,
    };

    const lowerBound = coverage.degraded;
    const folded = foldDispatchProductionCells(read.events, {
      nowMs,
      windowMs,
      repoName: targetName,
      handoffCovered: covered,
    }, lowerBound);
    const recurring = folded.filter(
      (cell) => cell.units >= DISPATCH_PRODUCTION_MIN_UNITS && cell.days.size >= DISPATCH_PRODUCTION_MIN_DAYS,
    );
    if (recurring.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? DISPATCH_PRODUCTION_BACKLOG_MAX_ITEMS, DISPATCH_PRODUCTION_ITEM_HARD_MAX));
    return recurring.slice(0, limit).map((cell) => dispatchProductionItem(cell, repo, coverage));
  } catch {
    return [];
  }
}
