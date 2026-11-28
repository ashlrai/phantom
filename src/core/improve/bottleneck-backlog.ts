/**
 * <runs>/ledger/bottleneck-hourly.jsonl hourly pipeline-bottleneck
 * analyzer rows → self-improvement backlog items.
 *
 * The fleet's bottleneck analyzer (launchd ai.ashlr.bottleneck-hourly →
 * ~/.ashlr-runs/bin/bottleneck_hourly.py, fleet machinery outside this
 * repository) appends one ashlr.bottleneck-hourly/v1 row per hourly run.
 * Each row records:
 *
 *   - metrics.stages: pipeline stage latency percentiles over trailing
 *     windows — open_to_merged, gate_first_green_24h,
 *     merged_to_released and released_to_installed, each with n, p50,
 *     p95 and, for the release-side stages, n_pending plus pending-age
 *     percentiles (merges awaiting a published release, releases
 *     awaiting an install marker);
 *   - metrics.per_repo / top-level per_repo: per-repo merge rates and
 *     open-PR counts (the top-level block only exists since
 *     2026-11-24);
 *   - merge_drop_attribution: the hourly merge-drop read — per-repo
 *     auto-merge PR states (conflicts, required-check blocks, unknown
 *     mergeability, behind, red master commits, merge-queue waits), a
 *     fleet-wide per-(repo, check) tally of required-check conclusions
 *     on auto-merge PR heads, per-lane supply stalls measured from
 *     queue/status.json + load-curve + jobs.jsonl, and ranked inferred
 *     causes whose est_merges_lost fields the writer itself labels
 *     inference (est_is_inference);
 *   - burn_pace / reaper: subscription burn-pace and reaper tallies
 *     (added 2026-11-24, not folded here);
 *   - bottleneck / rq_filed: the writer's own slowest-stage verdict and
 *     the bus RQ it files on stage change;
 *   - errors: per-block failure strings — a non-empty errors object
 *     means that hour's evidence is partial (merge_drop fails often
 *     enough on large repos' GraphQL budgets that whole days of
 *     merge-drop coverage go missing);
 *   - eo_ping: whether the writer's own >20% stage-regression /
 *     bottleneck-change / merge-rate-drop rule warranted an EO alert
 *     this run, and whether the latest warranted ping still sits
 *     unrelayed in eo-ping-pending.json (unsent_pending.stale after
 *     two hours; the writer overwrites the pending file each warranted
 *     run, so one stuck ping marks every later row stale).
 *
 * Until now the journal's only consumers were the writer's own EO ping
 * file and bus RQ/INCIDENT filings — no repository code folded it into
 * work, so recurring analyzer blackouts, lane stalls, required-check
 * blocks, release-pipeline pending backlogs and unrelayed regression
 * alerts never became backlog items. bottleneckBacklogItems carries the
 * journal into discoverBacklog:
 *
 *  - analyzer-errors cells per errors key: rows carrying a non-empty
 *    errors entry for that key recurring across days — measurement
 *    blind spots in the fleet's own pipeline telemetry.
 *  - lane-stall cells per lane: merge_drop_attribution.lane_supply rows
 *    where the writer's stalled flag held (queued work, lane not
 *    held/off, zero running in >=80% of sampled minutes) recurring
 *    across days — lanes starved while work waited, measured
 *    independently of the work-market journal unfed-backlog reads.
 *  - check-block cells per (repo, check): required-check conclusions on
 *    open auto-merge PR heads where failing + missing (concluded-bad
 *    or absent — the PR cannot merge on that check) stay at the bar
 *    recurring across days; pending conclusions are quoted as context,
 *    never counted as blocked.
 *  - release-pending cells per stage: stages whose n_pending and
 *    pending_age_p95 stay over the backlog bars recurring across days —
 *    merges outrunning the release/install drain.
 *  - an eo-ping-stale cell: warranted alerts recurring while the relay
 *    state shows the latest ping unrelayed past the writer's own two
 *    hour stale mark across days — regression detections nobody was
 *    told about.
 *  - a corrupt-lines cell: lines failing the row contract inside the
 *    retained tail.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail at BOTTLENECK_TAIL_BYTES; nothing is
 *    written and no network is touched. The file is append-only with
 *    no rotation, so the open descriptor pins one consistent snapshot
 *    and a truncated tail is stated as a lower bound in every prompt,
 *    never read as the full window.
 *  - Rows count only under the writer's frame: the schema literal and
 *    a parseable ts. Every evidence block is optional because the
 *    writer's schema genuinely grew (per_repo, burn_pace and reaper
 *    appeared 2026-11-24; eo_ping changed from boolean to object), so
 *    absent blocks are unrecorded evidence, never zeros. Block fields
 *    re-validate individually — null-or-finite numbers, bounded
 *    identifier strings, the stalled===true gate the writer applies —
 *    and anything off-contract is ignored, not guessed.
 *  - Exact-line replays dedupe to one recorded row, matching the
 *    sibling folds' replay rule.
 *  - Rows window on their ts inside the 7-day window plus the sibling
 *    folds' future-skew tolerance; rows whose ts does not parse or
 *    lands outside are context, never cells.
 *  - est_merges_lost and ranked causes are the writer's labelled
 *    inference; prompts quote them only as recorded inference, never
 *    as measurements. Stall and check evidence exists only on rows
 *    where merge_drop_attribution succeeded — its blackout hours are
 *    the analyzer-errors cell, and prompts state the coverage.
 *  - released_to_installed covers phantom installs only (the writer's
 *    own scope note); n=0 stretches mean no install marker matched,
 *    which is marker-coverage evidence, not proof of zero installs.
 *  - pending ages are ages since merge/publish — they grow with the
 *    window by construction, so the cell bars pair a pending-count
 *    floor with an age floor rather than reading growth into them.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the journal describes this
 *    install's pipeline. Dedup is downstream: item ids hash the cell
 *    identity, never counts or timestamps, so a refresh re-derives the
 *    same ids and a recovered condition simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are per-key/per-lane/per-check/per-stage plus two file-level ones. */
