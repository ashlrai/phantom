/**
 * jobs.jsonl Git-operation observations → self-improvement backlog items.
 *
 * Every Git invocation the fleet's own code paths run is wrapped by
 * observeGit/observeGitSync/observeGitAsync (src/core/fleet/
 * git-observations.ts) — safe-git, worktree add/remove, inbox apply and
 * merge, fleet worktrees, merge-queue prep, the detached post-merge
 * runner, autopilot act, the improve loop — and by router_git_observed
 * (contrib/router/lib/git_safety.sh) on the router side. Each wrapper
 * appends `git_operation` rows to metrics/jobs.jsonl under the fleet
 * runs directory:
 *
 *   {event:'git_operation', machine, lane, ts, operation, elapsed_ms,
 *    retries?, failed?}
 *
 * operation is one of index.lock, worktree_add, worktree_remove, fetch
 * or push; timed operations carry elapsed_ms and fetch/push carry
 * retries; an index.lock row is written only when a Git invocation
 * failed with index.lock in its stderr, so every recorded index.lock
 * row is a lock failure, never a neutral observation.
 *
 * The rows' only reader is `phm fleet job-latency`'s git_contention
 * section (src/core/fleet/job-latency.ts) — a report someone had to
 * run and read. Until now nothing folded the history into work, so a
 * host whose Git operations kept hitting index.lock, or whose
 * fetches/pushes kept recording retries, looked like ordinary rows in
 * a file nobody opened.
 *
 * gitContentionBacklogItems carries the recorded observations into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling jobs-ledger feeds
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail at ROUTER_OUTCOME_LEDGER_LIMIT; nothing is
 *    written and no network is touched.
 *  - Writer-contract rows only. A row counts only when its own fields
 *    validate against the writers' contract — event 'git_operation',
 *    operation inside the five-name vocabulary, non-empty machine and
 *    lane strings, a timestamp inside the window under the jobs
 *    ledger's own TS_KEYS dialect, and failed/retries in their
 *    recorded shapes. Malformed lines are skipped, never guessed.
 *  - Adverse means recorded, never inferred. index.lock rows count only
 *    when failed is recorded true; fetch/push rows count only when
 *    retries is a recorded positive integer. retries absent or 0 is a
 *    clean observation, and timed rows are context only — no recorded
 *    verdict makes a slow operation adverse on its own.
 *  - One source, one ledger. A missing or unreadable jobs.jsonl silences
 *    the whole source — a host that never ran an observed Git
 *    invocation and a healthy fleet look identical to an absent series,
 *    and both correctly emit nothing.
 *  - Recurring means recorded across days. A cell emits only at
 *    GIT_CONTENTION_MIN_UNITS adverse rows spanning
 *    GIT_CONTENTION_MIN_DAYS distinct UTC days inside the window — a
 *    single wedged lock's burst of failures, or one retry storm on one
 *    afternoon, never queues a session.
 *  - Fleet machinery only. The rows describe this install's hosts,
 *    lanes and Git call paths — they carry no repository column — so
 *    items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    feeds apply.
 *  - Hostnames stay out of prompts. The cell counts distinct recorded
 *    machines but never prints a hostname — the prompt names
 *    `phm fleet job-latency --json`'s git_contention fold as the
 *    per-host breakdown.
 *  - Dedup is downstream. Item ids key on the operation cell — never
 *    the counts, machines or timestamps — so a refresh re-derives the
 *    same ids and appendUserBacklogItems adds only what is new; a cell
 *    that resolves simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, lane strings are scrubbed, flattened and capped
 *    before they reach a prompt, machine names are counted never
 *    printed, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is three operations, so the cap bounds nothing real. */
