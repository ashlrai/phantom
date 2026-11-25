/**
 * <runs>/bus/usage-live-alerts.jsonl usage-live alert journal →
 * self-improvement backlog items.
 *
 * Every `phm usage live` pass — one shot or `--watch` — runs
 * runLiveUsageTick (src/core/usage/live/engine.ts), which evaluates the
 * tick's lane/site readings through evaluateAlerts and appends one
 * {ts, level, subject, message, pct, resetAt} UsageAlert row per fired
 * alert to this append-only file under the bus directory
 * (<runs>/bus, mode 0600). The level vocabulary is closed:
 * 'cap-80' and 'cap-95' fire once per (subject, resetAt, level) for
 * eight days when a subscription lane or browser-extra allowance
 * reports >= 80% / >= 95% of its cap; 'expire-unspent' fires on the
 * same key when the burn projection says >= 25% of the allowance will
 * expire unused inside 24 hours; 'needs-signin' fires once per
 * (site, UTC day) when the dedicated usage browser lands on a
 * provider's sign-in page. pct is the recorded percentage (null for
 * needs-signin), resetAt the allowance window's reset instant (null
 * for needs-signin and for readings that carry none), and message is
 * free text this fold never surfaces — needs-signin messages embed
 * the provider's sign-in URL.
 *
 * Until now the journal had no reader at all: the only surfaces were
 * the command's own console print and usage-live-first-readings.md,
 * both point-in-time outputs of the pass that wrote them, so a
 * subscription that kept saturating window after window, a paid
 * allowance that kept expiring unspent, or a usage site that kept
 * losing its browser session never became work.
 * usageLiveAlertsBacklogItems carries the same rows into
 * discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items; a
 *    malformed line is skipped, never guessed.
 *  - Rows count only under the journal's own contract: ts parses to a
 *    finite instant, level is the writer's closed vocabulary,
 *    subject is a bounded identifier, pct is null or a finite
 *    percentage in [0, 100], and resetAt is null or a parseable
 *    instant — with the writer's own level pairing enforced
 *    (needs-signin always pct/resetAt null; cap and expire levels
 *    always a numeric pct). Foreign shapes are malformed, never
 *    folded. Undated or unparseable rows cannot exist under the
 *    contract; anything else is skipped.
 *  - Recurring means recorded across windows and days: a cap or
 *    expire cell emits only at USAGE_LIVE_ALERTS_MIN_ROWS in-window
 *    rows across USAGE_LIVE_ALERTS_MIN_DAYS distinct UTC days AND
 *    USAGE_LIVE_ALERTS_MIN_WINDOWS distinct resetAt instants — the
 *    writer's own dedupe key, so one saturated window re-alerted
 *    cannot mint a pattern by itself, while a subject that keeps
 *    hitting the wall in successive provider windows can. A
 *    needs-signin cell emits at the row/day bars alone: its resetAt
 *    is always null and the writer already fires it at most once
 *    per site per UTC day, so distinct days are the recurrence.
 *  - Every alert level is adverse evidence by construction — the
 *    writer only journals fired alerts, never healthy readings — so
 *    no level is filtered out as "designed"; the designed outcomes
 *    (a planned burst, an owner-only plan cap, a site that requires
 *    periodic re-auth) are named in NO_CHANGE instead.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's usage subscriptions and carries no repository column.
 *    Dedup is downstream: the item id hashes the cell identity,
 *    never counts or timestamps, so a refresh re-derives the same id
 *    and a recovered subject simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is subjects × four levels. */
export const USAGE_LIVE_ALERTS_BACKLOG_MAX_ITEMS = 12;
const USAGE_LIVE_ALERTS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const USAGE_LIVE_ALERTS_WINDOW_HOURS = 168;
/** A cap/expire cell emits only at this many in-window rows carrying its evidence... */
export const USAGE_LIVE_ALERTS_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days... */
export const USAGE_LIVE_ALERTS_MIN_DAYS = 2;
/** ...and at least this many distinct resetAt instants, so one saturated window re-alerted cannot mint a pattern. */
export const USAGE_LIVE_ALERTS_MIN_WINDOWS = 2;
/** Bounded no-follow tail; the writer never compacts, so the tail is the whole recent record. */
export const USAGE_LIVE_ALERTS_TAIL_BYTES = 512 * 1024;
/** The fleet's own repository label: usage-alert evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded subject strings are bounded identifiers; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** The writer's subjects are lane, budget-lane and site identifiers; control characters and oversized text reject the row. */
const MAX_SUBJECT_CHARS = 120;

