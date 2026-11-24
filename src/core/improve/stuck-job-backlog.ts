/**
 * Stuck-job reaper evidence → self-improvement backlog items.
 *
 * The self-tick's stray-stop step (src/cli/fleet-stray-stop.ts →
 * src/core/fleet/running-stuck.ts actOnStuckJobs) is the fleet's own
 * last-resort reaper for running jobs that are not really running, and it
 * keeps two audit ledgers under the runs directory's queue/:
 *
 *   - queue/stuck-jobs.jsonl — one {at, job, action:'ghost-closed'} row per
 *     ghost marker the reaper closed: the pid recorded in <ID>.launch was
 *     gone but queue/run/<ID>.line stayed open without a matching .fin, so
 *     closeGhost wrote .fin the way dispatchd does and appended the row.
 *   - queue/job-stops.jsonl — one {at, id, pids, outcome, by} row per
 *     stopJob call; rows with by:'stuck-jobs' and outcome:'stopped' are the
 *     kills the reaper made on jobs past the stuck bar (started over 90
 *     minutes ago, log silent over 30): SIGTERM, then SIGKILL after the
 *     grace, audited before the first signal.
 *
 * Until now both ledgers were write-only audit trails: stuck-jobs.jsonl has
 * no reader at all, and job-stops.jsonl is read only per-job by the job
 * window (`phm job show`). `phm jobs stuck --json` classifies the LIVE
 * marker set (jobs.stuck.v1) but folds no history, and the lost-launch
 * feed deliberately excludes open-marker jobs — the exact class ghosts
 * belong to — while a killed job's marker lingers until the next reaper
 * pass closes it as a ghost. So recurring reaper interventions, the
 * signature of a launch→reap handoff that keeps dropping finish evidence
 * or of jobs that keep hanging instead of ending, never became work.
 *
 * stuckJobBacklogItems carries the recorded interventions into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the lost-launch, tick-health,
 * precheck-skip and sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both reaper ledgers are read through readLedgerTail's
 *    bounded no-follow tails and metrics/jobs.jsonl through the same
 *    bound for lane/repo attribution; nothing is written and no network
 *    is touched.
 *  - Recorded rows only. A ledger row counts only when its own fields
 *    validate — action 'ghost-closed' with a fleet-shaped job id and a
 *    parseable timestamp inside the window for ghosts; by 'stuck-jobs'
 *    with outcome 'stopped' for kills (operator, mobile and desktop
 *    stops are deliberate acts, not reaper evidence). Malformed lines
 *    are skipped, never guessed.
 *  - Independent sources. Each class reads its own ledger: a missing or
 *    unreadable stuck-jobs.jsonl silences only the ghost class, and the
 *    same for job-stops.jsonl and the kill class. When both yield no
 *    in-window rows the whole source stays quiet — a fresh install whose
 *    reaper never fired is clean, not degraded.
 *  - Lane and repo attribution is enrichment, not a gate. The reaper
 *    ledgers record no lane; the fold joins metrics/jobs.jsonl through
 *    jobTimelines' canonical dialect for the job ids seen. A job with no
 *    launch/claim row in the bounded tail — or an unreadable jobs ledger
 *    — groups under 'unknown' rather than being guessed, and items still
 *    emit because the reaper rows are self-sufficient evidence.
 *  - Recurring means recorded and distinct. A (kind, lane) cell emits
 *    only at STUCK_JOB_RECURRING distinct job ids inside the window, so
 *    one unlucky job or one busy tick never queues a session. The two
 *    classes stay separate: 'ghost' (the process died and the marker
 *    lied until the reaper closed it — finish evidence never landed) and
 *    'stuck-kill' (a live process hung past the bar and had to be killed)
 *    need different fixes.
 *  - Truncation is stated, never hidden. When a reaper ledger's bounded
 *    tail cut older rows, the cell's counts are a lower bound and the
 *    prompt says so (the fleet-controller feed's convention).
 *  - The reaper and the launch path are pinned ops machinery.
 *    contrib/mac's dispatchd.py, launch.sh and install-gate.py are
 *    Security-reviewed and re-pinned; agents never edit the live copies.
 *    Items therefore emit only when the backlog target's repository name
 *    is 'phantom' — the same last-segment rule the sibling fleet-evidence
 *    sources apply — and their prompts direct sessions to fix what this
 *    repository owns (the queue/run marker protocol's consumers and the
 *    fleet/queue code in src/, the detectors that read this evidence) or
 *    report no-change naming pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (kind +
 *    lane — never the counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; a cell
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

/** Items one call may emit; (kind, lane) cells are bounded by lane diversity. */
export const STUCK_JOB_MAX_ITEMS = 8;
const STUCK_JOB_ITEM_HARD_MAX = 25;
/**
 * Distinct jobs one (kind, lane) cell needs inside the window before it
 * counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const STUCK_JOB_RECURRING = 3;
/** Evidence window: three days of reaper actions gives recurring patterns room without letting stale interventions linger. */
export const STUCK_JOB_WINDOW_HOURS = 72;
/** Bounded tails for the two reaper ledgers; a row is ~120 bytes so these cover thousands of actions. */
const STUCK_JOBS_TAIL_BYTES = 512 * 1024;
const JOB_STOPS_TAIL_BYTES = 512 * 1024;
/** Ledger file names under <runsDir>/queue/, the writer's own constants' values. */
const STUCK_JOBS_FILE = 'stuck-jobs.jsonl';
const JOB_STOPS_FILE = 'job-stops.jsonl';
/** The job-stops 'by' value actOnStuckJobs passes to stopJob — reaper kills, never operator stops. */
const REAPER_STOP_BY = 'stuck-jobs';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/repo strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_REPO_CHARS = 120;
/** Distinct repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: reaper evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface StuckJobItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/stuck-jobs.jsonl, queue/job-stops.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default STUCK_JOB_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default STUCK_JOB_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The two recorded reaper interventions; they need different fixes so they never share a cell. */
export type StuckJobKind = 'ghost' | 'stuck-kill';

