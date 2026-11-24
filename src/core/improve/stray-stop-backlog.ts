/**
 * Stray-stop ledger evidence → self-improvement backlog items.
 *
 * A "stray" is a live process still inside a finished job's worktree,
 * holding the lane slot the job already released — readStraySlots
 * (src/core/fleet/stray-slots.ts) finds them by matching live pids'
 * cwds and command lines against the worktrees of jobs whose finish is
 * recorded. stopStray (src/core/fleet/stray-stop.ts) then re-reads the
 * evidence, refuses anything that is no longer a stray or a protected
 * pid, SIGTERMs the stray and appends one audit row to
 * <runsDir>/stray-stops.jsonl:
 *
 *   {at, lane, job, pid, result} — result 'signalled' when the SIGTERM
 *   landed, 'already-gone' when the pid exited between detection and
 *   signal. Refusals and failed kills throw before the append, so every
 *   recorded row is a stray the fleet actually found and tried to stop.
 *
 * The ledger has three writers and no reader: the self-tick's
 * stray-stop step (src/cli/fleet-self-tick.ts → fleet-stray-stop.ts),
 * `phm fleet stray-stop --apply`, and the verse fleet-holds API's stop
 * route (src/core/verse/fleet-holds-api.ts). `phm fleet stray-slots`
 * serves only the LIVE report; nothing folds the history, so recurring
 * process leaks — jobs whose finish leaves children behind — never
 * became work even though each leak holds a lane slot until the next
 * reaper pass and points at the launch→finish lifecycle this
 * repository owns.
 *
 * strayStopBacklogItems carries the recorded stops into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue them
 * exactly like the stuck-job, lost-launch and sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLedgerTail's bounded
 *    no-follow tail and metrics/jobs.jsonl through the same bound for
 *    repo attribution; nothing is written and no network is touched.
 *  - Recorded rows only. A row counts only when its own fields validate
 *    against the writer's contract — result 'signalled' or
 *    'already-gone', lane and job matching the fleet's STRAY_ID_PATTERN,
 *    a safe-integer pid above 1, and a parseable timestamp inside the
 *    window. Malformed lines are skipped, never guessed.
 *  - One source, one ledger. A missing or unreadable stray-stops.jsonl
 *    silences the whole source — a fresh install whose reaper never
 *    fired is clean, not degraded.
 *  - Lane is the ledger's own field, never guessed; repo attribution is
 *    enrichment, not a gate. The fold joins metrics/jobs.jsonl through
 *    jobTimelines' canonical dialect for the job ids seen and groups
 *    repo tallies under the recorded lane. A job with no launch/claim
 *    row in the bounded tail — or an unreadable jobs ledger — simply
 *    contributes no repo tally, and items still emit because the stop
 *    rows are self-sufficient evidence.
 *  - Recurring means recorded and distinct. A lane cell emits only at
 *    STRAY_STOP_RECURRING distinct job ids inside the window, so one
 *    unlucky job leaking several pids, or one busy reaper pass, never
 *    queues a session. Both results count: 'already-gone' still
 *    recorded a stray the fleet found holding a finished job's
 *    worktree — it self-resolved before the signal landed, which is
 *    weaker evidence but the same leak — and the prompt quotes the
 *    recorded signalled/already-gone split so the session can weigh it.
 *  - Truncation is stated, never hidden. When the ledger's bounded tail
 *    cut older rows, the cell's counts are a lower bound and the prompt
 *    says so (the fleet-controller feed's convention).
 *  - The reaper and the launch path are pinned ops machinery.
 *    contrib/mac's dispatchd.py, launch.sh and install-gate.py are
 *    Security-reviewed and re-pinned; agents never edit the live copies.
 *    Items therefore emit only when the backlog target's repository name
 *    is 'phantom' — the same last-segment rule the sibling fleet-evidence
 *    sources apply — and their prompts direct sessions to fix what this
 *    repository owns (the stray detection and stop path in
 *    src/core/fleet, the finish lifecycle and queue/marker protocol's
 *    consumers in src/) or report no-change naming pinned/owner-side
 *    causes.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    lane — never the counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; a lane
 *    that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example job ids must match the fleet's own id
 *    shape before they are quoted, lane and repo strings are scrubbed,
 *    flattened and capped, and the brief carries the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { STRAY_ID_PATTERN } from '../fleet/stray-slots.js';
import { jobTimelines, parseLedgerTs, type JobTimeline } from '../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; lane cells are bounded by lane diversity. */
export const STRAY_STOP_MAX_ITEMS = 8;
const STRAY_STOP_ITEM_HARD_MAX = 25;
/**
 * Distinct jobs one lane cell needs inside the window before it counts
 * as recurring — the fleet's RECURRING_FAILURES convention the sibling
 * feeds apply to their own tallies.
 */
