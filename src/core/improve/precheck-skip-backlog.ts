/**
 * Precheck-skip ledger → self-improvement backlog items.
 *
 * The dispatcher's claim loop appends one row to
 * <runsDir>/queue/precheck-skips.tsv for every job its empty-run precheck
 * (contrib/precheck.sh via contrib/mac/launch_precheck.py) or its dupcheck
 * gate finishes as DONE-NOOP without a model call — `TS⇥job⇥code⇥reason`
 * in local wall time. A skip means the fleet spent a queue slot deciding
 * the work was already done or empty; the job never launched and no agent
 * ever ran. Two evidence kinds in that ledger never became work:
 *
 *  - A (code, reason) group recurring across distinct jobs: the same skip
 *    signature — `files_and_tests_exist`, `symbols_defined`,
 *    `dupcheck_already_done`, `empty_streak_Nx`, `id_merged_pr_N`,
 *    `PRECHECK_UNSURE_*` — finishing many different jobs inside the
 *    window. Reasons embed job- and PR-specific numbers, so the fold
 *    groups on a digit-normalized shape (`pr_123_MERGED` and
 *    `pr_456_MERGED` share `pr_#_MERGED`), never the raw reason. A
 *    recurring group means either the queue producers keep minting work
 *    master already satisfies — queuegen proposals, router-queue rows,
 *    backlog-discovered items, restock picks, issue triage — or one
 *    precheck rule now misfires on a whole class of jobs.
 *  - One job id skipped again and again: each skip consumed a ready.tsv
 *    row, so a repeat means a producer re-added the same DONE-NOOP job —
 *    queuegen dedup, a restock re-pick, router-queue regeneration or
 *    backlog re-discovery resurrecting finished work. `phm fleet
 *    precheck-repeats` exists precisely to surface these repeats.
 *
 * Until now the ledger only ever reached `phm fleet precheck-repeats`,
 * the `skips`/`repeatedSkips` sections of `phm fleet queue --json` and
 * the health tallies inside `phm fleet parked --json` — reports someone
 * had to run and read. precheckSkipBacklogItems carries the same rows
 * into discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the lost-launch, memory-pressure
 * and fleet-controller sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readSource's bounded tail —
 *    the last 256 KiB, the same bound the queue projection applies —
 *    with the leading partial line dropped. Nothing is written and no
 *    network is touched.
 *  - Healthy-only evidence. A degraded read yields no items; a missing
 *    ledger is an empty file — no skips, no items. Rows the parser
 *    cannot validate (wrong cell count, unsafe or oversized fields,
 *    an id outside the ledger's own shape) never reach the fold, and a
 *    row whose timestamp cannot be placed inside the window does not
 *    count — unknown stays unknown.
 *  - Recurring means recorded. A group cell emits only at
 *    PRECHECK_SKIP_RECURRING distinct job ids inside the window, a
 *    repeat cell only at that many recorded rows for one job id, so a
 *    single unlucky skip or one requeue never queues a session.
 *  - The skip machinery is pinned ops machinery. contrib/mac's
 *    launch_precheck.py, precheck.sh and dispatchd.py are
 *    Security-reviewed and re-pinned; agents never edit the live
 *    copies. The ledger also records no repository column — the
 *    dispatcher's skips serve every repo this install runs — so items
 *    emit only when the backlog target's repository name is 'phantom',
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply, and their prompts direct sessions to fix what this
 *    repository owns (the queue producers and dedup in src/core/queue,
 *    the backlog feeds, the detectors that read this evidence) or
 *    report no-change naming pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    code+shape pair, or the job id — never the counts or timestamps),
 *    so a refresh re-derives the same id and appendUserBacklogItems
 *    adds only what is new; a cell that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the ledger's
 *    own id shape before they are quoted, reason strings are scrubbed,
 *    flattened and capped, and the brief carries the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { localTimestamp, readSource } from '../fleet/runs-parked-queue.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by code/reason/job diversity. */
export const PRECHECK_SKIP_MAX_ITEMS = 8;
const PRECHECK_SKIP_ITEM_HARD_MAX = 25;
/**
 * The recurring bar both cell kinds share: a (code, reason-shape) group
 * needs this many distinct job ids inside the window, and a repeated job
 * needs this many recorded skip rows — the fleet's RECURRING_FAILURES
 * convention the sibling feeds apply to their own tallies.
 */