/** One validated reaper action: the job it touched and when (epoch ms). */
export interface StuckJobAction {
  job: string;
  atMs: number;
}

export interface StuckJobTally {
  /** Sanitized recorded text (a repo label). */
  text: string;
  count: number;
}

/** One (kind, lane) cell: distinct jobs the reaper intervened on plus the recorded detail the prompt quotes. */
export interface StuckJobCell {
  kind: StuckJobKind;
  /** Sanitized lane label, or 'unknown' when the jobs ledger recorded none for these jobs. */
  lane: string;
  /** Distinct job ids the reaper acted on inside the window. */
  count: number;
  /** Recorded repo labels, most frequent first (capped at MAX_PROMPT_TALLIES). */
  repos: StuckJobTally[];
  /** Up to MAX_EXAMPLES fleet-shaped job ids. */
  jobs: string[];
  /** ISO bounds of the cell's recorded actions; null when none carried a usable timestamp. */
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

function tallyOf(map: Map<string, number>, max: number): StuckJobTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

/**
 * Pure: the ghost-close rows of a stuck-jobs.jsonl tail. Only
 * action:'ghost-closed' rows with a fleet-shaped job id and an in-window
 * timestamp count; every other line — other actions, malformed JSON,
 * untimestamped or future-stamped rows — is skipped, never guessed.
 */
export function parseGhostRows(text: string, cutoffMs: number, nowMs: number): StuckJobAction[] {
  const out: StuckJobAction[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['action'] !== 'ghost-closed') continue;
    const job = r['job'];
    if (typeof job !== 'string' || !STRAY_ID_PATTERN.test(job)) continue;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    out.push({ job, atMs });
  }
  return out;
}

/**
 * Pure: the reaper-kill rows of a job-stops.jsonl tail. Only rows the
 * stuck-job reaper itself recorded — by:'stuck-jobs' with
 * outcome:'stopped' — count; operator, mobile, desktop and refused or
 * not-running calls are deliberate acts or no-ops, not reaper evidence.
 */
export function parseStuckKillRows(text: string, cutoffMs: number, nowMs: number): StuckJobAction[] {
  const out: StuckJobAction[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    if (r['by'] !== REAPER_STOP_BY || r['outcome'] !== 'stopped') continue;
    const job = r['id'];
    if (typeof job !== 'string' || !STRAY_ID_PATTERN.test(job)) continue;
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    out.push({ job, atMs });
  }
  return out;
}

