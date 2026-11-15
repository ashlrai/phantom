/**
 * core/fleet/conflict-risk.ts — read-only conflict predictor for the rebase
 * scheduler.
 *
 * One `gh pr list --state open` read (with `files`) plus one `--state merged`
 * read (with `files` and `mergedAt`) and, when present, the local jobs ledger
 * produce a `fleet.conflict-risk.v1` report: which open PRs are likely to
 * conflict with the NEXT N predicted merges, so the scheduler can rebase the
 * high-risk ones before their turn instead of recutting them after.
 *
 * The model is a declared heuristic, not a measured probability:
 *
 *   predicted merges   planMergeBacklog's order — green-ready first, then
 *                      behind, then non-draft pending, oldest-waiting inside
 *                      each tier; the first `--next` of them are the window.
 *   file overlap       a predicted merge threatens an open PR when they share
 *                      at least one literal path. A window member is only
 *                      threatened by merges at earlier positions — merges
 *                      after its own turn cannot break it first.
 *   recency            a shared path the base already rewrote recently (a
 *                      merged PR touched it inside the hot window) weighs
 *                      double: the open PR is already stale on that path.
 *   score              each threatening merge contributes likelihood
 *                      min(1, (hot*2 + cold)/4); the PR's score is
 *                      1 - Π(1 - likelihood) over its threats — each merge
 *                      rolls the dice on it.
 *   band               high ≥ 0.6, medium ≥ 0.3, low > 0, none = 0. Only high
 *                      carries `rebaseRecommended` — the scheduler's trigger.
 *
 * Merge velocity converts the window into a time horizon (`horizonHours =
 * next / mergesPerHour`) and sizes the hot window; it is measured on the
 * merged-PR page when available (all merges churn the base, not only fleet
 * ones) and falls back to the fleet ledger's MERGED outcomes.
 *
 * Advisory only: the report grants no rebase, merge or dispatch authority.
 * Consumers re-read the exact head and pass existing gates before acting.
 * Degraded legs stay honest — a failed open read is `open-failed`, a failed
 * merged read drops hot/recency evidence but never invents clean overlap, and
 * an unreadable ledger falls back or reports `velocity.source: unavailable`.
 */
import { tmpdir } from 'node:os';
import { defaultGitRunner } from '../verse/git-ops.js';
import type { CloudGh } from '../cloud/pr-actions.js';
import { normalizeRepoPath } from '../authority/protected-paths.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  FLEET_PR_GH_VIEW_FIELDS,
  parseFleetPrGhState,
  type FleetMergeStateRead,
  type FleetPrGhState,
} from './fleet-merge-state.js';
import {
  mergeBacklogCreatedAt,
  planMergeBacklog,
  type MergeBacklogEntry,
  type MergeBacklogItem,
} from './merge-backlog-plan.js';
import { readMergeBacklogStates } from './merge-backlog-read.js';

export const CONFLICT_RISK_SCHEMA = 'fleet.conflict-risk.v1' as const;

export const CONFLICT_RISK_DEFAULT_NEXT = 5;
export const CONFLICT_RISK_MAX_NEXT = 32;
export const CONFLICT_RISK_DEFAULT_LIMIT = 200;
export const CONFLICT_RISK_MAX_LIMIT = 1000;
export const CONFLICT_RISK_DEFAULT_MERGED_LIMIT = 50;
export const CONFLICT_RISK_MAX_MERGED_LIMIT = 200;
export const CONFLICT_RISK_DEFAULT_WINDOW_HOURS = 6;
export const CONFLICT_RISK_MAX_WINDOW_HOURS = 168;

/** gh caps `files` at 100 per PR; bound parsing further out so a page stays cheap. */
const MAX_FILES_PER_PR = 300;
const MAX_TITLE_CHARS = 120;
const MAX_SHARED_PATHS = 8;
const MAX_RISKS = 200;
/** A shared path the base rewrote inside the hot window counts double. */
const HOT_WEIGHT = 2;
const COLD_WEIGHT = 1;
/** Weight at which one predicted merge's conflict likelihood saturates at 1. */
const PER_MERGE_SATURATION = 4;
export const CONFLICT_RISK_BAND_HIGH = 0.6;
export const CONFLICT_RISK_BAND_MEDIUM = 0.3;
/** Hot lookback when merge velocity cannot project a horizon. */
const FALLBACK_HOT_WINDOW_HOURS = 24;
const MAX_HOT_WINDOW_HOURS = 168;

