/**
 * Work-market reroute journal + reward ledger → self-improvement backlog
 * items.
 *
 * Every Leader board tick, routeExpiringCapacity
 * (src/core/fleet/resource-queue-route.ts, driven from the Leader's board
 * hook in src/core/vision/leader.ts) may re-hint eligible READY rows in
 * queue/ready.tsv toward under-target included lanes — earliest verified
 * quota deadline first — rewriting each moved row's lane column and its
 * requirements spec's preferred_lane under the dispatcher and ready-file
 * locks, then appending one receipt per moved row to
 * <runs>/metrics/work-market.jsonl through the same appendGuarded path the
 * dispatcher uses: `work-market.v1` / `queue_reroute` with
 * reason_codes ['resource_plan_under_target', 'expiring_included_quota' |
 * 'expiring_reset_bank'] (docs/QUEUE.md). The journal is append-only with
 * no rotation, so readers take a bounded tail.
 *
 * Until now the queue_reroute event had no reader at all — the sibling
 * folds cover the journal's route_decision, unfed_capacity, repo_share
 * and posture events, and the docs themselves note these receipts are
 * not claim or route-decision events, so every existing fold skips them.
 * A job the Leader keeps re-hinting — its ready.tsv lane and
 * preferred_lane rewritten tick after tick as earlier-deadline lanes
 * rotate in, or as the market's own route_decisions push back — churns
 * the shared queue's lane column with no trace anywhere, and work the
 * re-hint moved that then closed unmerged or was reverted looked like
 * ordinary fleet outcomes. queueRerouteBacklogItems carries the same
 * receipts into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both ledgers are read through readLedgerTail's bounded
 *    no-follow tails; nothing is written and no network is touched. A
 *    missing or unreadable work-market journal yields no items; a
 *    missing or unreadable reward ledger yields no outcome cells —
 *    churn cells still emit since they need no join.
 *  - Rows count only under the writer's contract: schema
 *    'work-market.v1', event 'queue_reroute', an epoch-seconds `ts`
 *    inside the window (the same ±5-minute future skew the sibling
 *    folds tolerate), a bounded job id, preferred_lane null or a lane
 *    id (open-hint rows reroute too), a lane-id target_lane, a
 *    parseable deadline_at stamp, non-negative integer running/target
 *    counts and reason_codes carrying the writer's
 *    'resource_plan_under_target' marker plus an expiring_* code.
 *    Malformed lines, other schemas and other events are skipped,
 *    never guessed.
 *  - Recurring means recorded across days: a per-job churn cell emits
 *    only at REROUTE_JOB_MIN_ROWS receipts across REROUTE_JOB_MIN_DAYS
 *    distinct UTC days, and a per-target-lane not-held cell only at
 *    REROUTE_NOTHELD_MIN_JOBS distinct resolved-not-held jobs across
 *    REROUTE_NOTHELD_MIN_DAYS days.
 *  - The outcome join is the reward substrate's own verdict:
 *    foldRewardSignals over <ashlr>/metrics/reward-signals.jsonl — one
 *    first-write-wins row per resolved job, merged:false covering
 *    closed-unmerged and reverted resolutions alike. Jobs the ledger
 *    never resolved are 'unresolved' context, never counted toward a
 *    bar; a truncated reward tail marks every not-held count a lower
 *    bound.
 *  - Association, not causation: a rerouted job that did not hold does
 *    not prove the re-hint caused it — the prompt says so and sends the
 *    investigator to the per-job evidence first.
 *  - Truncation is stated, never hidden: when either bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: the receipts carry no repository column, so
 *    items emit only for the fleet's own repository — the same
 *    last-segment rule the sibling fleet-evidence sources apply. Dedup
 *    is downstream: item ids hash the cell identity, never counts or
 *    timestamps, so refreshes re-derive the same ids.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  REWARD_SIGNAL_MAX_BYTES,
  rewardSignalPath,
} from '../metrics/reward-signal.js';
import {
  foldRewardSignals,
  readLedgerTail,
  ROUTER_MARKET_LEDGER_RELATIVE,
} from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; churn and lane cells stay well under this. */
export const REROUTE_BACKLOG_MAX_ITEMS = 10;
const REROUTE_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const REROUTE_WINDOW_HOURS = 168;
/**
 * Bounded tail of the append-only journal — the same 32 MiB tail the
 * unfed, posture and repo_share folds read; route_decision rows
 * dominate the file, so this covers the recent decision stream and
 * prompts state any truncation as a lower bound.
 */
