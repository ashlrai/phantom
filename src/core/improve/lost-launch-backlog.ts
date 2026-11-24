/**
 * Lost-launch evidence → self-improvement backlog items.
 *
 * `phm jobs lost` (src/core/fleet/lost-launches.ts, schema jobs.lost.v1)
 * folds the tail of metrics/jobs.jsonl plus the first line of each recent
 * <ID>.launch file into the launches that vanished: a `launch` event with
 * no `finish`/`publish` row afterwards once the 30-minute launch grace has
 * passed ('launched, never finished'), or a .launch file whose first line
 * begins 'error:' — the launcher died after the job was claimed ('launch
 * failed: …', e.g. the shared-clone git ref lock race). Two honesty gaps in
 * that report keep it out of the backlog on its own: it is a report someone
 * had to run and read (and `phm fleet supply-doctor` only counts the 24 h
 * subset in its verdict line), and it cannot tell a vanished launch from a
 * job that is simply still running — any launch older than the grace with
 * no finish yet reads as lost, and fleet jobs legitimately run past 30
 * minutes.
 *
 * lostLaunchBacklogItems carries the corroborated evidence into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review,
 * empty-tag, post-merge and ci-rerun sources beside it. A launch counts as
 * lost evidence only when the job holds no open run marker —
 * queue/run/<ID>.line without a matching .fin is the dispatcher's own
 * running rule (src/core/fleet/running-stuck.ts), so a job the fleet still
 * counts as running is never queued as work. What remains is the gap no
 * other fold sees: outcome learning censors an unresolved attempt until
 * its horizon and never counts it, `launch_failed`/`launch_terminal` rows
 * close attempts as non-breakage 'closed', and the silent vanish writes no
 * terminal row at all.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLostLaunches'
 *    bounded 8 MiB no-follow tail and the .launch heads through its capped
 *    parallel first-line reads; run markers through readRunningJobs'
 *    bounded marker scan. Nothing is written and no network is touched.
 *  - Healthy-only evidence. An unreadable jobs ledger yields
 *    known:false and no items; a runs dir whose queue/run markers cannot
 *    be listed yields no items either — without the running-set the
 *    vanished class cannot be told from a long job, so unknown stays
 *    unknown. A missing queue/run directory is a clean empty running set,
 *    not an error.
 *  - Recurring means recorded. A (lane, class) cell emits only at
 *    LOST_LAUNCH_RECURRING corroborated losses inside the window, so one
 *    crashed launcher or one slow job never queues a session. The two
 *    classes stay separate: 'launch-error' (the .launch first line records
 *    the launcher died — shared-clone ref races, disk, lane auth) and
 *    'vanished' (launched, no terminal row, no open marker — the
 *    launch→run handoff dropped the job) need different fixes.
 *  - Lane attribution is as recorded. Launch rows carry lane|pool|arm;
 *    rows without one group under 'unknown' rather than being guessed.
 *    The recorded repo tallies ride inside the prompt as evidence — the
 *    launch machinery is this install's, shared across every repository
 *    the fleet serves.
 *  - The launch path is pinned ops machinery. contrib/mac's launch.sh,
 *    batch-launch.sh and dispatchd.py are Security-reviewed and re-pinned;
 *    agents never edit the live copies. Items therefore emit only when the
 *    backlog target's repository name is 'phantom' — the same last-segment
 *    rule the sibling fleet-evidence sources apply — and their prompts
 *    direct sessions to fix what this repository owns (the queue/job
 *    lifecycle and fleet code in src/, the detectors that read this
 *    evidence) or report no-change naming pinned/owner-side causes.
 *  - Dedup is downstream. The item id hashes the cell identity (class +
 *    lane — never the counts or timestamps), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; a cell
 *    that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example job ids must match the ledger's own id
 *    shape before they are quoted, reason and repo strings are scrubbed,
 *    flattened and capped, and the brief carries the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  readLostLaunches,
  type LostLaunch,
} from '../fleet/lost-launches.js';
import { readRunningJobs } from '../fleet/running-stuck.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (lane, class) cells are bounded by lane diversity. */
export const LOST_LAUNCH_MAX_ITEMS = 8;
const LOST_LAUNCH_ITEM_HARD_MAX = 25;
/**
 * Corroborated losses one (lane, class) cell needs inside the window before
 * it counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const LOST_LAUNCH_RECURRING = 3;
/** Evidence window: three days of launches gives recurring patterns room without letting stale losses linger. */
export const LOST_LAUNCH_WINDOW_HOURS = 72;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/repo/reason strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_REPO_CHARS = 120;
const MAX_REASON_CHARS = 160;
/** Distinct reason and repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt; each must match the ledger id shape. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: launch evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The job-id shape the runs dir and ledger use; anything else is never quoted into a prompt. */
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LostLaunchItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl, <ID>.launch files and queue/run markers; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default LOST_LAUNCH_WINDOW_HOURS). */
  sinceHours?: number;
  /** Most items one call emits (default LOST_LAUNCH_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The two recorded loss shapes; they need different fixes so they never share a cell. */