export const PRECHECK_SKIP_RECURRING = 3;
/** Evidence window: one week of skips gives recurring producer patterns room without letting stale evidence linger. */
export const PRECHECK_SKIP_WINDOW_HOURS = 168;
/** Tail bound on the skip ledger — the same 256 KiB readFleetQueue applies to this file. */
export const PRECHECK_SKIPS_MAX_BYTES = 256 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Reason strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_REASON_CHARS = 160;
/** Reason-shape characters quoted inside one title before the remainder is elided. */
const TITLE_SHAPE_MAX = 80;
/** Example job ids quoted per cell inside one prompt; each must match the ledger id shape. */
const MAX_EXAMPLE_JOBS = 3;
/** Distinct reason tallies quoted inside one prompt. */
const MAX_PROMPT_REASONS = 4;
/** The fleet's own repository label: skip evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The job-id shape the runs dir and ledger use; anything else is never quoted into a prompt. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Same row validation the queue projection applies: ledger ids are shorter still. */
const SKIP_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// eslint-disable-next-line no-control-regex -- ledger fields must not carry paths or control bytes.
const UNSAFE_CELL = /[/\\\x00-\x1f\x7f]/;
/** Same per-cell bound parseSkips enforces on at/code/reason. */
const MAX_CELL_CHARS = 400;

export interface PrecheckSkipItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/precheck-skips.tsv; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default PRECHECK_SKIP_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default PRECHECK_SKIP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

export interface PrecheckSkipTally {
  /** Sanitized recorded text (a reason or an exit code). */
  text: string;
  count: number;
}

/** The two recorded skip shapes; they need different fixes so they never share a cell. */
export type PrecheckSkipKind = 'group' | 'repeat';

/** One recurring skip cell: a (code, reason-shape) group or one repeatedly-skipped job. */
export interface PrecheckSkipCell {
  kind: PrecheckSkipKind;
  /** group cells: the recorded exit code as written. */
  code: string;
  /** group cells: the digit-normalized reason shape (`pr_123_MERGED` → `pr_#_MERGED`). */
  shape: string;
  /** repeat cells: the job id the ledger kept skipping. */
  job: string;
  /** group cells: distinct job ids inside the window; repeat cells: recorded skip rows for the job. */
  count: number;
  /** Total recorded rows folded into the cell. */
  rows: number;
  /** Recorded exit codes, most frequent first (repeat cells mainly). */
  codes: PrecheckSkipTally[];
  /** Recorded raw reasons, scrubbed/flattened/capped, most frequent first. */
  reasons: PrecheckSkipTally[];
  /** Up to MAX_EXAMPLE_JOBS ledger-safe job ids (group cells). */
  jobs: string[];
  /** ISO bounds of the cell's recorded skips; null when none carried a usable timestamp. */
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

/**
 * The grouping shape for a recorded reason: scrubbed and flattened, then
 * every run of digits collapsed to '#'. The recorded vocabulary embeds
 * job- and PR-specific numbers (`id_merged_pr_123`, `pr_45_MERGED`,
 * `empty_streak_7x`, `PRECHECK_UNSURE_pr_9`) that would keep every row in
 * its own cell; fixed reasons pass through unchanged.
 */
function reasonShape(reason: string): string {
  return scrubSecrets(reason).replace(/\s+/g, ' ').trim().replace(/[0-9]+/g, '#');
}

interface SkipRow {
  job: string;
  code: string;
  reason: string;
  shape: string;
  ms: number;
}

/** Same row contract parseSkips enforces: four cells, safe fields, ledger-shaped job id. */
function parseSkipRows(text: string): SkipRow[] {
  const rows: SkipRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.replace(/\r$/, '').split('\t');
    const [at, job, code, reason] = cells;
    if (cells.length !== 4 || !at || !job || !SKIP_JOB_ID.test(job) || !code || !reason ||
        [at, code, reason].some((cell) => cell.length > MAX_CELL_CHARS || UNSAFE_CELL.test(cell))) {
      continue;
    }
    rows.push({ job, code, reason, shape: reasonShape(reason), ms: localTimestamp(at).ms });
  }
  return rows;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): PrecheckSkipTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

