/**
 * Backoff-skip receipts → self-improvement backlog items.
 *
 * dispatchd's two wall scanners — ab_scan (usage/quota patterns) and
 * ab_auth_scan (auth-failure streaks) in contrib/mac/dispatchd.py —
 * record a different kind of provider-wall evidence than the hold
 * receipts: when a finished job's fresh log tail matches a provider
 * wall pattern, ab_run() must prove whether the run produced work
 * before the lane can be held, and that proof runs through the pinned
 * git-safe helper (~/.ashlr-runs/bin/git-safe-env.sh). When ab_gs_ok()
 * fails — the helper is missing, not a regular file, a symlink, or its
 * sha256 no longer matches the GITSAFE_SHA compiled into dispatchd —
 * the outcome stays unknown and the scanner deliberately places NO
 * hold: it appends one receipt instead:
 *
 *   - `autobackoff_skip` rows: one per job whose usage-limit scan hit
 *     helper_unavailable (the .autobackoff.seen marker caps the job at
 *     one row ever), carrying lane, job, the matched pattern id and
 *     src 'helper_unavailable'.
 *   - `authbackoff_skip` rows: the auth-failure scan's same verdict on
 *     the same check — the job's .authfail.seen verdict is never
 *     written, so the row can repeat while the job's log stays fresh.
 *
 * Until now these receipts had no named reader at all: the friction
 * fold adds them to its quota-exhaustion and auth-failures totals as
 * silent counts with no evidence lines, the router outcome fold
 * excludes them by design (they record no verdict and never join),
 * and the incident gate borrows them only for lane-error signatures —
 * so a fleet whose wall protection was persistently disarmed looked
 * like ordinary provider churn. Every skip row is a detected wall that
 * left its lane running: the fleet keeps dispatching into quota- or
 * auth-walled capacity while the hold machinery that exists for
 * exactly this case stays off. backoffSkipBacklogItems carries the
 * same tail into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing, unreadable or non-file ledger yields no
 *    items; a truncated tail is stated as a lower bound.
 *  - Rows count only under the writer's contract: the two skip event
 *    names across the event|type|kind alias set, src 'helper_unavailable'
 *    (the only skip path that writes a metric row — a different src is
 *    a different signal this feed does not claim), a lane inside the
 *    bounded lane-id shape, a job id inside the ledger's own id shape,
 *    and a pattern id inside the producer's closed per-family
 *    vocabulary mirrored from AB_RX/AB_AUTH_RX — a row that cannot
 *    name its job or whose signal is not the recorded one never
 *    counts. Malformed JSON lines are skipped, never guessed.
 *  - Recurring means recorded across distinct jobs and days: a cell
 *    emits only at BACKOFF_SKIP_MIN_JOBS distinct job ids across
 *    BACKOFF_SKIP_MIN_DAYS distinct UTC days inside the window, so
 *    one unlucky job's repeated auth-scan rows and one bad day never
 *    queue a session.
 *  - Fleet machinery only: jobs.jsonl describes this install's
 *    dispatch machinery and carries no per-job repository column, so
 *    items emit only when the backlog target's repository name is
 *    'phantom' — the same last-segment rule the sibling fleet-evidence
 *    sources apply.
 *  - Dedup is downstream: the item id hashes the cell identity
 *    (family, lane, pattern — never counts or timestamps), so a
 *    refresh re-derives the same id and a recovered cell simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerAtMs, ledgerEventName, ledgerJobId, ledgerLane } from '../fleet/empty-cause.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by lane x closed-vocabulary diversity. */
export const BACKOFF_SKIP_MAX_ITEMS = 10;
const BACKOFF_SKIP_ITEM_HARD_MAX = 25;
/** A cell emits only at this many distinct job ids inside the window... */
export const BACKOFF_SKIP_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const BACKOFF_SKIP_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const BACKOFF_SKIP_WINDOW_HOURS = 168;
/** Newest-bytes bound retained from the append-only jobs ledger — the same tail the sibling jobs-ledger feeds read. */
export const BACKOFF_SKIP_LEDGER_LIMIT = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: backoff-skip evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Lane identifiers the producer writes — the same bounded shape outcomes.ts applies to wall lanes. */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** The job-id shape a row must carry to be attributable; a looser prompt-safe shape gates quoting. */
const LEDGER_JOB_ID = /^[A-Za-z0-9._-]{1,90}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * The two skip event names, mapped to their scanner families. Both
 * write through the same ab_run() helper check; they stay separate
 * cells because the usage/quota and auth wall families fail and
 * recover differently.
 */