export const REROUTE_TAIL_BYTES = 32 * 1024 * 1024;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const REROUTE_FUTURE_SKEW_SECONDS = 300;
/** A job emits a churn cell at this many recorded re-hints... */
export const REROUTE_JOB_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days. */
export const REROUTE_JOB_MIN_DAYS = 2;
/** A target lane emits a not-held cell at this many distinct rerouted jobs... */
export const REROUTE_NOTHELD_MIN_JOBS = 3;
/** ...whose reroute evidence spans at least this many distinct UTC days. */
export const REROUTE_NOTHELD_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Job ids quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_JOBS = 8;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Target lanes quoted inside one churn prompt before the rest is summarized. */
const MAX_PROMPT_LANES = 6;
/** Bounded per-row collections, mirroring the sibling folds' caps. */
const MAX_REASON_CODES = 32;
/** Map key standing in for a receipt whose preferred_lane was the writer's explicit null. */
const OPEN_HINT = '(open hint)';

/**
 * The writer's lane vocabulary — the same bounded lane-id shape the
 * sibling market folds validate (contrib/mac/work_market.py lane ids).
 */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Reason codes are the market's lowercase code shape. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The writer's fixed first reason code on every queue_reroute receipt. */
const REROUTE_MARKER = 'resource_plan_under_target';
/** Expiring-quota reason codes the writer can record (docs/QUEUE.md). */
const EXPIRING_PREFIX = 'expiring_';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const laneField = (value: unknown): string | null =>
  typeof value === 'string' && LANE.test(value) ? value : null;

const dayOf = (tsSeconds: number): string => new Date(tsSeconds * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fold — one pass over the work-market journal tail
// ---------------------------------------------------------------------------

/** Per-job reroute evidence inside the window. */
export interface RerouteJobFold {
  job: string;
  /** Recorded queue_reroute receipts for the job. */
  rows: number;
  /** Distinct UTC days the receipts landed on. */
  days: Set<string>;
  /** Distinct target lanes the job was re-hinted toward. */
  targets: Set<string>;
  /** Distinct hints the job arrived with — the receipt's preferred_lane, null recorded as OPEN_HINT. */
  hints: Set<string>;
  /** Expiring-quota reason codes recorded across the receipts. */
  expiring: Set<string>;
  /** The newest receipt's target lane — where the Leader last pointed the job. */
  lastTarget: string;
  firstMs: number | null;
  lastMs: number | null;
}

export interface RerouteFold {
  /** Valid in-window queue_reroute rows (rows that passed the producer contract). */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** Per-job reroute folds keyed by job id. */
  jobs: Map<string, RerouteJobFold>;
}

/**
 * Pure: fold one journal tail into per-job reroute evidence. Rows outside
 * the window are skipped as non-evidence; malformed JSON, wrong
 * schema/event, a missing or non-finite timestamp and a queue_reroute row
 * that fails the producer's shape (bad job id, a preferred_lane that is
 * neither null nor a lane id, a missing/malformed target_lane,
 * deadline_at, running or target, reason_codes without the writer's
 * marker or any expiring_* code) all count as invalid — the writer's
 * contract is all-or-nothing per row.
 */
export function foldRerouteJournal(text: string, nowMs: number, windowHours: number): RerouteFold {
  const fold: RerouteFold = { records: 0, invalidRows: 0, jobs: new Map() };
  const since = nowMs / 1000 - windowHours * 3600;
  const until = nowMs / 1000 + REROUTE_FUTURE_SKEW_SECONDS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap prefilter: reroute events are a minority of rows and the
    // pinned writer emits compact JSON, so '"event":"queue_reroute"' is verbatim.
    if (!trimmed.includes('"event":"queue_reroute"')) continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRecord(row) || row['schema'] !== 'work-market.v1' || row['event'] !== 'queue_reroute') {
      fold.invalidRows += 1;
      continue;
    }
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
      fold.invalidRows += 1;
      continue;
    }
    if (ts < since || ts > until) continue;
    const job = row['job'];
    const preferred = row['preferred_lane'];
    const target = row['target_lane'];
    const deadline = row['deadline_at'];
    const running = row['running'];
    const targetCount = row['target'];
    const codes = row['reason_codes'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200 ||
        !('preferred_lane' in row) ||
        (preferred !== null && laneField(preferred) === null) ||
        laneField(target) === null ||
        typeof deadline !== 'string' || deadline === '' || !Number.isFinite(Date.parse(deadline)) ||
        !count(running) || !count(targetCount) ||
        !Array.isArray(codes)) {
      fold.invalidRows += 1;
      continue;
    }
    let marker = false;
    const expiring = new Set<string>();
    for (const code of codes.slice(0, MAX_REASON_CODES)) {
      if (typeof code !== 'string' || !CODE.test(code)) continue;
      if (code === REROUTE_MARKER) marker = true;
      if (code.startsWith(EXPIRING_PREFIX)) expiring.add(code);
    }
    if (!marker || expiring.size === 0) {
      fold.invalidRows += 1;
      continue;
    }
    fold.records += 1;
    const atMs = ts * 1000;
    const day = dayOf(ts);
    let cell = fold.jobs.get(job);
    if (cell === undefined) {
      cell = {
        job, rows: 0, days: new Set(), targets: new Set(), hints: new Set(), expiring: new Set(),
        lastTarget: laneField(target)!, firstMs: null, lastMs: null,
      };
      fold.jobs.set(job, cell);
    }
    cell.rows += 1;
    cell.days.add(day);
    cell.targets.add(laneField(target)!);
    cell.hints.add(preferred === null ? OPEN_HINT : laneField(preferred)!);
    for (const code of expiring) cell.expiring.add(code);
    // Journal order is append order — the newest receipt's target is
    // where the Leader last pointed the job.
    cell.lastTarget = laneField(target)!;
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Reward join — the substrate's own held-merge verdict per rerouted job
// ---------------------------------------------------------------------------

