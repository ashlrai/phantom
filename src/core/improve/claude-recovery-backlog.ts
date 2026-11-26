/**
 * Claude-recovery ledger → self-improvement backlog items.
 *
 * The dispatcher's claim loop runs launch_precheck.claude_recoveries()
 * over the jobs ledger every tick (contrib/mac/dispatchd.py): a job whose
 * claude lane recorded two fresh exit_code=1, empty=true finishes on
 * distinct attempts inside a day gets one automatic recovery — a
 * `<job>-CR1` child carrying the same prompt under a new id, requeued
 * until it finishes, publishes or gives up. Each spawn appends exactly
 * one `claude_recovery` row to metrics/jobs.jsonl: parent_job, the child
 * job id, the recorded reason, the bounded evidence receipts
 * (ts/lane/exit_code/empty/repo) and the spawn timestamp; the live
 * done flags live in queue/claude-recoveries.json beside it.
 *
 * Until now that row had no reader at all — not the router outcome
 * fold, not outcome learning, not any backlog source — so the fleet's
 * own record that the claude lane kept producing exit-1 empty finishes
 * never became work. Every other jobs.jsonl event folds somewhere
 * (skip gates into the outcome fold and precheck feeds, backoff holds
 * into friction and incident-gate, concurrency sheds into friction,
 * launch deaths into lost-launches); claude_recovery was the one
 * lifecycle row that stopped at the file. claudeRecoveryBacklogItems
 * carries the same tail into discoverBacklog, so `phm improve discover`
 * and the scheduler's autoDiscover queue it exactly like the
 * lost-launch, precheck-skip and typed-route sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail (CLAUDE_RECOVERY_LEDGER_LIMIT); nothing is
 *    written and no network is touched. A missing, unreadable or
 *    non-file ledger yields no items.
 *  - Healthy-only evidence. Rows count only under the writer's
 *    contract: the claude_recovery event name across the
 *    event|type|kind alias set, a parent_job inside the ledger's own
 *    id shape (a row that cannot name its parent is unattributable),
 *    and a timestamp the shared ledger dialect can place inside the
 *    window — a row whose stamp cannot be placed does not count,
 *    unknown stays unknown. Malformed JSON lines are skipped.
 *  - Recurring means recorded across distinct jobs. A cell emits only
 *    at CLAUDE_RECOVERY_RECURRING distinct parent_job ids inside the
 *    window, so one unlucky job never queues a session; each recovery
 *    already required two recorded exit-1 empty finishes, so the bar
 *    stands for at least six wasted claude attempts.
 *  - The recovery machinery is pinned ops machinery.
 *    contrib/mac/launch_precheck.py and dispatchd.py are
 *    Security-reviewed and re-pinned; agents never edit the live
 *    copies. The row also carries two fields this feed never quotes —
 *    `line` (the child's raw queue line, which embeds a prompt path)
 *    and `source` (the parent's prompt path) — local filesystem text
 *    that stays out of prompts. Items emit only when the backlog
 *    target's repository name is 'phantom', the same last-segment rule
 *    the sibling fleet-evidence sources apply, and their prompts direct
 *    sessions to fix what this repository owns or report no-change
 *    naming pinned/owner-side causes. The recorded repo tallies ride
 *    inside the prompt as evidence — the machinery is this install's,
 *    shared across every repository the fleet serves.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    recorded reason — never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new; a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, a parent_job counts under the id shape
 *    the producer itself fullmatches while example ids quoted into a
 *    prompt must also match the stricter prompt-safe shape, reason and
 *    repo strings are scrubbed, flattened and capped, a truncated tail
 *    is stated as a lower bound, and the brief carries the usual
 *    no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerAtMs, ledgerEventName } from '../fleet/empty-cause.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by recorded-reason diversity. */
export const CLAUDE_RECOVERY_MAX_ITEMS = 8;
const CLAUDE_RECOVERY_ITEM_HARD_MAX = 25;
/**
 * The recurring bar: distinct parent jobs auto-recovered inside the
 * window before the cell counts as recurring — the fleet's
 * RECURRING_FAILURES convention the sibling feeds apply. Each counted
 * job already burned two exit-1 empty claude finishes, so three
 * recoveries stand for six wasted attempts.
 */
export const CLAUDE_RECOVERY_RECURRING = 3;
/** Evidence window: three days of recoveries gives recurring lane patterns room without letting stale evidence linger. */
export const CLAUDE_RECOVERY_WINDOW_HOURS = 72;
/** Newest-bytes bound retained from the append-only jobs ledger — the same tail the sibling jobs-ledger feeds read. */
export const CLAUDE_RECOVERY_LEDGER_LIMIT = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Reason strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_REASON_CHARS = 160;
/** Repo labels are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_REPO_CHARS = 120;
/** Distinct repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt; each must match the ledger id shape. */
const MAX_EXAMPLE_JOBS = 3;
/** Evidence receipts scanned per row for repo labels — the producer writes at most two. */
const MAX_EVIDENCE_ENTRIES = 8;
/** The fleet's own repository label: recovery evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The job-id shape the producer itself accepts (launch_precheck.py's fullmatch); a row outside it is unattributable. */
const LEDGER_JOB_ID = /^[A-Za-z0-9._-]{1,90}$/;
/** The stricter shape a job id must also match before it is quoted into a prompt. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The parent-job field spellings the producer's row contract carries. */
const PARENT_JOB_KEYS = ['parent_job', 'parentJob', 'parent'] as const;
/** The reason field the producer's row contract carries. */
const REASON_KEYS = ['reason'] as const;