export const STRAY_STOP_RECURRING = 3;
/** Evidence window: three days of stray stops gives recurring patterns room without letting stale interventions linger. */
export const STRAY_STOP_WINDOW_HOURS = 72;
/** Bounded tail for the stop ledger; a row is ~120 bytes so this covers thousands of stops. */
const STRAY_STOPS_TAIL_BYTES = 512 * 1024;
/** Ledger file name at the runs dir root — the writer's own default path's basename. */
const STRAY_STOPS_FILE = 'stray-stops.jsonl';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane strings already match STRAY_ID_PATTERN (80 chars max); flatten, scrub and cap at that bound so distinct lanes never collide. */
const MAX_LANE_CHARS = 80;
/** Repo strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_REPO_CHARS = 120;
/** Distinct repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: stray-stop evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's own result vocabulary (StrayStopResultV1). */
const STRAY_RESULTS = new Set(['signalled', 'already-gone']);

export interface StrayStopItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding stray-stops.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default STRAY_STOP_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default STRAY_STOP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated stray stop: the job and pid the reaper touched, the recorded result and when (epoch ms). */
export interface StrayStopRecord {
  lane: string;
  job: string;
  pid: number;
  result: 'signalled' | 'already-gone';
  atMs: number;
}

export interface StrayStopTally {
  /** Sanitized recorded text (a repo label or result). */
  text: string;
  count: number;
}

/** One lane cell: distinct jobs that leaked stray processes plus the recorded detail the prompt quotes. */
export interface StrayStopCell {
  /** Sanitized recorded lane label. */
  lane: string;
  /** Distinct job ids with a recorded stray stop inside the window. */
  count: number;
  /** Total validated stop rows — one job leaking several pids records several rows. */
  stops: number;
  /** Recorded result mix, most frequent first (capped at MAX_PROMPT_TALLIES). */
  results: StrayStopTally[];
  /** Recorded repo labels, most frequent first (capped at MAX_PROMPT_TALLIES). */
  repos: StrayStopTally[];
  /** Up to MAX_EXAMPLES fleet-shaped job ids. */
  jobs: string[];
  /** ISO bounds of the cell's recorded stops; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the source ledger's bounded tail cut older rows: counts are a lower bound. */
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

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): StrayStopTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

/**
 * Pure: the validated stray-stop rows of a stray-stops.jsonl tail. Only
 * rows matching the writer's contract — result 'signalled' or
 * 'already-gone', STRAY_ID_PATTERN lane and job, a safe-integer pid above
 * 1, and an in-window timestamp — count; every other line — refused or
 * failed outcomes the writer never records, malformed JSON,
 * untimestamped or future-stamped rows — is skipped, never guessed.
 */
export function parseStrayStopRows(text: string, cutoffMs: number, nowMs: number): StrayStopRecord[] {
  const out: StrayStopRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const result = r['result'];
    if (typeof result !== 'string' || !STRAY_RESULTS.has(result)) continue;
    const lane = r['lane'];
    const job = r['job'];
    if (typeof lane !== 'string' || !STRAY_ID_PATTERN.test(lane)) continue;
    if (typeof job !== 'string' || !STRAY_ID_PATTERN.test(job)) continue;
    const pid = r['pid'];
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) continue;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    out.push({ lane, job, pid, result: result as StrayStopRecord['result'], atMs });
  }
  return out;
}

/**
 * Pure: fold validated stray stops into per-lane cells. The lane is the
 * ledger's own recorded field — the stray report names the lane the
 * finished job's slot belonged to — so no lane enrichment is needed;
 * only repo tallies join metrics/jobs.jsonl, and a job absent from that
 * ledger contributes none. A job the reaper stopped several times still
 * counts once toward the recurring bar: the signal is distinct jobs
 * leaking processes, not one job's pid count.
 */
export function foldStrayStopCells(
  stops: readonly StrayStopRecord[],
  repos: ReadonlyMap<string, Pick<JobTimeline, 'repo'>>,
  lowerBound = false,
): StrayStopCell[] {
  const cells = new Map<string, {
    lane: string;
    jobs: Set<string>;
    rows: number;
    results: Map<string, number>;
    repos: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const stop of stops) {
    const lane = fieldText(stop.lane, MAX_LANE_CHARS) || 'unknown';
    let cell = cells.get(lane);
    if (cell === undefined) {
      cell = { lane, jobs: new Set(), rows: 0, results: new Map(), repos: new Map(), firstMs: null, lastMs: null };
      cells.set(lane, cell);
    }
    const fresh = !cell.jobs.has(stop.job);
    cell.jobs.add(stop.job);
    cell.rows += 1;
    bump(cell.results, stop.result);
    // Repo tallies count distinct jobs like the cell count does: a job
    // whose several stray pids were each stopped is one piece of
    // evidence, not one per row.
    const repo = repos.get(stop.job)?.repo;
    if (fresh && repo !== null && repo !== undefined && repo.trim() !== '') bump(cell.repos, fieldText(repo, MAX_REPO_CHARS));
    cell.firstMs = cell.firstMs === null ? stop.atMs : Math.min(cell.firstMs, stop.atMs);
    cell.lastMs = cell.lastMs === null ? stop.atMs : Math.max(cell.lastMs, stop.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      lane: cell.lane,
      count: cell.jobs.size,
      stops: cell.rows,
      results: tallyOf(cell.results, MAX_PROMPT_TALLIES),
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      jobs: [...cell.jobs].slice(0, MAX_EXAMPLES),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane));
}