const GH_LIST_TIMEOUT_MS = 60_000;
const GH_LIST_MAX_BYTES = 16 * 1024 * 1024;
const OPEN_GH_FIELDS = `${FLEET_PR_GH_VIEW_FIELDS},createdAt,title,files`;
const MERGED_GH_FIELDS = 'number,files,mergedAt';
const MERGED_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/[1-9]\d*\/?$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Production gh: argv only, bounded, never prompts (git-ops' runner and env). */
const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: GH_LIST_TIMEOUT_MS, maxStdoutBytes: GH_LIST_MAX_BYTES,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

export type ConflictRiskTier = 'ready' | 'behind' | 'pending';
export type ConflictRiskBand = 'high' | 'medium' | 'low' | 'none';

/** One validated open-PR row: the parsed GitHub view plus the fields the predictor reads. */
export interface ConflictRiskOpenPr {
  /** null when gh could not describe the PR — it still counts as unreadable. */
  github: FleetPrGhState | null;
  createdAt?: string;
  /** Bounded raw title; scrubbed only at report assembly. */
  title: string;
  /** Normalized, deduplicated repo paths. */
  files: string[];
  /** Our own parse cap was hit; gh's silent ~100-file cap cannot be detected. */
  filesTruncated: boolean;
}

/** One validated merged-PR row — churn evidence, nothing else. */
export interface ConflictRiskMergedPr {
  number: number;
  /** Parseable `mergedAt` as epoch ms, else null (never invented). */
  mergedAt: number | null;
  files: string[];
}

export interface ConflictRiskPredictedMerge {
  number: number;
  /** 1-based position in the predicted merge order. */
  position: number;
  tier: ConflictRiskTier;
  files: number;
}

export interface ConflictRiskThreat {
  /** Predicted merge that threatens this PR. */
  number: number;
  position: number;
  /** Shared literal paths, sorted, capped at MAX_SHARED_PATHS. */
  shared: string[];
  sharedTotal: number;
  /** Shared paths the base also rewrote inside the hot window. */
  hot: number;
}

export interface ConflictRiskEntry {
  number: number;
  /** Scrubbed, bounded — a title is untrusted text. */
  title: string;
  headSha: string | null;
  /** Predicted merge position when this PR is itself in the window, else null. */
  position: number | null;
  files: number;
  score: number;
  band: Exclude<ConflictRiskBand, 'none'>;
  /** True only on `high` — the scheduler's proactive-rebase trigger. */
  rebaseRecommended: boolean;
  /** Earliest predicted merge position that threatens it; null when none. */
  conflictByPosition: number | null;
  threats: ConflictRiskThreat[];
}

export interface ConflictRiskReport {
  schema: typeof CONFLICT_RISK_SCHEMA;
  v: 1;
  repo: string;
  generatedAt: string;
  /** 'open-failed' when gh could not list PRs; 'truncated' when the open page filled. */
  source: 'ok' | 'open-failed' | 'truncated';
  /** Fixed machine token on open-failed; never gh's stderr. */
  reason?: string;
  /** False when the open page hit --limit: unseen PRs carry unseen risk. */
  complete: boolean;
  reads: {
    open: 'ok' | 'failed';
    merged: 'ok' | 'failed';
    ledger: 'ok' | 'unavailable' | 'skipped';
  };
  velocity: {
    source: 'merged-page' | 'ledger' | 'unavailable';
    windowHours: number;
    merges: number | null;
    mergesPerHour: number | null;
    /** True when the merged page filled inside the window — the rate is a floor. */
    truncated: boolean;
  };
  /** next / mergesPerHour when velocity is known and positive, else null. */
  horizonHours: number | null;
  hotWindowHours: number;
  next: number;
  /** The predicted next-N merge window, in order. */
  nextMerges: ConflictRiskPredictedMerge[];
  /** PRs already conflicting — recut candidates, not rebase candidates. */
  conflicting: { number: number; headSha: string | null }[];
  /** Open PRs with at least one threatening predicted merge, highest score first. */
  risks: ConflictRiskEntry[];
  /** Threatened PRs beyond MAX_RISKS — counted, not listed. */
  risksOmitted: number;
  counts: {
    open: number;
    unreadable: number;
    predicted: number;
    conflicting: number;
    high: number;
    medium: number;
    low: number;
    none: number;
  };
  note: string;
}

const NOTE = 'Heuristic prediction from file overlap and merge recency, not a measured conflict rate: '
  + 'gh pr list returns at most ~100 files per PR and says nothing about diff regions, so file overlap is a '
  + 'necessary-but-insufficient signal. Advisory only — re-verify the exact head before rebasing or merging.';

/** Validate one `gh pr list` open row; null when the row cannot name a PR at all. */
export function parseConflictRiskOpenPr(raw: unknown): ConflictRiskOpenPr | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const github = parseFleetPrGhState(row);
  const number = github?.number ?? row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  return {
    github,
    createdAt: mergeBacklogCreatedAt(row),
    title: typeof row['title'] === 'string' ? row['title'].slice(0, MAX_TITLE_CHARS) : '',
    ...parseFiles(row['files']),
  };
}

