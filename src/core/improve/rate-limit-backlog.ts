/**
 * ~/.ashlr/fabric/claude-rate-limit-events.jsonl Claude CLI rate-limit events
 * → self-improvement backlog items.
 *
 * Every Claude run's captured output can carry the CLI's own
 * rate_limit_event metadata line — {type, status, rateLimitType,
 * utilization, resetsAt} — and recordClaudeRateLimitEventLine
 * (src/core/fabric/claude-rate-limit-event.ts) appends the sanitized
 * {type:'rate_limit_event', status, rateLimitType, utilization,
 * resetsAt, capturedAt} record to this one append-only file,
 * never persisting prompts, diffs, tool arguments or model text. The file
 * self-compacts past CLAUDE_RATE_LIMIT_EVENTS_MAX_BYTES keeping only the
 * records a newest-first scan could still return.
 *
 * Until now its only reader was the resource monitor's live snapshot:
 * readLatestClaudeRateLimitEvent returns the newest unexpired event per
 * window type so senseClaudeState can mark the backend exhausted,
 * throttled or near — a point-in-time verdict that resets every poll. A
 * fleet whose Claude accounts keep exhausting the same provider window
 * week after week looked like a healthy snapshot between events: the
 * recurrence was recorded and never folded into work.
 * rateLimitBacklogItems carries the same rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's bounded
 *    no-follow tail at the writer's own compaction bound; nothing is
 *    written and no network is touched. A missing or unreadable file
 *    yields no items; a malformed line is skipped, never guessed.
 *  - Rows count only under the journal's own contract: the writer's own
 *    parser (parseClaudeRateLimitEventLine) accepts a line — type
 *    'rate_limit_event', finite utilization, positive resetsAt — and the
 *    record's capturedAt lands inside the window. Undated rows fall back
 *    to the epoch and land outside the window rather than passing as
 *    fresh evidence; foreign shapes are malformed, never folded.
 *  - Recurring means recorded across windows and days: a cell emits only
 *    at RATE_LIMIT_MIN_ROWS in-window adverse rows across
 *    RATE_LIMIT_MIN_DAYS distinct UTC days AND RATE_LIMIT_MIN_WINDOWS
 *    distinct resetsAt values — each resetsAt is a different provider
 *    rate-limit window, so one exhausted window re-sampled by every run
 *    cannot mint a pattern by itself.
 *  - Only adverse pressure folds: utilization >= 1 is 'exhausted' (the
 *    provider reports the window fully consumed — the same boundary
 *    resource-monitor's classifier uses) and utilization >=
 *    RATE_LIMIT_NEAR_UTILIZATION is 'near-limit' (the monitor's 'near'
 *    band, usedPct >= 75). Healthier rows count as events but never form
 *    cells — headroom is not evidence.
 *  - Truncation is stated, never hidden: when the bounded tail cut older
 *    bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling fleet-evidence
 *    sources apply — since the journal describes this install's Claude
 *    runs and carries no repository column. Dedup is downstream: the
 *    item id hashes the cell identity, never counts or timestamps, so a
 *    refresh re-derives the same id and a recovered cell simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { CLAUDE_RATE_LIMIT_EVENTS_MAX_BYTES, claudeRateLimitEventsPath, parseClaudeRateLimitEventLine } from '../fabric/claude-rate-limit-event.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is small closed vocabularies. */
export const RATE_LIMIT_BACKLOG_MAX_ITEMS = 12;
const RATE_LIMIT_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const RATE_LIMIT_WINDOW_HOURS = 168;
/** A cell emits only at this many in-window adverse rows carrying its evidence... */
export const RATE_LIMIT_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days... */
export const RATE_LIMIT_MIN_DAYS = 2;
/** ...and at least this many distinct provider reset windows, so one exhausted window re-sampled cannot mint a pattern. */
export const RATE_LIMIT_MIN_WINDOWS = 2;
/** utilization >= 1: the provider reports the window fully consumed (resource-monitor's 'exhausted' boundary). */
export const RATE_LIMIT_EXHAUSTED_UTILIZATION = 1;
/** utilization >= 0.75: the monitor's 'near' band (usedPct >= 75) — sustained pressure below the wall. */
export const RATE_LIMIT_NEAR_UTILIZATION = 0.75;
/** The fleet's own repository label: rate-limit evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Status tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** The writer's sanitizeLabel already bounds these to [A-Za-z0-9_.:-]; the shape check is defense in depth. */
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