const NO_CHANGE = 'If the window has rolled forward, the leaks were a one-off burst the fleet recovered from, the jobs were legitimately long-running with detached helpers the stray bar misfired on once, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed dispatchd/launcher/reaper files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-ledger gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is stray-stops.jsonl at the fleet runs directory root (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the stray-stop reaper\'s own audit ledger, one bounded tail read — written by `phm fleet stray-stop --apply`, the self-tick\'s stray-stop step and the fleet-holds stop route, each row one SIGTERM (or an already-gone pid) on a live process still inside a finished job\'s worktree. `phm fleet stray-slots --json` is the live stray-slots.v1 report; this ledger is its history. Repo attribution joins metrics/jobs.jsonl through the same fold `phm jobs lost` and the router outcome readers use. Until this feed the ledger was write-only audit: no report folded it.';

function tallyText(tallies: readonly StrayStopTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: StrayStopCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function repoText(cell: StrayStopCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
}

function jobsText(cell: StrayStopCell): string {
  return cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
}

function boundText(cell: StrayStopCell): string {
  return cell.lowerBound ? ' The ledger tail was truncated, so these counts are a lower bound.' : '';
}

function strayStopPrompt(cell: StrayStopCell): string {
  const rows = cell.stops === cell.count ? '' : ` (${cell.stops} recorded stop rows)`;
  return [
    `Phantom's fleet keeps reaping processes that outlive their jobs — ${cell.count} distinct job(s) on lane '${cell.lane}' had stray processes stopped inside the window${rows}, the self-improvement work this backlog exists for.`,
    '',
    `The stray-stop ledger recorded one row per stop: readStraySlots found live processes still inside a finished job's worktree holding its lane slot, and stopStray re-read the evidence and SIGTERMed each stray — 'signalled' when the signal landed, 'already-gone' when the pid exited between detection and signal.${repoText(cell)} Result mix: ${tallyText(cell.results)}.${jobsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The stray detector and stop path are this repository's — src/core/fleet/stray-slots.ts decides what counts as a stray and src/core/fleet/stray-stop.ts audits each stop — while dispatchd, launch.sh and the reaper's invocation are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned, never edited live). What this repository also owns is the job lifecycle around them: whether finish recording should reap or account for the worktree's remaining processes before the slot is released, whether the queue/run marker protocol's consumers or the fleet code in src/core leave children behind, and every detector that reads this evidence.`,
    '',
    `Find where finished jobs leak processes: join metrics/jobs.jsonl for what those jobs were doing — lane, model and repo correlation, jobs whose finish legitimately detaches helpers versus wedged leftovers, whether the stray bar or the finish path misfires for a workload class, or whether the cause is pinned/host-side. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function strayStopItem(cell: StrayStopCell, repo: string): CloudBacklogItem {
  const lane = cell.lane;
  const id = `fleet-stray-stop-${createHash('sha256').update(`stray:${lane}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Finished fleet jobs keep leaving stray processes on ${lane}`.slice(0, MAX_TITLE_CHARS),
    prompt: strayStopPrompt(cell),
    area: 'stray-stops',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Bounded tail of metrics/jobs.jsonl folded through the canonical jobTimelines dialect; empty on any read failure — attribution degrades, never blocks the stop evidence. */
async function readJobRepos(runsDir: string, nowMs: number): Promise<ReadonlyMap<string, Pick<JobTimeline, 'repo'>>> {
  try {
    const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
    if (tail.state !== 'read') return new Map();
    return jobTimelines(tail.text, nowMs);
  } catch {
    return new Map();
  }
}

/**
 * Backlog items for the stray-stop ledger's recurring lane cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function strayStopBacklogItems(opts: StrayStopItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writer's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? STRAY_STOP_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(join(runsDir, STRAY_STOPS_FILE), STRAY_STOPS_TAIL_BYTES);
    const stops = tail.state === 'read' ? parseStrayStopRows(tail.text, cutoffMs, nowMs) : [];
    if (stops.length === 0) return [];
    const jobs = await readJobRepos(runsDir, nowMs);
    const cells = foldStrayStopCells(stops, jobs, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.count >= STRAY_STOP_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? STRAY_STOP_MAX_ITEMS, STRAY_STOP_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => strayStopItem(cell, repo));
  } catch {
    return [];
  }
}