const SKIP_FAMILIES: Readonly<Record<string, 'usage' | 'auth'>> = {
  autobackoff_skip: 'usage',
  authbackoff_skip: 'auth',
};
/**
 * The producers' closed pattern vocabularies, mirrored from the
 * pinned tables (contrib/mac/dispatchd.py): AB_RX's usage/quota
 * pattern ids for autobackoff_skip and AB_AUTH_RX's auth-failure ids
 * for authbackoff_skip. A pattern outside its family's set is not a
 * receipt this feed recognizes.
 */
const USAGE_PATTERNS: ReadonlySet<string> = new Set([
  'codex_usage_limit', 'codex_credits_exhausted', 'codex_rate_limit_429',
  'claude_usage_limit', 'claude_rate_limit_error', 'claude_credit_balance', 'claude_oauth_expired',
  'devin_acu_exhausted', 'devin_usage_limit', 'devin_weekly_quota',
]);
const AUTH_PATTERNS: ReadonlySet<string> = new Set([
  'codex_auth_failure', 'devin_auth_failure',
  'claude_auth_401', 'claude_not_logged_in', 'claude_auth_error',
]);
/** The only src value the producers' skip paths write — helper_unavailable is the row's whole meaning. */
const SKIP_SRC = 'helper_unavailable';
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLE_JOBS = 3;

export interface BackoffSkipItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default BACKOFF_SKIP_WINDOW_HOURS). */
  windowHours?: number;
  /** Newest-bytes bound on the jobs-ledger tail (default BACKOFF_SKIP_LEDGER_LIMIT). */
  ledgerLimit?: number;
  /** Most items one call emits (default BACKOFF_SKIP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One recurring backoff-skip cell: a (family, lane, pattern) group of distinct jobs. */