export type RateLimitTier = 'exhausted' | 'near-limit';

export interface RateLimitItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: claudeRateLimitEventsPath(), the writer's own ~/.ashlr/fabric path). */
  journalPath?: string;
  /** Evidence window in hours (default RATE_LIMIT_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default RATE_LIMIT_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-cell in-window fold before the recurring bars apply. */
export interface RateLimitCellFold {
  rateLimitType: string;
  tier: RateLimitTier;
  /** In-window adverse rows for this (type, tier). */
  rows: number;
  /** Distinct resetsAt values — each is a different provider rate-limit window. */
  windows: Set<number>;
  /** Distinct UTC days. */
  days: Set<string>;
  /** Status tallies across the cell's rows (the CLI's own allowed/rejected labels). */
  statuses: Map<string, number>;
  /** Highest utilization any contributing row recorded. */
  maxUtilization: number;
  firstMs: number | null;
  lastMs: number | null;
}

export interface RateLimitFold {
  /** In-window parsed rate_limit_event records — the share denominator the prompts quote. */
  events: number;
  cells: Map<string, RateLimitCellFold>;
  /** Non-blank lines the writer's parser rejected. */
  malformed: number;
  /** Parsed records outside the window (including undated rows, which fold as epoch). */
  outsideWindow: number;
}

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

/** The adverse tier a utilization reading sits in; null for ordinary headroom. */
function tierOf(utilization: number): RateLimitTier | null {
  if (utilization >= RATE_LIMIT_EXHAUSTED_UTILIZATION) return 'exhausted';
  if (utilization >= RATE_LIMIT_NEAR_UTILIZATION) return 'near-limit';
  return null;
}

/**
 * Pure: fold journal text(s) — oldest first — into per-cell recurring
 * adverse evidence. Lines the writer's own parser rejects, undated rows
 * and out-of-window records are skipped, never guessed; healthy
 * utilization counts as an event but never forms a cell.
 */