export const BOTTLENECK_BACKLOG_MAX_ITEMS = 8;
const BOTTLENECK_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const BOTTLENECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** ±1-minute future skew, the sibling folds' clock-drift tolerance on ledger timestamps. */
const BOTTLENECK_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail of the append-only journal. Rows run ~10-26 KB each at
 * ~24 per day, so 8 MiB retains well over the 7-day window even at the
 * fat end; a truncated tail is stated as a lower bound rather than
 * silently read as complete.
 */
export const BOTTLENECK_TAIL_BYTES = 8 * 1024 * 1024;
/** Error-keyed analyzer rows a cell needs inside the window. */
export const BOTTLENECK_MIN_ERROR_ROWS = 6;
/** ...recorded across at least this many distinct UTC days. */
export const BOTTLENECK_MIN_ERROR_DAYS = 2;
/** Stalled lane_supply rows a lane cell needs inside the window. */
export const BOTTLENECK_MIN_STALL_ROWS = 8;
/** ...recorded across at least this many distinct UTC days. */
export const BOTTLENECK_MIN_STALL_DAYS = 2;
/** Auto-merge PRs hard-blocked on one required check (failing + missing conclusions) for a check-block row to count. */
export const BOTTLENECK_MIN_CHECK_BLOCKED = 20;
/** Check-block rows a (repo, check) cell needs inside the window. */
export const BOTTLENECK_MIN_CHECK_ROWS = 6;
/** ...recorded across at least this many distinct UTC days. */
export const BOTTLENECK_MIN_CHECK_DAYS = 2;
/** Pending merges a release-pending row needs before its age is evidence. */
export const BOTTLENECK_MIN_PENDING = 200;
/** Pending-age p95 floor in minutes (4 days) for a release-pending row to count. */
export const BOTTLENECK_MIN_PENDING_AGE_MIN = 4 * 24 * 60;
/** Release-pending rows a stage cell needs inside the window. */
export const BOTTLENECK_MIN_PENDING_ROWS = 6;
/** ...recorded across at least this many distinct UTC days. */
export const BOTTLENECK_MIN_PENDING_DAYS = 2;
/** Stale eo-ping rows a cell needs inside the window (~one day of hourly rows). */
export const BOTTLENECK_MIN_EO_STALE_ROWS = 24;
/** ...recorded across at least this many distinct UTC days. */
export const BOTTLENECK_MIN_EO_STALE_DAYS = 2;
/** Contract-failing lines the corrupt-lines cell needs inside the retained tail. */
export const BOTTLENECK_MIN_CORRUPT = 3;
/** The fleet's own repository label: the journal describes this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's schema literal (bottleneck_hourly.py main()). */
const BOTTLENECK_SCHEMA = 'ashlr.bottleneck-hourly/v1';
/** Lane ids join in the producer's bounded identifier shape. */
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Bare repo names as the writer records them in checks[] and errors keys. */
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Stage keys are snake_case identifiers; the writer's set is closed today but new stages fold generically. */
const STAGE_KEY = /^[a-z0-9_]{1,40}$/;
/** Error-map keys: block names plus per-repo 'repo:stage' spellings. */
const ERROR_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** Check names are display strings ('Merge Gate'); bounded printable text, no C0/C1 controls or DEL. */
const isCheckName = (value: string): boolean => {
  if (value.length < 1 || value.length > 80 || value.trim() === '') return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
  }
  return true;
};
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; messages and reasons quote scrubbed and capped. */
const MAX_MESSAGE_CHARS = 160;
/** Error keys / lanes / checks quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_KEYS = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface BottleneckItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding ledger/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Journal override (default: <runsDir>/ledger/bottleneck-hourly.jsonl). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in ms (default BOTTLENECK_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default BOTTLENECK_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now, ms epoch). */
  now?: number;
}

/** One stage's recorded summary inside a row, every field null-or-finite. */
export interface BottleneckStageSample {
  n: number | null;
  p50: number | null;
  p95: number | null;
  nPending: number | null;
  pendingAgeP50: number | null;
  pendingAgeP95: number | null;
  scope: string | null;
}

/** One lane_supply entry the writer marked stalled on this row. */
export interface BottleneckLaneStall {
  lane: string;
  queuedNow: number | null;
  runningMeanThisH: number | null;
  zeroRunningMinThisH: number | null;
  minutesSampledThisH: number | null;
  launchesThisH: number | null;
  mergeRate24h: number | null;
  /** The writer's labelled inference — merges this stall plausibly cost per hour, when recorded. */
  estMergesLost: number | null;
}

/** One checks[] entry: required-check conclusions across open auto-merge PR heads. */
export interface BottleneckCheckBlock {
  repo: string;
  check: string;
  failing: number;
  pending: number;
  missing: number;
}

