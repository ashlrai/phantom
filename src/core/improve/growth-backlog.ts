/**
 * growth-backlog.ts — fold the Engineering Ops growth-metrics export series
 * into recurring adverse cells for the improve backlog.
 *
 * `phm world` and `GET /api/verse/growth` chart the fleet's north-star
 * outcome metrics — PRs opened/merged, releases shipped and metered cost
 * per merged PR — from three append-only exports Engineering Ops writes
 * every 15 minutes under <runs>/metrics/ (docs/GROWTH.md):
 *
 *   - growth-pulls-hourly.jsonl — either per-pull fact rows
 *     {repo, createdAt, number, ...} or per-hour count rows
 *     {t|ts|at|hour|time, opened, merged}; the same two shapes
 *     src/core/growth/read.ts parseHourly accepts, whichever the file
 *     actually carries;
 *   - growth-cost-hourly.jsonl — {t|ts|at|hour|time, costPerMergedPrUsd}
 *     rows where the value is a finite number or null;
 *   - growth-releases.jsonl — {publishedAt} rows;
 *   - growth-exports-status.json — the freshness clock the growth report
 *     treats as authoritative (a series is stale past 30 minutes).
 *
 * Until now the series had exactly one reader — loadGrowthFacts inside
 * src/core/growth/read.ts, which projects them into the world-model and
 * verse chart — a display surface someone had to open. A series that
 * stayed dark while the fleet kept merging and publishing, or a
 * cost-per-merge reading that kept running hot, never became work. This
 * fold gives the improvement loop the same recurring-adverse cells the
 * sibling journals already emit.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The export files are read through readGrowthJsonl's
 *    bounded 8 MiB line reader and jobs.jsonl through readLedgerTail's
 *    bounded tail; nothing is written and no network is touched.
 *  - A missing or unreadable series file contributes nothing — a clean
 *    empty source, never a guessed darkness. A file that reads but
 *    yields zero usable in-window rows is the dark evidence itself.
 *  - Unknown stays unknown. jobs.jsonl is the activity cross-check for
 *    the cost and pulls darkness cells: with no proven in-window merges
 *    or PR opens there is nothing the metrics were obliged to record,
 *    so those cells cannot fire on an unreadable or quiet ledger.
 *  - The cost-elevated cell needs usable readings on BOTH sides of the
 *    split — a sparse or one-sided series reports nothing rather than a
 *    fabricated trend.
 *  - Truncation is stated, not hidden: a tail or line cap that clipped
 *    the evidence marks the cell's counts as lower bounds in the prompt.
 *  - Repo matching is by repository name, the same rule the sibling
 *    folds apply; the exports describe this install's fleet, so items
 *    emit only for the fleet's own repository.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readGrowthJsonl, readMetricsJson } from '../growth/read.js';
import { jobTimelines } from '../metrics/loop.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; the cell kinds are bounded by series count. */
export const GROWTH_MAX_ITEMS = 8;
const GROWTH_ITEM_HARD_MAX = 25;
/** Evidence window: seven days — the recurring-flake/sibling convention. */
export const GROWTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the siblings apply. */
const GROWTH_FUTURE_SKEW_MS = 60_000;
/** In-window merges the jobs ledger must prove before a dark cost series counts as evidence. */
export const GROWTH_DARK_MIN_MERGES = 3;
/** In-window PR opens the jobs ledger must prove before a dark pulls series counts as evidence. */
export const GROWTH_DARK_MIN_OPENS = 3;
/** Usable cost readings required on each side of the elevated split. */
export const GROWTH_ELEVATED_MIN_READINGS = 6;
/** Median ratio (newest day vs the rest of the window) that reads as a sustained rise. */
export const GROWTH_ELEVATED_RATIO = 1.5;
/** The elevated split: readings newer than this anchor the "now" side. */
const GROWTH_ELEVATED_RECENT_MS = 24 * 60 * 60 * 1000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: growth evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Series file names under <runs>/metrics/, the writer's own constants (growth/read.ts). */
const PULLS_HOURLY_FILE = 'growth-pulls-hourly.jsonl';
const COST_HOURLY_FILE = 'growth-cost-hourly.jsonl';
const RELEASES_FILE = 'growth-releases.jsonl';
const STATUS_FILE = 'growth-exports-status.json';
/** Timestamp keys the growth rows carry, in the order growth/read.ts stampOf tries them. */
const GROWTH_TS_KEYS = ['t', 'ts', 'at', 'hour', 'time'] as const;