export type UsageLiveAlertLevel = 'cap-80' | 'cap-95' | 'expire-unspent' | 'needs-signin';
const ALERT_LEVELS = new Set<string>(['cap-80', 'cap-95', 'expire-unspent', 'needs-signin']);

export interface UsageLiveAlertsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Journal override (default: join(runsDir, 'bus', 'usage-live-alerts.jsonl')). */
  journalPath?: string;
  /** Runs dir for the journal default; a non-empty absolute ASHLR_RUNS_DIR wins, else ~/.ashlr-runs — the CLI's own resolution. */
  runsDir?: string;
  /** Home for the ~/.ashlr-runs fallback; default homedir(). */
  homeDir?: string;
  /** Evidence window in hours (default USAGE_LIVE_ALERTS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default USAGE_LIVE_ALERTS_BACKLOG_MAX_ITEMS, hard-capped). */
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

/** The runs dir the CLI's own resolution picks: absolute ASHLR_RUNS_DIR, else ~/.ashlr-runs. */
function defaultRunsDir(homeDir: string): string {
  const env = process.env['ASHLR_RUNS_DIR'];
  if (env !== undefined && env !== '' && isAbsolute(env)) return env;
  return join(homeDir, '.ashlr-runs');
}

// ---------------------------------------------------------------------------
// Row contract — one UsageAlert exactly as runLiveUsageTick appends it
// ---------------------------------------------------------------------------

