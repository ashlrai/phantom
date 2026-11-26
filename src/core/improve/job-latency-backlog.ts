/**
 * jobs.jsonl per-phase latency → self-improvement backlog items.
 *
 * `phm fleet job-latency` (src/core/fleet/job-latency.ts) folds the fleet's
 * append-only jobs ledger into per-phase wall-time totals: queue_wait
 * (queued→launch), checkout (launch→checkout_complete), model
 * (checkout_complete→finish), worker (launch→finish), publish_wait
 * (finish→publish), ci (ci_start→ci_complete) and merge
 * (ci_complete→merged). Each phase row carries measured_jobs,
 * missing_jobs, total_seconds and the report's own fix_line, and
 * top_wastes ranks the phases by recorded total wait — where the fleet's
 * job wall-clock actually goes.
 *
 * Its sibling section, git_contention, already folds into the backlog
 * (git-contention-backlog.ts). The phases section had no fold: the
 * per-phase totals and their fix lines only ever reached the report
 * itself — a report someone had to run and read. A fleet whose jobs
 * kept piling their wall time into one phase (model execution, CI,
 * merge-queue dwell, queue admission) looked like ordinary numbers in a
 * file nobody opened, and the phase's own fix line sat as a suggestion,
 * never queued work.
 *
 * jobLatencyBacklogItems carries the same fold into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling jobs-ledger feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read once through readLedgerTail's
 *    bounded no-follow tail at ROUTER_OUTCOME_LEDGER_LIMIT; nothing is
 *    written and no network is touched. The bounded tail is the evidence
 *    window: phases pair lifecycle boundaries per job id exactly as the
 *    report folds them, so a truncated tail folds lower-bound flagged.
 *  - The report's own verdict, not an invented bar. A phase emits only
 *    when jobLatency measured it on at least JOB_LATENCY_PHASE_MIN_MEASURED
 *    job attempts AND its recorded total_seconds reaches
 *    JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS — enough samples that the total
 *    is not one fluke, and enough accumulated wait that the phase is a
 *    fleet-level bottleneck rather than noise. total_seconds is quoted
 *    only as recorded; missing_jobs is quoted as the report counts it
 *    (attempts that lacked both boundaries), never guessed.
 *  - Adverse means recorded, never inferred. There is no per-phase
 *    "bad" verdict in the ledger — the phases measure where time goes,
 *    not whether it was wrong. The emit bars are deliberately conservative
 *    precisely because the signal is descriptive: only a phase that is
 *    both well-measured and materially slow becomes work.
 *  - One source, one ledger. A missing or unreadable jobs.jsonl silences
 *    the whole source; an empty or boundary-sparse ledger yields phases
 *    with total_seconds null and emits nothing.
 *  - Fleet machinery only. The phases describe this install's dispatch,
 *    checkout, model, publish, CI and merge path — they carry no
 *    repository column — so items emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence feeds apply.
 *  - Dedup is downstream. The item id hashes the phase identity — never
 *    the totals, counts or timestamps — so a refresh re-derives the same
 *    ids and appendUserBacklogItems adds only what is new; a phase whose
 *    wait shrinks below the bars simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: totals and counts
 *    are quoted only as recorded, the report's fix_line is quoted
 *    verbatim, and the brief carries the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { jobLatency } from '../fleet/job-latency.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the phase vocabulary is seven names, so the cap bounds nothing real. */
export const JOB_LATENCY_MAX_ITEMS = 8;
const JOB_LATENCY_ITEM_HARD_MAX = 25;
/** Job attempts a phase must be measured on before its total counts as recurring evidence. */
export const JOB_LATENCY_PHASE_MIN_MEASURED = 10;
/**
 * Recorded wait (seconds) a phase must accumulate across the bounded tail
 * before it counts as a fleet-level bottleneck. Six hours over the tail's
 * recent weeks is ~tens of minutes a day — below that the phase is noise
 * next to the sibling evidence feeds, so it never queues a session.
 */
