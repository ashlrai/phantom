/**
 * Worktree-reap evidence → self-improvement backlog items.
 *
 * The self-tick's planner-tick stage runs the scheduled worktree reap
 * (src/cli/fleet-self-tick.ts → src/core/fleet/worktree-reap-tick.ts →
 * src/core/fleet/worktrees.ts readWorktrees('apply')). Whenever job
 * worktrees pass the warning level it removes up to WORKTREE_REAP_CAP
 * safe ones — never --force — and removeSafe appends one audit row per
 * removal attempt to queue/worktree-reap.jsonl under the runs directory:
 *
 *   {job, status, reason?, via?, at}
 *
 *   - status 'removed' — git worktree remove succeeded (via may be
 *     'stale-no-publish' when the never-published quiet-period gate
 *     qualified the row).
 *   - status 'refused' — a safety gate declined the removal; reason is
 *     'state-changed' (the audit→remove recheck saw the worktree's state
 *     or hold move), 'uncommitted-changes', 'unpushed-commits' or
 *     'unsafe-path' (git refused the path itself).
 *   - status 'failed'  — the removal was attempted and git errored;
 *     reason 'git-remove-failed'.
 *
 * Until now the journal's only reader was the newest-attempt fold inside
 * `phm worktrees --reap --status` and the ReaperHealth verdict the
 * worktrees report computes — reports someone had to run and read. The
 * journal itself is append-only history nobody folded: a reap whose
 * removals keep failing, whose unsafe-path refusals keep recurring (a
 * naming/path bug minting un-reapable worktrees), or whose dirty and
 * unpushed holds keep stranding finished jobs' worktrees forever — the
 * exact accumulation the reap exists to bound — never became work.
 *
 * worktreeReapBacklogItems carries the recorded attempts into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the stuck-job, lost-launch and
 * sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The reap journal is read through readLedgerTail's
 *    bounded no-follow tail and metrics/jobs.jsonl through the same
 *    bound for lane/repo attribution; nothing is written and no network
 *    is touched.
 *  - Recorded rows only. A journal row counts only when its own fields
 *    validate — a worktree-name-shaped job id, a known status, a known
 *    refusal reason where the status requires one, and a parseable
 *    timestamp inside the window. Malformed lines are skipped, never
 *    guessed. 'removed' rows are success evidence, not backlog signal,
 *    and 'refused'/'state-changed' rows are the audit→remove recheck
 *    doing its job — routine churn on a busy fleet, never emitted.
 *  - Lane and repo attribution is enrichment, not a gate. The journal
 *    records no lane; the fold joins metrics/jobs.jsonl through
 *    jobTimelines' canonical dialect for the job ids seen. A worktree
 *    with no launch/claim row in the bounded tail — or an unreadable
 *    jobs ledger — groups under 'unknown' rather than being guessed,
 *    and items still emit because the journal rows are self-sufficient
 *    evidence.
 *  - Recurring means recorded and distinct. A (kind, lane) cell emits
 *    only at WORKTREE_REAP_RECURRING distinct job ids inside the window,
 *    so one unlucky worktree or one bad batch tick never queues a
 *    session. The kinds stay separate because they need different
 *    fixes: 'remove-failed' (the git removal itself errors),
 *    'unsafe-path' (worktrees minted at paths the remover cannot
 *    touch), 'unpushed-commits' and 'uncommitted-changes' (safety holds
 *    stranding finished jobs' worktrees — the upstream finish/publish
 *    path left work behind).
 *  - Truncation is stated, never hidden. When the journal's bounded
 *    tail cut older rows, the cell's counts are a lower bound and the
 *    prompt says so (the fleet-controller feed's convention).
 *  - The reaper and the removal path live in this repository
 *    (src/core/fleet/worktrees.ts, worktree-reap-tick.ts,
 *    fleet-self-tick.ts) while dispatchd, launch.sh, publish.sh and
 *    install-gate.py are pinned ops machinery. Items therefore emit
 *    only when the backlog target's repository name is 'phantom' —
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply — and their prompts direct sessions to fix what this
 *    repository owns or report no-change naming pinned/owner-side
 *    causes.
 *  - Dedup is downstream. The item id hashes the cell identity (kind +
 *    lane — never the counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the worktree
 *    name shape before they are quoted, lane and repo strings are
 *    scrubbed, flattened and capped, and the brief carries the usual
 *    no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { jobTimelines, parseLedgerTs, type JobTimeline } from '../metrics/loop.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (kind, lane) cells are bounded by lane diversity. */
