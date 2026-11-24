/**
 * jobs.jsonl finish-row usage capture → self-improvement backlog items.
 *
 * Every dispatchd finish row carries the usage block the lane already
 * reports — claude and claude-api result JSON usage, devin's sessions.db
 * tokens + billed ACUs, the 'tokens used' log line — flattened by
 * job_usage() (contrib/mac/dispatchd.py) into tokens_total/acus plus two
 * provenance labels: usage_source names the measurement path that
 * supplied the block (devin-sessions-db / claude-result-json /
 * tokens-line) and usage_missing names why usage stayed unknowable
 * (devin-session-db-missing, devin-session-db-unreadable,
 * devin-no-session-for-worktree, devin-usage-incomplete,
 * devin-usage-not-reported, claude-usage-incomplete,
 * claude-result-not-in-log, tokens-line-not-in-log — dispatchd's closed
 * vocabulary today; the router fold records whatever bounded label a
 * producer wrote rather than second-guessing it). The labels exist so
 * every downstream consumer can keep missing usage unknown rather than
 * zero — but until now the only readers were `phm fleet
 * router-weights`'s coverage tallies and `phm router outcomes`'s
 * per-job fields, reports someone had to run and read. A capture path
 * that keeps failing — a sessions.db the reader can no longer open, a
 * result JSON shape that drifted, a tokens line the log format stopped
 * printing — silently starves the router's weight evidence, calibration
 * and cost joins while looking like ordinary absent data.
 * usageGapBacklogItems carries the same rows into discoverBacklog: a
 * usage_missing label that keeps recurring across distinct jobs and UTC
 * days is self-diagnosed improvement work that never became a backlog
 * item.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail — the same ROUTER_OUTCOME_LEDGER_LIMIT
 *    window the router outcome fold reads — plus one jobTimelines pass
 *    over the same text for lane/repo attribution; nothing is written
 *    and no network is touched. A missing or unreadable file yields no
 *    items.
 *  - Rows count only under the jobs-ledger dialect: JSON objects with a
 *    bounded job id (job|job_id|jobId|id), the 'finish' lifecycle event
 *    across event|type|kind, and a usage_missing label inside the
 *    router fold's own bounded-label shape (snake_case before
 *    camelCase). Node-pool producer schemas, malformed lines and every
 *    other event are skipped, never guessed.
 *  - The standing finish stands: each job collapses to its newest
 *    finish row in the tail — dispatchd writes the full usage block on
 *    every finish, so the newest row's usage_missing IS the job's
 *    current capture state; a retry whose later finish captured usage
 *    is evidence the gap closed, not that it persists (the router
 *    outcome fold's any-row sticky join answers a different question:
 *    what the job's outcome should record). The standing row's
 *    timestamp must land inside the window — an undated or
 *    future-dated standing finish contributes nothing.
 *  - Recurring means recorded across days: a label cell emits only at
 *    USAGE_GAP_MIN_JOBS distinct jobs across USAGE_GAP_MIN_DAYS
 *    distinct UTC days inside the 7-day window — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply.
 *  - Attribution degrades, never suppresses: lane prefers the finish
 *    row's own lane|pool|arm then the jobs ledger's timeline, repo
 *    joins the same timeline's recorded repo — both fall back to
 *    'unknown'/'unattributed' rather than dropping the gap evidence.
 *  - Truncation is stated, never hidden: when the bounded tail cut
 *    older rows, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the capture paths are this
 *    install's dispatcher and lanes. Dedup is downstream: the item id
 *    hashes the label identity, never counts or timestamps, so a
 *    refresh re-derives the same id and a recovered label simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerEventName, ledgerJobId, ledgerLane, ledgerPhase } from '../fleet/empty-cause.js';
import { isNodePoolLedgerRow, ledgerEventTs } from '../fleet/jobs-ledger-dialect.js';
import { jobTimelines, type JobTimeline } from '../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; usage_missing labels are a small closed vocabulary. */
export const USAGE_GAP_BACKLOG_MAX_ITEMS = 10;
const USAGE_GAP_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const USAGE_GAP_WINDOW_HOURS = 168;
/** A label cell emits only at the fleet's recurring bar of distinct jobs... */
export const USAGE_GAP_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const USAGE_GAP_MIN_DAYS = 2;
/**
 * Bounded tail of the append-only jobs ledger — the same
 * ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome fold reads, so
 * the backlog sees exactly the evidence `phm router outcomes` and
 * `phm fleet router-weights` fold; prompts state any truncation as a
 * lower bound.
 */