export const GIT_CONTENTION_MAX_ITEMS = 8;
const GIT_CONTENTION_ITEM_HARD_MAX = 25;
/** Evidence window: seven days — the recurring-flake/sibling convention for jobs-ledger evidence. */
export const GIT_CONTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Adverse rows one cell needs inside the window before it counts as recurring. */
export const GIT_CONTENTION_MIN_UNITS = 3;
/** Distinct UTC days those rows must span — recurring means across days, not one burst. */
export const GIT_CONTENTION_MIN_DAYS = 2;
/** The fleet's own repository label: git-operation evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writers' operation vocabulary (gitOperations in job-latency.ts, Operation in git-observations.ts). */
const GIT_OPERATIONS = ['index.lock', 'worktree_add', 'worktree_remove', 'fetch', 'push'] as const;
type GitOperation = (typeof GIT_OPERATIONS)[number];
/** The cell kinds an adverse row can feed: lock failures and recorded fetch/push retries. */
type GitContentionKind = 'index.lock' | 'fetch' | 'push';
/** jobs.jsonl timestamp dialect — the same TS_KEYS set job-latency's boundaryTs accepts. */
const TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane strings are writer-recorded text; flatten, scrub and cap before they reach a prompt or tally. */
const MAX_LANE_CHARS = 80;
/** Machine strings are hostnames; counted for the prompt, never printed. */
const MAX_MACHINE_CHARS = 120;
/** Distinct lane tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;

export interface GitContentionItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default GIT_CONTENTION_WINDOW_MS). */
  windowMs?: number;
  /** Ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default GIT_CONTENTION_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated git_operation row: the recorded observation fields the fold needs. */
export interface GitOperationRecord {
  machine: string;
  lane: string;
  operation: GitOperation;
  /** Epoch ms of the row's timestamp. */
  atMs: number;
  /** UTC day key ('YYYY-MM-DD') the timestamp falls in. */
  utcDay: string;
  failed: boolean | null;
  retries: number | null;
}

/** One adverse cell: recorded lock failures or fetch/push retries for one operation. */
export interface GitContentionCell {
  kind: GitContentionKind;
  /** Adverse rows inside the window (index.lock failures, or fetch/push rows with retries > 0). */
  rows: number;
  /** Total recorded retries across the operation's in-window rows (fetch/push cells only; null for index.lock). */
  retries: number | null;
  /** Distinct UTC days the adverse rows span. */
  days: number;
  /** Distinct recorded machines the operation's rows touched — counted, never named. */
  machines: number;
  /** Recorded lane labels, most frequent first (capped at MAX_PROMPT_TALLIES). */
  lanes: { text: string; count: number }[];
  /** ISO bounds of the cell's adverse rows. */
  firstSeen: string;
  lastSeen: string;
  /** True when the bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** First parseable stamp among the ledger's timestamp fields — job-latency's boundaryTs dialect. */
function rowTs(row: Record<string, unknown>): number {
  for (const field of TS_KEYS) {
    const value = row[field];
    if (typeof value === 'string') {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return at;
    }
  }
  return NaN;
}

/**
 * Pure: the validated git_operation rows of a jobs.jsonl tail. Only
 * writer-contract rows count — event 'git_operation' (the
 * event/type/kind precedence job-latency's boundaryEvent applies), an
 * operation inside the five-name vocabulary, non-empty machine and lane
 * strings, an in-window timestamp, and failed/retries in their recorded
 * shapes. Every other line is skipped, never guessed. elapsed_ms is
 * accepted but not carried: no recorded verdict makes a slow operation
 * adverse.
 */
export function parseGitContentionRows(text: string, cutoffMs: number, nowMs: number): GitOperationRecord[] {
  const out: GitOperationRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const event = r['event'] ?? r['type'] ?? r['kind'];
    if (event !== 'git_operation') continue;
    const operation = GIT_OPERATIONS.find((op) => op === r['operation']);
    if (operation === undefined) continue;
    const machine = r['machine'];
    const lane = r['lane'];
    if (typeof machine !== 'string' || machine.trim() === '') continue;
    if (typeof lane !== 'string' || lane.trim() === '') continue;
    const atMs = rowTs(r);
    if (!Number.isFinite(atMs) || atMs < cutoffMs || atMs > nowMs) continue;
    const failedRaw = r['failed'];
    const failed = typeof failedRaw === 'boolean' ? failedRaw : null;
    const retriesRaw = r['retries'];
    const retries = typeof retriesRaw === 'number' && Number.isSafeInteger(retriesRaw) && retriesRaw >= 0 ? retriesRaw : null;
    out.push({
      machine: machine.trim(),
      lane: lane.trim(),
      operation,
      atMs,
      utcDay: new Date(atMs).toISOString().slice(0, 10),
      failed,
      retries,
    });
  }
  return out;
}

