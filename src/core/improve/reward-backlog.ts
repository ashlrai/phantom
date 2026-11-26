/**
 * Reward-signal ledger recurring per-pool not-held collapse →
 * self-improvement backlog items.
 *
 * `metrics/reward-feed.ts` folds the fleet jobs ledger into the
 * append-only reward substrate at `$ASHLR_HOME/metrics/reward-signals.jsonl`
 * on the daemon's reward-sync off-tick job: one scrubbed
 * reward-signal.v1 row per job whose PR lifecycle reached an authoritative
 * resolution — MERGED (a verified merge timestamp) or CLOSED-unmerged /
 * reverted (merged:false, the substrate's held-merge bar). The file is the
 * shared per-job reward substrate for three local consumers — router
 * calibration (`phm router-calibration --jobs <file>` groups rows into
 * arms by pool), the eval harness (`readRewardSignals`) and the dashboard
 * (`latestRewardSignals`) — plus the `phm router outcomes` join that fills
 * unresolved merged/ttm_s/ci_wall_s/cost_usd/repo fields. Until now every
 * consumer was a report or a join someone had to run and read: a dispatch
 * pool whose resolved jobs keep landing work that does not hold never
 * became work, even though the ledger exists precisely to score which arm
 * deserves the next dispatch.
 *
 * rewardBacklogItems carries the same ledger into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once through readLedgerTail's bounded
 *    no-follow tail at the writer's own REWARD_SIGNAL_MAX_BYTES bound;
 *    nothing is written and no network is touched. A missing or
 *    unreadable file yields no items.
 *  - Rows count only under the writer's contract: isRewardSignalV1 — the
 *    exact key set, canonical ISO timestamps, the merged ⇔ mergedAt
 *    pairing, the derived timeToMergeMs identity and the closed cost
 *    shape. Anything less is an invalid row: counted, never partially
 *    trusted. The ledger only ever records RESOLVED jobs — in-flight work
 *    is absent by design and never counts for or against a pool.
 *    Only the first valid retained row per job counts, matching the writer's
 *    refusal to overwrite a recorded job. Deduplication precedes windowing.
 *  - Recurring means recorded across days at a rate that cannot be a
 *    transient burst: a pool's cell emits only when its in-window rows
 *    reach REWARD_MIN_ROWS, its not-held rows reach REWARD_MIN_NOT_HELD,
 *    not-held rows are a strict majority of the pool's resolved rows,
 *    and the not-held rows span at least REWARD_MIN_DAYS distinct UTC days.
 *    The bars mirror outcome learning's own low-merge cell (a good-merge
 *    rate under half with enough attempts to mean something).
 *  - 'unknown' is the calibration arm's own label for a row whose pool
 *    went unrecorded — the cell is keyed on the recorded pool only, so
 *    unattributed resolutions group together and the prompt says the
 *    attribution itself is missing.
 *  - Fleet machinery only: the ledger is this install's dispatch record,
 *    so items emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the sibling fleet-evidence
 *    sources apply. Row-level repo names are quoted as evidence, never
 *    used to filter — a pool's arm quality is fleet-level in
 *    calibration.
 *  - A truncated ledger yields no items. The omitted rows can change
 *    the majority verdict and which row was recorded first for a job.
 *  - Dedup is downstream: item ids hash the pool identity — never the
 *    counts or timestamps — so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a pool that recovers
 *    simply stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  isRewardSignalV1,
  REWARD_SIGNAL_MAX_BYTES,
  rewardSignalPath,
} from '../metrics/reward-signal.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the fleet's pool count stays well under this. */
export const REWARD_BACKLOG_MAX_ITEMS = 8;
const REWARD_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const REWARD_BACKLOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds apply. */
const REWARD_BACKLOG_FUTURE_SKEW_MS = 60_000;
/**
 * Resolved rows one pool needs inside the window before its outcomes
 * count as recurring — the same order the sibling per-cell bars use. A
 * pool with fewer resolved jobs than this has too thin a sample for a
 * majority verdict to mean anything.
 */
export const REWARD_MIN_ROWS = 6;
/** Not-held rows a pool needs inside the window — the recurring floor. */
export const REWARD_MIN_NOT_HELD = 4;
/** Distinct UTC days on which not-held outcomes must be recorded. */
export const REWARD_MIN_DAYS = 2;
/** The fleet's own repository label: ledger evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Repo tallies quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_REPOS = 3;
/** Map key standing in for a row whose pool field was null — never a legal pool name. */
const UNATTRIBUTED_KEY = '';

export interface RewardBacklogItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Ledger override (default: $ASHLR_HOME/metrics/reward-signals.jsonl). */
  ledgerPath?: string;
  /** Ashlr home for the default ledger path (default: ashlrHome()). */
  homeDir?: string;
  /** Evidence window in ms (default REWARD_BACKLOG_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default REWARD_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOfMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** One pool's in-window resolved-outcome tally. */