export const WORKTREE_REAP_MAX_ITEMS = 8;
const WORKTREE_REAP_ITEM_HARD_MAX = 25;
/**
 * Distinct jobs one (kind, lane) cell needs inside the window before it
 * counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const WORKTREE_REAP_RECURRING = 3;
/**
 * Evidence window: the reap only journals when worktrees pass the warning
 * level and at most once per 30 minutes, so rows are sparse — a week of
 * attempts gives recurring patterns room without letting stale evidence
 * linger (the sibling feeds' 7-day convention).
 */
export const WORKTREE_REAP_WINDOW_HOURS = 168;
/** Bounded tail for the reap journal; a row is ~150 bytes so this covers thousands of attempts. */
const WORKTREE_REAP_TAIL_BYTES = 512 * 1024;
/** Journal file name under <runsDir>/queue/, the writer's own constant value (worktrees.ts logRemoval). */
const REAP_JOURNAL_FILE = 'worktree-reap.jsonl';
/** The worktree-name shape wt-audit applies to job worktree folders (its JOB_ID rule). */
const REAP_JOB_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Lane/repo strings are ledger-recorded text; flatten, scrub and cap before use. */
const MAX_LANE_CHARS = 60;
const MAX_REPO_CHARS = 120;
/** Distinct repo tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: reap evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface WorktreeReapItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding queue/worktree-reap.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default WORKTREE_REAP_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default WORKTREE_REAP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/**
 * The recorded removal outcomes that can become work. 'state-changed'
 * refusals and successful 'removed' rows are deliberately absent: the
 * first is the audit→remove recheck working, the second is the reap
 * doing its job.
 */
export type WorktreeReapKind = 'remove-failed' | 'unsafe-path' | 'unpushed-commits' | 'uncommitted-changes';

/** One validated reap attempt: the worktree it touched, its outcome class and when (epoch ms). */
export interface WorktreeReapAction {
  job: string;
  kind: WorktreeReapKind;
  /** The journal's own reason label, kept for the prompt tally ('git-remove-failed', the refusal reasons). */
  reason: string;
  /** 'stale-no-publish' when the quiet-period gate qualified the row, else 'standard'. */
  via: string;
  atMs: number;
}

export interface WorktreeReapTally {
  /** Sanitized recorded text (a repo or reason label). */
  text: string;
  count: number;
}