/**
 * Pure: fold validated reaper actions into per-(kind, lane) cells. The
 * lane comes from the jobs ledger's own timeline for that job — launch
 * and claim rows are the dispatch-attribution events — and groups under
 * 'unknown' when the ledger has none, is unreadable or was clipped. A
 * job the reaper touched twice still counts once: the recurring bar is
 * about distinct jobs needing rescue, not one job's repeated relaunches.
 */
export function foldStuckJobCells(
  ghosts: readonly StuckJobAction[],
  kills: readonly StuckJobAction[],
  jobs: ReadonlyMap<string, Pick<JobTimeline, 'lane' | 'repo'>>,
  lowerBound: { ghost?: boolean; 'stuck-kill'?: boolean } = {},
): StuckJobCell[] {
  const cells = new Map<string, {
    kind: StuckJobKind;
    lane: string;
    jobs: Set<string>;
    repos: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  const fold = (kind: StuckJobKind, actions: readonly StuckJobAction[]): void => {
    for (const action of actions) {
      const timeline = jobs.get(action.job);
      const lane = timeline?.lane === null || timeline?.lane === undefined || timeline.lane.trim() === ''
        ? 'unknown'
        : fieldText(timeline.lane, MAX_LANE_CHARS) || 'unknown';
      const key = JSON.stringify([kind, lane]);
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { kind, lane, jobs: new Set(), repos: new Map(), firstMs: null, lastMs: null };
        cells.set(key, cell);
      }
      const fresh = !cell.jobs.has(action.job);
      cell.jobs.add(action.job);
      // Repo tallies count distinct jobs like the cell count does: a job the
      // reaper touched twice is one piece of evidence, not two.
      const repo = timeline?.repo;
      if (fresh && repo !== null && repo !== undefined && repo.trim() !== '') bump(cell.repos, fieldText(repo, MAX_REPO_CHARS));
      cell.firstMs = cell.firstMs === null ? action.atMs : Math.min(cell.firstMs, action.atMs);
      cell.lastMs = cell.lastMs === null ? action.atMs : Math.max(cell.lastMs, action.atMs);
    }
  };
  fold('ghost', ghosts);
  fold('stuck-kill', kills);
  return [...cells.values()]
    .map((cell) => ({
      kind: cell.kind,
      lane: cell.lane,
      count: cell.jobs.size,
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      jobs: [...cell.jobs].slice(0, MAX_EXAMPLES),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound: lowerBound[cell.kind] === true,
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane) || a.kind.localeCompare(b.kind));
}

const NO_CHANGE = 'If the window has rolled forward, the interventions were a one-off burst the fleet recovered from, the jobs were legitimately long-running and the thresholds misfired once, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed dispatchd/launcher/reaper files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-ledger gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/stuck-jobs.jsonl and queue/job-stops.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the stray-stop reaper\'s own audit ledgers, one bounded tail read each — with lane and repo attribution joined from metrics/jobs.jsonl through the same fold `phm jobs lost` and the router outcome readers use. `phm jobs stuck --json` is the live jobs.stuck.v1 view of the marker set; these ledgers are its history. Until this feed, both were write-only audit: no report folded them.';

function tallyText(tallies: readonly StuckJobTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: StuckJobCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function repoText(cell: StuckJobCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
}

function jobsText(cell: StuckJobCell): string {
  return cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
}

function boundText(cell: StuckJobCell): string {
  return cell.lowerBound ? ' The ledger tail was truncated, so these counts are a lower bound.' : '';
}

function ghostPrompt(cell: StuckJobCell): string {
  return [
    `Phantom's fleet keeps leaving run markers that outlive dead jobs — ${cell.count} distinct job(s) ghost-closed on lane '${cell.lane}' inside the window, the self-improvement work this backlog exists for.`,
    '',
    `The stray-stop reaper's ledger recorded action 'ghost-closed': the pid in <ID>.launch was gone but queue/run/<ID>.line stayed open without a matching .fin, so the reaper wrote .fin the way dispatchd does and appended the audit row.${repoText(cell)}${jobsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The reaper, dispatchd and the launcher are pinned ops machinery — contrib/mac's dispatchd.py, launch.sh and install-gate.py are Security-reviewed and re-pinned, and agents never edit the live copies under ~/.ashlr-runs/bin. What this repository owns is the queue/run marker protocol's consumers and the fleet/queue code in src/core, the finish-evidence writers, and every detector that reads this evidence — outcome learning only counts recorded terminal rows, so a job whose process died before the reap path wrote .fin or a finish row leaves a marker that lied until the reaper closed it, and the lost-launch feed excludes open-marker jobs by design.`,
    '',
    `Find where the launch→reap handoff drops the finish: whether the marker protocol or the finish-evidence writers in this repo should close or record the gap sooner, whether the fleet should detect the dead-pid marker earlier than the reaper's pass, or whether the cause is pinned/host-side. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function stuckKillPrompt(cell: StuckJobCell): string {
  return [
    `Phantom's fleet keeps killing jobs that run past the stuck bar — ${cell.count} distinct job(s) stopped by the reaper on lane '${cell.lane}' inside the window, the self-improvement work this backlog exists for.`,
    '',
    `The reaper's stopJob audit recorded by 'stuck-jobs' with outcome 'stopped': jobs older than 90 minutes whose logs had been silent for over 30 minutes still had live fleet processes, so the reaper SIGTERMed them and SIGKILLed survivors after the grace.${repoText(cell)}${jobsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The reaper thresholds and the stuck classification live in src/core/fleet/running-stuck.ts — this repository owns them — while dispatchd, launch.sh and the reaper's invocation are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned, never edited live). What this repository also owns is the queue/job lifecycle around them: whether jobs that legitimately run long should carry a progress signal the silence check can see, whether an earlier timeout belongs in the queue spec or fleet code, and every detector that reads this evidence.`,
    '',
    `Find whether the hangs are real: join metrics/jobs.jsonl for what those jobs were doing — lane, model and repo correlation, jobs that legitimately run long versus wedged ones, whether the 90-minute/30-minute bars misfire for a workload class, or whether the cause is pinned/host-side. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function stuckJobItem(cell: StuckJobCell, repo: string): CloudBacklogItem {
  const lane = cell.lane;
  const titles: Record<StuckJobKind, string> = {
    'ghost': `Fleet jobs keep leaving ghost run markers on ${lane}`,
    'stuck-kill': `Fleet jobs keep hanging until the reaper kills them on ${lane}`,
  };
  const id = `fleet-stuck-job-${createHash('sha256').update(`stuck:${cell.kind}:${lane}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'ghost' ? ghostPrompt(cell) : stuckKillPrompt(cell),
    area: 'stuck-jobs',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Bounded tail of metrics/jobs.jsonl folded through the canonical jobTimelines dialect; empty on any read failure — attribution degrades to 'unknown', never blocks the reaper evidence. */
async function readJobTimelines(runsDir: string, nowMs: number): Promise<ReadonlyMap<string, JobTimeline>> {
  try {
    const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
    if (tail.state !== 'read') return new Map();
    return jobTimelines(tail.text, nowMs);
  } catch {
    return new Map();
  }
}

/**
 * Backlog items for the stuck-job reaper's recurring (kind, lane) cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function stuckJobBacklogItems(opts: StuckJobItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the reaper's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? STUCK_JOB_WINDOW_HOURS) * 3_600_000;
    const [ghostTail, stopTail] = await Promise.all([
      readLedgerTail(join(runsDir, 'queue', STUCK_JOBS_FILE), STUCK_JOBS_TAIL_BYTES),
      readLedgerTail(join(runsDir, 'queue', JOB_STOPS_FILE), JOB_STOPS_TAIL_BYTES),
    ]);
    const ghosts = ghostTail.state === 'read' ? parseGhostRows(ghostTail.text, cutoffMs, nowMs) : [];
    const kills = stopTail.state === 'read' ? parseStuckKillRows(stopTail.text, cutoffMs, nowMs) : [];
    if (ghosts.length === 0 && kills.length === 0) return [];
    const jobs = await readJobTimelines(runsDir, nowMs);
    const cells = foldStuckJobCells(ghosts, kills, jobs, {
      ghost: ghostTail.state === 'read' && ghostTail.truncated === true,
      'stuck-kill': stopTail.state === 'read' && stopTail.truncated === true,
    }).filter((cell) => cell.count >= STUCK_JOB_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? STUCK_JOB_MAX_ITEMS, STUCK_JOB_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => stuckJobItem(cell, repo));
  } catch {
    return [];
  }
}