interface CellAcc {
  kind: PrecheckSkipKind;
  code: string;
  shape: string;
  job: string;
  rows: number;
  jobs: Set<string>;
  codes: Map<string, number>;
  reasons: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

function newAcc(kind: PrecheckSkipKind, row: SkipRow): CellAcc {
  return {
    kind,
    code: kind === 'group' ? row.code : '',
    shape: kind === 'group' ? row.shape : '',
    job: kind === 'repeat' ? row.job : '',
    rows: 0,
    jobs: new Set<string>(),
    codes: new Map<string, number>(),
    reasons: new Map<string, number>(),
    firstMs: null,
    lastMs: null,
  };
}

function foldRow(acc: CellAcc, row: SkipRow): void {
  acc.rows += 1;
  if (acc.kind === 'group') acc.jobs.add(row.job);
  bump(acc.codes, fieldText(row.code, 40) || 'unrecorded code');
  bump(acc.reasons, fieldText(row.reason, MAX_REASON_CHARS) || 'unrecorded reason');
  if (Number.isFinite(row.ms)) {
    acc.firstMs = acc.firstMs === null ? row.ms : Math.min(acc.firstMs, row.ms);
    acc.lastMs = acc.lastMs === null ? row.ms : Math.max(acc.lastMs, row.ms);
  }
}

function toCell(acc: CellAcc): PrecheckSkipCell {
  const jobs = acc.kind === 'group'
    ? [...acc.jobs].filter((job) => SAFE_JOB_ID.test(job)).slice(0, MAX_EXAMPLE_JOBS)
    : acc.job !== '' && SAFE_JOB_ID.test(acc.job) ? [acc.job] : [];
  return {
    kind: acc.kind,
    code: acc.code,
    shape: acc.shape,
    job: acc.job,
    count: acc.kind === 'group' ? acc.jobs.size : acc.rows,
    rows: acc.rows,
    codes: tallyOf(acc.codes, MAX_PROMPT_REASONS),
    reasons: tallyOf(acc.reasons, MAX_PROMPT_REASONS),
    jobs,
    firstSeen: acc.firstMs === null ? null : new Date(acc.firstMs).toISOString(),
    lastSeen: acc.lastMs === null ? null : new Date(acc.lastMs).toISOString(),
  };
}

/**
 * Pure: fold the skip ledger's text into recurring cells inside the
 * window. Rows are validated exactly like the queue projection's
 * parseSkips; rows whose timestamp cannot be placed inside
 * [nowMs - windowMs, nowMs] never reach a cell. Group cells key on
 * (code, digit-normalized reason shape) and count distinct job ids;
 * repeat cells key on the job id and count recorded rows.
 */
export function foldPrecheckSkipCells(text: string, nowMs: number, windowMs: number): PrecheckSkipCell[] {
  const groups = new Map<string, CellAcc>();
  const repeats = new Map<string, CellAcc>();
  for (const row of parseSkipRows(text)) {
    if (!Number.isFinite(row.ms) || row.ms > nowMs || row.ms < nowMs - windowMs) continue;
    const gkey = JSON.stringify([row.code, row.shape]);
    let group = groups.get(gkey);
    if (group === undefined) { group = newAcc('group', row); groups.set(gkey, group); }
    foldRow(group, row);
    let repeat = repeats.get(row.job);
    if (repeat === undefined) { repeat = newAcc('repeat', row); repeats.set(row.job, repeat); }
    foldRow(repeat, row);
  }
  return [...groups.values(), ...repeats.values()]
    .map(toCell)
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code) || a.job.localeCompare(b.job) || a.shape.localeCompare(b.shape));
}

const NO_CHANGE = 'If the window has rolled forward, the skips were a one-off burst the producers recovered from, the skips are the precheck correctly finishing already-done work, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed dispatcher/precheck files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the pinned boundary and the folding commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/precheck-skips.tsv under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), appended by the dispatchd claim loop for every job its empty-run precheck or dupcheck gate finishes as DONE-NOOP without a model call — one row per skip: local timestamp, job id, exit code, reason. `phm fleet precheck-repeats --json` folds the same file into per-code, per-reason and repeated-job tallies, `phm fleet parked --json` folds its last-24-hour counts into the queue-health report, and `phm fleet queue --json` carries skipsLast24h and repeatedSkipGroups. The precheck itself is contrib/mac/launch_precheck.py plus the installed contrib/precheck.sh — pinned, Security-reviewed ops machinery agents never edit live.';