interface UsageAlertRow {
  tsMs: number;
  level: UsageLiveAlertLevel;
  subject: string;
  /** Recorded percentage; the writer always sets a number for cap/expire and null for needs-signin. */
  pct: number | null;
  /** Recorded reset instant in ms; null when the reading carried none (and always for needs-signin). */
  resetAtMs: number | null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function parseInstant(value: unknown, maxChars: number): number | null {
  if (!boundedString(value, maxChars)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Structural validation of one persisted row against the writer's
 * UsageAlert contract. Required fields must be present and well-formed;
 * the writer's level pairing is enforced (needs-signin always pct and
 * resetAt null; cap and expire levels always a numeric pct in [0, 100]
 * with resetAt null or a parseable instant). Returns null for a
 * corrupted or foreign row so the caller counts it malformed and skips
 * it rather than let damaged evidence masquerade as a real alert.
 * `message` is deliberately not validated or surfaced: it is free text
 * and needs-signin rows embed the provider's sign-in URL.
 */
function projectAlert(row: Record<string, unknown>): UsageAlertRow | null {
  const tsRaw = row['ts'];
  const tsMs = parseInstant(tsRaw, 64);
  const level = row['level'];
  const subject = row['subject'];
  const pct = row['pct'];
  const resetRaw = row['resetAt'];
  if (tsMs === null || typeof level !== 'string' || !ALERT_LEVELS.has(level)) return null;
  if (!boundedString(subject, MAX_SUBJECT_CHARS)) return null;
  if (level === 'needs-signin') {
    if (pct !== null || resetRaw !== null) return null;
    return { tsMs, level: level as UsageLiveAlertLevel, subject, pct: null, resetAtMs: null };
  }
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (resetRaw !== null) {
    const resetAtMs = parseInstant(resetRaw, 64);
    if (resetAtMs === null) return null;
    return { tsMs, level: level as UsageLiveAlertLevel, subject, pct, resetAtMs };
  }
  return { tsMs, level: level as UsageLiveAlertLevel, subject, pct, resetAtMs: null };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-cell in-window fold before the recurring bars apply. */
export interface UsageLiveAlertCellFold {
  level: UsageLiveAlertLevel;
  subject: string;
  /** In-window rows for this (level, subject). */
  rows: number;
  /** Distinct UTC days. */
  days: Set<string>;
  /** Distinct resetAt instants — each is a different allowance window (needs-signin never contributes). */
  windows: Set<number>;
  /** Highest pct any contributing row recorded (null for needs-signin). */
  maxPct: number | null;
  firstMs: number | null;
  lastMs: number | null;
}

export interface UsageLiveAlertsFold {
  /** In-window parsed alert rows — the share denominator the prompts quote. */
  alerts: number;
  cells: Map<string, UsageLiveAlertCellFold>;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
  /** Parsed rows outside the window or beyond the future-skew tolerance. */
  outsideWindow: number;
}

const touch = (cell: { firstMs: number | null; lastMs: number | null }, atMs: number): void => {
  cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
  cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
};

/**
 * Pure: fold journal text(s) — oldest first — into per-cell recurring
 * alert evidence. Lines that fail the writer's row contract, and rows
 * outside the window, are skipped, never guessed.
 */
export function foldUsageLiveAlerts(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): UsageLiveAlertsFold {
  const fold: UsageLiveAlertsFold = { alerts: 0, cells: new Map(), malformed: 0, outsideWindow: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fold.malformed++;
        continue;
      }
      const alert = projectAlert(parsed as Record<string, unknown>);
      if (alert === null) { fold.malformed++; continue; }
      if (alert.tsMs < since || alert.tsMs > until) { fold.outsideWindow++; continue; }
      fold.alerts += 1;
      const key = `${alert.level}|${alert.subject}`;
      let cell = fold.cells.get(key);
      if (cell === undefined) {
        cell = { level: alert.level, subject: alert.subject, rows: 0, days: new Set(), windows: new Set(), maxPct: null, firstMs: null, lastMs: null };
        fold.cells.set(key, cell);
      }
      cell.rows += 1;
      cell.days.add(dayOf(alert.tsMs));
      if (alert.resetAtMs !== null) cell.windows.add(alert.resetAtMs);
      cell.maxPct = alert.pct === null ? cell.maxPct : Math.max(cell.maxPct ?? alert.pct, alert.pct);
      touch(cell, alert.tsMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageLiveAlertCell {
  kind: 'usage-live-alert';
  level: UsageLiveAlertLevel;
  subject: string;
  /** In-window rows carrying the cell's evidence. */
  rows: number;
  /** Distinct resetAt instants across those rows (0 for needs-signin, whose resetAt is always null). */
  windows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** In-window parsed alert rows overall — the share denominator. */
  alerts: number;
  /** Highest pct any contributing row recorded (null for needs-signin). */
  maxPct: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * The recurring bars one cell must clear. Cap and expire levels need
 * rows, days AND distinct reset windows — the writer's own dedupe key —
 * so one saturated window re-alerted after its eight-day dedupe expiry
 * cannot mint a pattern; needs-signin needs rows and days only, since
 * its resetAt is always null and the writer already fires it at most
 * once per site per UTC day.
 */
function recurring(cell: UsageLiveAlertCellFold): boolean {
  if (cell.rows < USAGE_LIVE_ALERTS_MIN_ROWS || cell.days.size < USAGE_LIVE_ALERTS_MIN_DAYS) return false;
  if (cell.level === 'needs-signin') return true;
  return cell.windows.size >= USAGE_LIVE_ALERTS_MIN_WINDOWS;
}

/** Emission order: the wall hit first, wasted paid capacity next, sustained pressure, then session friction. */
const LEVEL_RANK: Record<UsageLiveAlertLevel, number> = {
  'cap-95': 0,
  'expire-unspent': 1,
  'cap-80': 2,
  'needs-signin': 3,
};

/**
 * Pure: recurring cells — a (level, subject) group at the row/day/window
 * bars. Sharper levels sort first, then row count.
 */
export function usageLiveAlertCells(fold: UsageLiveAlertsFold, lowerBound = false): UsageLiveAlertCell[] {
  const cells: UsageLiveAlertCell[] = [];
  for (const cell of fold.cells.values()) {
    if (!recurring(cell)) continue;
    cells.push({
      kind: 'usage-live-alert',
      level: cell.level,
      subject: cell.subject,
      rows: cell.rows,
      windows: cell.windows.size,
      days: [...cell.days].sort(),
      alerts: fold.alerts,
      maxPct: cell.maxPct,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || b.rows - a.rows || `${a.level}|${a.subject}`.localeCompare(`${b.level}|${b.subject}`));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/bus/usage-live-alerts.jsonl — busDir in src/cli/usage-live.ts resolves <runs>/bus (an absolute ASHLR_RUNS_DIR wins, else ~/.ashlr-runs) — one {ts, level, subject, message, pct, resetAt} UsageAlert row per alert runLiveUsageTick (src/core/usage/live/engine.ts) fires on every `phm usage live` pass, deduped per (subject, resetAt, level) for eight days on the cap and expire levels and per (site, UTC day) on needs-signin. Until now the journal had no reader at all: the only surfaces were the command\'s own console print and usage-live-first-readings.md, both point-in-time outputs of the pass that wrote them, so a subscription that kept saturating, a paid allowance that kept expiring unspent, or a usage site that kept losing its browser session never became work.';

const REPRO = 'Reproduce the fold by reading <runs dir>/bus/usage-live-alerts.jsonl directly, keeping rows whose ts lands inside the window, grouping by (level, subject), and counting distinct UTC days and distinct resetAt instants (cap and expire levels only — needs-signin rows always carry resetAt null). The writer, alert evaluation and dedupe this repository owns are src/core/usage/live/engine.ts (runLiveUsageTick, evaluateAlerts) and src/cli/usage-live.ts.';

const NO_CHANGE = 'If `phm usage live` only runs on demand the journal is a sparse sample rather than a continuous record; if the pressure was a planned concentrated run that has since ended, the subject\'s provider plan cap is the binding constraint — plan changes are owner-only — the site requires periodic re-auth by design, the allowance genuinely exceeds demand so the plan is oversized (resizing is owner-only), or the readings behind the alerts were themselves wrong — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: UsageLiveAlertCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: UsageLiveAlertCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: UsageLiveAlertCell): string =>
  cell.alerts > 0 ? ` (${Math.round((cell.rows / cell.alerts) * 100)}% of the ${cell.alerts} in-window alert rows)` : '';

const pctText = (cell: UsageLiveAlertCell): string =>
  cell.maxPct === null ? '' : ` Peak recorded ${Math.round(cell.maxPct * 10) / 10}%.`;

function capClaim(level: UsageLiveAlertLevel): string {
  return level === 'cap-95'
    ? 'at or above 95% of its allowance cap — the provider reports the window effectively consumed, so that subscription cannot take more fleet work'
    : 'at or above 80% of its allowance cap — sustained pressure below the wall, the level the fleet would rather route around before it becomes a refusal';
}

function usageLiveAlertPrompt(cell: UsageLiveAlertCell): string {
  const subject = fieldText(cell.subject, MAX_NAME_CHARS);
  const windowsText = cell.level === 'needs-signin'
    ? ''
    : ` across ${cell.windows} distinct reset window(s)`;
  const headline = cell.level === 'cap-95'
    ? `Phantom's usage-live alert journal keeps recording '${subject}' at its cap`
    : cell.level === 'cap-80'
      ? `Phantom's usage-live alert journal keeps recording '${subject}' near its cap`
      : cell.level === 'expire-unspent'
        ? `Phantom's usage-live alert journal keeps recording '${subject}' expiring with paid allowance unspent`
        : `Phantom's usage browser keeps landing on '${subject}'s sign-in page`;
  const claim = cell.level === 'cap-95' || cell.level === 'cap-80'
    ? capClaim(cell.level)
    : cell.level === 'expire-unspent'
      ? 'projected to expire with at least 25% of the allowance unspent inside 24 hours — paid capacity the fleet is paying for and not using'
      : 'the dedicated usage browser reaches the provider\'s sign-in page instead of a readable usage page, so that site\'s allowance goes unmeasured until someone signs in again';
  const detail = [
    headline,
    '',
    `${cell.rows} alert row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)})${windowsText} for '${subject}' — the self-improvement work this backlog exists for.`,
    '',
    `Each row is one alert a \`phm usage live\` tick fired: '${subject}' was ${claim}.${pctText(cell)}${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    cell.level === 'needs-signin'
      ? `Find why the usage browser keeps losing '${subject}'s session: check the dedicated profile's persistence and launch path in src/core/usage/live/browser.ts and src/core/usage/live/sites.ts, whether the provider expires sessions on a schedule only a fresh human sign-in resets, and whether the profile directory is being recreated or cleaned between passes. The sign-in itself is a human step — name it rather than working around it; what lives here is whether the fleet should detect the loss earlier, mark the site's readings stale honestly, or stop paying browser passes for a session that cannot hold.`
      : cell.level === 'expire-unspent'
        ? `Find why '${subject}' keeps projecting paid allowance to expire unused: compare the alert pct and reset window against the budget block the same tick writes (<runs>/queue/usage-live-budget.json) and the burn-rate estimate feeding the projection in src/core/usage/live/engine.ts, then check whether routing keeps preferring other seats while this allowance sits idle (src/core/routing), whether the projection misreads a window that already rolled, or whether the plan is simply oversized for the fleet's demand — resizing is owner-only. Fix what lives here — the projection, the seat preference order, or the evidence path feeding the reading.`
        : `Find why '${subject}' keeps reporting ${cell.level === 'cap-95' ? 'at least 95%' : 'at least 80%'} of its cap: compare the recorded pct against the budget block the same tick writes (<runs>/queue/usage-live-budget.json) and the capacity snapshot (~/.ashlr/routing/capacity.json), then check whether the fleet keeps scheduling onto one subscription instead of spreading across seats with headroom (src/core/routing), whether the seat policies or budget overrides keep preferring the saturated lane, or whether the provider plan's cap is simply the binding constraint — plan changes are owner-only, so name them rather than working around them. Fix what lives here — the capacity snapshot producer, the routing preference order in src/core/routing, or the evidence path that feeds the snapshot.`,
    '',
    NO_CHANGE,
    '',
    REPRO,
  ];
  return detail.join('\n');
}

function usageLiveAlertTitle(cell: UsageLiveAlertCell): string {
  const subject = fieldText(cell.subject, MAX_NAME_CHARS);
  switch (cell.level) {
    case 'cap-95': return `Usage '${subject}' keeps hitting its cap`.slice(0, MAX_TITLE_CHARS);
    case 'cap-80': return `Usage '${subject}' keeps running near its cap`.slice(0, MAX_TITLE_CHARS);
    case 'expire-unspent': return `Usage '${subject}' keeps expiring with allowance unspent`.slice(0, MAX_TITLE_CHARS);
    case 'needs-signin': return `Usage site '${subject}' keeps needing sign-in`.slice(0, MAX_TITLE_CHARS);
  }
}

function usageLiveAlertArea(cell: UsageLiveAlertCell): string {
  switch (cell.level) {
    case 'cap-95':
    case 'cap-80': return 'usage-live-cap';
    case 'expire-unspent': return 'usage-live-expire';
    case 'needs-signin': return 'usage-live-signin';
  }
}

function usageLiveAlertItem(cell: UsageLiveAlertCell, repo: string): CloudBacklogItem {
  return {
    id: `usage-live-${sha(`${cell.level}|${cell.subject}`)}`,
    title: usageLiveAlertTitle(cell),
    prompt: usageLiveAlertPrompt(cell),
    area: usageLiveAlertArea(cell),
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the usage-live alert journal's recurring evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function usageLiveAlertsBacklogItems(opts: UsageLiveAlertsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? USAGE_LIVE_ALERTS_WINDOW_HOURS;
    const homeDir = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? defaultRunsDir(homeDir);
    const journalPath = opts.journalPath ?? join(runsDir, 'bus', 'usage-live-alerts.jsonl');
    const read = await readLedgerTail(journalPath, USAGE_LIVE_ALERTS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so the tail folds whole.
    const fold = foldUsageLiveAlerts([read.text], nowMs, windowHours);
    if (fold.alerts === 0) return [];
    const cells = usageLiveAlertCells(fold, read.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? USAGE_LIVE_ALERTS_BACKLOG_MAX_ITEMS, USAGE_LIVE_ALERTS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => usageLiveAlertItem(cell, repo));
  } catch {
    return [];
  }
}