/** Validate one `gh pr list --state merged` row; null when it cannot name a PR. */
export function parseConflictRiskMergedPr(raw: unknown): ConflictRiskMergedPr | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const number = row['number'];
  if (!Number.isSafeInteger(number) || (number as number) < 1) return null;
  const mergedAt = typeof row['mergedAt'] === 'string' ? Date.parse(row['mergedAt']) : NaN;
  return { number: number as number, mergedAt: Number.isFinite(mergedAt) ? mergedAt : null, ...parseFiles(row['files']) };
}

function parseFiles(raw: unknown): { files: string[]; filesTruncated: boolean } {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  for (const entry of rows.slice(0, MAX_FILES_PER_PR)) {
    if (entry === null || typeof entry !== 'object' || !('path' in entry)) continue;
    const rawPath = (entry as { path: unknown }).path;
    const path = typeof rawPath === 'string' ? normalizeRepoPath(rawPath) : null;
    if (path !== null) seen.add(path);
  }
  return { files: [...seen], filesTruncated: rows.length > MAX_FILES_PER_PR };
}

/**
 * Latest MERGED-outcome count for one repo inside the window, from the fleet
 * jobs ledger. One row per job wins (the newest timestamp); rows without a
 * canonical PR url cannot name their repo and never count.
 */
export function ledgerMergeCount(text: string, repo: string, windowMs: number, nowMs: number): number {
  const wanted = repo.toLowerCase();
  const latest = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const row = parsed as Record<string, unknown>;
    if (row['event'] !== 'outcome' || row['state'] !== 'MERGED') continue;
    const job = row['job'];
    if (typeof job !== 'string' || !job.trim()) continue;
    const at = typeof row['ts'] === 'string' ? Date.parse(row['ts']) : NaN;
    if (!Number.isFinite(at) || at > nowMs || at < nowMs - windowMs) continue;
    const match = typeof row['url'] === 'string' ? MERGED_URL_RE.exec(row['url']) : null;
    if (!match || match[1]!.toLowerCase() !== wanted) continue;
    if ((latest.get(job) ?? -Infinity) < at) latest.set(job, at);
  }
  return latest.size;
}

/** Merged-page fallback: mergedAt inside the window. Unknown timestamps never count. */
export function mergedPageMergeCount(merged: readonly ConflictRiskMergedPr[], windowMs: number, nowMs: number): number {
  return merged.filter(pr => pr.mergedAt !== null && pr.mergedAt <= nowMs && nowMs - pr.mergedAt <= windowMs).length;
}