export interface RewardPoolTally {
  /** Recorded dispatch pool; null when the row's pool field was unrecorded. */
  pool: string | null;
  /** Resolved rows inside the window (merged and not-held). */
  rows: number;
  /** Rows whose recorded verdict is a held merge. */
  held: number;
  /** Rows whose recorded verdict is merged:false — closed-unmerged or reverted. */
  notHeld: number;
  /** Distinct UTC days the rows span, keyed on recordedAt. */
  days: Set<string>;
  /** Distinct UTC days with at least one not-held row. */
  notHeldDays: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** Recorded repo tallies (null repo counts under 'unattributed'). */
  repos: Map<string, number>;
}

export interface RewardJournalFold {
  /** Distinct jobs whose first valid retained reward row is in the window. */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** Per-pool tallies keyed by pool, UNATTRIBUTED_KEY for null pool. */
  pools: Map<string, RewardPoolTally>;
}

/**
 * Pure: fold one ledger tail into the reward-signal evidence fold. Rows
 * outside the window, malformed JSON and rows failing isRewardSignalV1
 * are skipped — never guessed. The window anchors on recordedAt, the
 * row's own evidence-arrival stamp.
 */
export function foldRewardJournal(text: string, nowMs: number, windowMs: number): RewardJournalFold {
  const fold: RewardJournalFold = { records: 0, invalidRows: 0, pools: new Map() };
  const seenJobs = new Set<string>();
  const since = nowMs - windowMs;
  const until = nowMs + REWARD_BACKLOG_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRewardSignalV1(row)) { fold.invalidRows += 1; continue; }
    if (seenJobs.has(row.jobId)) continue;
    seenJobs.add(row.jobId);
    const atMs = Date.parse(row.recordedAt);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    fold.records += 1;
    const key = row.pool ?? UNATTRIBUTED_KEY;
    let tally = fold.pools.get(key);
    if (tally === undefined) {
      tally = { pool: row.pool, rows: 0, held: 0, notHeld: 0, days: new Set(), notHeldDays: new Set(), firstMs: null, lastMs: null, repos: new Map() };
      fold.pools.set(key, tally);
    }
    tally.rows += 1;
    const day = dayOfMs(atMs);
    if (row.merged) {
      tally.held += 1;
    } else {
      tally.notHeld += 1;
      tally.notHeldDays.add(day);
    }
    tally.days.add(day);
    tally.firstMs = tally.firstMs === null ? atMs : Math.min(tally.firstMs, atMs);
    tally.lastMs = tally.lastMs === null ? atMs : Math.max(tally.lastMs, atMs);
    const repoKey = row.repo ?? 'unattributed';
    tally.repos.set(repoKey, (tally.repos.get(repoKey) ?? 0) + 1);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface RewardPoolCell {
  /** Recorded dispatch pool; null when rows went unrecorded (calibration's 'unknown' arm). */
  pool: string | null;
  /** Resolved rows inside the window. */
  rows: number;
  /** Rows whose recorded verdict is a held merge. */
  held: number;
  /** Rows whose recorded verdict is merged:false — the collapse count. */
  notHeld: number;
  /** notHeld / rows, computed by the cell builder. */
  share: number;
  /** Distinct UTC days the evidence spans, sorted. */
  days: string[];
  /** Distinct UTC days with at least one not-held row, sorted. */
  notHeldDays: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** Top recorded repo tallies for prompt evidence, repo name → row count. */
  repos: [string, number][];
}

/**
 * Pure: the recurring pool cells the fold justifies. A cell emits only
 * while its resolved rows reach REWARD_MIN_ROWS, its not-held rows reach
 * REWARD_MIN_NOT_HELD and are a strict majority, and the not-held rows span
 * REWARD_MIN_DAYS distinct UTC days. Sorted worst-first by not-held
 * count, then rows, then pool name.
 */