/** One (kind, lane) cell: distinct worktrees the reap could not clear plus the recorded detail the prompt quotes. */
export interface WorktreeReapCell {
  kind: WorktreeReapKind;
  /** Sanitized lane label, or 'unknown' when the jobs ledger recorded none for these jobs. */
  lane: string;
  /** Distinct job/worktree ids the reap recorded inside the window. */
  count: number;
  /** Recorded repo labels, most frequent first (capped at MAX_PROMPT_TALLIES). */
  repos: WorktreeReapTally[];
  /** Recorded reason labels, most frequent first — meaningful on 'remove-failed' cells. */
  reasons: WorktreeReapTally[];
  /** Recorded via labels ('stale-no-publish' vs 'standard'), most frequent first. */
  vias: WorktreeReapTally[];
  /** Up to MAX_EXAMPLES worktree-name-shaped job ids. */
  jobs: string[];
  /** ISO bounds of the cell's recorded attempts; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older rows: counts are a lower bound. */
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

function tallyOf(map: Map<string, number>, max: number): WorktreeReapTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

const inWindow = (atMs: number, cutoffMs: number, nowMs: number): boolean =>
  atMs >= cutoffMs && atMs <= nowMs;

/** Journal status values removeSafe writes; anything else is a foreign or corrupt row. */
const KNOWN_STATUS = new Set(['removed', 'refused', 'failed']);
/** Refusal reasons the safety gates record; 'state-changed' is excluded at the kind map. */
const REFUSAL_KIND: Record<string, WorktreeReapKind> = {
  'unsafe-path': 'unsafe-path',
  'unpushed-commits': 'unpushed-commits',
  'uncommitted-changes': 'uncommitted-changes',
};

/**
 * Pure: the emit-worthy rows of a worktree-reap.jsonl tail. Only rows
 * whose own fields validate count — a worktree-name-shaped job id, a
 * known status, a recognized outcome (failed, or refused with one of
 * the three stranding/unsafe reasons), and an in-window timestamp.
 * 'removed' successes, 'state-changed' recheck refusals, refused rows
 * with no usable reason, malformed JSON and untimestamped or
 * future-stamped rows are all skipped, never guessed.
 */
export function parseReapRows(text: string, cutoffMs: number, nowMs: number): WorktreeReapAction[] {
  const out: WorktreeReapAction[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const job = r['job'];
    const status = r['status'];
    if (typeof job !== 'string' || !REAP_JOB_PATTERN.test(job)) continue;
    if (typeof status !== 'string' || !KNOWN_STATUS.has(status)) continue;
    const reason = typeof r['reason'] === 'string' && r['reason'].trim() !== '' ? r['reason'].trim() : null;
    let kind: WorktreeReapKind;
    if (status === 'failed') {
      kind = 'remove-failed';
    } else if (status === 'refused' && reason !== null) {
      const mapped = REFUSAL_KIND[reason];
      if (mapped === undefined) continue; // 'state-changed' and unknown reasons never emit.
      kind = mapped;
    } else {
      continue; // 'removed' rows are success evidence, not backlog signal.
    }
    const atMs = parseLedgerTs(r['at']);
    if (atMs === null || !inWindow(atMs, cutoffMs, nowMs)) continue;
    const via = r['via'] === 'stale-no-publish' ? 'stale-no-publish' : 'standard';
    out.push({ job, kind, reason: reason ?? 'unrecorded', via, atMs });
  }
  return out;
}

/**
 * Pure: fold validated reap attempts into per-(kind, lane) cells. The
 * lane comes from the jobs ledger's own timeline for that job — launch
 * and claim rows are the dispatch-attribution events — and groups under
 * 'unknown' when the ledger has none, is unreadable or was clipped. A
 * job the reap touched twice still counts once: the recurring bar is
 * about distinct worktrees needing rescue, not one worktree's repeated
 * refusals across runs.
 */
export function foldReapCells(
  actions: readonly WorktreeReapAction[],
  jobs: ReadonlyMap<string, Pick<JobTimeline, 'lane' | 'repo'>>,
  lowerBound = false,
): WorktreeReapCell[] {
  const cells = new Map<string, {
    kind: WorktreeReapKind;
    lane: string;
    jobs: Set<string>;
    repos: Map<string, number>;
    reasons: Map<string, number>;
    vias: Map<string, number>;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const action of actions) {
    const timeline = jobs.get(action.job);
    const lane = timeline?.lane === null || timeline?.lane === undefined || timeline.lane.trim() === ''
      ? 'unknown'
      : fieldText(timeline.lane, MAX_LANE_CHARS) || 'unknown';
    const key = JSON.stringify([action.kind, lane]);
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { kind: action.kind, lane, jobs: new Set(), repos: new Map(), reasons: new Map(), vias: new Map(), firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    const fresh = !cell.jobs.has(action.job);
    cell.jobs.add(action.job);
    // Repo/reason/via tallies count distinct jobs like the cell count
    // does: a worktree the reap touched twice is one piece of evidence.
    const repo = timeline?.repo;
    if (fresh && repo !== null && repo !== undefined && repo.trim() !== '') bump(cell.repos, fieldText(repo, MAX_REPO_CHARS));
    if (fresh) {
      bump(cell.reasons, fieldText(action.reason, MAX_LANE_CHARS) || 'unrecorded');
      bump(cell.vias, action.via);
    }
    cell.firstMs = cell.firstMs === null ? action.atMs : Math.min(cell.firstMs, action.atMs);
    cell.lastMs = cell.lastMs === null ? action.atMs : Math.max(cell.lastMs, action.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      kind: cell.kind,
      lane: cell.lane,
      count: cell.jobs.size,
      repos: tallyOf(cell.repos, MAX_PROMPT_TALLIES),
      reasons: tallyOf(cell.reasons, MAX_PROMPT_TALLIES),
      vias: tallyOf(cell.vias, MAX_PROMPT_TALLIES),
      jobs: [...cell.jobs].slice(0, MAX_EXAMPLES),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane) || a.kind.localeCompare(b.kind));
}

const NO_CHANGE = 'If the window has rolled forward, the attempts were a one-off burst the fleet recovered from, the refusals were legitimate holds on work that is genuinely kept, or the cause is owner-only or pinned ops machinery (credentials, billing, host disk, the Security-reviewed dispatchd/launcher/publish files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-journal gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is queue/worktree-reap.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the scheduled reap\'s own removal-attempt journal, one bounded tail read, appended by src/core/fleet/worktrees.ts removeSafe every time the self-tick\'s planner-tick stage runs the reap (only while job worktrees pass the warning level, at most once per 30 minutes, capped per run). `phm worktrees --reap --status` shows the last run summary and `phm worktrees --json` lists the current rows and holds. Until this feed the journal had no trend fold — only the newest-attempt read inside those reports.';

function tallyText(tallies: readonly WorktreeReapTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: WorktreeReapCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function repoText(cell: WorktreeReapCell): string {
  return cell.repos.length === 0 ? '' : ` Recorded repositories: ${tallyText(cell.repos)}.`;
}

function jobsText(cell: WorktreeReapCell): string {
  return cell.jobs.length === 0 ? '' : ` Example job ids: ${cell.jobs.join(', ')}.`;
}

function boundText(cell: WorktreeReapCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function staleText(cell: WorktreeReapCell): string {
  const stale = cell.vias.find((v) => v.text === 'stale-no-publish');
  return stale === undefined ? '' : ` ${stale.count} of them qualified through the stale-no-publish quiet-period gate.`;
}

function removeFailedPrompt(cell: WorktreeReapCell): string {
  return [
    `Phantom's scheduled worktree reap keeps failing to remove job worktrees — ${cell.count} distinct worktree(s) recorded failed removals on lane '${cell.lane}' inside the window, while finished jobs keep accumulating on disk.`,
    '',
    `The reap journal recorded status 'failed' — the safety gates passed and git worktree remove itself errored.${cell.reasons.length > 0 ? ` Recorded reasons: ${tallyText(cell.reasons)}.` : ''}${repoText(cell)}${jobsText(cell)}${seenText(cell)}${staleText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The removal path is this repository's own: src/core/fleet/worktrees.ts removeSafe runs \`git worktree remove\` (never --force) after the audit→remove recheck, src/core/fleet/worktree-reap-tick.ts bounds each run, and the self-tick planner-tick stage invokes it — while dispatchd, launch.sh, publish.sh and install-gate.py are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned, never edited live). What this repository owns is the whole reap path: whether the audit's safe classification can go stale between read and remove, whether locked worktrees, nested repositories, path-length or filesystem limits make git refuse, whether a failed removal should mark the worktree so the next audit does not retry it forever, and every detector that reads this evidence.`,
    '',
    `Find why the removals error: reproduce the audit on the named worktrees, check git's own refusal reason where it is recorded, and whether the recheck or the remover should handle the case. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unsafePathPrompt(cell: WorktreeReapCell): string {
  return [
    `Phantom's scheduled worktree reap keeps refusing worktrees on unsafe paths — ${cell.count} distinct worktree(s) recorded unsafe-path refusals on lane '${cell.lane}' inside the window, so those worktrees can never be reaped and disk keeps growing.`,
    '',
    `The reap journal recorded status 'refused' with reason 'unsafe-path': the remover's path-safety check declined the worktree path itself, before git ran.${repoText(cell)}${jobsText(cell)}${seenText(cell)}${staleText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The path check and the worktree-name → path mapping are this repository's own — src/core/fleet/worktrees.ts and wt-audit.ts decide which folders count as job worktrees and which paths the remover may touch — while dispatchd and the launcher that mint the worktree folders are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned). What this repository owns is whether the unsafe-path rule is misfiring on legitimate job worktrees (a too-strict pattern, a path-joining bug, symlinked roots) or correctly refusing paths that should never have been minted — in which case the minting side's contract is the thing to tighten.`,
    '',
    `Find which paths trip the check and why: join the named job ids to their worktree folders, compare against the safety rule, and decide whether the rule or the minting contract is wrong. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unpushedCommitsPrompt(cell: WorktreeReapCell): string {
  return [
    `Phantom's finished job worktrees keep holding unpushed commits — ${cell.count} distinct worktree(s) recorded unpushed-commits refusals on lane '${cell.lane}' inside the window, so the safety gate can never reap them and they accumulate on disk.`,
    '',
    `The reap journal recorded status 'refused' with reason 'unpushed-commits': the worktree's branch has commits its upstream never received, so removal would lose work.${repoText(cell)}${jobsText(cell)}${seenText(cell)}${staleText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The hasUnpushed check and the reap gates are this repository's own (src/core/fleet/worktrees.ts), and so is the queue/job lifecycle around publish — while publish.sh, dispatchd and the finish path's host side are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned). What this repository owns is whether the check misfires — e.g. counting branches whose upstream was never configured, or commits that are already merged under a different ref — versus jobs genuinely finishing with work that never reached a remote, which is a publish-contract gap to close in the finish evidence this repo writes.`,
    '',
    `Find whether the refusals are correct holds or a misfiring check: join the named jobs to their publish/finish rows in metrics/jobs.jsonl, check whether their branches actually carry unpushed commits today, and whether the gate should distinguish 'work exists nowhere else' from 'upstream bookkeeping missing'. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function uncommittedChangesPrompt(cell: WorktreeReapCell): string {
  return [
    `Phantom's job worktrees keep holding uncommitted changes — ${cell.count} distinct worktree(s) recorded uncommitted-changes refusals on lane '${cell.lane}' inside the window, so the safety gate can never reap them and they accumulate on disk.`,
    '',
    `The reap journal recorded status 'refused' with reason 'uncommitted-changes': the worktree has uncommitted files, so removal could lose work.${repoText(cell)}${jobsText(cell)}${seenText(cell)}${staleText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The isClean check and the reap gates are this repository's own (src/core/fleet/worktrees.ts), and so is the job finish path's cleanup contract in src/core — while dispatchd, launch.sh and publish.sh are pinned ops machinery (contrib/mac, Security-reviewed, re-pinned). What this repository owns is whether the check misfires on generated or ignored debris (node_modules, dist, build records, editor files the agent never meant to keep) versus jobs genuinely finishing dirty, which points at the finish path leaving the worktree unclean — a gap this repo's queue/job lifecycle code can close.`,
    '',
    `Find whether the refusals are correct holds or debris the check should ignore: inspect a named worktree's uncommitted set, compare against what the finish path is meant to leave behind, and decide whether isClean needs an ignore rule or the finish path needs a cleanup step. Fix what lives here; if the cause is ops-pinned machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function worktreeReapItem(cell: WorktreeReapCell, repo: string): CloudBacklogItem {
  const lane = cell.lane;
  const titles: Record<WorktreeReapKind, string> = {
    'remove-failed': `The worktree reaper keeps failing to remove worktrees on ${lane}`,
    'unsafe-path': `The worktree reaper keeps refusing unsafe paths on ${lane}`,
    'unpushed-commits': `Job worktrees keep holding unpushed commits on ${lane}`,
    'uncommitted-changes': `Job worktrees keep holding uncommitted changes on ${lane}`,
  };
  const prompts: Record<WorktreeReapKind, (cell: WorktreeReapCell) => string> = {
    'remove-failed': removeFailedPrompt,
    'unsafe-path': unsafePathPrompt,
    'unpushed-commits': unpushedCommitsPrompt,
    'uncommitted-changes': uncommittedChangesPrompt,
  };
  const id = `fleet-worktree-reap-${createHash('sha256').update(`reap:${cell.kind}:${lane}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[cell.kind].slice(0, MAX_TITLE_CHARS),
    prompt: prompts[cell.kind](cell),
    area: 'worktree-reap',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Bounded tail of metrics/jobs.jsonl folded through the canonical jobTimelines dialect; empty on any read failure — attribution degrades to 'unknown', never blocks the reap evidence. */
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
 * Backlog items for the worktree reap's recurring (kind, lane) cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function worktreeReapBacklogItems(opts: WorktreeReapItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the reap's own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const cutoffMs = nowMs - (opts.windowHours ?? WORKTREE_REAP_WINDOW_HOURS) * 3_600_000;
    const tail = await readLedgerTail(join(runsDir, 'queue', REAP_JOURNAL_FILE), WORKTREE_REAP_TAIL_BYTES);
    const actions = tail.state === 'read' ? parseReapRows(tail.text, cutoffMs, nowMs) : [];
    if (actions.length === 0) return [];
    const jobs = await readJobTimelines(runsDir, nowMs);
    const cells = foldReapCells(actions, jobs, tail.state === 'read' && tail.truncated === true)
      .filter((cell) => cell.count >= WORKTREE_REAP_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? WORKTREE_REAP_MAX_ITEMS, WORKTREE_REAP_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => worktreeReapItem(cell, repo));
  } catch {
    return [];
  }
}