export interface GrowthItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Metrics dir override (default: <runsDir>/metrics). */
  metricsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default GROWTH_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default GROWTH_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A usable in-window cost reading: the hour stamp plus a non-null finite usd. */
export interface GrowthCostReading {
  atMs: number;
  usd: number;
  utcDay: string;
}

/** A usable in-window pulls reading, whichever export shape the file carried. */
export interface GrowthPullsReading {
  atMs: number;
  /** 'pull' for per-PR fact rows, 'count' for per-hour opened/merged aggregates. */
  shape: 'pull' | 'count';
  opened: number | null;
  merged: number | null;
  utcDay: string;
}

/** A usable in-window release timestamp. */
export interface GrowthReleaseReading {
  atMs: number;
  utcDay: string;
}

export interface GrowthSeriesFold {
  /** Series files that read at all (present, parseable lines); absent files stay out. */
  costRead: boolean;
  pullsRead: boolean;
  releasesRead: boolean;
  /** Usable readings whose timestamp landed inside the window. */
  cost: GrowthCostReading[];
  pulls: GrowthPullsReading[];
  releases: GrowthReleaseReading[];
  /** Total parseable rows seen per series across the whole file (context, not windowed). */
  costRows: number;
  pullsRows: number;
  releaseRows: number;
  /** Per-series freshness claim from growth-exports-status.json, ISO or null. */
  clock: { pulls: string | null; releases: string | null; cost: string | null };
  /** Lines that failed JSON parse across the three series. */
  invalidRows: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** ISO-string timestamp from the growth row's own keys; null when none parse. */
function growthStamp(row: Record<string, unknown>): number | null {
  for (const key of GROWTH_TS_KEYS) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    const at = Date.parse(value);
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** The pulls file's two shapes, mirroring growth/read.ts isPullRow/isCountRow. */
function isPullFact(row: Record<string, unknown>): boolean {
  return typeof row['repo'] === 'string' && typeof row['createdAt'] === 'string' && typeof row['number'] === 'number';
}
function isPullCount(row: Record<string, unknown>): boolean {
  return finite(row['opened']) !== null || finite(row['merged']) !== null;
}

/**
 * Pure: fold the three export series into usable in-window readings.
 * `null` line arrays mean the file was absent or unreadable — that series
 * contributes nothing. Rows are validated under the growth reader's own
 * dialect; rows whose timestamp cannot be placed inside
 * [nowMs - windowMs, nowMs + skew] never reach the fold.
 */
export function foldGrowthSeries(
  costLines: readonly string[] | null,
  pullsLines: readonly string[] | null,
  releasesLines: readonly string[] | null,
  nowMs: number,
  windowMs: number,
): GrowthSeriesFold {
  const fold: GrowthSeriesFold = {
    costRead: costLines !== null,
    pullsRead: pullsLines !== null,
    releasesRead: releasesLines !== null,
    cost: [], pulls: [], releases: [],
    costRows: 0, pullsRows: 0, releaseRows: 0,
    clock: { pulls: null, releases: null, cost: null },
    invalidRows: 0,
  };
  const since = nowMs - windowMs;
  const until = nowMs + GROWTH_FUTURE_SKEW_MS;
  const inWindow = (atMs: number): boolean => atMs >= since && atMs <= until;

  if (costLines !== null) {
    for (const line of costLines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let row: unknown;
      try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
      if (!isRecord(row)) { fold.invalidRows += 1; continue; }
      const atMs = growthStamp(row);
      if (atMs === null) { fold.invalidRows += 1; continue; }
      fold.costRows += 1;
      const usdRaw = row['costPerMergedPrUsd'];
      const usd = usdRaw === null ? null : finite(usdRaw);
      if (usd === null) continue; // a null/invalid usd is a non-reading, not a dark row
      if (!inWindow(atMs)) continue;
      fold.cost.push({ atMs, usd, utcDay: dayOfMs(atMs) });
    }
  }

  if (pullsLines !== null) {
    // The file carries one shape or the other; count rows seen per shape so a
    // mixed tail never double-counts. Pull facts win when both appear, matching
    // parseHourly's own precedence.
    let pullFacts = 0;
    let countRows = 0;
    const pending: GrowthPullsReading[] = [];
    for (const line of pullsLines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let row: unknown;
      try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
      if (!isRecord(row)) { fold.invalidRows += 1; continue; }
      if (isPullFact(row)) {
        pullFacts += 1;
        const atMs = Date.parse(row['createdAt'] as string);
        if (!Number.isFinite(atMs) || !inWindow(atMs)) continue;
        pending.push({ atMs, shape: 'pull', opened: null, merged: null, utcDay: dayOfMs(atMs) });
        continue;
      }
      if (!isPullCount(row)) { fold.invalidRows += 1; continue; }
      const atMs = growthStamp(row);
      if (atMs === null) { fold.invalidRows += 1; continue; }
      countRows += 1;
      if (!inWindow(atMs)) continue;
      pending.push({
        atMs, shape: 'count',
        opened: finite(row['opened']), merged: finite(row['merged']),
        utcDay: dayOfMs(atMs),
      });
    }
    // parseHourly treats a file with any pull facts as the pull shape; mirror it
    // so a stray count row never masquerades as coverage beside real facts.
    fold.pulls = pullFacts > 0 ? pending.filter((r) => r.shape === 'pull') : pending;
    fold.pullsRows = pullFacts > 0 ? pullFacts : countRows;
  }

  if (releasesLines !== null) {
    for (const line of releasesLines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let row: unknown;
      try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
      if (!isRecord(row)) { fold.invalidRows += 1; continue; }
      const published = row['publishedAt'];
      if (typeof published !== 'string') { fold.invalidRows += 1; continue; }
      const atMs = Date.parse(published);
      if (!Number.isFinite(atMs)) { fold.invalidRows += 1; continue; }
      fold.releaseRows += 1;
      if (!inWindow(atMs)) continue;
      fold.releases.push({ atMs, utcDay: dayOfMs(atMs) });
    }
  }
  return fold;
}

/** The freshness clock parseStatus computes: per-series ISO or null. */
export function foldGrowthClock(raw: unknown): { pulls: string | null; releases: string | null; cost: string | null } {
  const empty = { pulls: null, releases: null, cost: null };
  if (!isRecord(raw)) return empty;
  const iso = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  };
  const top = iso(raw['generatedAt']);
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'string') return iso(value) ?? top;
      if (isRecord(value)) return iso(value['generatedAt']) ?? iso(value['observedAt']) ?? top;
    }
    return top;
  };
  return {
    pulls: pick('pulls', 'growth-pulls-1d.json', PULLS_HOURLY_FILE),
    releases: pick('releases', RELEASES_FILE),
    cost: pick('cost', COST_HOURLY_FILE),
  };
}