/** One validated journal row, reduced to what the fold counts and quotes. */
export interface BottleneckRow {
  atMs: number;
  utcDay: string;
  /** Stage samples keyed by stage name; only stages carrying at least one numeric field land. */
  stages: Map<string, BottleneckStageSample>;
  /** errors object entries that passed the key/message contract, in row order. */
  errors: { key: string; message: string }[];
  /** merge_drop_attribution carried a repos object — the row's merge-drop evidence succeeded. */
  mdaCovered: boolean;
  /** lane_supply lanes the writer marked stalled this row. */
  laneStalls: BottleneckLaneStall[];
  /** checks[] entries this row recorded. */
  checkBlocks: BottleneckCheckBlock[];
  /** eo_ping.warranted === true on this row. */
  eoWarranted: boolean;
  /** eo_ping.stale === true on this row, with the pending ping's recorded fields when present. */
  eoStale: { ageHours: number | null; reasons: string[] } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Pure: validate one parsed journal line against the writer's row
 * frame — the schema literal and a parseable ts are the only required
 * fields because the writer's evidence blocks grew over time and stay
 * optional. Returns null when even the frame fails; block contents are
 * extracted defensively field by field.
 */
export function parseBottleneckJournalEntry(value: unknown): BottleneckRow | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== BOTTLENECK_SCHEMA) return null;
  const ts = value['ts'];
  if (typeof ts !== 'string') return null;
  const atMs = Date.parse(ts);
  if (!Number.isFinite(atMs)) return null;

  const row: BottleneckRow = {
    atMs,
    utcDay: utcDayOf(atMs),
    stages: new Map(),
    errors: [],
    mdaCovered: false,
    laneStalls: [],
    checkBlocks: [],
    eoWarranted: false,
    eoStale: null,
  };

  const metrics = value['metrics'];
  if (isRecord(metrics)) {
    const stages = metrics['stages'];
    if (isRecord(stages)) {
      for (const [key, raw] of Object.entries(stages)) {
        if (!STAGE_KEY.test(key) || !isRecord(raw)) continue;
        const sample: BottleneckStageSample = {
          n: finiteOrNull(raw['n']),
          p50: finiteOrNull(raw['p50']),
          p95: finiteOrNull(raw['p95']),
          nPending: finiteOrNull(raw['n_pending']),
          pendingAgeP50: finiteOrNull(raw['pending_age_p50']),
          pendingAgeP95: finiteOrNull(raw['pending_age_p95']),
          scope: typeof raw['scope'] === 'string' ? raw['scope'] : null,
        };
        // A stage object with no measured field at all carries no evidence.
        if (Object.values(sample).every((v) => v === null)) continue;
        row.stages.set(key, sample);
      }
    }
  }

  const errors = value['errors'];
  if (isRecord(errors)) {
    for (const [key, message] of Object.entries(errors)) {
      if (!ERROR_KEY.test(key) || typeof message !== 'string' || message === '') continue;
      row.errors.push({ key, message });
    }
  }

  const mda = value['merge_drop_attribution'];
  if (isRecord(mda)) {
    row.mdaCovered = isRecord(mda['repos']);
    const laneSupply = mda['lane_supply'];
    if (isRecord(laneSupply)) {
      const lanes = laneSupply['lanes'];
      if (isRecord(lanes)) {
        for (const [lane, raw] of Object.entries(lanes)) {
          if (!LANE_ID.test(lane) || !isRecord(raw)) continue;
          if (raw['stalled'] !== true) continue;
          row.laneStalls.push({
            lane,
            queuedNow: finiteOrNull(raw['queued_now']),
            runningMeanThisH: finiteOrNull(raw['running_mean_this_h']),
            zeroRunningMinThisH: finiteOrNull(raw['zero_running_minutes_this_h']),
            minutesSampledThisH: finiteOrNull(raw['minutes_sampled_this_h']),
            launchesThisH: finiteOrNull(raw['launches_this_h']),
            mergeRate24h: finiteOrNull(raw['merge_rate_24h']),
            estMergesLost: finiteOrNull(raw['est_merges_lost']),
          });
        }
      }
    }
    const checks = mda['checks'];
    if (Array.isArray(checks)) {
      for (const raw of checks) {
        if (!isRecord(raw)) continue;
        const repo = raw['repo'];
        const check = raw['check'];
        if (typeof repo !== 'string' || !REPO_NAME.test(repo)) continue;
        if (typeof check !== 'string' || !isCheckName(check)) continue;
        const failing = finiteOrNull(raw['failing']);
        const pending = finiteOrNull(raw['pending']);
        const missing = finiteOrNull(raw['missing']);
        // failing + missing are the hard-blocked count; both must be
        // recorded for the cell math, pending stays optional context.
        if (failing === null || missing === null) continue;
        row.checkBlocks.push({ repo, check, failing, pending: pending ?? 0, missing });
      }
    }
  }

  const eoPing = value['eo_ping'];
  if (isRecord(eoPing)) {
    if (eoPing['warranted'] === true) row.eoWarranted = true;
    if (eoPing['stale'] === true) {
      const pending = eoPing['unsent_pending'];
      const reasons: string[] = [];
      if (isRecord(pending) && Array.isArray(pending['reasons'])) {
        for (const r of pending['reasons']) {
          if (typeof r === 'string' && r !== '') reasons.push(r);
        }
      }
      row.eoStale = {
        ageHours: isRecord(pending) ? finiteOrNull(pending['age_h']) : null,
        reasons,
      };
    }
  }

  return row;
}

/**
 * Pure: parse one journal file's text into deduped validated rows plus
 * the count of lines that were not on-contract records — malformed JSON
 * and off-frame rows are counted, never guessed. Dedup is by exact line
 * content: identical rows are the same recorded run surfaced twice and
 * replays count once at their first retained position.
 */