/**
 * Pure: fold validated git_operation rows into adverse cells. A row is
 * adverse evidence for exactly one cell kind: an index.lock row whose
 * failed flag is recorded true feeds 'index.lock'; a fetch or push row
 * whose retries is a recorded positive integer feeds that operation's
 * cell. worktree rows and every clean observation feed nothing.
 */
export function foldGitContentionCells(rows: readonly GitOperationRecord[], lowerBound = false): GitContentionCell[] {
  const kinds: GitContentionKind[] = ['index.lock', 'fetch', 'push'];
  const cells = new Map<GitContentionKind, {
    kind: GitContentionKind;
    rows: number;
    days: Set<string>;
    machines: Set<string>;
    lanes: Map<string, number>;
    firstMs: number;
    lastMs: number;
    opRetries: number;
    opRetriesSeen: boolean;
  }>();
  for (const kind of kinds) {
    cells.set(kind, {
      kind, rows: 0, days: new Set(), machines: new Set(), lanes: new Map(),
      firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY,
      opRetries: 0, opRetriesSeen: false,
    });
  }
  for (const row of rows) {
    if (row.operation === 'worktree_add' || row.operation === 'worktree_remove') continue;
    const cell = cells.get(row.operation as GitContentionKind);
    if (cell === undefined) continue;
    if (row.retries !== null) { cell.opRetries += row.retries; cell.opRetriesSeen = true; }
    const adverse = row.operation === 'index.lock'
      ? row.failed === true
      : row.retries !== null && row.retries > 0;
    if (!adverse) continue;
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.machines.add(fieldText(row.machine, MAX_MACHINE_CHARS) || 'unknown');
    const lane = fieldText(row.lane, MAX_LANE_CHARS) || 'unknown';
    cell.lanes.set(lane, (cell.lanes.get(lane) ?? 0) + 1);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
  }
  const out: GitContentionCell[] = [];
  for (const cell of cells.values()) {
    if (cell.rows === 0) continue;
    const lanes = [...cell.lanes.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
      .slice(0, MAX_PROMPT_TALLIES);
    out.push({
      kind: cell.kind,
      rows: cell.rows,
      retries: cell.kind === 'index.lock' ? null : (cell.opRetriesSeen ? cell.opRetries : null),
      days: cell.days.size,
      machines: cell.machines.size,
      lanes,
      firstSeen: new Date(cell.firstMs).toISOString(),
      lastSeen: new Date(cell.lastMs).toISOString(),
      lowerBound,
    });
  }
  return out;
}

const NO_CHANGE = 'If the window has rolled forward, the contention was a one-off burst the later operations recovered from, the locks cleared once the holder finished, or the cause is owner-side or pinned ops machinery (credentials, billing, host antivirus or indexing, the Security-reviewed dispatcher/launcher files under contrib/mac and ~/.ashlr-runs/bin, the host Git installation itself) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-report gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the git_operation rows of metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — appended by observeGit/observeGitSync/observeGitAsync (src/core/fleet/git-observations.ts) around the fleet\'s own Git call paths and by router_git_observed (contrib/router/lib/git_safety.sh) on the router side. `phm fleet job-latency --json` folds the same rows into its git_contention section — per machine, lane and operation p90 timings, index.lock failure and fetch/push retry tallies — the per-host breakdown this backlog counts but never prints. Until this feed the rows fed only that report: no fold turned recurring contention into work.';

function lanesText(cell: GitContentionCell): string {
  return cell.lanes.length === 0 ? '' : ` Recorded lanes: ${cell.lanes.map((l) => `'${l.text}' ×${l.count}`).join(', ')}.`;
}

function seenText(cell: GitContentionCell): string {
  return cell.firstSeen === cell.lastSeen
    ? ` First recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: GitContentionCell): string {
  return cell.lowerBound ? ' The jobs.jsonl tail was truncated, so these counts are a lower bound.' : '';
}

function contentionPrompt(cell: GitContentionCell): string {
  const days = `${cell.rows} recorded ${cell.kind === 'index.lock' ? 'index.lock failure' : `${cell.kind} retry`} row(s) across ${cell.days} distinct UTC day(s) on ${cell.machines} fleet host(s)`;
  const retryText = cell.kind === 'index.lock' || cell.retries === null
    ? ''
    : ` ${cell.retries} retries recorded across the operation's in-window rows.`;
  const what = cell.kind === 'index.lock'
    ? 'Git operations keep failing on index.lock — another Git process holds the repository index lock long enough that fleet operations time out or error against it.'
    : cell.kind === 'fetch'
      ? 'Git fetches keep recording retries — remote reads are stalling or failing often enough that the observed invocations had to retry.'
      : 'Git pushes keep recording retries — remote writes are stalling or failing often enough that the observed invocations had to retry.';
  return [
    `Phantom's fleet Git operations show recurring ${cell.kind === 'index.lock' ? 'index.lock contention' : `${cell.kind} retries`} — ${days}, the self-improvement work this backlog exists for.`,
    '',
    `${what}${retryText}${lanesText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the observation wrappers and every fleet call site that runs Git — src/core/fleet/git-observations.ts decides what is recorded, src/core/sandbox/safe-git.ts and src/core/fleet/worktrees.ts own the sandboxed and worktree Git paths, and the inbox apply/merge, merge-queue-prep, detached-post-merge-runner, autopilot and improve-loop call sites decide how often and how serialized fleet Git runs. For index.lock contention that means finding what serializes or wedges the index lock — whether fleet Git operations on one repository should queue or retry with backoff instead of failing, whether a call path leaves a lock-holding process behind (the stray-stop and worktree-reap feeds are the sibling evidence), or whether the observation coverage itself misses the operations that matter. For fetch/push retries it means the remote call pattern — fetch/push fan-out, missing backoff, or a remote that keeps refusing. The contrib/mac dispatcher and launcher files and the host Git installation are pinned or owner-side: if the cause lives there — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function contentionItem(cell: GitContentionCell, repo: string): CloudBacklogItem {
  const id = `fleet-git-${cell.kind}-${createHash('sha256').update(`git-op:${cell.kind}`).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'index.lock'
    ? 'Fleet Git operations keep failing on index.lock'
    : `Fleet Git ${cell.kind === 'fetch' ? 'fetches' : 'pushes'} keep recording retries`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: contentionPrompt(cell),
    area: 'git-contention',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Backlog items for the jobs ledger's recurring Git-contention cells. Total: any read or fold failure yields no items. */
export async function gitContentionBacklogItems(opts: GitContentionItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writers' own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? GIT_CONTENTION_WINDOW_MS;
    const cutoffMs = nowMs - windowMs;
    const path = opts.journalPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, ROUTER_OUTCOME_LEDGER_LIMIT);
    // A missing ledger is a clean empty source; an unreadable or non-file
    // read means evidence exists that cannot be trusted — fail closed. A
    // truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const rows = parseGitContentionRows(tail.text, cutoffMs, nowMs);
    if (rows.length === 0) return [];
    const cells = foldGitContentionCells(rows, tail.truncated === true)
      .filter((cell) => cell.rows >= GIT_CONTENTION_MIN_UNITS && cell.days >= GIT_CONTENTION_MIN_DAYS)
      .sort((a, b) => b.rows - a.rows || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? GIT_CONTENTION_MAX_ITEMS, GIT_CONTENTION_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => contentionItem(cell, repo));
  } catch {
    return [];
  }
}