export type LostLaunchKind = 'launch-error' | 'vanished';

export interface LostLaunchTally {
  /** Sanitized recorded text (a reason or a repo label). */
  text: string;
  count: number;
}

/** One (lane, class) cell: corroborated losses plus the recorded detail the prompt quotes. */
export interface LostLaunchCell {
  /** Sanitized lane label, or 'unknown' when the ledger recorded none. */
  lane: string;
  kind: LostLaunchKind;
  /** Corroborated lost launches inside the window — distinct jobs. */
  count: number;
  /** Recorded reasons, most frequent first (capped at MAX_PROMPT_TALLIES). */
  reasons: LostLaunchTally[];
  /** Recorded repo labels, most frequent first (capped at MAX_PROMPT_TALLIES). */
  repos: LostLaunchTally[];
  /** Up to MAX_EXAMPLES ledger-safe job ids. */
  jobs: string[];
  /** ISO bounds of the cell's recorded launches; null when none carried a timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const kindOf = (reason: string): LostLaunchKind =>
  reason.startsWith('launch failed:') ? 'launch-error' : 'vanished';

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): LostLaunchTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: fold the lost-launch report into per-(lane, class) cells. Jobs the
 * dispatcher still counts as running (an open queue/run marker) are
 * excluded — a launch older than the grace with no finish yet is a long
 * job, not a loss. Everything else the report calls lost is corroborated:
 * no terminal row and no open marker.
 */
export function foldLostLaunchCells(
  lost: readonly LostLaunch[],
  running: ReadonlySet<string>,
): LostLaunchCell[] {
  const cells = new Map<string, {
    lane: string;
    kind: LostLaunchKind;
    count: number;
    reasons: Map<string, number>;
    repos: Map<string, number>;
    jobs: string[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const item of lost) {
    if (running.has(item.job)) continue;
    const kind = kindOf(item.reason);
    const lane = item.lane === null || item.lane.trim() === ''
      ? 'unknown'
      : fieldText(item.lane, MAX_LANE_CHARS) || 'unknown';
    const key = JSON.stringify([kind, lane]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { lane, kind, count: 0, reasons: new Map(), repos: new Map(), jobs: [], firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    cell.count += 1;
    bump(cell.reasons, fieldText(item.reason, MAX_REASON_CHARS) || 'unrecorded reason');
    if (item.repo !== null && item.repo.trim() !== '') bump(cell.repos, fieldText(item.repo, MAX_REPO_CHARS));
    if (cell.jobs.length < MAX_EXAMPLES && SAFE_JOB_ID.test(item.job) && !cell.jobs.includes(item.job)) cell.jobs.push(item.job);
    const at = item.launched_at === null ? NaN : Date.parse(item.launched_at);
    if (Number.isFinite(at)) {
      cell.firstMs = cell.firstMs === null ? at : Math.min(cell.firstMs, at);
      cell.lastMs = cell.lastMs === null ? at : Math.max(cell.lastMs, at);
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      lane: cell.lane,
      kind: cell.kind,
      count: cell.count,
      reasons: tallyOf(cell.reasons, MAX_PROMPT_TALLIES),
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      jobs: cell.jobs,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane) || a.kind.localeCompare(b.kind));
}

const NO_CHANGE = 'If the window has rolled forward, the losses were a one-off burst the next launches recovered from, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the marker rule is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/jobs.jsonl plus the first line of each recent <ID>.launch file under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), folded by `phm jobs lost --since 72h --json` into the jobs.lost.v1 report — with one addition this feed makes: jobs still holding an open queue/run/<ID>.line marker are running per the dispatcher\'s own rule (src/core/fleet/running-stuck.ts) and are excluded, so `phm jobs lost` on its own shows the uncorroborated superset. `phm fleet supply-doctor` counts only the 24-hour subset in its verdict line.';

function tallyText(tallies: readonly LostLaunchTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: LostLaunchCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function repoText(cell: LostLaunchCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
}

function jobsText(cell: LostLaunchCell): string {
  return cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
}

function launchErrorPrompt(cell: LostLaunchCell): string {
  return [
    `Phantom's launch path keeps dying before jobs start — ${cell.count} recorded launch failure(s) on lane '${cell.lane}' inside the window, the self-improvement work this backlog exists for.`,
    '',
    `A <ID>.launch first line under the fleet runs directory begins 'error:' — the launcher died after the job was claimed, so no agent ever ran and (usually) no launch_failed row reached metrics/jobs.jsonl. Recorded reasons: ${tallyText(cell.reasons)}.${repoText(cell)}${jobsText(cell)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The launcher itself is pinned ops machinery — contrib/mac's launch.sh, batch-launch.sh and dispatchd.py are Security-reviewed and re-pinned, and agents never edit the live copies under ~/.ashlr-runs/bin. What this repository owns is the queue/job lifecycle and fleet code the launch path feeds (src/core/queue, src/core/fleet), the job specs the queue carries, and every detector that reads this evidence — outcome learning only sees launch_failed rows the launcher managed to write, never these silent deaths.`,
    '',
    `Find which side owns the cause: reproduce the recorded reason against the launch path — the shared-clone git ref lock race, a full runs volume, lane auth or quota, a job spec the launcher rejects — then check whether repo-side code should prevent it, requeue the work faster, or record better terminal evidence, and fix what lives here. If the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function vanishedPrompt(cell: LostLaunchCell): string {
  return [
    `Phantom's fleet keeps launching jobs that then vanish — ${cell.count} recorded case(s) on lane '${cell.lane}' inside the window, the self-improvement work this backlog exists for.`,
    '',
    `A launch event in metrics/jobs.jsonl has no finish or publish row afterwards once the 30-minute launch grace passed, and the job holds no open queue/run/<ID>.line marker — the dispatcher no longer counts it running and no terminal evidence exists. Recorded reasons: ${tallyText(cell.reasons)}.${repoText(cell)}${jobsText(cell)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The launch path is pinned ops machinery (contrib/mac launch.sh, batch-launch.sh, dispatchd.py — Security-reviewed, re-pinned, never edited live). What this repository owns is the queue/job lifecycle and fleet code around it (src/core/queue, src/core/fleet) and every detector that reads this evidence: outcome learning censors an unresolved attempt until its horizon and never counts it as a failure, so a silent vanish is invisible to every existing fold.`,
    '',
    `Find where the launch→run handoff drops the job: whether queue specs, admission or the ledger writers in this repo should record a terminal row when a launch produces nothing, whether the fleet should detect and requeue the vanish sooner, or whether the cause is pinned/owner-side. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function lostLaunchItem(cell: LostLaunchCell, repo: string): CloudBacklogItem {
  const lane = cell.lane;
  const titles: Record<LostLaunchKind, string> = {
    'launch-error': `Fleet launches keep dying at launch on ${lane}`,
    vanished: `Fleet jobs keep launching then vanishing on ${lane}`,
  };
  const id = `fleet-lost-launch-${createHash('sha256').update(`lost:${cell.kind}:${lane}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: cell.kind === 'launch-error' ? launchErrorPrompt(cell) : vanishedPrompt(cell),
    area: 'lost-launches',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the lost-launch report's recurring (lane, class)
 * cells, corroborated against open run markers. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function lostLaunchBacklogItems(opts: LostLaunchItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence readLostLaunches applies: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const report = await readLostLaunches(opts.sinceHours ?? LOST_LAUNCH_WINDOW_HOURS, {
      runsDir,
      now: () => nowMs,
    });
    if (!report.known) return [];
    let running: ReadonlySet<string>;
    try {
      running = new Set((await readRunningJobs(runsDir)).map((job) => job.job));
    } catch (error) {
      // A missing queue/run directory is a clean empty running set; any
      // other read failure means the vanished class cannot be told from a
      // long job, so the whole source stays quiet.
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') running = new Set();
      else return [];
    }
    const cells = foldLostLaunchCells(report.lost, running)
      .filter((cell) => cell.count >= LOST_LAUNCH_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? LOST_LAUNCH_MAX_ITEMS, LOST_LAUNCH_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => lostLaunchItem(cell, repo));
  } catch {
    return [];
  }
}