/** Median of a numeric series; null on empty. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type GrowthCell =
  | { kind: 'cost-dark'; merges: number; clockFresh: boolean }
  | { kind: 'pulls-dark'; opens: number; clockFresh: boolean }
  | { kind: 'releases-quiet'; totalRows: number; clockFresh: boolean }
  | { kind: 'cost-elevated'; recentMedian: number; baselineMedian: number; ratio: number; recentReadings: number; baselineReadings: number; recentDay: string; baselineDays: number };

/** In-window merge/open counts the jobs ledger proves, for the darkness cross-check. */
export interface GrowthActivity {
  merges: number;
  opens: number;
}

/**
 * Pure: derive the emittable cells from a folded series plus the proven
 * in-window activity. Darkness cells need the file to have read AND the
 * activity cross-check (cost/pulls) or a non-empty history (releases);
 * elevated needs readings on both sides of the recent split.
 */
export function growthCells(
  fold: GrowthSeriesFold,
  activity: GrowthActivity,
  nowMs: number,
): GrowthCell[] {
  const cells: GrowthCell[] = [];
  const clockAgeMs = (iso: string | null): number | null =>
    iso === null ? null : nowMs - Date.parse(iso);
  const fresh = (iso: string | null): boolean => {
    const age = clockAgeMs(iso);
    return age !== null && age >= -GROWTH_FUTURE_SKEW_MS && age <= 30 * 60 * 1000;
  };

  if (fold.costRead && fold.cost.length === 0 && activity.merges >= GROWTH_DARK_MIN_MERGES) {
    cells.push({ kind: 'cost-dark', merges: activity.merges, clockFresh: fresh(fold.clock.cost) });
  }
  if (fold.pullsRead && fold.pulls.length === 0 && activity.opens >= GROWTH_DARK_MIN_OPENS) {
    cells.push({ kind: 'pulls-dark', opens: activity.opens, clockFresh: fresh(fold.clock.pulls) });
  }
  if (fold.releasesRead && fold.releaseRows > 0 && fold.releases.length === 0) {
    cells.push({ kind: 'releases-quiet', totalRows: fold.releaseRows, clockFresh: fresh(fold.clock.releases) });
  }

  // Cost-elevated: median of readings in the newest 24h vs the rest of the
  // window. Both sides need the reading bar; a sparse series reports nothing.
  const recentCutoff = nowMs - GROWTH_ELEVATED_RECENT_MS;
  const recent = fold.cost.filter((r) => r.atMs >= recentCutoff).map((r) => r.usd);
  const baseline = fold.cost.filter((r) => r.atMs < recentCutoff).map((r) => r.usd);
  if (recent.length >= GROWTH_ELEVATED_MIN_READINGS && baseline.length >= GROWTH_ELEVATED_MIN_READINGS) {
    const recentMedian = median(recent);
    const baselineMedian = median(baseline);
    if (recentMedian !== null && baselineMedian !== null && baselineMedian > 0) {
      const ratio = recentMedian / baselineMedian;
      if (ratio >= GROWTH_ELEVATED_RATIO) {
        const recentDay = fold.cost.filter((r) => r.atMs >= recentCutoff)
          .map((r) => r.utcDay).sort().at(-1) ?? dayOfMs(nowMs);
        cells.push({
          kind: 'cost-elevated', recentMedian, baselineMedian, ratio,
          recentReadings: recent.length, baselineReadings: baseline.length,
          recentDay, baselineDays: new Set(fold.cost.filter((r) => r.atMs < recentCutoff).map((r) => r.utcDay)).size,
        });
      }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const NO_CHANGE = 'If the window has rolled forward, the fleet genuinely had nothing to measure (no merges for cost, no PR opens for pulls, no scheduled release for releases), the elevated reading was a one-off spend spike that already reverted, or the cause is owner-side — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the files, the reader and the ops writer are named so the session can verify it. */
const EVIDENCE = 'The evidence is the Engineering Ops growth export series under <runs>/metrics/ (~/.ashlr-runs or $ASHLR_RUNS_DIR): growth-pulls-hourly.jsonl, growth-cost-hourly.jsonl and growth-releases.jsonl, plus the growth-exports-status.json freshness clock — the same files src/core/growth/read.ts loadGrowthFacts projects into `phm world` and GET /api/verse/growth (docs/GROWTH.md). The exports are written every 15 minutes by Engineering Ops outside this repository; this fold reads them through the same bounded 8 MiB line reader and folds metrics/jobs.jsonl through jobTimelines for the merge/open cross-check. Until this feed the series had no trend reader — only the world-model projection — so a dark or hot metric series never became work.';

const usdText = (value: number): string => `$${value.toFixed(2)}`;

function clockText(fresh: boolean): string {
  return fresh
    ? ' The exports-status clock claims this series fresh inside its 30-minute bar while the data stayed dark — the export is writing but delivering nothing usable.'
    : ' The exports-status clock does not claim this series fresh, so the darkness may be an export-side stall rather than a data gap.';
}

function growthPrompt(cell: GrowthCell, fold: GrowthSeriesFold, windowMs: number): string {
  const days = Math.round(windowMs / (24 * 60 * 60 * 1000));
  switch (cell.kind) {
    case 'cost-dark':
      return [
        `Phantom's growth outcome metrics keep recording merges the cost series cannot price — metrics/jobs.jsonl proves ${cell.merges} merged job(s) inside the ${days}-day window while growth-cost-hourly.jsonl yielded zero usable costPerMergedPrUsd readings, the self-improvement work this backlog exists for.`,
        '',
        `Cost per merged PR is the fleet's metered-cost outcome metric: each hourly row carries the merged-PR cost the export computed. A series that stays dark while real merges land means the cost join upstream is broken — metered lanes produced no usage readings, the merge evidence never reached the cost computation, or the export itself stalled — and every cost-per-merge figure the world model and verse chart show is absent rather than zero.`,
        '',
        `In-window merges proven from jobs.jsonl: ${cell.merges}. Total cost rows the file carried (all windows): ${fold.costRows}.${clockText(cell.clockFresh)}`,
        '',
        EVIDENCE,
        '',
        `What this repository owns: the metered usage capture the cost join depends on — usage-readings.log under the runs queue and the ASHLR_HOME usage store that src/core/usage/resource-usage.ts folds, the jobs.jsonl finish rows' cost/tokens fields the export reads, and the growth reader's own dialect (src/core/growth/read.ts parseCost). If the capture side is healthy the stall is Engineering Ops export-side — outside this repository — so report no-change and name which side the evidence points to. ${NO_CHANGE}`,
      ].join('\n');
    case 'pulls-dark':
      return [
        `Phantom's growth outcome metrics keep recording pull requests the pulls export cannot see — metrics/jobs.jsonl proves ${cell.opens} PR open(s) inside the ${days}-day window while growth-pulls-hourly.jsonl yielded zero usable rows, the self-improvement work this backlog exists for.`,
        '',
        `PRs opened and merged are the fleet's throughput outcome metrics: the export carries either per-pull fact rows or per-hour opened/merged counts across the org. A series that stays dark while the fleet keeps publishing means the export's pull source is broken or stalled — and every opened/merged figure the world model shows is absent rather than zero.`,
        '',
        `In-window PR opens proven from jobs.jsonl: ${cell.opens}. Total pulls rows the file carried (all windows): ${fold.pullsRows}.${clockText(cell.clockFresh)}`,
        '',
        EVIDENCE,
        '',
        `What this repository owns: the publish evidence the export reads — jobs.jsonl publish/PR rows and their pr URLs, and the growth reader's own two-shape dialect (src/core/growth/read.ts parseHourly). If the publish side is healthy the stall is Engineering Ops export-side — outside this repository — so report no-change and name which side the evidence points to. ${NO_CHANGE}`,
      ].join('\n');
    case 'releases-quiet':
      return [
        `Phantom's growth outcome metrics show no release recorded inside the ${days}-day window — growth-releases.jsonl carries ${cell.totalRows} historical publishedAt row(s) but none landed in-window, the self-improvement work this backlog exists for.`,
        '',
        `Releases shipped is the fleet's delivery outcome metric. A series with history that goes quiet may be a legitimately slow release cadence — or a ship pipeline that stalled: the sanctioned release workflow stopped dispatching, releases merged but never published, or the export's release source broke. The fold cannot tell which from the journal alone; the item exists so someone checks.`,
        '',
        `Historical release rows retained: ${cell.totalRows}.${clockText(cell.clockFresh)}`,
        '',
        EVIDENCE,
        '',
        `What this repository owns: the release pipeline evidence — the release workflow dispatch path, merge-events and jobs.jsonl release/ship rows, and the growth reader's parseReleases dialect (src/core/growth/read.ts). Check whether releases actually shipped in-window before treating the quiet as a defect; if the cadence is legitimately slower than the window, report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
    case 'cost-elevated': {
      const ratioText = cell.ratio >= 10 ? `${cell.ratio.toFixed(1)}×` : `${cell.ratio.toFixed(2)}×`;
      return [
        `Phantom's metered cost per merged PR is running well above its recent baseline — the newest day's median costPerMergedPrUsd is ${ratioText} the ${days}-day window's earlier median, the self-improvement work this backlog exists for.`,
        '',
        `Each usable growth-cost-hourly.jsonl row prices one merged PR's metered spend. A sustained elevation means the fleet's cost efficiency regressed: a lane or engine started burning more per merge, merges got smaller relative to spend, or the cost attribution widened to cover spend it previously missed.`,
        '',
        `Recent side (${cell.recentReadings} readings): median ${usdText(cell.recentMedian)}. Baseline side (${cell.baselineReadings} readings across ${cell.baselineDays} UTC day(s)): median ${usdText(cell.baselineMedian)}.`,
        '',
        EVIDENCE,
        '',
        `What this repository owns: the cost attribution the metric prices — usage-readings.jsonl per-pool pctUsed/cost readings, jobs.jsonl finish-row cost_usd/tokens fields, and the router outcome/weight folds that already join the same spend evidence (src/core/router/outcomes.ts, src/core/router/weight-proposals.ts). Check which lane or engine's spend grew before changing anything; if the elevation is a deliberate capacity spend that already reverted, report no-change and name the evidence. ${NO_CHANGE}`,
      ].join('\n');
    }
  }
}

function growthItem(cell: GrowthCell, repo: string, fold: GrowthSeriesFold, windowMs: number): CloudBacklogItem {
  const id = `growth-${cell.kind}-${createHash('sha256').update(`growth:${cell.kind}`).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'cost-dark' ? 'Growth cost-per-merge metric stays dark while merges land'
    : cell.kind === 'pulls-dark' ? 'Growth pulls export stays dark while the fleet publishes'
    : cell.kind === 'releases-quiet' ? 'Growth releases series records no release in the window'
    : 'Metered cost per merged PR runs above its recent baseline';
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: growthPrompt(cell, fold, windowMs),
    area: 'growth-metrics',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Bounded tail of metrics/jobs.jsonl folded through the canonical jobTimelines dialect; empty on any read failure — the darkness cross-check degrades to zero activity, never blocks the fold. */
async function readGrowthActivity(runsDir: string, nowMs: number, windowMs: number): Promise<GrowthActivity> {
  const empty = { merges: 0, opens: 0 };
  try {
    const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
    if (tail.state !== 'read') return empty;
    const timelines = jobTimelines(tail.text, nowMs);
    const since = nowMs - windowMs;
    const until = nowMs + GROWTH_FUTURE_SKEW_MS;
    let merges = 0;
    let opens = 0;
    for (const job of timelines.values()) {
      if (job.mergedAt !== null && job.mergedAt >= since && job.mergedAt <= until) merges += 1;
      if (job.openedAt !== null && job.openedAt >= since && job.openedAt <= until) opens += 1;
    }
    return { merges, opens };
  } catch {
    return empty;
  }
}

/**
 * Backlog items for the growth export series' recurring adverse cells.
 * Total: a missing series set, another repository or any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function growthBacklogItems(opts: GrowthItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : GROWTH_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling folds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const metricsDir = opts.metricsDir ?? join(runsDir, 'metrics');
    const [costLines, pullsLines, releasesLines, statusJson] = await Promise.all([
      readGrowthJsonl(join(metricsDir, COST_HOURLY_FILE)),
      readGrowthJsonl(join(metricsDir, PULLS_HOURLY_FILE)),
      readGrowthJsonl(join(metricsDir, RELEASES_FILE)),
      readMetricsJson(join(metricsDir, STATUS_FILE)),
    ]);
    // Every series absent means the export pipeline is not running here at
    // all — a clean empty source, not three dark series.
    if (costLines === null && pullsLines === null && releasesLines === null) return [];
    const fold = foldGrowthSeries(costLines, pullsLines, releasesLines, nowMs, windowMs);
    fold.clock = foldGrowthClock(statusJson);
    const activity = await readGrowthActivity(runsDir, nowMs, windowMs);
    const cells = growthCells(fold, activity, nowMs);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? GROWTH_MAX_ITEMS, GROWTH_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => growthItem(cell, repo, fold, windowMs));
  } catch {
    return [];
  }
}
