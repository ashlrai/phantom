/**
 * Producer yield → self-improvement backlog items.
 *
 * Phantom already measures which job producer earns its launch slots:
 * `phm jobs yield --by source` folds metrics/jobs.jsonl through the same
 * yieldTally run fold `phm jobs yield` and the per-family stop verdicts
 * use, groups launches by jobSource — the src= producer tag on the queue
 * line or launch row, else the job id's producer prefix (leader bets,
 * Core's RQ-PHX rows, the cl-stream docs jobs, guardian FIXUP rows,
 * restock filler, everything else 'other') — and prints launches, PRs,
 * merges, empties, aborts, merged-per-launch and the median minutes to
 * merge per source (jobs.yield-by.v1). The leader status digest carries
 * the worst row as its yield_low line. Until now that scoreboard only
 * ever reached a report and one digest line someone had to read: a
 * producer whose launches keep ending empty or aborted — work the fleet
 * paid a launch slot for and got nothing back — never became work, even
 * though the producers are the self-improvement machinery's own intake.
 *
 * sourceYieldBacklogItems carries the same gated projection into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review,
 * empty-tag, post-merge, ci-rerun, lost-launch, memory, fleet-controller
 * and skill-outcome sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail (ROUTER_OUTCOME_LEDGER_LIMIT — the same bound
 *    the post-merge and lost-launch feeds apply) and queue/router-queue.md
 *    through a bounded tail read for its src= producer tags; nothing is
 *    written and no network is touched. The fold itself is the pure
 *    yieldBy/jobs.yield-by.v1 projection `phm jobs yield --by source`
 *    prints, so the backlog can never disagree with the report.
 *  - Unknown stays unknown. A missing or unreadable jobs ledger yields
 *    no items — never a zero-yield guess. An unreadable or oversized
 *    router queue only drops the src= tag join (yieldBy reports the same
 *    gap); sources still resolve from launch-row tags and job id
 *    prefixes, and 'other' never emits because it is a catch-all, not a
 *    producer.
 *  - Judged, not sampled. A source emits only at the fleet's own judging
 *    bars: JOB_STOP_MIN_LAUNCHES launches inside the window (the same
 *    "enough launches to judge" count the per-family stop verdicts
 *    require), merged-per-launch under JOB_STOP_RATE — the fleet's own
 *    poor-yield threshold — and at least SOURCE_YIELD_ADVERSE_MIN
 *    recorded empty-or-aborted finishes, the RECURRING_FAILURES
 *    convention applied to no-land verdicts, so one bad afternoon or a
 *    batch still in flight never queues a session. In-flight launches
 *    carry no finish verdict and cannot satisfy the adverse bar.
 *  - Association, not causation. Yield attributes launches to producers;
 *    it does not prove the producer's selection is at fault — the jobs
 *    may have been misrouted, starved of the right lanes, or hit host
 *    state the repo cannot fix. The prompt keeps that framing and names
 *    the usual no-change escape.
 *  - Fleet machinery only. Launches, producers and the queue are this
 *    install's own machinery, so items emit only for the fleet's own
 *    repository ('phantom' last-segment match, the same rule the sibling
 *    feeds apply); self-improvement pointed at another repository
 *    inherits nothing.
 *  - Dedup is downstream. The item id embeds a stable hash of the source
 *    name only — never the tallies or timestamps — so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; shifted counts do not spawn twin items, and a source that
 *    stops qualifying simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the source name comes from the fixed producer
 *    vocabulary, and the brief names the report, the ledgers and the
 *    fold with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { queueProducers } from '../fleet/job-producers.js';
import { readTail } from '../metrics/loop-collect.js';
import {
  readLedgerTail,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
} from '../router/outcomes.js';
import {
  JOB_STOP_MIN_LAUNCHES,
  JOB_STOP_RATE,
} from '../fleet/slot-yield.js';
import { yieldBy, type YieldByRow } from '../fleet/yield-by.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the producer vocabulary is six names, so the cap is belt-and-braces. */
export const SOURCE_YIELD_MAX_ITEMS = 8;
const SOURCE_YIELD_ITEM_HARD_MAX = 25;
/**
 * Recorded empty-or-aborted finishes a source needs inside the window
 * before its poor yield counts as recurring — the fleet's
 * RECURRING_FAILURES convention the sibling feeds apply to their own
 * tallies. Launches still in flight carry no finish verdict and never
 * count toward it.
 */