export interface ClaudeRecoveryItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default CLAUDE_RECOVERY_WINDOW_HOURS). */
  windowHours?: number;
  /** Newest-bytes bound on the jobs-ledger tail (default CLAUDE_RECOVERY_LEDGER_LIMIT). */
  ledgerLimit?: number;
  /** Most items one call emits (default CLAUDE_RECOVERY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

export interface ClaudeRecoveryTally {
  /** Sanitized recorded text (a repo label). */
  text: string;
  count: number;
}

/** One recorded-reason cell: the auto-recoveries the ledger wrote inside the window. */
export interface ClaudeRecoveryCell {
  /** Sanitized recorded reason ('claude_exit_1_empty_repeated' today), or 'unrecorded reason'. */
  reason: string;
  /** Distinct parent_job ids inside the window — the recurring count. */
  count: number;
  /** Total valid claude_recovery rows folded into the cell. */
  rows: number;
  /** Recorded target repo labels from the evidence receipts, most frequent first. */
  repos: ClaudeRecoveryTally[];
  /** Up to MAX_EXAMPLE_JOBS prompt-safe parent job ids (counted ids need only the producer's shape). */
  parents: string[];
  /** Up to MAX_EXAMPLE_JOBS prompt-safe child (-CR1) job ids. */
  children: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): ClaudeRecoveryTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

interface RecoveryRow {
  parent: string;
  child: string | null;
  reason: string;
  repos: string[];
}

/**
 * Validate one ledger row under the producer's contract. Returns null
 * when the row is not a usable claude_recovery record: the event name
 * must resolve through the shared dialect and parent_job must sit
 * inside the id shape launch_precheck.py itself fullmatches (the row's
 * whole attribution); timestamp placement is the caller's window
 * check. `line` and `source` are deliberately never read: both are
 * local filesystem text.
 */
function parseRecoveryRow(row: Record<string, unknown>): RecoveryRow | null {
  if (ledgerEventName(row) !== 'claude_recovery') return null;
  const parent = firstString(row, PARENT_JOB_KEYS);
  if (parent === null || !LEDGER_JOB_ID.test(parent)) return null;
  const childRaw = firstString(row, ['job', 'job_id', 'jobId', 'id']);
  const child = childRaw !== null && LEDGER_JOB_ID.test(childRaw) ? childRaw : null;
  const reasonRaw = firstString(row, REASON_KEYS);
  const reason = reasonRaw === null ? 'unrecorded reason' : fieldText(reasonRaw, MAX_REASON_CHARS) || 'unrecorded reason';
  const repos = new Set<string>();
  const evidence = row['evidence'];
  if (Array.isArray(evidence)) {
    for (const entry of evidence.slice(0, MAX_EVIDENCE_ENTRIES)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const repo = (entry as Record<string, unknown>)['repo'];
      if (typeof repo !== 'string' || repo.trim() === '') continue;
      const label = fieldText(repo, MAX_REPO_CHARS);
      if (label !== '') repos.add(label);
    }
  }
  return { parent, child, reason, repos: [...repos] };
}

/**
 * Pure: fold jobs.jsonl text into per-reason cells inside the window.
 * Rows are validated under the producer's contract; rows whose
 * timestamp cannot be placed inside [nowMs - windowMs, nowMs] never
 * reach a cell. `count` is distinct parent_job ids — the recurring
 * measure — while `rows` keeps the raw record count.
 */