/** Paths the base rewrote inside the hot window — the recency half of the heuristic. */
export function churnedPaths(merged: readonly ConflictRiskMergedPr[], hotWindowMs: number, nowMs: number): Set<string> {
  const hot = new Set<string>();
  for (const pr of merged) {
    if (pr.mergedAt === null || pr.mergedAt > nowMs || nowMs - pr.mergedAt > hotWindowMs) continue;
    for (const path of pr.files) hot.add(path);
  }
  return hot;
}

/** Same priority the planner's oldestFirst uses; kept private there, so duplicated. */
function waitingMs(item: MergeBacklogItem): number {
  const openedAt = item.mergeState.state === 'ok' ? item.mergeState.record.pr?.openedAt : undefined;
  for (const value of [item.createdAt, openedAt]) {
    if (value && ISO_TS_RE.test(value)) {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return Infinity;
}

const TIER_OF: Readonly<Record<string, ConflictRiskTier>> = {
  'green-ready': 'ready', behind: 'behind', pending: 'pending',
};

/**
 * The predicted next-N merge window: planMergeBacklog's ready merges first,
 * then base-refresh (behind) PRs, then non-draft pending PRs whose checks may
 * still land them — oldest-waiting inside each tier. Conflicted, red-required,
 * draft, closed and unknown PRs are not predicted merges.
 */
export function predictedMergeWindow(items: readonly MergeBacklogItem[], next: number): MergeBacklogEntry[] {
  const plan = planMergeBacklog(items, { merges: Number.MAX_SAFE_INTEGER, recuts: Number.MAX_SAFE_INTEGER });
  const pending = plan.deferred
    .filter(entry => entry.classification.class === 'pending' && entry.classification.reason !== 'draft')
    .sort((a, b) => waitingMs(a) - waitingMs(b));
  return [...plan.merges, ...plan.refreshes, ...pending].slice(0, next);
}

/** One merge's conflict likelihood against a PR: saturated weighted overlap. */
function mergeLikelihood(sharedTotal: number, hot: number): number {
  return Math.min(1, (hot * HOT_WEIGHT + (sharedTotal - hot) * COLD_WEIGHT) / PER_MERGE_SATURATION);
}

function bandOf(score: number): ConflictRiskBand {
  return score >= CONFLICT_RISK_BAND_HIGH ? 'high' : score >= CONFLICT_RISK_BAND_MEDIUM ? 'medium' : score > 0 ? 'low' : 'none';
}

export interface ConflictRiskScoreInput {
  open: readonly ConflictRiskOpenPr[];
  window: readonly MergeBacklogEntry[];
  filesByPr: ReadonlyMap<number, Set<string>>;
  hot: ReadonlySet<string>;
}

/**
 * Score every scoreable open PR against the window. Pure and total — the
 * report assembly adds ordering, bands and counts. A PR already conflicting,
 * not OPEN, or undescribed is not scored here.
 */
export function scoreConflictRisk(input: ConflictRiskScoreInput): Map<number, { score: number; threats: ConflictRiskThreat[] }> {
  const positionByPr = new Map<number, number>();
  const windowFiles: { number: number; position: number; files: Set<string> }[] = [];
  input.window.forEach((entry, index) => {
    const number = entry.github?.number;
    if (number === undefined) return;
    positionByPr.set(number, index + 1);
    const files = input.filesByPr.get(number);
    if (files && files.size > 0) windowFiles.push({ number, position: index + 1, files });
  });

  const scored = new Map<number, { score: number; threats: ConflictRiskThreat[] }>();
  for (const pr of input.open) {
    if (pr.github === null || pr.github.state !== 'OPEN' || pr.github.mergeable === 'CONFLICTING' || pr.github.mergeStateStatus === 'DIRTY') continue;
    const files = input.filesByPr.get(pr.github.number);
    if (!files || files.size === 0) continue;
    const ownPosition = positionByPr.get(pr.github.number) ?? null;
    const threats: ConflictRiskThreat[] = [];
    for (const merge of windowFiles) {
      if (merge.number === pr.github.number) continue;
      // Only merges landing before this PR's own turn can break it first.
      if (ownPosition !== null && merge.position >= ownPosition) continue;
      const shared: string[] = [];
      for (const path of files) if (merge.files.has(path)) shared.push(path);
      if (shared.length === 0) continue;
      shared.sort();
      const hot = shared.filter(path => input.hot.has(path)).length;
      threats.push({ number: merge.number, position: merge.position, shared: shared.slice(0, MAX_SHARED_PATHS), sharedTotal: shared.length, hot });
    }
    let survive = 1;
    for (const threat of threats) survive *= 1 - mergeLikelihood(threat.sharedTotal, threat.hot);
    const score = Math.round((1 - survive) * 10_000) / 10_000;
    scored.set(pr.github.number, { score, threats });
  }
  return scored;
}

export interface ConflictRiskBuildInput {
  repo: string;
  /** Raw open-PR rows; 'failed' means the gh read itself failed. */
  open: readonly unknown[] | 'failed';
  /** Raw merged-PR rows for churn/recency; 'failed'/absent = that leg is unknown. */
  merged?: readonly unknown[] | 'failed';
  /** True when the merged page hit its --merged-limit while every row fell inside the window. */
  mergedTruncated?: boolean;
  /** jobs.jsonl text for the velocity fallback; null = unreadable, absent = not attempted. */
  ledger?: string | null;
  /** Open rows the page held before parsing; defaults to open.length. */
  observedOpen?: number;
  openFailedReason?: string;
  states?: (repo: string) => ReadonlyMap<number, FleetMergeStateRead>;
  next?: number;
  limit?: number;
  windowHours?: number;
  now?: Date;
}

/** Pure report assembly — no I/O. Every leg degrades honestly, never silently. */
export function buildConflictRiskReport(input: ConflictRiskBuildInput): ConflictRiskReport {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const next = Number.isSafeInteger(input.next)
    ? Math.min(Math.max(input.next as number, 1), CONFLICT_RISK_MAX_NEXT)
    : CONFLICT_RISK_DEFAULT_NEXT;
  const limit = Number.isSafeInteger(input.limit)
    ? Math.min(Math.max(input.limit as number, 1), CONFLICT_RISK_MAX_LIMIT)
    : CONFLICT_RISK_DEFAULT_LIMIT;
  const windowHours = Number.isSafeInteger(input.windowHours)
    ? Math.min(Math.max(input.windowHours as number, 1), CONFLICT_RISK_MAX_WINDOW_HOURS)
    : CONFLICT_RISK_DEFAULT_WINDOW_HOURS;
  const windowMs = windowHours * 3_600_000;

  const base = {
    schema: CONFLICT_RISK_SCHEMA, v: 1 as const, repo: input.repo, generatedAt: now.toISOString(),
    next,
    nextMerges: [] as ConflictRiskPredictedMerge[],
    conflicting: [] as { number: number; headSha: string | null }[],
    risks: [] as ConflictRiskEntry[],
    risksOmitted: 0,
    note: NOTE,
  };

  if (input.open === 'failed') {
    return {
      ...base,
      source: 'open-failed', reason: input.openFailedReason ?? 'gh-pr-list-failed', complete: false,
      reads: { open: 'failed', merged: Array.isArray(input.merged) ? 'ok' : 'failed', ledger: input.ledger === null ? 'unavailable' : input.ledger === undefined ? 'skipped' : 'ok' },
      velocity: { source: 'unavailable', windowHours, merges: null, mergesPerHour: null, truncated: false },
      horizonHours: null, hotWindowHours: FALLBACK_HOT_WINDOW_HOURS,
      counts: { open: 0, unreadable: 0, predicted: 0, conflicting: 0, high: 0, medium: 0, low: 0, none: 0 },
    };
  }

  const open = input.open.map(parseConflictRiskOpenPr).filter((pr): pr is ConflictRiskOpenPr => pr !== null);
  const observedOpen = input.observedOpen ?? input.open.length;
  const merged = Array.isArray(input.merged)
    ? input.merged.map(parseConflictRiskMergedPr).filter((pr): pr is ConflictRiskMergedPr => pr !== null)
    : null;

  // Velocity: the merged page first (every merge churns the base, fleet or
  // human), then the fleet ledger, then honestly unavailable.
  const mergedCount = merged === null ? null : mergedPageMergeCount(merged, windowMs, nowMs);
  const ledgerCount = typeof input.ledger === 'string' ? ledgerMergeCount(input.ledger, input.repo, windowMs, nowMs) : null;
  const velocity = mergedCount !== null
    ? { source: 'merged-page' as const, windowHours, merges: mergedCount, mergesPerHour: mergedCount / windowHours, truncated: input.mergedTruncated === true && mergedCount > 0 && mergedCount === merged!.length }
    : ledgerCount !== null
      ? { source: 'ledger' as const, windowHours, merges: ledgerCount, mergesPerHour: ledgerCount / windowHours, truncated: false }
      : { source: 'unavailable' as const, windowHours, merges: null, mergesPerHour: null, truncated: false };
  const horizonHours = velocity.mergesPerHour !== null && velocity.mergesPerHour > 0 ? next / velocity.mergesPerHour : null;
  const hotWindowHours = Math.min(Math.max(horizonHours ?? FALLBACK_HOT_WINDOW_HOURS, 1), MAX_HOT_WINDOW_HOURS);
  const hot = merged === null ? new Set<string>() : churnedPaths(merged, hotWindowHours * 3_600_000, nowMs);

  // Join merge-state records and predict the merge window.
  const states = (input.states ?? readMergeBacklogStates)(input.repo);
  const missing: FleetMergeStateRead = { state: 'missing' };
  const filesByPr = new Map<number, Set<string>>();
  const items: MergeBacklogItem[] = open.map(pr => {
    if (pr.github) filesByPr.set(pr.github.number, new Set(pr.files));
    return { repo: input.repo, createdAt: pr.createdAt, github: pr.github, mergeState: (pr.github && states.get(pr.github.number)) || missing };
  });
  const window = predictedMergeWindow(items, next);
  const positionByPr = new Map<number, number>();
  const nextMerges = window.map((entry, index) => {
    const number = entry.github?.number ?? 0;
    positionByPr.set(number, index + 1);
    return { number, position: index + 1, tier: TIER_OF[entry.classification.class] ?? 'pending', files: filesByPr.get(number)?.size ?? 0 };
  });

  const conflicting = open
    .filter(pr => pr.github !== null && pr.github.state === 'OPEN' &&
      (pr.github.mergeable === 'CONFLICTING' || pr.github.mergeStateStatus === 'DIRTY'))
    .map(pr => ({ number: pr.github!.number, headSha: pr.github!.headSha }))
    .sort((a, b) => a.number - b.number);

  const scored = scoreConflictRisk({ open, window, filesByPr, hot });
  const risks: ConflictRiskEntry[] = [];
  for (const pr of open) {
    if (pr.github === null) continue;
    const entry = scored.get(pr.github.number);
    if (!entry || entry.score <= 0) continue;
    const band = bandOf(entry.score);
    if (band === 'none') continue;
    risks.push({
      number: pr.github.number,
      title: scrubSecrets(pr.title),
      headSha: pr.github.headSha,
      position: positionByPr.get(pr.github.number) ?? null,
      files: filesByPr.get(pr.github.number)?.size ?? 0,
      score: entry.score,
      band,
      rebaseRecommended: band === 'high',
      conflictByPosition: entry.threats.length ? Math.min(...entry.threats.map(t => t.position)) : null,
      threats: entry.threats,
    });
  }
  risks.sort((a, b) => b.score - a.score || (a.position ?? Infinity) - (b.position ?? Infinity) || a.number - b.number);

  const counts = {
    open: open.length,
    unreadable: Math.max(0, observedOpen - open.length) + open.filter(pr => pr.github === null).length,
    predicted: nextMerges.length,
    conflicting: conflicting.length,
    high: risks.filter(r => r.band === 'high').length,
    medium: risks.filter(r => r.band === 'medium').length,
    low: risks.filter(r => r.band === 'low').length,
    none: 0,
  };
  // Every parsed, non-conflicting open PR was scored; the rest are 'none'.
  const scoreable = open.filter(pr => pr.github !== null && pr.github.state === 'OPEN' &&
    pr.github.mergeable !== 'CONFLICTING' && pr.github.mergeStateStatus !== 'DIRTY').length;
  counts.none = scoreable - counts.high - counts.medium - counts.low;

  return {
    ...base,
    source: observedOpen < limit ? 'ok' : 'truncated',
    complete: observedOpen < limit,
    reads: {
      open: 'ok',
      merged: merged === null ? 'failed' : 'ok',
      ledger: input.ledger === null ? 'unavailable' : input.ledger === undefined ? 'skipped' : 'ok',
    },
    velocity,
    horizonHours: horizonHours === null ? null : Math.round(horizonHours * 100) / 100,
    hotWindowHours,
    nextMerges,
    conflicting,
    risks: risks.slice(0, MAX_RISKS),
    risksOmitted: Math.max(0, risks.length - MAX_RISKS),
    counts,
  };
}

async function ghPrList(repo: string, state: 'open' | 'merged', limit: number, fields: string, gh: CloudGh) {
  const argv = ['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', fields];
  // The merged page must be the freshest merges, not the freshest creations.
  if (state === 'merged') argv.push('--search', 'sort:updated-desc');
  const result = await gh(argv);
  if (!result.ok) return { ok: false as const, reason: 'gh-pr-list-failed' };
  try {
    const rows: unknown = JSON.parse(result.stdout);
    return Array.isArray(rows) ? { ok: true as const, rows } : { ok: false as const, reason: 'gh-pr-list-not-an-array' };
  } catch {
    return { ok: false as const, reason: 'gh-pr-list-not-json' };
  }
}

export interface ReadConflictRiskInput {
  repo: string;
  gh?: CloudGh;
  /** jobs.jsonl text for the velocity fallback; null = unreadable, absent = not attempted. */
  ledger?: string | null;
  states?: (repo: string) => ReadonlyMap<number, FleetMergeStateRead>;
  next?: number;
  limit?: number;
  mergedLimit?: number;
  windowHours?: number;
  now?: () => Date;
}

/**
 * One repo's conflict-risk report. Two bounded gh reads; a failed open read
 * still emits an honest `open-failed` report rather than a fake-clean one.
 */
export async function readConflictRisk(input: ReadConflictRiskInput): Promise<ConflictRiskReport> {
  const gh = input.gh ?? defaultGh;
  const limit = Number.isSafeInteger(input.limit)
    ? Math.min(Math.max(input.limit as number, 1), CONFLICT_RISK_MAX_LIMIT)
    : CONFLICT_RISK_DEFAULT_LIMIT;
  const mergedLimit = Number.isSafeInteger(input.mergedLimit)
    ? Math.min(Math.max(input.mergedLimit as number, 1), CONFLICT_RISK_MAX_MERGED_LIMIT)
    : CONFLICT_RISK_DEFAULT_MERGED_LIMIT;
  const now = (input.now ?? (() => new Date()))();

  const [openRead, mergedRead] = await Promise.all([
    ghPrList(input.repo, 'open', limit, OPEN_GH_FIELDS, gh),
    ghPrList(input.repo, 'merged', mergedLimit, MERGED_GH_FIELDS, gh),
  ]);

  return buildConflictRiskReport({
    repo: input.repo,
    open: openRead.ok ? openRead.rows : 'failed',
    openFailedReason: openRead.ok ? undefined : openRead.reason,
    observedOpen: openRead.ok ? openRead.rows.length : undefined,
    merged: mergedRead.ok ? mergedRead.rows : 'failed',
    mergedTruncated: mergedRead.ok ? mergedRead.rows.length >= mergedLimit : false,
    ledger: input.ledger,
    states: input.states,
    next: input.next,
    limit,
    windowHours: input.windowHours,
    now,
  });
}