export const SOURCE_YIELD_ADVERSE_MIN = 3;
/**
 * Evidence window: seven days, the same convention the skill-outcome and
 * post-merge feeds anchor on. Merges land days after launch, so the
 * 24-hour report window `phm jobs yield` defaults to would under-count
 * them and make every source look worse than it is.
 */
export const SOURCE_YIELD_WINDOW_HOURS = 24 * 7;
/** router-queue.md is a small live queue file; past this bound the src= join is skipped, never guessed. */
const QUEUE_TAIL_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: launch evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Producer names are ledger-derived text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 96;
/** Sources that are catch-alls, not one producer — the same names worstYield refuses to call stoppable. */
const NEVER_A_PRODUCER = new Set(['other', 'unknown']);

export interface SourceYieldItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl and queue/router-queue.md; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default SOURCE_YIELD_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default SOURCE_YIELD_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the yield fold (default: now, ms epoch). */
  now?: number;
  /**
   * Injected jobs.jsonl text (tests); skips the ledger read when set.
   * Same contract as the fold's own text input: null means the ledger is
   * missing or unreadable — withheld evidence, never zero-filled counts.
   */
  jobsText?: string | null;
  /**
   * Injected queue/router-queue.md text (tests); skips the queue read
   * when set. Null means the queue is unreadable — the src= tag join is
   * skipped and sources resolve from launch tags and id prefixes, the
   * same degraded mode `phm jobs yield --by source` reports as a gap.
   */
  queueText?: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_NAME_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** What each producer name is, in the vocabulary yield-by.ts's jobSource documents. */
const SOURCE_NOTES: Record<string, string> = {
  leader: 'the leader\'s bet proposals — queue rows tagged src=leader/bet/bets and the N<day><letter>Q8 job ids',
  core: 'the Core orchestrator\'s planner rows — RQ-PHX ids and src=core/phx tags',
  'cl-stream': 'the cl-stream docs and desk jobs — RQ-CL ids and src=cl-stream/cl/docs tags',
  guardian: 'the main-guardian\'s refix feed — FIXUP- ids and src=guardian/fixup tags',
  filler: 'the restock filler — one-test RQ-*A*Q8 rows and src=filler/restock tags',
};

function sourceNote(name: string): string {
  return SOURCE_NOTES[name] ?? 'a named producer the launch src= tags or job id prefixes attribute';
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The evidence pointers every prompt shares; the fold and the report command are named so the session can reproduce it. */
const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), folded by `phm jobs yield --by source --since 7d --json` into jobs.yield-by.v1 — the same yieldTally run fold `phm jobs yield`, the per-family stop verdicts and the leader digest\'s yield_low line use — with the src= producer tags joined from queue/router-queue.md through queueProducers (src/core/fleet/yield-by.ts, slot-yield.ts, job-producers.ts). `phm jobs producers --json` shows who queued the launches hour by hour.';

const NO_CHANGE = 'If the window has rolled forward, the yield recovered, the launches were misrouted or starved rather than badly chosen, or the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence.';