/** Per-lane not-held evidence: distinct rerouted jobs the reward ledger resolved merged:false. */
export interface RerouteLaneCell {
  lane: string;
  /** Distinct rerouted jobs whose newest receipt targeted this lane and resolved not-held. */
  jobs: number;
  /** Example job ids quoted inside the prompt. */
  examples: string[];
  /** Distinct UTC days the member jobs' reroute receipts span. */
  days: string[];
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface RerouteChurnCell {
  job: string;
  rows: number;
  days: string[];
  /** Distinct target lanes the job was re-hinted toward, sorted. */
  targets: string[];
  /** Distinct hints the job arrived with (OPEN_HINT for open work), sorted. */
  hints: string[];
  /** Expiring-quota reason codes recorded, sorted. */
  expiring: string[];
  lastTarget: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/**
 * Pure: the churn cells the fold justifies — one per job whose receipts
 * reach REROUTE_JOB_MIN_ROWS across REROUTE_JOB_MIN_DAYS distinct UTC
 * days. Sorted by rows, then job id — deterministic across refreshes.
 */
export function rerouteChurnCells(fold: RerouteFold): RerouteChurnCell[] {
  const cells: RerouteChurnCell[] = [];
  for (const job of fold.jobs.values()) {
    if (job.rows < REROUTE_JOB_MIN_ROWS || job.days.size < REROUTE_JOB_MIN_DAYS) continue;
    cells.push({
      job: job.job,
      rows: job.rows,
      days: [...job.days].sort(),
      targets: [...job.targets].sort(),
      hints: [...job.hints].sort(),
      expiring: [...job.expiring].sort(),
      lastTarget: job.lastTarget,
      firstSeen: isoOrNull(job.firstMs),
      lastSeen: isoOrNull(job.lastMs),
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.job.localeCompare(b.job));
}

/**
 * Pure: the not-held lane cells the fold plus the reward verdicts
 * justify. Each distinct rerouted job attributes to its newest receipt's
 * target lane; a lane emits only while its resolved-not-held jobs reach
 * REROUTE_NOTHELD_MIN_JOBS across REROUTE_NOTHELD_MIN_DAYS distinct UTC
 * days of reroute evidence. `coverage` tallies every distinct rerouted
 * job's reward verdict for the prompt — resolved held, resolved
 * not-held and unresolved stay separate, never folded into one number.
 */
export function rerouteNotHeldCells(
  fold: RerouteFold,
  rewards: ReadonlyMap<string, { merged: boolean }>,
): { cells: RerouteLaneCell[]; resolved: number; held: number; notHeld: number; unresolved: number } {
  const byLane = new Map<string, { jobs: Map<string, RerouteJobFold>; days: Set<string>; firstMs: number | null; lastMs: number | null }>();
  let resolved = 0, held = 0, notHeld = 0, unresolved = 0;
  for (const job of fold.jobs.values()) {
    const verdict = rewards.get(job.job);
    if (verdict === undefined) { unresolved += 1; continue; }
    resolved += 1;
    if (verdict.merged) { held += 1; continue; }
    notHeld += 1;
    let cell = byLane.get(job.lastTarget);
    if (cell === undefined) {
      cell = { jobs: new Map(), days: new Set(), firstMs: null, lastMs: null };
      byLane.set(job.lastTarget, cell);
    }
    cell.jobs.set(job.job, job);
    for (const day of job.days) cell.days.add(day);
    if (job.firstMs !== null) cell.firstMs = cell.firstMs === null ? job.firstMs : Math.min(cell.firstMs, job.firstMs);
    if (job.lastMs !== null) cell.lastMs = cell.lastMs === null ? job.lastMs : Math.max(cell.lastMs, job.lastMs);
  }
  const cells: RerouteLaneCell[] = [];
  for (const [lane, cell] of byLane) {
    if (cell.jobs.size < REROUTE_NOTHELD_MIN_JOBS || cell.days.size < REROUTE_NOTHELD_MIN_DAYS) continue;
    const members = [...cell.jobs.values()].sort((a, b) => b.rows - a.rows || a.job.localeCompare(b.job));
    cells.push({
      lane,
      jobs: cell.jobs.size,
      examples: members.slice(0, MAX_PROMPT_JOBS).map((j) => j.job),
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
    });
  }
  cells.sort((a, b) => b.jobs - a.jobs || a.lane.localeCompare(b.lane));
  return { cells, resolved, held, notHeld, unresolved };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/work-market.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): routeExpiringCapacity (src/core/fleet/resource-queue-route.ts) — run from the Leader\'s board hook in src/core/vision/leader.ts on every live tick — re-hints eligible READY rows in queue/ready.tsv toward under-target included lanes (earliest verified quota deadline first, expiring_included_quota or expiring_reset_bank) and appends one work-market.v1 queue_reroute receipt per moved row with the job id, the hint it left (preferred_lane, null for open work), the target lane, the quota deadline, the lane\'s running/target counts and the reason codes. The journal is append-only with no rotation and route_decision rows dominate it; the sibling folds cover route_decision, unfed_capacity, repo_share and posture — queue_reroute is the event none of them read, and docs/QUEUE.md records that these receipts are not claim or route-decision events. Outcomes join <ashlr>/metrics/reward-signals.jsonl (reward-signal.v1 rows the daemon\'s reward-sync off-tick job writes — one first-write-wins resolved verdict per job, merged:false covering closed-unmerged and reverted resolutions) through foldRewardSignals, the same substrate `phm router-calibration` and `phm router outcomes` read.';

const PINNED_NOTE = ' contrib/mac/dispatchd.py and contrib/mac/work_market.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives (the Leader\'s routing inputs in src/core/vision/leader.ts and src/core/usage/resource-live/, the queue producers\' specs, the market and outcome folds), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the re-hints settled (each job found its lane and launched or the expiring window passed), the churn traces to a deliberate operator state (a quota window rotating on schedule, a lane held for maintenance) or owner-only cause (credentials, billing, host capacity), the not-held rows trace to causes outside the re-hint (the jobs\' own specs, lane health, deliberate closes), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

/** Ledger-recorded names are regex-bounded already; scrub and cap defensively before display. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : days.join(', ');
};

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' A bounded journal tail was truncated at the read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

function churnPrompt(cell: RerouteChurnCell, lowerBound: boolean): string {
  const job = fieldText(cell.job, 200);
  const lanes = cell.targets.slice(0, MAX_PROMPT_LANES).map((l) => `'${fieldText(l, MAX_NAME_CHARS)}'`).join(', ')
    + (cell.targets.length > MAX_PROMPT_LANES ? `, +${cell.targets.length - MAX_PROMPT_LANES} more` : '');
  const hints = cell.hints.map((h) => h === OPEN_HINT ? 'an open hint (no preferred_lane)' : `'${fieldText(h, MAX_NAME_CHARS)}'`).join(', ');
  const expiring = cell.expiring.map((c) => `'${fieldText(c, MAX_NAME_CHARS)}'`).join(', ');
  return [
    `Phantom's expiring-capacity router keeps re-hinting the same ready job — '${job}' carries ${cell.rows} recorded queue_reroute receipt(s) inside the 7-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each receipt is one rewrite of the job's lane column and requirements preferred_lane in queue/ready.tsv: the Leader moved it toward an under-target included lane ahead of that lane's quota deadline, and the move sets preferred_lane to the target — so the hint each receipt records is where the previous rewrite (or the job's own spec) left it. The job has arrived hinted at ${hints} and been pointed at ${lanes.length === 0 ? 'no recorded lane' : lanes} across the window, last at '${fieldText(cell.lastTarget, MAX_NAME_CHARS)}'; recorded expiring reasons: ${expiring}.${seenText(cell.firstSeen, cell.lastSeen)}${boundNote(lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `A job should settle after one re-hint — its preferred_lane becomes the target, so a second move needs an earlier-deadline lane or the job's hint knocked back. Find which is happening: trace '${job}' through queue/ready.tsv's current hint and requirements cell, its route_decision rows in metrics/work-market.jsonl (does the market keep overriding the Leader's hint back — preferred_lane_fallback or resource_fit — so the two routers fight?), and its claim/launch/outcome rows in metrics/jobs.jsonl and the reward ledger (did it launch, on which lane, and did it hold?). Recurring re-hints of one job mean either the expiring-quota ordering keeps leapfrogging it between lanes or the Leader's rewrite and the market's own decisions are unstable — both are this repository's routing inputs to fix.`,
    '',
    `Fix what lives here — the Leader's routing cadence and inputs in src/core/vision/leader.ts and src/core/usage/resource-live/, the queue spec producers' preferred_lane handling, or the ready.tsv hint consumers in this repository's src/ — and keep deliberate operator state (quota windows rotating on schedule, held lanes) out of scope.${PINNED_NOTE} If the re-hints settled or the job already merged on its last target, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function notHeldPrompt(cell: RerouteLaneCell, coverage: { resolved: number; held: number; notHeld: number; unresolved: number }, lowerBound: boolean, rewardLowerBound: boolean): string {
  const lane = fieldText(cell.lane, MAX_NAME_CHARS);
  const jobs = cell.examples.map((j) => `'${fieldText(j, 200)}'`).join(', ')
    + (cell.jobs > cell.examples.length ? `, +${cell.jobs - cell.examples.length} more` : '');
  const truncated = [lowerBound ? 'work-market journal' : null, rewardLowerBound ? 'reward ledger' : null]
    .filter((t): t is string => t !== null);
  const bound = truncated.length === 0 ? ''
    : ` Truncated tails (${truncated.join(' and ')}) mean these counts cover only the retained window — a lower bound, not the full window.`;
  return [
    `Phantom's expiring-capacity re-hints keep landing work that does not hold — ${cell.jobs} distinct job(s) the Leader last pointed at lane '${lane}' resolved merged:false in the reward ledger inside the 7-day window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Example job ids: ${jobs}. Of the ${coverage.resolved + coverage.unresolved} distinct rerouted job(s) the fold saw, ${coverage.resolved} resolved in the reward ledger — ${coverage.held} held merges, ${coverage.notHeld} not held — and ${coverage.unresolved} never resolved (still queued, in flight, or outside the retained ledger).${seenText(cell.firstSeen, cell.lastSeen)}${bound}`,
    '',
    EVIDENCE,
    '',
    `merged:false is the substrate's held-merge verdict: the job's PR closed without merging or a verified merge was later reverted. This is association, not proof the re-hint caused it — the Leader only rewrites the hint; dispatch still decides lane and the job's own spec decides the work. Check the per-job evidence before changing anything: 'phm router outcomes --lane ${lane}' for the lane's verdicts, the reward ledger for each example job's recorded outcome, and the jobs' route_decision rows for whether the market kept or overrode the re-hinted preferred_lane. A lane whose rerouted work keeps not holding while its ordinary work holds points at the re-hint targeting the wrong jobs (requirements the lane cannot serve, work it is bad at); a lane that does not hold generally is the reward-backlog per-pool collapse's evidence instead — check which the tallies support.`,
    '',
    `Fix what lives here — the Leader's lane-targeting inputs in src/core/vision/leader.ts and src/core/usage/resource-live/ (which lanes count as under-target burn candidates and which jobs are eligible), the queue spec producers' needs/tier/cost fields, or this repository's outcome folds when the verdicts themselves are wrong.${PINNED_NOTE} If the window has rolled forward, the not-held rows trace to the jobs' own causes (bad specs, lane health, deliberate closes) rather than the re-hint, or this checkout is not the fleet repository the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

export interface QueueRerouteBacklogOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/work-market.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Journal override (default: <runsDir>/metrics/work-market.jsonl). */
  journalPath?: string;
  /** Reward-ledger override (default: <ashlr>/metrics/reward-signals.jsonl). */
  rewardPath?: string;
  /** Evidence window in hours (default REROUTE_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default REROUTE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

const FLEET_REPO_NAME = 'phantom';

function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the work market's queue_reroute receipts: per-job
 * churn cells and per-target-lane not-held cells. Total: any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function queueRerouteBacklogItems(opts: QueueRerouteBacklogOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling folds apply: an absolute ASHLR_RUNS_DIR
    // wins, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? REROUTE_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, REROUTE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldRerouteJournal(tail.text, nowMs, windowHours);
    if (fold.records === 0) return [];

    // The outcome join reads the reward substrate only when reroute
    // evidence exists. A missing/unreadable ledger leaves every job
    // unresolved — the not-held cells simply never emit; churn cells are
    // unaffected since they need no join.
    let rewards: ReadonlyMap<string, { merged: boolean }> = new Map();
    let rewardRead = false;
    let rewardTruncated = false;
    try {
      const rewardTail = await readLedgerTail(opts.rewardPath ?? rewardSignalPath(), REWARD_SIGNAL_MAX_BYTES);
      if (rewardTail.state === 'read') {
        rewards = foldRewardSignals(rewardTail.text);
        rewardRead = true;
        rewardTruncated = rewardTail.truncated;
      }
    } catch {
      rewardRead = false;
    }
    const outcome = rewardRead
      ? rerouteNotHeldCells(fold, rewards)
      : { cells: [] as RerouteLaneCell[], resolved: 0, held: 0, notHeld: 0, unresolved: fold.jobs.size };

    const churn = rerouteChurnCells(fold);
    if (churn.length === 0 && outcome.cells.length === 0) return [];
    const journalLowerBound = tail.truncated;
    const items: CloudBacklogItem[] = [];
    for (const cell of churn) {
      items.push({
        id: `queue-reroute-churn-${sha(`reroute-churn:${cell.job}`)}`,
        title: `Expiring-capacity router keeps re-hinting job '${cell.job}'`.slice(0, MAX_TITLE_CHARS),
        prompt: churnPrompt(cell, journalLowerBound),
        area: 'queue-reroute',
        priority: 3,
        ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
      });
    }
    for (const cell of outcome.cells) {
      items.push({
        id: `queue-reroute-notheld-${sha(`reroute-notheld:${cell.lane}`)}`,
        title: `Rerouted work keeps not holding on lane '${cell.lane}'`.slice(0, MAX_TITLE_CHARS),
        prompt: notHeldPrompt(cell, { resolved: outcome.resolved, held: outcome.held, notHeld: outcome.notHeld, unresolved: outcome.unresolved }, journalLowerBound, rewardTruncated),
        area: 'reroute-outcomes',
        priority: 3,
        ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
      });
    }
    const limit = Math.max(1, Math.min(opts.limit ?? REROUTE_BACKLOG_MAX_ITEMS, REROUTE_BACKLOG_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