export interface BackoffSkipCell {
  /** 'usage' for autobackoff_skip rows, 'auth' for authbackoff_skip rows. */
  family: 'usage' | 'auth';
  /** The recorded event name ('autobackoff_skip' or 'authbackoff_skip'). */
  event: string;
  /** Bounded lane identifier the producer recorded. */
  lane: string;
  /** The closed-vocabulary pattern id the scanner matched. */
  pattern: string;
  /** Distinct job ids inside the window — the recurring count. */
  jobs: number;
  /** Distinct UTC days the cell's rows span inside the window. */
  days: number;
  /** Total valid rows folded into the cell. */
  rows: number;
  /** Up to MAX_EXAMPLE_JOBS prompt-safe job ids. */
  examples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface SkipRow {
  family: 'usage' | 'auth';
  event: string;
  lane: string;
  pattern: string;
  job: string;
}

/**
 * Validate one ledger row under the producer's contract. Returns null
 * when the row is not a usable backoff-skip receipt: the event name
 * must resolve through the shared dialect to one of the two skip
 * names, src must be 'helper_unavailable' (the only skip path that
 * writes a metric row), the lane must sit inside the bounded lane-id
 * shape, the job inside the ledger's id shape, and the pattern inside
 * its family's closed vocabulary. The timestamp placement is the
 * caller's window check.
 */
function parseSkipRow(row: Record<string, unknown>): SkipRow | null {
  const event = ledgerEventName(row);
  const family = event === null ? undefined : SKIP_FAMILIES[event];
  if (family === undefined || event === null) return null;
  if (row['src'] !== SKIP_SRC) return null;
  const lane = ledgerLane(row);
  const job = ledgerJobId(row);
  if (lane === null || !LANE.test(lane) || job === null || !LEDGER_JOB_ID.test(job)) return null;
  const pattern = row['pattern'];
  if (typeof pattern !== 'string') return null;
  const vocabulary = family === 'usage' ? USAGE_PATTERNS : AUTH_PATTERNS;
  if (!vocabulary.has(pattern)) return null;
  return { family, event, lane, pattern, job };
}

/**
 * Pure: fold jobs.jsonl text into per-(family, lane, pattern) cells.
 * Rows are validated under the producer's contract; rows whose
 * timestamp cannot be placed inside [nowMs - windowMs, nowMs] never
 * reach a cell. `jobs` is distinct job ids — the recurring measure —
 * while `rows` keeps the raw record count.
 */
export function foldBackoffSkipCells(text: string, nowMs: number, windowMs: number): BackoffSkipCell[] {
  const cells = new Map<string, {
    family: 'usage' | 'auth';
    event: string;
    lane: string;
    pattern: string;
    jobIds: Set<string>;
    rows: number;
    days: Set<string>;
    examples: string[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Cheap prefilter: the two skip events are a minority of rows.
    if (!line.includes('"autobackoff_skip"') && !line.includes('"authbackoff_skip"')) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const parsed = parseSkipRow(row);
    if (parsed === null) continue;
    const ms = ledgerAtMs(row);
    if (ms === null || ms > nowMs || ms < nowMs - windowMs) continue;
    const key = `${parsed.family}:${parsed.lane}:${parsed.pattern}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { family: parsed.family, event: parsed.event, lane: parsed.lane, pattern: parsed.pattern,
        jobIds: new Set(), rows: 0, days: new Set(), examples: [], firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.jobIds.add(parsed.job);
    cell.days.add(dayOf(ms));
    if (SAFE_JOB_ID.test(parsed.job)
        && cell.examples.length < MAX_EXAMPLE_JOBS && !cell.examples.includes(parsed.job)) {
      cell.examples.push(parsed.job);
    }
    cell.firstMs = cell.firstMs === null ? ms : Math.min(cell.firstMs, ms);
    cell.lastMs = cell.lastMs === null ? ms : Math.max(cell.lastMs, ms);
  }
  return [...cells.values()]
    .map((cell) => ({
      family: cell.family,
      event: cell.event,
      lane: cell.lane,
      pattern: cell.pattern,
      jobs: cell.jobIds.size,
      days: cell.days.size,
      rows: cell.rows,
      examples: cell.examples,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.family.localeCompare(b.family) || a.lane.localeCompare(b.lane) || a.pattern.localeCompare(b.pattern));
}

const NO_CHANGE = 'If the window has rolled forward, the skips were a transient host state that has since verified clean, the recorded walls trace to deliberate operator state (credentials mid-rotation, a maintenance pause, a quota window that reset) or owner-only causes — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the pinned boundary and the folding commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd appends autobackoff_skip rows (one per job, capped by the .autobackoff.seen marker) and authbackoff_skip rows (the auth scan writes no verdict marker on this path, so they can repeat while the job log stays fresh) through the same metric() path every other job receipt takes, always with src \'helper_unavailable\'. The scanners and the pin check are ab_scan, ab_auth_scan, ab_run and ab_gs_ok in contrib/mac/dispatchd.py — GITSAFE names the pinned helper path and GITSAFE_SHA its expected sha256; the canonical helper source is contrib/mac/git-safe-env.sh. Those files are pinned, Security-reviewed ops machinery agents never edit live, and the pin check itself is a GATES-v3 boundary: a sha256 mismatch can also mean the host file was tampered with, which is a security finding to report — never something to weaken, bypass or re-pin from a session.';

const FAMILY_TEXT: Record<BackoffSkipCell['family'], { what: string; hunt: string }> = {
  usage: {
    what: 'usage/quota wall detections the backoff scan could not verify',
    hunt: 'whether autobackoff_hold rows still land beside the skips (intermittent helper failures) or stopped entirely while walls continue (protection fully down), whether the skips cluster on one lane or spread across every lane the helper guards, and whether this repository\'s quota evidence, lane placement or job shapes should respond to walls that currently hold nothing',
  },
  auth: {
    what: 'auth-failure streak detections the backoff scan could not verify',
    hunt: 'whether the same helper check also starves the auth streak\'s two-failure bar (no .authfail.seen verdict is ever written on this path, so the streak can never accumulate), whether authbackoff_hold rows still land beside the skips, and whether this repository\'s lane placement or credential-health evidence should surface the unverifiable streak earlier',
  },
};

function seenText(cell: BackoffSkipCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function examplesText(cell: BackoffSkipCell): string {
  return cell.examples.length === 0 ? '' : ` Example job ids: ${cell.examples.join(', ')}.`;
}

function skipPrompt(cell: BackoffSkipCell, truncated: boolean): string {
  const family = FAMILY_TEXT[cell.family];
  return [
    `Phantom's dispatcher keeps recording ${cell.family === 'usage' ? 'usage/quota' : 'auth-failure'} walls it cannot verify on lane '${cell.lane}' — ${cell.jobs} distinct job(s) across the window (${cell.rows} recorded ${cell.event} row(s), pattern '${cell.pattern}'), the self-improvement work this backlog exists for.`,
    '',
    `Each row is dispatchd's own verdict that protection was needed but could not be confirmed: the wall scanner matched a provider ${cell.family === 'usage' ? 'usage-limit' : 'authentication-failure'} pattern in a finished job's fresh log tail, then ab_run() needed the pinned git-safe helper to prove whether the run produced work — and ab_gs_ok() failed its checks (the helper missing, not a regular file, a symlink, or a sha256 that no longer matches GITSAFE_SHA), so the outcome stayed unknown and NO lane hold was placed. Every skip row is a detected wall that left its lane running: the fleet keeps dispatching into walled capacity while the hold machinery built for exactly this case stays disarmed.${seenText(cell)}${examplesText(cell)}`,
    '',
    EVIDENCE,
    '',
    ...(truncated ? ['The jobs-ledger read is a bounded newest-bytes tail, so these counts are a lower bound — older skips may exist beyond the retained window.', ''] : []),
    `Find which side owns the cause: ${family.hunt}. Fix what lives here — for example a skip-aware reader that names the degraded protection path the way this backlog item does, hold receipts that carry the skip cause so a walled lane is visible before the next launch, or quota/credential evidence readers in src/ that should distrust unverifiable wall verdicts. If the pinned helper verifies clean now, GITSAFE_SHA in contrib/mac/dispatchd.py is stale against the canonical contrib/mac/git-safe-env.sh (a source change this repository can prepare — the live install still needs Security review and re-pin), the host file drifted or was tampered with (a Security matter — report it, never re-pin or weaken the check from a session), or the cause is owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function backoffSkipItem(cell: BackoffSkipCell, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `fleet-backoff-skip-${createHash('sha256').update(`backoff-skip:${cell.family}:${cell.lane}:${cell.pattern}`).digest('hex').slice(0, 16)}`;
  const title = (cell.family === 'usage'
    ? `Usage-limit walls keep going unheld on lane '${cell.lane}'`
    : `Auth-failure walls keep going unheld on lane '${cell.lane}'`)
    .slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: skipPrompt(cell, truncated),
    area: 'backoff-skips',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring backoff-skip cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function backoffSkipBacklogItems(opts: BackoffSkipItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling jobs-ledger feeds apply: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const read = await readLedgerTail(jobsPath, opts.ledgerLimit ?? BACKOFF_SKIP_LEDGER_LIMIT);
    if (read.state !== 'read') return [];
    const windowMs = (opts.windowHours ?? BACKOFF_SKIP_WINDOW_HOURS) * 3_600_000;
    const cells = foldBackoffSkipCells(read.text, nowMs, windowMs)
      .filter((cell) => cell.jobs >= BACKOFF_SKIP_MIN_JOBS && cell.days >= BACKOFF_SKIP_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? BACKOFF_SKIP_MAX_ITEMS, BACKOFF_SKIP_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => backoffSkipItem(cell, repo, read.truncated));
  } catch {
    return [];
  }
}