function tallyText(tallies: readonly PrecheckSkipTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: PrecheckSkipCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function groupPrompt(cell: PrecheckSkipCell): string {
  const shape = fieldText(cell.shape, TITLE_SHAPE_MAX * 2);
  return [
    `Phantom's launch precheck keeps finishing queued jobs as DONE-NOOP without a model call — ${cell.count} distinct job(s) skipped ${cell.rows} recorded time(s) inside the window for code ${cell.code} reason '${shape}', the self-improvement work this backlog exists for.`,
    '',
    `Each precheck-skips.tsv row is one dispatchd skip: the empty-run precheck or the dupcheck gate decided the work was already done or empty, so the job never launched and no agent ran. Recorded reasons: ${tallyText(cell.reasons)}.${cell.jobs.length > 0 ? ` Example job ids: ${cell.jobs.join(', ')}.` : ''}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `A skip is usually correct — the question is which producer keeps minting work master already satisfies, or whether one precheck rule now misfires on a whole class of jobs. Find which side owns the cause: the queue producers this repository owns (queuegen proposals, router-queue rows, cloud-backlog-discovered items, restock picks, issue triage) minting already-done work; the dupcheck gate or the empty-run detectors under src/core/queue misfiring; or job specs whose acceptance text the precheck can never satisfy. If the skips are the machinery working as designed on legitimately finished work — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function repeatPrompt(cell: PrecheckSkipCell): string {
  return [
    `Job '${cell.job}' was skipped by the launch precheck ${cell.rows} recorded time(s) inside the window — the queue keeps resurrecting work the precheck already finished as DONE-NOOP, the self-improvement work this backlog exists for.`,
    '',
    `Each skip consumed a ready.tsv row without a model call; for the same job id to skip again, a producer must have re-added it after the finish. Recorded codes: ${tallyText(cell.codes)}; recorded reasons: ${tallyText(cell.reasons)}.${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find the re-add path: which producer re-queues a DONE-NOOP job id — queuegen dedup, restock re-picks, router-queue regeneration or backlog re-discovery — and whether this repository's dedup (src/core/queue, backlog item id stability, the restock source-file DONE-NOOP/CLAIMED marking) should refuse the resurrection sooner. The dispatcher and precheck are pinned ops machinery — contrib/mac and ~/.ashlr-runs/bin are Security-reviewed and never edited live; fix what lives here, and if the repeats were a one-off requeue burst or the cause is pinned/owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function precheckSkipItem(cell: PrecheckSkipCell, repo: string): CloudBacklogItem {
  const hashInput = cell.kind === 'group' ? `skip-group:${cell.code}:${cell.shape}` : `skip-repeat:${cell.job}`;
  const id = `fleet-precheck-skip-${createHash('sha256').update(hashInput).digest('hex').slice(0, 16)}`;
  const title = cell.kind === 'group'
    ? `Precheck keeps skipping queued jobs: code ${cell.code} ${cell.shape}`
    : `Job ${cell.job} keeps being skipped by the launch precheck`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'group' ? groupPrompt(cell) : repeatPrompt(cell),
    area: 'precheck-skips',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the precheck-skip ledger's recurring (code,
 * reason-shape) groups and repeatedly-skipped job ids. Total: any read
 * or fold failure yields no items rather than throwing into discovery.
 */
export async function precheckSkipBacklogItems(opts: PrecheckSkipItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence readFleetQueue applies: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value
    // is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = (opts.windowHours ?? PRECHECK_SKIP_WINDOW_HOURS) * 3_600_000;
    const source = await readSource(join(runsDir, 'queue', 'precheck-skips.tsv'), PRECHECK_SKIPS_MAX_BYTES, true);
    if (source.state === 'degraded') return [];
    const cells = foldPrecheckSkipCells(source.text, nowMs, windowMs)
      .filter((cell) => cell.count >= PRECHECK_SKIP_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? PRECHECK_SKIP_MAX_ITEMS, PRECHECK_SKIP_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => precheckSkipItem(cell, repo));
  } catch {
    return [];
  }
}