function sourceYieldPrompt(row: YieldByRow, windowHours: number, truncated: boolean): string {
  const name = fieldText(row.name);
  const prs = row.prs;
  const mergeWord = `${row.merged} ${row.merged === 1 ? 'merge' : 'merges'}`;
  const lines = [
    `Phantom's launch yield by producer keeps bottoming out — '${name}' recorded ${plural(row.launches, 'launch', 'launches')} inside the ${windowHours}-hour window with ${mergeWord} (${row.empty} empty, ${row.aborted} aborted, ${plural(prs, 'PR')}), the self-improvement work this backlog exists for.`,
    '',
    `Yield attributes launches to producers; it does not prove the producer is at fault — the jobs may have been misrouted, starved of the right lanes or models, or hit host state outside the repo's control. '${name}' is ${sourceNote(name)}.`,
    '',
    EVIDENCE,
    ...(truncated ? ['', 'The jobs-ledger read hit its tail bound, so launches older than the retained window are not counted — the tallies are a lower bound, not the whole story.'] : []),
    '',
    `Find out why this producer's jobs keep ending empty or aborted: trace a few of its job ids through metrics/jobs.jsonl (launch → finish/publish → outcome rows), check whether its selection criteria, prompts, acceptance text or lane/tier fit in this repository's producer code generate work that cannot land, and fix the cause. The per-family stop machinery (jobYield stop verdicts and the job stop file) already refuses the worst families — this item is about the producer level: why it keeps drafting launches that yield nothing. Run the affected suite. ${NO_CHANGE}`,
  ];
  return lines.join('\n');
}

function sourceYieldItem(row: YieldByRow, repo: string, windowHours: number, truncated: boolean): CloudBacklogItem {
  const name = fieldText(row.name);
  const displayName = name.length > 120 ? `${name.slice(0, 119)}…` : name;
  const title = `Job producer '${displayName}' keeps launching work that never merges`;
  const id = `fleet-source-yield-${createHash('sha256').update(`source-yield:${row.name}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: sourceYieldPrompt(row, windowHours, truncated),
    area: 'source-yield',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * The adverse bar: enough launches to judge (the fleet's own
 * JOB_STOP_MIN_LAUNCHES count), merged-per-launch under the fleet's own
 * JOB_STOP_RATE poor-yield threshold, and at least
 * SOURCE_YIELD_ADVERSE_MIN recorded empty-or-aborted finishes — the
 * recurring no-land evidence. 'other' and 'unknown' are catch-alls, not
 * producers, and never emit.
 */
function adverseYield(row: YieldByRow): boolean {
  if (NEVER_A_PRODUCER.has(row.name)) return false;
  return row.launches >= JOB_STOP_MIN_LAUNCHES
    && row.merged_per_launch < JOB_STOP_RATE
    && row.empty + row.aborted >= SOURCE_YIELD_ADVERSE_MIN;
}

/**
 * Backlog items for the producer-yield scoreboard's recurring
 * no-land sources. Total: a withheld ledger, another repository or any
 * read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function sourceYieldBacklogItems(opts: SourceYieldItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const windowHours = opts.windowHours !== undefined && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : SOURCE_YIELD_WINDOW_HOURS;
    const now = opts.now ?? Date.now();
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));

    let jobsText: string | null;
    let truncated = false;
    if (opts.jobsText !== undefined) {
      jobsText = opts.jobsText;
    } else {
      const read = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
      if (read.state !== 'read') return [];
      jobsText = read.text;
      truncated = read.truncated;
    }
    if (jobsText === null) return [];

    // The src= producer-tag join is best-effort: an unreadable or
    // oversized queue only drops it, exactly the degraded mode
    // `phm jobs yield --by source` already reports as a gap.
    const queueText = opts.queueText !== undefined
      ? opts.queueText
      : await readTail(join(runsDir, 'queue', 'router-queue.md'), QUEUE_TAIL_BYTES).then((tail) => tail?.text ?? null);
    const queue = queueText === null ? null : queueProducers(queueText);

    const report = yieldBy(jobsText.split('\n'), 'source', now, windowHours, queue);
    const candidates = report.rows.filter(adverseYield);
    const limit = Math.max(1, Math.min(opts.limit ?? SOURCE_YIELD_MAX_ITEMS, SOURCE_YIELD_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((row) => sourceYieldItem(row, repo, windowHours, truncated));
  } catch {
    return [];
  }
}