export const JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS = 6 * 60 * 60;
/** The fleet's own repository label: phase evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;

export interface JobLatencyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default JOB_LATENCY_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One phase that cleared the measured-and-material bars. */
export interface JobLatencyPhaseCell {
  phase: string;
  /** Job attempts the phase was measured on (both boundaries recorded and unambiguous). */
  measuredJobs: number;
  /** Attempts the report counted but could not measure this phase on; null when the report had no ledger. */
  missingJobs: number | null;
  /** Recorded total wait in seconds across measured attempts. */
  totalSeconds: number;
  /** Mean recorded wait per measured attempt. */
  meanSeconds: number;
  /** The report's own suggested fix line, quoted verbatim into the prompt. */
  fixLine: string;
  /** True when the bounded tail cut older rows: totals are a lower bound. */
  lowerBound: boolean;
}

type PhaseRow = ReturnType<typeof jobLatency>['phases'][number];

/**
 * Pure: the phases of a jobLatency report that cleared the bars, sorted by
 * recorded total wait descending — the same ranking top_wastes applies.
 * A phase with total_seconds null (no measured attempt) or under either
 * bar is dropped, never guessed.
 */
export function selectJobLatencyPhases(phases: readonly PhaseRow[], lowerBound = false): JobLatencyPhaseCell[] {
  const out: JobLatencyPhaseCell[] = [];
  for (const row of phases) {
    if (row.total_seconds === null) continue;
    if (row.measured_jobs < JOB_LATENCY_PHASE_MIN_MEASURED) continue;
    if (row.total_seconds < JOB_LATENCY_PHASE_MIN_TOTAL_SECONDS) continue;
    out.push({
      phase: row.phase,
      measuredJobs: row.measured_jobs,
      missingJobs: row.missing_jobs,
      totalSeconds: row.total_seconds,
      meanSeconds: row.total_seconds / row.measured_jobs,
      fixLine: row.fix_line,
      lowerBound,
    });
  }
  return out.sort((a, b) => b.totalSeconds - a.totalSeconds || a.phase.localeCompare(b.phase));
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const NO_CHANGE = 'If the window has rolled forward, the phase is no longer the recorded bottleneck (the fleet rebalanced, the offending stage was fixed, or dispatch slowed everywhere so no single phase dominates), the boundary evidence went sparse, or the cause is owner-side or pinned ops machinery (credentials, billing, the Security-reviewed dispatcher/launcher files under contrib/mac and ~/.ashlr-runs/bin, the host itself) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the write-only-report gap is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the lifecycle boundary rows of metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR) — the enqueue/queued arrival, launch, checkout_complete, finish, publish/published, ci_start, ci_complete and merged/CLOSED/MERGED stamps dispatchd and the outcome reconciler append per job attempt. `phm fleet job-latency --json` folds the same rows into its phases and top_wastes sections — per-phase measured_jobs, missing_jobs, total_seconds and fix_line — the ranking this backlog counts but never prints. Until this feed the phases fed only that report: no fold turned a recurring material wait into work.';

/** Per-phase "what this repository owns" guidance — where each wait's cause lives in this tree. */
const PHASE_OWNS: Record<string, string> = {
  queue_wait: 'queue admission and dispatch: the work-market selection, lane capacity and dispatch scheduling that decide when a queued job launches (src/core/fleet dispatch and queue specs, the work-market claim path). A long queue_wait is jobs waiting for a capable, healthy executor with quota and capacity — find whether dispatch is leaving ready work unfed, whether lane hints are blocking capable seats, or whether admission itself is serialized.',
  checkout: 'worktree and checkout preparation: the launch→checkout_complete span where the worker materializes the repository (src/core/fleet/worktrees.ts, the safe-git checkout paths, worktree reuse). A long checkout is preparation dominating the slot — find whether worktrees are rebuilt instead of reused, whether the checkout fetches more than the job needs, or whether git contention (the sibling git-contention feed) is inflating it.',
  model: 'model execution: the checkout_complete→finish span where the agent session actually runs — prompt assembly, context size, tool-call round-trips and the model itself. A long model phase is the worker\'s core cost — find whether prompts carry repeated or oversized context, whether the lane\'s prompt template or model assignment is wrong for the job shape, or whether tool work is being duplicated.',
  worker: 'the whole worker slot: launch→finish, the sum of checkout, model and whatever the boundaries do not isolate. Its fix line already notes checkout and model refine it when their boundaries exist — treat this as the umbrella signal and the other phases as the decomposition. A long worker slot with no dominant component points at orchestration overhead between the recorded boundaries.',
  publish_wait: 'post-finish publish delay: the finish→publish span where a completed worker waits for its PR to be opened — the publish station, publisher capacity and PR-creation path. A long publish_wait is finished work sitting unpublished — find whether the publisher is saturated, serialized or missing, and whether publish claims are being recorded late.',
  ci: 'the CI critical path: ci_start→ci_complete, the checks a pull request must pass. A long ci phase is verification dominating wall time — find whether suites run serially where they could shard, whether the changed-file selection runs more than the diff needs, whether duplicate or retry work inflates the run, or whether a single slow suite gates everything. The .github/workflows files are pinned ops machinery: if the cause lives there, report no-change and name the evidence.',
  merge: 'post-CI merge dwell: ci_complete→merged, the wait from green checks to landing — the merge queue, auto-merge admission and required-check evaluation. A long merge phase is verified work waiting to land — find whether the merge queue is serialized behind unrelated PRs, whether auto-merge is armed late, or whether a required check re-runs after green.',
};

function phaseTitle(cell: JobLatencyPhaseCell): string {
  const names: Record<string, string> = {
    queue_wait: 'queue admission', checkout: 'checkout preparation', model: 'model execution',
    worker: 'worker slot', publish_wait: 'publish wait', ci: 'CI', merge: 'merge queue dwell',
  };
  return `Fleet job ${names[cell.phase] ?? cell.phase} is a recorded latency bottleneck`;
}

function phasePrompt(cell: JobLatencyPhaseCell): string {
  const hours = cell.totalSeconds >= 3600 ? `${(cell.totalSeconds / 3600).toFixed(1)}h` : `${Math.round(cell.totalSeconds / 60)}m`;
  const mean = cell.meanSeconds >= 60 ? `${(cell.meanSeconds / 60).toFixed(1)}m` : `${Math.round(cell.meanSeconds)}s`;
  const missing = cell.missingJobs === null ? '' : `; ${cell.missingJobs} attempt(s) lacked both boundaries and went unmeasured`;
  const bound = cell.lowerBound ? ' The jobs.jsonl tail was truncated, so these totals are a lower bound.' : '';
  const owns = PHASE_OWNS[cell.phase] ?? 'the fleet machinery that owns this stage of the job lifecycle.';
  return [
    `Phantom's fleet jobs keep spending recorded wall time in the '${cell.phase}' phase — ${hours} across ${cell.measuredJobs} measured job attempt(s) (mean ${mean} per attempt${missing}), the self-improvement work this backlog exists for.`,
    '',
    `The report's own fix line for this phase: "${fieldText(cell.fixLine, 400)}".${bound}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: ${owns} Fix the cause in this repository — the phase is where the fleet's job wall-clock concentrates, so reducing it raises every lane's throughput. If the phase is no longer the recorded bottleneck or the window no longer reproduces it — ${NO_CHANGE}`,
  ].join('\n');
}

function phaseItem(cell: JobLatencyPhaseCell, repo: string): CloudBacklogItem {
  const id = `fleet-joblatency-${cell.phase}-${createHash('sha256').update(`job-phase:${cell.phase}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: phaseTitle(cell).slice(0, MAX_TITLE_CHARS),
    prompt: phasePrompt(cell),
    area: 'job-latency',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** Backlog items for the jobs ledger's recurring material phase waits. Total: any read or fold failure yields no items. */
export async function jobLatencyBacklogItems(opts: JobLatencyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the writers' own readers apply: explicit dir, then
    // a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const path = opts.journalPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, ROUTER_OUTCOME_LEDGER_LIMIT);
    // A missing ledger is a clean empty source; an unreadable or non-file
    // read means evidence exists that cannot be trusted — fail closed. A
    // truncated tail still folds, lower-bound flagged.
    if (tail.state !== 'read') return [];
    const report = jobLatency(tail.text);
    if (!report.known) return [];
    const cells = selectJobLatencyPhases(report.phases, tail.truncated === true);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? JOB_LATENCY_MAX_ITEMS, JOB_LATENCY_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => phaseItem(cell, repo));
  } catch {
    return [];
  }
}