export function parseBottleneckJournal(text: string): {
  rows: BottleneckRow[];
  invalidRows: number;
  replayedRows: number;
} {
  const seen = new Set<string>();
  const rows: BottleneckRow[] = [];
  let invalidRows = 0;
  let replayedRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (seen.has(trimmed)) { replayedRows += 1; continue; }
    seen.add(trimmed);
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseBottleneckJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows, replayedRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-error-key analyzer failure tallies inside the window. */
export interface BottleneckErrorTally {
  key: string;
  rows: number;
  days: Set<string>;
  /** The newest recorded message for the key, kept raw for prompt-time scrubbing. */
  lastMessage: string;
  firstMs: number;
  lastMs: number;
}

/** Per-lane stall tallies inside the window. */
export interface BottleneckStallTally {
  lane: string;
  rows: number;
  days: Set<string>;
  /** Newest stalled row's recorded fields — the prompt's freshest evidence. */
  latest: BottleneckLaneStall;
  firstMs: number;
  lastMs: number;
}

/** Per-(repo, check) required-check block tallies inside the window. */
export interface BottleneckCheckTally {
  repo: string;
  check: string;
  /** Rows where failing + missing met the hard-blocked bar. */
  rows: number;
  days: Set<string>;
  /** Largest failing + missing seen on one row. */
  maxBlocked: number;
  /** Newest qualifying row's recorded conclusions. */
  latest: BottleneckCheckBlock;
  firstMs: number;
  lastMs: number;
}

/** Per-stage pending-backlog tallies inside the window. */
export interface BottleneckPendingTally {
  stage: string;
  /** Rows carrying the stage at all. */
  rows: number;
  /** Rows meeting the pending-count and pending-age bars. */
  pendingRows: number;
  days: Set<string>;
  /** Newest row's stage sample (pending fields only are meaningful for the cell). */
  latest: BottleneckStageSample;
  firstMs: number;
  lastMs: number;
}

export interface BottleneckFold {
  /** In-window valid rows. */
  rows: number;
  errors: Map<string, BottleneckErrorTally>;
  stalls: Map<string, BottleneckStallTally>;
  checks: Map<string, BottleneckCheckTally>;
  pending: Map<string, BottleneckPendingTally>;
  /** Rows where eo_ping.warranted held. */
  eoWarrantedRows: number;
  /** Rows where eo_ping.stale held. */
  eoStaleRows: number;
  eoStaleDays: Set<string>;
  /** First/last stale-row timestamps — Infinity/-Infinity until one lands. */
  eoStaleFirstMs: number;
  eoStaleLastMs: number;
  /** The newest stale row's pending-ping fields (ts kept as the raw string for quoting). */
  eoLatestStale: { atMs: number; ageHours: number | null; reasons: string[] } | null;
  /** Rows whose merge_drop_attribution carried a repos object — stall/check evidence coverage. */
  mdaRows: number;
  /** On-contract rows outside the window. */
  outsideWindow: number;
  /** Non-blank lines the writer's frame rejected. */
  invalidRows: number;
  /** Exact-line replay rows collapsed by dedup — context only. */
  replayedRows: number;
}

const checkKey = (repo: string, check: string): string => `${repo}\0${check}`;

/**
 * Pure: fold journal text into the bottleneck evidence. Only rows
 * whose ts lands inside the window join tallies; every block stays
 * optional so schema growth reads as unrecorded evidence, not zeros.
 */
export function foldBottleneckRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): BottleneckFold {
  const parsed = parseBottleneckJournal(text);
  const fold: BottleneckFold = {
    rows: 0,
    errors: new Map(),
    stalls: new Map(),
    checks: new Map(),
    pending: new Map(),
    eoWarrantedRows: 0,
    eoStaleRows: 0,
    eoStaleDays: new Set(),
    eoStaleFirstMs: Infinity,
    eoStaleLastMs: -Infinity,
    eoLatestStale: null,
    mdaRows: 0,
    outsideWindow: 0,
    invalidRows: parsed.invalidRows,
    replayedRows: parsed.replayedRows,
  };
  const windowMs = opts.windowMs ?? BOTTLENECK_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + BOTTLENECK_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    if (row.mdaCovered) fold.mdaRows += 1;

    for (const { key, message } of row.errors) {
      let t = fold.errors.get(key);
      if (t === undefined) {
        t = { key, rows: 0, days: new Set(), lastMessage: message, firstMs: row.atMs, lastMs: row.atMs };
        fold.errors.set(key, t);
      }
      t.rows += 1;
      t.days.add(row.utcDay);
      if (row.atMs >= t.lastMs) { t.lastMs = row.atMs; t.lastMessage = message; }
      t.firstMs = Math.min(t.firstMs, row.atMs);
    }

    for (const stall of row.laneStalls) {
      let t = fold.stalls.get(stall.lane);
      if (t === undefined) {
        t = { lane: stall.lane, rows: 0, days: new Set(), latest: stall, firstMs: row.atMs, lastMs: row.atMs };
        fold.stalls.set(stall.lane, t);
      }
      t.rows += 1;
      t.days.add(row.utcDay);
      if (row.atMs >= t.lastMs) { t.lastMs = row.atMs; t.latest = stall; }
      t.firstMs = Math.min(t.firstMs, row.atMs);
    }

    for (const block of row.checkBlocks) {
      const hardBlocked = block.failing + block.missing;
      if (hardBlocked < BOTTLENECK_MIN_CHECK_BLOCKED) continue;
      const k = checkKey(block.repo, block.check);
      let t = fold.checks.get(k);
      if (t === undefined) {
        t = {
          repo: block.repo, check: block.check, rows: 0, days: new Set(),
          maxBlocked: hardBlocked, latest: block, firstMs: row.atMs, lastMs: row.atMs,
        };
        fold.checks.set(k, t);
      }
      t.rows += 1;
      t.days.add(row.utcDay);
      t.maxBlocked = Math.max(t.maxBlocked, hardBlocked);
      if (row.atMs >= t.lastMs) { t.lastMs = row.atMs; t.latest = block; }
      t.firstMs = Math.min(t.firstMs, row.atMs);
    }

    for (const [stage, sample] of row.stages) {
      const pendingHit = sample.nPending !== null
        && sample.nPending >= BOTTLENECK_MIN_PENDING
        && sample.pendingAgeP95 !== null
        && sample.pendingAgeP95 >= BOTTLENECK_MIN_PENDING_AGE_MIN;
      let t = fold.pending.get(stage);
      if (t === undefined) {
        t = { stage, rows: 0, pendingRows: 0, days: new Set(), latest: sample, firstMs: row.atMs, lastMs: row.atMs };
        fold.pending.set(stage, t);
      }
      t.rows += 1;
      if (pendingHit) {
        t.pendingRows += 1;
        t.days.add(row.utcDay);
      }
      if (row.atMs >= t.lastMs) { t.lastMs = row.atMs; t.latest = sample; }
      t.firstMs = Math.min(t.firstMs, row.atMs);
    }

    if (row.eoWarranted) fold.eoWarrantedRows += 1;
    if (row.eoStale !== null) {
      fold.eoStaleRows += 1;
      fold.eoStaleDays.add(row.utcDay);
      fold.eoStaleFirstMs = Math.min(fold.eoStaleFirstMs, row.atMs);
      fold.eoStaleLastMs = Math.max(fold.eoStaleLastMs, row.atMs);
      if (fold.eoLatestStale === null || row.atMs >= fold.eoLatestStale.atMs) {
        fold.eoLatestStale = { atMs: row.atMs, ageHours: row.eoStale.ageHours, reasons: row.eoStale.reasons };
      }
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface BottleneckErrorCell {
  kind: 'analyzer-errors';
  key: string;
  rows: number;
  days: string[];
  /** Scrubbed, capped newest recorded message for the key. */
  lastMessage: string;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface BottleneckStallCell {
  kind: 'lane-stall';
  lane: string;
  rows: number;
  days: string[];
  latest: BottleneckLaneStall;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface BottleneckCheckCell {
  kind: 'check-block';
  repo: string;
  check: string;
  rows: number;
  days: string[];
  maxBlocked: number;
  latest: BottleneckCheckBlock;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface BottleneckPendingCell {
  kind: 'release-pending';
  stage: string;
  rows: number;
  pendingRows: number;
  days: string[];
  latest: BottleneckStageSample;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface BottleneckEoCell {
  kind: 'eo-ping-stale';
  staleRows: number;
  days: string[];
  warrantedRows: number;
  ageHours: number | null;
  reasons: string[];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

export interface BottleneckCorruptCell {
  kind: 'corrupt-lines';
  invalidRows: number;
  lowerBound: boolean;
}

export type BottleneckCell =
  | BottleneckErrorCell
  | BottleneckStallCell
  | BottleneckCheckCell
  | BottleneckPendingCell
  | BottleneckEoCell
  | BottleneckCorruptCell;

const isoOrNull = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Scrub and bound one recorded message for quoting inside a prompt. */
const messageText = (message: string): string => {
  const flat = scrubSecrets(message).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
};

const reasonText = (reason: string): string => messageText(reason);

/**
 * Pure: the emittable cells — per-error-key analyzer failures, per-lane
 * stalls, per-(repo, check) hard blocks, per-stage pending backlogs, the
 * eo-ping stale relay cell and corrupt-lines, each at its own recurrence
 * bars. Ordering is deterministic: kind groups in a fixed order, then
 * the cell's own severity measure, then its identity.
 */
export function bottleneckCells(fold: BottleneckFold, lowerBound = false): BottleneckCell[] {
  const cells: BottleneckCell[] = [];

  const errors: BottleneckErrorCell[] = [];
  for (const t of fold.errors.values()) {
    if (t.rows < BOTTLENECK_MIN_ERROR_ROWS || t.days.size < BOTTLENECK_MIN_ERROR_DAYS) continue;
    errors.push({
      kind: 'analyzer-errors',
      key: t.key,
      rows: t.rows,
      days: [...t.days].sort(),
      lastMessage: messageText(t.lastMessage),
      firstSeen: isoOrNull(t.firstMs),
      lastSeen: isoOrNull(t.lastMs),
      lowerBound,
    });
  }
  errors.sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
  cells.push(...errors);

  const stalls: BottleneckStallCell[] = [];
  for (const t of fold.stalls.values()) {
    if (t.rows < BOTTLENECK_MIN_STALL_ROWS || t.days.size < BOTTLENECK_MIN_STALL_DAYS) continue;
    stalls.push({
      kind: 'lane-stall',
      lane: t.lane,
      rows: t.rows,
      days: [...t.days].sort(),
      latest: t.latest,
      firstSeen: isoOrNull(t.firstMs),
      lastSeen: isoOrNull(t.lastMs),
      lowerBound,
    });
  }
  stalls.sort((a, b) => b.rows - a.rows || a.lane.localeCompare(b.lane));
  cells.push(...stalls);

  const checks: BottleneckCheckCell[] = [];
  for (const t of fold.checks.values()) {
    if (t.rows < BOTTLENECK_MIN_CHECK_ROWS || t.days.size < BOTTLENECK_MIN_CHECK_DAYS) continue;
    checks.push({
      kind: 'check-block',
      repo: t.repo,
      check: t.check,
      rows: t.rows,
      days: [...t.days].sort(),
      maxBlocked: t.maxBlocked,
      latest: t.latest,
      firstSeen: isoOrNull(t.firstMs),
      lastSeen: isoOrNull(t.lastMs),
      lowerBound,
    });
  }
  checks.sort((a, b) => b.maxBlocked - a.maxBlocked || a.repo.localeCompare(b.repo) || a.check.localeCompare(b.check));
  cells.push(...checks);

  const pending: BottleneckPendingCell[] = [];
  for (const t of fold.pending.values()) {
    if (t.pendingRows < BOTTLENECK_MIN_PENDING_ROWS || t.days.size < BOTTLENECK_MIN_PENDING_DAYS) continue;
    pending.push({
      kind: 'release-pending',
      stage: t.stage,
      rows: t.rows,
      pendingRows: t.pendingRows,
      days: [...t.days].sort(),
      latest: t.latest,
      firstSeen: isoOrNull(t.firstMs),
      lastSeen: isoOrNull(t.lastMs),
      lowerBound,
    });
  }
  pending.sort((a, b) => b.pendingRows - a.pendingRows || a.stage.localeCompare(b.stage));
  cells.push(...pending);

  if (fold.eoStaleRows >= BOTTLENECK_MIN_EO_STALE_ROWS && fold.eoStaleDays.size >= BOTTLENECK_MIN_EO_STALE_DAYS) {
    cells.push({
      kind: 'eo-ping-stale',
      staleRows: fold.eoStaleRows,
      days: [...fold.eoStaleDays].sort(),
      warrantedRows: fold.eoWarrantedRows,
      ageHours: fold.eoLatestStale?.ageHours ?? null,
      reasons: (fold.eoLatestStale?.reasons ?? []).slice(0, MAX_PROMPT_KEYS).map(reasonText),
      firstSeen: isoOrNull(fold.eoStaleFirstMs),
      lastSeen: isoOrNull(fold.eoStaleLastMs),
      lowerBound,
    });
  }

  if (fold.invalidRows >= BOTTLENECK_MIN_CORRUPT) {
    cells.push({ kind: 'corrupt-lines', invalidRows: fold.invalidRows, lowerBound });
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs>/ledger/bottleneck-hourly.jsonl (ASHLR_RUNS_DIR or ~/.ashlr-runs) — one ashlr.bottleneck-hourly/v1 row per hourly run of the fleet\'s bottleneck analyzer (launchd ai.ashlr.bottleneck-hourly → ~/.ashlr-runs/bin/bottleneck_hourly.py, fleet machinery outside this repository). Each row records pipeline stage latency percentiles over trailing windows (open_to_merged over 7d by mergedAt, gate_first_green_24h over 24h, merged_to_released and released_to_installed with pending counts and pending-age percentiles), per-repo merge rates and open-PR counts, merge-drop attribution (per-repo auto-merge PR states, required-check rollups on PR heads, merge-queue waits, per-lane supply stalls — est_merges_lost fields are the writer\'s own labelled inference, never measurements), subscription burn pace, reaper tallies, the row\'s errors object, and eo_ping warranted/stale relay state. The file is append-only with no rotation; this fold reads the newest bounded tail through readLedgerTail, re-validates each row\'s schema literal and timestamp, treats every evidence block as optional because the writer\'s schema grew over time (per_repo, burn_pace and reaper blocks appeared 2026-11-24; eo_ping changed from a boolean to an object), dedupes exact line replays, windows rows on ts inside the 7-day window plus the sibling folds\' future-skew tolerance, and states a truncated tail as a lower bound. Until this feed the journal had no repository reader — its only consumers were the writer\'s own EO ping file and bus RQ/INCIDENT filings — so recurring analyzer blackouts, lane stalls, required-check blocks, release-pipeline pending backlogs and unrelayed regression alerts never became backlog work.';

const REPRO = 'Reproduce the fold by reading <runs>/ledger/bottleneck-hourly.jsonl directly, keeping on-frame ashlr.bottleneck-hourly/v1 rows whose ts lands inside the window, deduped by exact line, and tallying per errors key, per stalled lane_supply lane, per (repo, check) hard-blocked count (failing + missing), per stage pending bars (n_pending and pending_age_p95), eo_ping stale rows and contract-failing lines. The writer is bottleneck_hourly.py under ~/.ashlr-runs/bin — outside this repository — while the journals its blocks derive from (metrics/jobs.jsonl, metrics/load-curve.jsonl, queue/status.json, GitHub PR/release/check reads) are this install\'s own fleet evidence.';

const NO_CHANGE = 'If the window has rolled forward, the condition recovered (the lane launched again, the check went green, the pending backlog drained, the relay caught up, the analyzer\'s errors cleared), the recorded evidence was a bounded-tail artifact rather than recurrence, the writer-side machinery already filed and closed the owning RQ/INCIDENT, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

const WINDOW_DAYS = Math.round(BOTTLENECK_WINDOW_MS / 86_400_000);

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen
    ? ` Recorded ${firstSeen}.`
    : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

const boundText = (lowerBound: boolean): string =>
  lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const numText = (value: number | null, unit = ''): string =>
  value === null ? 'unrecorded' : `${value}${unit}`;

function bottleneckErrorPrompt(cell: BottleneckErrorCell): string {
  return [
    `Phantom's hourly pipeline-bottleneck analyzer keeps failing the same evidence block — errors key '${cell.key}' appears on ${cell.rows} in-window row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Every hourly row the analyzer writes carries an errors object naming which evidence blocks failed that run; a recurring key means that telemetry has been dark for hours at a time, not a one-off GraphQL timeout. Latest recorded message: "${cell.lastMessage}".${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the downstream consumers that go blind while the block fails — this fold's own lane-stall and check-block cells only exist on rows where merge_drop_attribution succeeded, so a merge_drop blackout also blinds those cells (the coverage is stated in their prompts); the in-repo journals the analyzer derives from (metrics/jobs.jsonl, metrics/load-curve.jsonl, queue/status.json) already have sibling folds that keep working through the blackout; and fleet/manifest.json's classification of the writer itself. The writer, its GraphQL query budget and its launchd schedule are fleet machinery outside this repository — do not patch them here. Check whether the failing block's inputs can be produced more cheaply or covered by a repo-side reader, and whether the blackout duration is acceptable or should be filed upstream. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function bottleneckStallPrompt(cell: BottleneckStallCell, mdaRows: number, foldRows: number): string {
  const l = cell.latest;
  const est = l.estMergesLost === null ? 'unrecorded' : `~${l.estMergesLost}/h (the writer's labelled inference, not a measurement)`;
  const coverage = ` Stall evidence exists only on rows where merge-drop attribution succeeded — ${mdaRows} of ${foldRows} in-window row(s) carried it, and its blackout hours are the analyzer-errors cell's evidence.`;
  return [
    `Phantom's pipeline keeps recording lane '${cell.lane}' stalled with work queued — ${cell.rows} hourly row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window where the writer's stalled flag held (queued_now > 0, lane not held/off, zero running in >=80% of sampled minutes), the self-improvement work this backlog exists for.`,
    '',
    `Newest recorded stall: queued_now ${numText(l.queuedNow)}, running_mean_this_h ${numText(l.runningMeanThisH)}, zero_running_minutes_this_h ${numText(l.zeroRunningMinThisH)} of ${numText(l.minutesSampledThisH)} sampled, launches_this_h ${numText(l.launchesThisH)}, merge_rate_24h ${numText(l.mergeRate24h)}, est_merges_lost ${est}.${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}${coverage}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the dispatch-side stall evidence this journal measures independently — unfed-backlog folds metrics/work-market.jsonl for lanes left with free slots while rows waited elsewhere, and queue/status.json lane targets/holds are this install's own configuration. A lane stalled here but fed there (or vice versa) is a coverage mismatch between two journals measuring the same starvation from different inputs; a lane stalled in both is confirmed starvation worth a lane-target or admission investigation. Check queue/slots.json and the lane's held/target state before changing dispatch behavior — the writer already excludes held and off lanes from its stalled flag, so a recorded stall means the lane was eligible and still never ran. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function bottleneckCheckPrompt(cell: BottleneckCheckCell): string {
  const l = cell.latest;
  return [
    `Phantom's pipeline keeps recording required check '${cell.check}' blocking auto-merge PRs on ${cell.repo} — ${cell.rows} hourly row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) where failing + missing conclusions stayed at ${cell.maxBlocked} or more open auto-merge PR heads (bar ${BOTTLENECK_MIN_CHECK_BLOCKED}), the self-improvement work this backlog exists for.`,
    '',
    `Newest recorded tally: failing ${l.failing}, pending ${l.pending}, missing ${l.missing} — failing means the check concluded non-success on the PR head, missing means no run exists for it at all; pending conclusions are in-flight CI and are quoted as context, never counted as blocked. A required check parked at this depth means the auto-merge fleet cannot drain on that repo until the heads go green or the check is fixed. ${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: when the recorded check is this repository's own gate (Merge Gate on phantom), the check definition, the merge-queue configuration and the rebase/rerun path that turns a failed head green again; the analyzer's check-name matching against statusCheckRollup contexts lives in the writer outside this repository, so first rule out a measurement artifact — stale heads that legitimately failed once, check names matching the wrong rollup context, or force-pushed-away commits the 24h gate window cannot see (the writer's own docstring names that limit). If the block is real, the work is drain-side: rebase coverage for conflicted heads, gate reruns, or queue ordering — sibling folds already file merge-queue friction from metrics/merge-events.jsonl and metrics/jobs.jsonl. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function bottleneckPendingPrompt(cell: BottleneckPendingCell): string {
  const l = cell.latest;
  const scope = l.scope === null ? '' : ` Stage scope as recorded: ${l.scope}.`;
  const pendingText = l.nPending === null ? 'unrecorded' : String(l.nPending);
  const ageText = l.pendingAgeP95 === null ? 'unrecorded' : `${Math.round(l.pendingAgeP95 / 60 * 10) / 10}h`;
  return [
    `Phantom's pipeline keeps recording stage '${cell.stage}' unable to drain its pending backlog — ${cell.pendingRows} of ${cell.rows} in-window row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) carried n_pending >= ${BOTTLENECK_MIN_PENDING} with pending_age_p95 >= ${BOTTLENECK_MIN_PENDING_AGE_MIN} minutes, the self-improvement work this backlog exists for.`,
    '',
    `Newest recorded stage sample: n ${numText(l.n)} measured, n_pending ${pendingText}, pending_age_p95 ${ageText}, p50 ${numText(l.p50)} min, p95 ${numText(l.p95)} min.${scope} Pending means merged PRs not yet inside a published release (merged_to_released) or published releases with no install marker on this Mac (released_to_installed — phantom installs only, per the writer's own scope note); pending ages are ages since merge/publish and grow with the window by construction, so the bars pair count with age rather than reading growth into them. An n=0 stretch with a large pending count is marker-coverage evidence — no install marker matched — not proof of zero installs. ${seenText(cell.firstSeen, cell.lastSeen)}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: the release-side machinery this stage measures — docs/RELEASING.md's sanctioned release workflow and version carriers, the install-marker layout under ~/.local/share/ashlr/releases that released_to_installed reads, and the merge velocity the pending backlog accumulates against (fleet eval-report and job-latency already fold merge timing from metrics/jobs.jsonl). Check which side the gap sits on before changing anything: release batching cadence vs merge inflow, a release workflow that stopped publishing, install markers that stopped appearing (the stage's n stayed 0 for days before markers matched again), or pending items legitimately awaiting a scheduled batch. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function bottleneckEoPrompt(cell: BottleneckEoCell): string {
  const ageText = cell.ageHours === null ? 'unrecorded' : `${Math.round(cell.ageHours * 10) / 10}h`;
  const reasons = cell.reasons.length === 0
    ? 'The pending ping recorded no reason strings.'
    : ` Latest pending reasons: ${cell.reasons.map((r) => `"${r}"`).join('; ')}.`;
  return [
    `Phantom's bottleneck analyzer keeps warranting EO regression alerts that stay unrelayed — eo_ping.stale held on ${cell.staleRows} in-window row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), with ${cell.warrantedRows} warranted run(s) recorded in the same window, the self-improvement work this backlog exists for.`,
    '',
    `eo_ping.warranted means the writer's own rule fired this run — a bottleneck stage change, a >20% stage p50/p95 worsening, or a >20% merges-per-hour drop — and eo_ping.stale means the latest warranted ping still sits in eo-ping-pending.json without the Eng Ops relay's relayed_at mark past the writer's two-hour stale bound. The pending file is overwritten each warranted run, so one stuck ping marks every later row stale: the days count measures how long alerts have gone unacknowledged, not distinct alerts. Newest pending ping age: ${ageText}.${reasons}${boundText(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `What this repository owns: nothing in the relay path itself — bottleneck_hourly.py writes the pending file and the Eng Ops relay sets relayed_at, both fleet machinery outside this repository. What this repository owns is whether the warranted regressions themselves keep recurring (the stage samples and merge_drop blocks in the same journal are the underlying evidence, and sibling folds already carry lane-stall, check-block and release-pending cells) and whether any repo-side reader should surface warranted pings the relay misses. Check eo-ping.jsonl and eo-ping-pending.json directly: if relayed_at marks are landing and only the newest ping is pending, the relay works and this cell is stale-state noise — report no-change. If warranted pings have gone unrelayed for days while stage regressions continued, the alert path has a real gap worth filing upstream. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

function bottleneckCorruptPrompt(invalidRows: number): string {
  return [
    `Phantom's pipeline-bottleneck journal keeps accumulating rows its own frame cannot trust — ${invalidRows} line(s) failing the ashlr.bottleneck-hourly/v1 row shape inside the retained tail, the self-improvement work this backlog exists for.`,
    '',
    `The writer appends one row per hourly run under a launchd lock, so contract-failing lines mean either a torn write, a foreign or hand edit appended after the writer's own rows, or schema drift between the writer's emitted shape and the validated frame (schema literal plus parseable ts — every evidence block is optional by design). Recurring contract failures mean the pipeline-bottleneck evidence stream itself is degrading — every fold built on it undercounts whatever the bad lines carried.`,
    '',
    EVIDENCE,
    '',
    `Find what keeps writing contract-failing rows to <runs>/ledger/bottleneck-hourly.jsonl: check for foreign appends or hand edits (the writer owns every line it emits — anything it did not write is suspect), schema drift between bottleneck_hourly.py's row shape and the validated frame, and encoding damage. If the failures are a single torn tail line from one interrupted append, report no-change — the next hourly run appends cleanly after it. The writer is fleet machinery outside this repository; this repository owns only the read-side contract.`,
    '',
    `If the window has rolled forward, the retained tail now parses clean, the corrupt rows were a one-off torn write already superseded by later rows, or this checkout is not the fleet install the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
}

/** Filename-safe cell identity for item ids — never counts or timestamps. */
const slug = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'x';

function bottleneckItem(cell: BottleneckCell, repo: string, fold: BottleneckFold): CloudBacklogItem | null {
  const repoLower = repo.trim().toLowerCase();
  const hash = (identity: string): string =>
    createHash('sha256').update(`bottleneck:${repoLower}:${identity}`).digest('hex').slice(0, 16);
  const base = { priority: 3 as const, area: 'bottleneck-hourly', ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}) };
  switch (cell.kind) {
    case 'analyzer-errors':
      return {
        ...base,
        id: `bottleneck-errors-${slug(cell.key)}-${hash(`errors:${cell.key}`)}`,
        title: `Pipeline bottleneck analyzer keeps failing: ${cell.key}`.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckErrorPrompt(cell),
      };
    case 'lane-stall':
      return {
        ...base,
        id: `bottleneck-lane-stall-${slug(cell.lane)}-${hash(`lane:${cell.lane}`)}`,
        title: `Pipeline bottleneck: lane '${cell.lane}' stalls with work queued`.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckStallPrompt(cell, fold.mdaRows, fold.rows),
      };
    case 'check-block':
      return {
        ...base,
        id: `bottleneck-check-${slug(cell.repo)}-${slug(cell.check)}-${hash(`check:${cell.repo}${cell.check}`)}`,
        title: `Pipeline bottleneck: '${cell.check}' blocks ${cell.repo} auto-merge PRs`.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckCheckPrompt(cell),
      };
    case 'release-pending':
      return {
        ...base,
        id: `bottleneck-pending-${slug(cell.stage)}-${hash(`pending:${cell.stage}`)}`,
        title: `Pipeline bottleneck: '${cell.stage}' pending backlog stays deep`.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckPendingPrompt(cell),
      };
    case 'eo-ping-stale':
      return {
        ...base,
        id: `bottleneck-eo-stale-${hash('eo-stale')}`,
        title: 'Pipeline bottleneck: warranted EO pings stay unrelayed'.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckEoPrompt(cell),
      };
    case 'corrupt-lines':
      return {
        ...base,
        id: `bottleneck-corrupt-${hash('corrupt')}`,
        title: 'Pipeline bottleneck journal: rows keep failing the row contract'.slice(0, MAX_TITLE_CHARS),
        prompt: bottleneckCorruptPrompt(cell.invalidRows),
      };
  }
  return null;
}

/**
 * Backlog items for the bottleneck-hourly journal's recurring analyzer
 * errors, lane stalls, required-check blocks, release-pending backlogs,
 * stale EO pings and contract failures. Total: a missing, unreadable or
 * non-file journal, another repository, or any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function bottleneckBacklogItems(opts: BottleneckItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || (repo.split('/').pop() ?? repo).trim().toLowerCase() !== FLEET_REPO_NAME) return [];
    const nowMs = opts.now ?? Date.now();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : BOTTLENECK_WINDOW_MS;
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence folds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, 'ledger', 'bottleneck-hourly.jsonl');
    const read = await readLedgerTail(journalPath, BOTTLENECK_TAIL_BYTES);
    // Healthy-only evidence bar: a missing, unreadable or non-file
    // journal is unknown, never a guessed tally — the same rule the
    // sibling sources apply to their own degraded corpora.
    if (read.state !== 'read' || read.text.trim() === '') return [];
    const fold = foldBottleneckRows(read.text, { nowMs, windowMs });
    if (fold.rows === 0 && fold.invalidRows < BOTTLENECK_MIN_CORRUPT) return [];
    const cells = bottleneckCells(fold, read.truncated);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? BOTTLENECK_BACKLOG_MAX_ITEMS, BOTTLENECK_BACKLOG_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of cells) {
      if (items.length >= limit) break;
      const item = bottleneckItem(cell, repo, fold);
      if (item !== null) items.push(item);
    }
    return items;
  } catch {
    return [];
  }
}