const USAGE_GAP_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: usage-capture evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Job ids name log files; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** usage_missing labels join in the router fold's own bounded identifier shape (its private LEDGER_LABEL). */
const USAGE_LABEL = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Lane/repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted inside one prompt. */
const MAX_EXAMPLES = 3;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface UsageGapItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default USAGE_GAP_WINDOW_HOURS). */
  windowHours?: number;
  /** Ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default USAGE_GAP_BACKLOG_MAX_ITEMS, hard-capped). */
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

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — one pass over the jobs-ledger tail
// ---------------------------------------------------------------------------

/** A job's standing finish: its newest in-tail finish row's timestamp, usage label and lane. */
interface StandingFinish {
  atMs: number | null;
  label: string | null;
  lane: string | null;
}

/** Per-label in-window fold before the recurring bars apply. */
export interface UsageGapLabelFold {
  label: string;
  /** Distinct jobs whose standing finish recorded this label (each job contributes once by construction). */
  jobs: Set<string>;
  /** Distinct UTC days the standing finishes landed on. */
  days: Set<string>;
  /** Lane tallies across the cell's jobs ('unknown' when nothing recorded a lane). */
  lanes: Map<string, number>;
  /** Repo tallies across the cell's jobs ('unattributed' when the ledger named none). */
  repos: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface UsageGapFold {
  /** Distinct jobs whose newest in-tail finish row landed inside the window — the share denominator. */
  finishes: number;
  /** usage_missing label → in-window fold, keyed by the recorded label verbatim. */
  gaps: Map<string, UsageGapLabelFold>;
  /** Non-blank lines carrying the finish marker that were not JSON objects. */
  malformed: number;
}

/** The usage_missing label a finish row recorded, in the router fold's bounded shape; snake_case before camelCase. */
function usageMissingLabel(row: Record<string, unknown>): string | null {
  for (const key of ['usage_missing', 'usageMissing'] as const) {
    const value = row[key];
    if (typeof value === 'string' && USAGE_LABEL.test(value)) return value;
  }
  return null;
}

/**
 * Pure: fold one jobs-ledger tail into per-label usage-capture gaps.
 * Each job collapses to its newest finish row in file order (the
 * append-only ledger's standing record); rows outside the window,
 * undated standing finishes, malformed JSON, wrong event names,
 * node-pool producer schemas and unsafe job ids are skipped, never
 * guessed. `timelines` is the same tail's jobTimelines fold — lane/repo
 * enrichment that degrades to 'unknown'/'unattributed' when absent.
 */
export function foldUsageGapJournal(
  text: string,
  nowMs: number,
  windowHours: number,
  timelines: ReadonlyMap<string, Pick<JobTimeline, 'lane' | 'repo'>> = new Map(),
): UsageGapFold {
  const fold: UsageGapFold = { finishes: 0, gaps: new Map(), malformed: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  const standing = new Map<string, StandingFinish>();
  for (const line of text.split('\n')) {
    // Cheap prefilter: finish rows are a minority of the ledger's rows.
    if (!line.includes('finish')) continue;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { fold.malformed++; continue; }
    if (!isRecord(row)) { fold.malformed++; continue; }
    if (isNodePoolLedgerRow(row)) continue;
    if (ledgerEventName(row) !== 'finish') continue;
    const job = ledgerJobId(row);
    if (job === null || !SAFE_JOB_ID.test(job)) continue;
    standing.set(job, {
      atMs: ledgerEventTs(row, ledgerPhase(row)),
      label: usageMissingLabel(row),
      lane: ledgerLane(row),
    });
  }
  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const [job, finish] of standing) {
    if (finish.atMs === null || finish.atMs < since || finish.atMs > until) continue;
    fold.finishes += 1;
    if (finish.label === null) continue;
    let cell = fold.gaps.get(finish.label);
    if (cell === undefined) {
      cell = { label: finish.label, jobs: new Set(), days: new Set(), lanes: new Map(), repos: new Map(), firstMs: null, lastMs: null };
      fold.gaps.set(finish.label, cell);
    }
    cell.jobs.add(job);
    cell.days.add(dayOf(finish.atMs));
    cell.firstMs = cell.firstMs === null ? finish.atMs : Math.min(cell.firstMs, finish.atMs);
    cell.lastMs = cell.lastMs === null ? finish.atMs : Math.max(cell.lastMs, finish.atMs);
    const timeline = timelines.get(job);
    const lane = finish.lane ?? timeline?.lane ?? null;
    bump(cell.lanes, lane === null || lane.trim() === '' ? 'unknown' : fieldText(lane, MAX_NAME_CHARS) || 'unknown');
    const repo = timeline?.repo ?? null;
    bump(cell.repos, repo === null || repo.trim() === '' ? 'unattributed' : fieldText(repo, MAX_NAME_CHARS) || 'unattributed');
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface UsageGapTally {
  /** Sanitized recorded text (a lane or repo label). */
  text: string;
  count: number;
}

/** One emitted usage_missing cell: the recurring-bar-passing label plus the recorded detail the prompt quotes. */
export interface UsageGapCell {
  /** The recorded usage_missing label, verbatim. */
  label: string;
  /** Distinct jobs whose standing finish recorded this label inside the window. */
  jobs: number;
  /** Up to MAX_EXAMPLES fleet-shaped job ids. */
  examples: string[];
  /** Sorted distinct UTC days the standing finishes landed on. */
  days: string[];
  /** In-window standing finishes across all jobs — the share denominator the prompt quotes. */
  finishes: number;
  /** jobs / finishes, or null when the denominator is empty (unreachable while a cell exists). */
  share: number | null;
  /** Recorded lane tallies, most frequent first. */
  lanes: UsageGapTally[];
  /** Recorded repo tallies ('unattributed' when the ledger named none), most frequent first. */
  repos: UsageGapTally[];
  /** ISO bounds of the cell's standing finishes; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): UsageGapTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: recurring usage_missing cells — a label recorded on enough
 * distinct jobs across enough distinct UTC days inside the window.
 * Sorted by job count, the worst capture gap first.
 */
export function usageGapCells(fold: UsageGapFold, lowerBound = false): UsageGapCell[] {
  const cells: UsageGapCell[] = [];
  for (const cell of fold.gaps.values()) {
    if (cell.jobs.size < USAGE_GAP_MIN_JOBS || cell.days.size < USAGE_GAP_MIN_DAYS) continue;
    cells.push({
      label: cell.label,
      jobs: cell.jobs.size,
      examples: [...cell.jobs].slice(0, MAX_EXAMPLES),
      days: [...cell.days].sort(),
      finishes: fold.finishes,
      share: fold.finishes > 0 ? cell.jobs.size / fold.finishes : null,
      lanes: tallyOf(cell.lanes, MAX_PROMPT_TALLIES),
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s job_usage() — devin_usage() reading the Devin sessions.db, claude_usage() reading the claude result JSON usage block, and the \'tokens used\' log-line fallback — flattens each lane\'s already-reported usage onto every finish row as tokens_total/acus plus usage_source (the measurement path: devin-sessions-db / claude-result-json / tokens-line) and usage_missing (why usage stayed unknowable). The ledger is append-only with no rotation; readers take a bounded tail. `phm fleet router-weights --json` folds the same rows into the usage_missing/usage_sources coverage tallies its advisory weight proposals quote (src/core/router/weight-proposals.ts over src/core/router/outcomes.ts), `phm router outcomes` prints the per-job usage_source/usage_missing fields, and router calibration pairs the same cost/token evidence per pool arm. Until this feed none of those readers queued work — a capture path that kept failing looked like ordinary absent data.';

const PINNED_NOTE = ' contrib/mac/dispatchd.py is pinned dispatcher machinery: a fix there needs Security review and re-pin before install — preview with contrib/mac/install.sh --dry-run --json and never install over the live pinned copy. Prefer evidence-backed changes in this repository\'s src/ where the cause lives (the finish-row and metrics writers, the ledger readers, the weight-proposal and calibration folds), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the label was a transitional CLI or host-state gap the fleet recovered from, the missing usage is a lane that legitimately reports none (an operator-known reporting gap rather than capture breakage), or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

/**
 * What each recorded label means in dispatchd's own vocabulary — the
 * capture path that failed, quoted from job_usage()/devin_usage()/
 * claude_usage() so the session starts from the producer's semantics
 * rather than guessing. Unknown labels (a producer's own bounded
 * vocabulary drift) fall back to the recorded text alone.
 */
const LABEL_HINTS: Record<string, string> = {
  'devin-session-db-missing': 'the Devin sessions.db file was absent on the host',
  'devin-session-db-unreadable': 'the Devin sessions.db existed but could not be read or parsed',
  'devin-no-session-for-worktree': 'no Devin session row matched the job\'s worktree',
  'devin-usage-incomplete': 'the Devin session reported responses but at least one lacked usage metrics',
  'devin-usage-not-reported': 'the Devin session carried no usage block at all',
  'claude-usage-incomplete': 'the claude result JSON carried a usage block whose token totals stayed incomplete',
  'claude-result-not-in-log': 'no type=result row with usage appeared in the job log tail',
  'tokens-line-not-in-log': 'no \'tokens used\' line appeared in the job log tail',
};

const tallyText = (tallies: readonly UsageGapTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: UsageGapCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: UsageGapCell): string =>
  cell.lowerBound ? ' The ledger tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

function usageGapPrompt(cell: UsageGapCell): string {
  const label = fieldText(cell.label, MAX_NAME_CHARS);
  const hint = LABEL_HINTS[cell.label];
  const share = cell.share === null ? '' : ` (${Math.round(cell.share * 100)}% of the ${cell.finishes} in-window finishes)`;
  const lanes = cell.lanes.length === 0 ? '' : ` Recorded lanes: ${tallyText(cell.lanes)}.`;
  const repos = cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
  const examples = cell.examples.length === 0 ? '' : ` Example job ids: ${cell.examples.join(', ')}.`;
  return [
    `Phantom's jobs ledger keeps recording finish rows whose usage capture failed — ${cell.jobs} distinct job(s) inside the window stand on usage_missing '${label}' across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `dispatchd's job_usage() writes this label when the lane's own usage evidence could not be flattened onto the finish row${hint === undefined ? '' : ` — ${hint}`}.${share}${lanes}${repos}${seenText(cell)}${examples}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find which capture path is actually failing: reproduce the tally with \`phm fleet router-weights --json\` (the usage_missing/usage_sources coverage section) and \`phm router outcomes --json\` (the per-job usage_source/usage_missing fields), then check whether the producing CLI changed shape — the Devin sessions.db schema, the claude result JSON usage block, the 'tokens used' log-line format — whether a finish-row or metrics writer in this repo dropped the fields, and whether the gap concentrates on the lane, repo or job shape the tallies name. A label that fires for every finish of one lane may be that lane's usage simply never being reported — still worth an item when it starves the router's cost and token evidence, but the fix may belong to the reporting side rather than the capture side.`,
    '',
    `Fix what lives here — the capture or reporting path this repository owns, or the ledger readers and weight folds in src/ that should surface the gap differently.${PINNED_NOTE} If the label traces to a lane that legitimately reports no usage, a host or CLI state that already recovered, or owner-only state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function usageGapItem(cell: UsageGapCell, repo: string): CloudBacklogItem {
  return {
    id: `usage-gap-${sha(`usage-gap:${cell.label}`)}`,
    title: `Fleet finishes keep losing usage telemetry: ${fieldText(cell.label, MAX_NAME_CHARS)}`.slice(0, MAX_TITLE_CHARS),
    prompt: usageGapPrompt(cell),
    area: 'usage-gap',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring usage-capture gaps.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function usageGapBacklogItems(opts: UsageGapItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? USAGE_GAP_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, USAGE_GAP_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const timelines = jobTimelines(tail.text, nowMs);
    const fold = foldUsageGapJournal(tail.text, nowMs, windowHours, timelines);
    if (fold.gaps.size === 0) return [];
    const cells = usageGapCells(fold, tail.truncated === true);
    const limit = Math.max(1, Math.min(opts.limit ?? USAGE_GAP_BACKLOG_MAX_ITEMS, USAGE_GAP_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => usageGapItem(cell, repo));
  } catch {
    return [];
  }
}