export function rewardCells(fold: RewardJournalFold): RewardPoolCell[] {
  const cells: RewardPoolCell[] = [];
  for (const tally of fold.pools.values()) {
    if (tally.rows < REWARD_MIN_ROWS || tally.notHeld < REWARD_MIN_NOT_HELD ||
        tally.notHeld * 2 <= tally.rows || tally.notHeldDays.size < REWARD_MIN_DAYS) continue;
    cells.push({
      pool: tally.pool,
      rows: tally.rows,
      held: tally.held,
      notHeld: tally.notHeld,
      share: tally.notHeld / tally.rows,
      days: [...tally.days].sort(),
      notHeldDays: [...tally.notHeldDays].sort(),
      firstSeen: isoOrNull(tally.firstMs),
      lastSeen: isoOrNull(tally.lastMs),
      repos: [...tally.repos.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_PROMPT_REPOS),
    });
  }
  return cells.sort((a, b) => b.notHeld - a.notHeld || b.rows - a.rows ||
    (a.pool ?? '').localeCompare(b.pool ?? ''));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/reward-signals.jsonl under the Ashlr home (~/.ashlr or $ASHLR_HOME): the daemon\'s reward-sync off-tick job (syncRewardSignalsFromJobsLedger in src/core/metrics/reward-feed.ts, launched from src/core/daemon/loop.ts) folds the tail of <runs>/metrics/jobs.jsonl plus api-spend costs into one scrubbed reward-signal.v1 row per resolved job — merged:true with mergedAt/timeToMergeMs for a verified merge, merged:false for a PR closed unmerged or a merge later reverted. The file is the shared reward substrate read by router calibration (`phm router-calibration --jobs <file>` groups rows into arms by pool), the eval harness and the dashboard, and joined per job by `phm router outcomes`; until this feed every consumer was a report someone had to run and read, so a pool whose resolved work kept not holding never became work.';

const NO_CHANGE = 'If the window has rolled forward, the pool was too quiet for the sample bars to mean anything, the not-held rows trace to deliberate operator state (jobs closed as superseded by a sanctioned recut, owner-side holds or pauses) or owner-side causes (lane credentials, quota, capacity), or this checkout is not the fleet repository the ledger describes — report no-change and name the evidence.';

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const cellDaysText = (cell: RewardPoolCell): string =>
  `across ${cell.notHeldDays.length} UTC day(s) (${daysText(cell.notHeldDays)})`;

const repoText = (repos: readonly [string, number][]): string => {
  if (repos.length === 0) return 'no recorded repo';
  return repos.map(([name, count]) => `${name}: ${count}`).join(', ');
};

function rewardPrompt(cell: RewardPoolCell): string {
  const poolLabel = cell.pool === null
    ? 'jobs whose pool field went unrecorded (the calibration arm reads \'unknown\')'
    : `dispatch pool '${cell.pool}'`;
  return [
    `Phantom's reward ledger keeps recording resolved jobs that do not hold — ${cell.notHeld} of ${cell.rows} resolved row(s) for ${poolLabel} inside the 7-day window carry merged:false, ${pct(cell.share)} not held ${cellDaysText(cell)} — recorded repos ${repoText(cell.repos)} — the self-improvement work this backlog exists for.`,
    '',
    `merged:false is the substrate's held-merge verdict: the job's PR closed without merging (rejected, superseded or abandoned) or a verified merge was later reverted — either way the dispatch produced no lasting change. The ledger only records resolved jobs, so in-flight work never counts; a strict majority of one pool's resolutions not holding is the same low-merge signature outcome learning's own cells flag, now visible per calibration arm.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.`,
    '',
    EVIDENCE,
    '',
    `Reproduce the fold first: run 'phm router-calibration --jobs <ashlr>/metrics/reward-signals.jsonl' and compare this pool's arm against the others, then 'phm router outcomes --lane <pool>' for the per-job verdicts behind the rows. A pool that keeps landing unmerged work is either being fed jobs it cannot land — wrong lane↔task fit, requirements the lane cannot meet, or queue rows parked on a saturated pool — or its dispatches keep failing for lane-health reasons (credentials, quota, model quality, host capacity). Check which side the evidence supports before changing routing: the calibration arm table says whether the collapse is this pool's alone, and the jobs ledger's per-job outcomes say whether the failures share a repo, job type or finish class. Fix what lives here — routing, dispatch-fit and outcome-consumption code in this repository's src/ — and keep deliberate operator state (sanctioned recuts closing superseded PRs, owner-side holds) and owner-side causes out of scope. If the window has rolled forward or the rows trace to deliberate state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function rewardItem(cell: RewardPoolCell, repo: string): CloudBacklogItem {
  const identity = `pool:${cell.pool ?? UNATTRIBUTED_KEY}`;
  const title = cell.pool === null
    ? `Resolved jobs keep landing without pool attribution and not holding`
    : `Dispatch pool '${cell.pool}' keeps landing work that does not hold`;
  return {
    id: `reward-${sha(identity)}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: rewardPrompt(cell),
    area: 'reward',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the reward ledger's recurring per-pool not-held
 * collapse. Total: a missing ledger, another repository or any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function rewardBacklogItems(opts: RewardBacklogItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : REWARD_BACKLOG_WINDOW_MS;
    const path = opts.ledgerPath ?? rewardSignalPath(opts.homeDir);
    const tail = await readLedgerTail(path, REWARD_SIGNAL_MAX_BYTES);
    if (tail.state !== 'read' || tail.truncated) return [];
    const fold = foldRewardJournal(tail.text, nowMs, windowMs);
    if (fold.records === 0) return [];
    const cells = rewardCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? REWARD_BACKLOG_MAX_ITEMS, REWARD_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => rewardItem(cell, repo));
  } catch {
    return [];
  }
}