export function foldRateLimitEvents(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): RateLimitFold {
  const fold: RateLimitFold = { events: 0, cells: new Map(), malformed: 0, outsideWindow: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // capturedAtMs=0: a row missing capturedAt folds as the epoch —
      // outside every window — rather than being stamped "now" as fresh
      // evidence. Journal rows always carry capturedAt.
      const event = parseClaudeRateLimitEventLine(line, 0);
      if (event === null) { fold.malformed++; continue; }
      const atMs = Date.parse(event.capturedAt);
      if (!Number.isFinite(atMs) || atMs < since || atMs > until) { fold.outsideWindow++; continue; }
      fold.events += 1;
      const tier = tierOf(event.utilization);
      if (tier === null) continue;
      if (!SAFE_LABEL.test(event.rateLimitType) || !SAFE_LABEL.test(event.status)) continue;
      const key = `${event.rateLimitType}|${tier}`;
      let cell = fold.cells.get(key);
      if (cell === undefined) {
        cell = { rateLimitType: event.rateLimitType, tier, rows: 0, windows: new Set(), days: new Set(), statuses: new Map(), maxUtilization: 0, firstMs: null, lastMs: null };
        fold.cells.set(key, cell);
      }
      cell.rows += 1;
      cell.windows.add(event.resetsAt);
      cell.days.add(dayOf(atMs));
      bump(cell.statuses, event.status);
      cell.maxUtilization = Math.max(cell.maxUtilization, event.utilization);
      touch(cell, atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageTally {
  /** Sanitized recorded text (a status label). */
  text: string;
  count: number;
}

export interface RateLimitCell {
  kind: 'rate-limit-window';
  rateLimitType: string;
  tier: RateLimitTier;
  /** In-window adverse rows carrying the cell's evidence. */
  rows: number;
  /** Distinct provider reset windows across those rows. */
  windows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window parsed records overall — the share denominator. */
  records: number;
  /** Status tallies across the cell's rows, most frequent first. */
  statuses: UsageTally[];
  /** Highest utilization any contributing row recorded. */
  maxUtilization: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): UsageTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const recurring = (rows: number, days: Set<string>, windows: Set<number>): boolean =>
  rows >= RATE_LIMIT_MIN_ROWS && days.size >= RATE_LIMIT_MIN_DAYS && windows.size >= RATE_LIMIT_MIN_WINDOWS;

/**
 * Pure: recurring cells — a (rateLimitType, tier) group at the
 * row/day/window bars. Exhausted cells sort first (the sharper signal),
 * then near-limit, each by row count.
 */
export function rateLimitCells(fold: RateLimitFold, lowerBound = false): RateLimitCell[] {
  const cells: RateLimitCell[] = [];
  for (const cell of fold.cells.values()) {
    if (!recurring(cell.rows, cell.days, cell.windows)) continue;
    cells.push({
      kind: 'rate-limit-window',
      rateLimitType: cell.rateLimitType,
      tier: cell.tier,
      rows: cell.rows,
      windows: cell.windows.size,
      days: [...cell.days].sort(),
      records: fold.events,
      statuses: tallyOf(cell.statuses, MAX_PROMPT_TALLIES),
      maxUtilization: cell.maxUtilization,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  const rank = (c: RateLimitCell): number => (c.tier === 'exhausted' ? 0 : 1);
  return cells.sort((a, b) => rank(a) - rank(b) || b.rows - a.rows || `${a.rateLimitType}|${a.tier}`.localeCompare(`${b.rateLimitType}|${b.tier}`));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is ~/.ashlr/fabric/claude-rate-limit-events.jsonl — claudeRateLimitEventsPath() in src/core/fabric/claude-rate-limit-event.ts resolves ~/.ashlr/fabric directly — one append-only file recordClaudeRateLimitEventLine writes from every Claude CLI run\'s captured output: the CLI\'s own rate_limit_event metadata line, sanitized to {type, status, rateLimitType, utilization, resetsAt, capturedAt}; prompts, diffs, tool arguments and model text are never persisted. The file self-compacts past CLAUDE_RATE_LIMIT_EVENTS_MAX_BYTES keeping only the records a newest-first scan could still return. Its only reader until this feed was the resource monitor\'s live snapshot — readLatestClaudeRateLimitEvent returns the newest unexpired event per window type for senseClaudeState\'s exhausted/throttled/near verdict, a point-in-time read that resets every poll and never folds a recurrence.';

const REPRO = 'Reproduce the fold by reading ~/.ashlr/fabric/claude-rate-limit-events.jsonl directly, keeping the sanitized rate_limit_event records whose capturedAt lands inside the window, classing utilization >= 1 as exhausted and >= 0.75 as near-limit, and grouping by (rateLimitType, tier). The writer, parser and compaction bound this repository owns are src/core/fabric/claude-rate-limit-event.ts (recordClaudeRateLimitEventLine, parseClaudeRateLimitEventLine, CLAUDE_RATE_LIMIT_EVENTS_MAX_BYTES) and src/core/fabric/resource-monitor.ts (the live-snapshot reader and its exhausted/throttled/near classification).';

const NO_CHANGE = 'If the window has rolled forward, the pattern was a temporary usage burst the later rows recovered from, the rows are stale duplicate captures of one provider window rather than recurring exhaustion, the fleet intentionally concentrated Claude work into a planned burst, or the binding constraint is the provider plan\'s own window cap — plan changes are owner-only — report no-change and name the evidence.';

const tallyText = (tallies: readonly UsageTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: RateLimitCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: RateLimitCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: RateLimitCell): string =>
  cell.records > 0 ? ` (${Math.round((cell.rows / cell.records) * 100)}% of the ${cell.records} in-window rate-limit records)` : '';

function rateLimitPrompt(cell: RateLimitCell): string {
  const exhausted = cell.tier === 'exhausted';
  const claim = exhausted
    ? `utilization >= 1 — the provider reports the '${cell.rateLimitType}' window fully consumed, so Claude work is being refused or throttled at the account level`
    : `utilization >= ${RATE_LIMIT_NEAR_UTILIZATION} — sustained pressure below the wall, the resource monitor's 'near' band`;
  const statuses = cell.statuses.length === 0 ? '' : ` Statuses the rows carried: ${tallyText(cell.statuses)}.`;
  const peak = ` Peak utilization ${Math.round(cell.maxUtilization * 100)}%.`;
  return [
    `Phantom's Claude rate-limit journal keeps recording ${exhausted ? 'exhausted' : 'near-limit'} provider windows — ${cell.rows} rate_limit_event row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) and ${cell.windows} distinct reset window(s) for rateLimitType '${cell.rateLimitType}', the self-improvement work this backlog exists for.`,
    '',
    `Each row is one rate_limit_event the Claude CLI emitted during a run: ${claim}.${statuses}${peak}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    exhausted
      ? `Find why the fleet keeps exhausting the Claude '${cell.rateLimitType}' window: read the newest rows and the capacity snapshot they imply (~/.ashlr/routing/capacity.json, published by the account collector), then check whether the fleet is concentrating too many concurrent Claude runs on one account, whether the budget policy's reserves or seat policies keep scheduling Claude work into an already-exhausted window instead of preferring seats with headroom (src/core/routing), or whether the provider plan's window cap is simply the binding constraint — plan changes are owner-only, so name them rather than working around them. The same capture gaps the usage-gap feed tracks at the jobs-ledger layer can make a healthy account read as exhausted.`
      : `Find why the fleet keeps running near the Claude '${cell.rateLimitType}' cap: read the newest rows and the capacity snapshot they imply (~/.ashlr/routing/capacity.json), then check whether demand is genuinely growing toward the provider window, whether the router keeps preferring Claude seats that sit closest to the cap instead of spreading across seats with headroom (src/core/routing), or whether near-limit readings reflect stale captures the live snapshot already discounts. Recurring near-limit is the early form of the exhaustion the fleet would rather route around.`,
    '',
    `Fix what lives here — the capacity snapshot producer, the routing preference order in src/core/routing, the run scheduler's seat spread, or the evidence path that feeds the snapshot.${exhausted ? ' If the exhaustion reflects a provider plan cap only Mason can change, name it as owner-only.' : ''} ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function rateLimitItem(cell: RateLimitCell, repo: string): CloudBacklogItem {
  const title = cell.tier === 'exhausted'
    ? `Claude ${fieldText(cell.rateLimitType, MAX_NAME_CHARS)} rate limit keeps exhausting`
    : `Claude ${fieldText(cell.rateLimitType, MAX_NAME_CHARS)} rate limit keeps running near the cap`;
  return {
    id: `rate-limit-${sha(`${cell.rateLimitType}|${cell.tier}`)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: rateLimitPrompt(cell),
    area: cell.tier === 'exhausted' ? 'rate-limit-exhausted' : 'rate-limit-near',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the Claude CLI rate-limit journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function rateLimitBacklogItems(opts: RateLimitItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? RATE_LIMIT_WINDOW_HOURS;
    const journalPath = opts.journalPath ?? claudeRateLimitEventsPath();
    const read = await readLedgerTail(journalPath, CLAUDE_RATE_LIMIT_EVENTS_MAX_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so the tail folds whole.
    const fold = foldRateLimitEvents([read.text], nowMs, windowHours);
    if (fold.events === 0) return [];
    const cells = rateLimitCells(fold, read.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? RATE_LIMIT_BACKLOG_MAX_ITEMS, RATE_LIMIT_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => rateLimitItem(cell, repo));
  } catch {
    return [];
  }
}