export function foldClaudeRecoveryCells(text: string, nowMs: number, windowMs: number): ClaudeRecoveryCell[] {
  const cells = new Map<string, {
    reason: string;
    parentIds: Set<string>;
    rows: number;
    repos: Map<string, number>;
    parentExamples: string[];
    childExamples: string[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const parsed = parseRecoveryRow(row);
    if (parsed === null) continue;
    const ms = ledgerAtMs(row);
    if (ms === null || ms > nowMs || ms < nowMs - windowMs) continue;
    let cell = cells.get(parsed.reason);
    if (cell === undefined) {
      cell = { reason: parsed.reason, parentIds: new Set(), rows: 0, repos: new Map(),
        parentExamples: [], childExamples: [], firstMs: null, lastMs: null };
      cells.set(parsed.reason, cell);
    }
    cell.rows += 1;
    cell.parentIds.add(parsed.parent);
    if (SAFE_JOB_ID.test(parsed.parent)
        && cell.parentExamples.length < MAX_EXAMPLE_JOBS && !cell.parentExamples.includes(parsed.parent)) {
      cell.parentExamples.push(parsed.parent);
    }
    if (parsed.child !== null && SAFE_JOB_ID.test(parsed.child)
        && cell.childExamples.length < MAX_EXAMPLE_JOBS && !cell.childExamples.includes(parsed.child)) {
      cell.childExamples.push(parsed.child);
    }
    for (const repo of parsed.repos) bump(cell.repos, repo);
    cell.firstMs = cell.firstMs === null ? ms : Math.min(cell.firstMs, ms);
    cell.lastMs = cell.lastMs === null ? ms : Math.max(cell.lastMs, ms);
  }
  return [...cells.values()]
    .map((cell) => ({
      reason: cell.reason,
      count: cell.parentIds.size,
      rows: cell.rows,
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      parents: cell.parentExamples,
      children: cell.childExamples,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

const NO_CHANGE = 'If the window has rolled forward, the recoveries were a one-off burst whose -CR1 children all landed, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed launch_precheck.py/dispatchd.py files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the pinned boundary and the folding commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): the dispatchd claim loop appends exactly one claude_recovery row per auto-recovery spawn — parent_job, the -CR1 child job id, the recorded reason, the bounded evidence receipts (ts/lane/exit_code/empty/repo) and the spawn timestamp; the live done flags live in queue/claude-recoveries.json beside it. The detector is claude_recoveries() in contrib/mac/launch_precheck.py invoked from contrib/mac/dispatchd.py — pinned, Security-reviewed ops machinery agents never edit live. Whether the -CR1 children themselves merge, churn or die is recorded on their own jobs.jsonl rows under the child job id.';

function tallyText(tallies: readonly ClaudeRecoveryTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: ClaudeRecoveryCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function repoText(cell: ClaudeRecoveryCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded target repositories: ${tallyText(cell.repos)}.`;
}

function parentsText(cell: ClaudeRecoveryCell): string {
  return cell.parents.length === 0 ? '' : ` Example parent job ids: ${cell.parents.join(', ')}.`;
}

function childrenText(cell: ClaudeRecoveryCell): string {
  return cell.children.length === 0 ? '' : ` Recovery child job ids: ${cell.children.join(', ')}.`;
}

function recoveryPrompt(cell: ClaudeRecoveryCell, truncated: boolean): string {
  return [
    `Phantom's dispatcher keeps auto-recovering Claude jobs — ${cell.count} distinct job(s) spawned a -CR1 recovery child inside the window (${cell.rows} recorded claude_recovery row(s), reason '${cell.reason}'), the self-improvement work this backlog exists for.`,
    '',
    `Each claude_recovery row is dispatchd's own verdict: claude_recoveries() saw two fresh exit_code=1, empty=true claude finishes on distinct attempts for one job and spawned a <job>-CR1 child carrying the same prompt under a new id — every spawn means at least two claude runs burned a launch slot and produced no diff.${repoText(cell)}${parentsText(cell)}${childrenText(cell)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    ...(truncated ? ['The jobs-ledger read is a bounded newest-bytes tail, so these counts are a lower bound — older recoveries may exist beyond the retained window.', ''] : []),
    `A recovery spawn means the claude lane produced repeated exit-1 empty finishes for the same job inside a day — wasted launch slots and delayed work, and a fleet that keeps needing them is either hitting a lane or model regression, a prompt or job-spec defect, or infra churn the recovery is papering over. Find which side owns the cause: whether the recorded exit-1-empty finishes cluster on one repo or job shape (the repository tallies above), whether the -CR1 children succeed or churn the same way (their own finish/outcome rows under the child job ids), and whether this repository's lane placement, job specs, detectors or docs should respond — for example recording the parent→child recovery link where outcome readers can see it, or flagging repeated exit-1-empty claude finishes earlier than the two-finish bar. If the recoveries were a one-off burst, the children all landed, or the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function claudeRecoveryItem(cell: ClaudeRecoveryCell, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `fleet-claude-recovery-${createHash('sha256').update(`claude-recovery:${cell.reason}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: 'Claude jobs keep needing dispatcher auto-recovery'.slice(0, MAX_TITLE_CHARS),
    prompt: recoveryPrompt(cell, truncated),
    area: 'claude-recovery',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring claude_recovery cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function claudeRecoveryBacklogItems(opts: ClaudeRecoveryItemsOptions): Promise<CloudBacklogItem[]> {
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
    const read = await readLedgerTail(jobsPath, opts.ledgerLimit ?? CLAUDE_RECOVERY_LEDGER_LIMIT);
    if (read.state !== 'read') return [];
    const windowMs = (opts.windowHours ?? CLAUDE_RECOVERY_WINDOW_HOURS) * 3_600_000;
    const cells = foldClaudeRecoveryCells(read.text, nowMs, windowMs)
      .filter((cell) => cell.count >= CLAUDE_RECOVERY_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? CLAUDE_RECOVERY_MAX_ITEMS, CLAUDE_RECOVERY_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => claudeRecoveryItem(cell, repo, read.truncated));
  } catch {
    return [];
  }
}
