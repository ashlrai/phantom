/**
 * Work-market journal → self-improvement backlog items.
 *
 * Every dispatchd tick runs the shared work market
 * (contrib/mac/work_market.py, driven from dispatchd.py) and appends its
 * auditable rows to <runs>/metrics/work-market.jsonl through
 * market_metric(): `route_decision` rows — the per-job chosen lane,
 * declared preference, override record, per-lane rejection reason codes
 * and ranking inputs — re-decided for every waiting job each tick, plus
 * one `unfed_capacity` row per tick that left some lane unfed. The
 * journal is append-only with no rotation, so readers take a bounded
 * tail. Until now it only ever reached reports someone had to run and
 * read — `phm fleet unfed`, `phm route explain`, the router outcome and
 * weight folds — none of which queue work. unfedBacklogItems carries
 * the same rows into discoverBacklog: a lane that keeps free target
 * slots while runnable rows wait under other lanes' hints, a lane that
 * keeps rejecting distinct jobs for the same recorded reason, jobs the
 * market keeps routing nowhere, and jobs whose lane hints name
 * executors the market view does not know are all self-diagnosed
 * improvement work that never became a backlog item.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items.
 *  - Rows count only under the writer's contract: schema
 *    'work-market.v1', an epoch-seconds `ts` inside the window (the
 *    same ±5-minute future skew the unfed folds tolerate), and the
 *    per-event fields each cell validates. Malformed lines, other
 *    schemas and other events are skipped, never guessed.
 *  - Route decisions collapse to each job's latest in-window row —
 *    the dispatcher's per-tick re-decision means raw rows would count
 *    one waiting job hundreds of times; the same latest-decision rule
 *    the unfed folds apply.
 *  - Recurring means recorded across days: every cell emits only when
 *    its evidence spans enough distinct UTC days plus its own count
 *    bar (unfed ticks for lanes, distinct jobs for decision cells).
 *  - Mechanical codes never emit: lower_rank, saturated, held,
 *    hysteresis_* and the unfed-only admission codes are the market
 *    working as designed. Unfed lanes emit on recurrence regardless
 *    of their blocked mix and quote the top recorded blocked codes.
 *  - Truncation is stated, never hidden: when the bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: the journal carries no per-job repository
 *    dimension, so items emit only for the fleet's own repository —
 *    the same last-segment rule the sibling fleet-evidence sources
 *    apply. Dedup is downstream: item ids hash the cell identity,
 *    never counts or timestamps, so refreshes re-derive the same ids.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_MARKET_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; unfed lanes plus bounded decision cells stay well under this. */
export const UNFED_BACKLOG_MAX_ITEMS = 10;
const UNFED_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const UNFED_WINDOW_HOURS = 168;
/**
 * Bounded tail of the append-only journal. The unfed report reads the
 * same 32 MiB tail (unfed-read.ts HISTORY_TAIL_BYTES); route_decision
 * rows dominate the file, so this covers the recent decision stream —
 * prompts state any truncation as a lower bound.
 */
const UNFED_TAIL_BYTES = 32 * 1024 * 1024;
/** An unfed lane emits only when recorded unfed on this many distinct UTC days... */
export const UNFED_LANE_MIN_DAYS = 2;
/** ...with at least this many unfed ticks inside the window. */
export const UNFED_LANE_MIN_TICKS = 6;
/** Decision cells (rejections, unrouted, unknown-preference) emit at the fleet's recurring-failures bar of distinct jobs... */
export const MARKET_CELL_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const MARKET_CELL_MIN_DAYS = 2;
/** The fleet's own repository label: market evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Lane identifiers the producer writes (dispatchd lane names). */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Reason codes the producer writes — the same closed shape unfed-capacity.ts validates. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Bounded per-row collections, mirroring the unfed folds' caps. */
const MAX_CODES = 32;
const MAX_REJECTED_LANES = 16;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Blocked/reason codes quoted inside one prompt. */
const MAX_PROMPT_CODES = 4;
/** (from → to) lane pairs quoted inside the unknown-preference prompt. */
const MAX_PROMPT_PAIRS = 3;

/**
 * Rejection codes that are the market working as designed, never
 * backlog evidence: lower_rank (eligible but outranked), saturated (at
 * target), held (a deliberate hold — the fleet-controller feed owns
 * hold-attribution evidence), hysteresis_* (move damping), and the
 * unfed-only mechanical codes should a malformed row ever carry them.
 */
const MECHANICAL_REJECT_CODES: ReadonlySet<string> = new Set([
  'lower_rank', 'saturated', 'held', 'not_evaluated', 'deferred_after_selection',
  'admission_stopped', 'global_admission',
]);

export interface UnfedItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/work-market.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default UNFED_WINDOW_HOURS). */
  windowHours?: number;
  /** Journal override (default: <runsDir>/metrics/work-market.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default UNFED_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are regex-bounded already; scrub and cap defensively before display. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const laneField = (value: unknown): string | null =>
  typeof value === 'string' && LANE.test(value) ? value : null;

const dayOf = (tsSeconds: number): string => new Date(tsSeconds * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-lane unfed evidence: ticks carrying the lane unfed, bucketed by UTC day. */
interface UnfedLaneFold {
  lane: string;
  ticks: number;
  slotTicks: number;
  days: Set<string>;
  /** Recorded blocked-code sums (the writer's per-row counts, summed as recorded). */
  blocked: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/** One job's latest in-window route decision — the collapse the unfed folds apply. */
interface LatestDecision {
  ts: number;
  day: string;
  chosen: string | null;
  overrideReason: string | null;
  overrideFrom: string | null;
  overrideTo: string | null;
  rejected: { lane: string; codes: string[] }[];
  decisionCodes: string[];
}

/** Decision-side cells keyed by kind + lane/code identity. */
interface DecisionCell {
  kind: 'reject' | 'unrouted' | 'unknown-preference';
  lane: string | null;
  code: string | null;
  jobs: number;
  days: Set<string>;
  /** unknown-preference only: 'from→to' hint pairs the market overrode, most frequent first. */
  pairs: Map<string, number>;
  /** unrouted only: recorded decision reason-code tallies (e.g. no_runnable_lane). */
  reasonCodes: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

interface MarketFold {
  unfed: Map<string, UnfedLaneFold>;
  latest: Map<string, LatestDecision>;
}

const emptyFold = (): MarketFold => ({ unfed: new Map(), latest: new Map() });

/** Recorded blocked/reason codes on one row: code-shaped keys with positive integer counts, capped. */
function rowCodes(value: unknown): [string, number][] {
  if (!isRecord(value)) return [];
  const out: [string, number][] = [];
  for (const [code, n] of Object.entries(value)) {
    if (out.length >= MAX_CODES) break;
    if (CODE.test(code) && count(n) && n > 0) out.push([code, n]);
  }
  return out;
}

/** A decision row's rejected_lanes entries — the same validation rejectedLanes() applies in unfed-capacity.ts. */
function rejectedLanes(value: unknown): { lane: string; codes: string[] }[] {
  if (!Array.isArray(value)) return [];
  const out: { lane: string; codes: string[] }[] = [];
  const seenLanes = new Set<string>();
  for (const entry of value) {
    if (out.length >= MAX_REJECTED_LANES || !isRecord(entry)) continue;
    const lane = laneField(entry['lane']);
    const rawCodes = entry['reason_codes'];
    if (lane === null || seenLanes.has(lane) || !Array.isArray(rawCodes)) continue;
    seenLanes.add(lane);
    const seen = new Set<string>();
    const codes: string[] = [];
    for (const code of rawCodes) {
      if (codes.length >= MAX_CODES) break;
      if (typeof code === 'string' && CODE.test(code) && !seen.has(code)) {
        seen.add(code);
        codes.push(code);
      }
    }
    out.push({ lane, codes });
  }
  return out;
}

const decisionCodes = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const code of value) {
    if (out.length >= MAX_CODES) break;
    if (typeof code === 'string' && CODE.test(code) && !seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
};

/**
 * Pure: fold one journal tail into unfed-lane folds and latest-per-job
 * decisions. Rows outside the window, malformed JSON, wrong schema or
 * non-finite timestamps are skipped; other events never reach the fold.
 */
export function foldWorkMarket(text: string, nowMs: number, windowHours: number): MarketFold {
  const fold = emptyFold();
  const since = nowMs / 1000 - windowHours * 3600;
  const until = nowMs / 1000 + 300;
  for (const line of text.split('\n')) {
    // Cheap prefilter: the two evidence events are a minority of rows.
    if (!line.includes('"unfed_capacity"') && !line.includes('"route_decision"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row['schema'] !== 'work-market.v1') continue;
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since || ts > until) continue;
    const day = dayOf(ts);
    const atMs = ts * 1000;
    if (row['event'] === 'unfed_capacity') {
      const lanes = row['lanes'];
      if (!isRecord(lanes)) continue;
      for (const [lane, value] of Object.entries(lanes)) {
        if (!LANE.test(lane) || !isRecord(value)) continue;
        // unfed === true is the writer's own verdict; the headroom and
        // waiting_elsewhere counts are re-checked so a malformed row can
        // never claim unfed capacity it does not record.
        if (value['unfed'] !== true || !count(value['headroom']) || !count(value['waiting_elsewhere'])) continue;
        if ((value['headroom'] as number) <= 0 || (value['waiting_elsewhere'] as number) <= 0) continue;
        let cell = fold.unfed.get(lane);
        if (cell === undefined) {
          cell = { lane, ticks: 0, slotTicks: 0, days: new Set(), blocked: new Map(), firstMs: null, lastMs: null };
          fold.unfed.set(lane, cell);
        }
        cell.ticks += 1;
        cell.days.add(day);
        cell.slotTicks += Math.min(value['headroom'] as number, value['waiting_elsewhere'] as number);
        cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
        cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
        for (const [code, n] of rowCodes(value['blocked'])) {
          if (!cell.blocked.has(code) && cell.blocked.size >= MAX_CODES) continue;
          cell.blocked.set(code, (cell.blocked.get(code) ?? 0) + n);
        }
      }
      continue;
    }
    if (row['event'] !== 'route_decision') continue;
    const job = row['job'];
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const prev = fold.latest.get(job);
    if (prev !== undefined && prev.ts >= ts) continue;
    let overrideReason: string | null = null;
    let overrideFrom: string | null = null;
    let overrideTo: string | null = null;
    if (isRecord(row['override'])) {
      const o = row['override'];
      const from = laneField(o['from']);
      const to = laneField(o['to']);
      const reason = o['reason'];
      if ((o['from'] === null || from !== null) && to !== null
          && typeof reason === 'string' && CODE.test(reason)) {
        overrideReason = reason;
        overrideFrom = from;
        overrideTo = to;
      }
    }
    fold.latest.set(job, {
      ts,
      day,
      chosen: laneField(row['chosen_lane']),
      overrideReason,
      overrideFrom,
      overrideTo,
      rejected: rejectedLanes(row['rejected_lanes']),
      decisionCodes: decisionCodes(row['reason_codes']),
    });
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

interface EmittedCell {
  kind: 'unfed' | 'reject' | 'unrouted' | 'unknown-preference';
  lane: string | null;
  code: string | null;
  /** Recorded counts quoted in the prompt. */
  jobs: number;
  ticks: number;
  slotTicks: number;
  days: string[];
  blocked: [string, number][];
  pairs: [string, number][];
  reasonCodes: [string, number][];
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

const topEntries = (map: Map<string, number>, max: number): [string, number][] =>
  [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

const seenText = (firstSeen: string | null, lastSeen: string | null): string => {
  if (firstSeen === null || lastSeen === null) return '';
  return firstSeen === lastSeen ? ` Recorded ${firstSeen}.` : ` Recorded ${firstSeen} through ${lastSeen}.`;
};

/**
 * Pure: recurring unfed lanes — free target slots while runnable rows
 * waited under other lanes' hints, on enough distinct UTC days. Sorted
 * by slot-ticks lost, the unfed report's own ranking.
 */
export function unfedLaneCells(fold: MarketFold): EmittedCell[] {
  const cells: EmittedCell[] = [];
  for (const cell of fold.unfed.values()) {
    if (cell.days.size < UNFED_LANE_MIN_DAYS || cell.ticks < UNFED_LANE_MIN_TICKS) continue;
    cells.push({
      kind: 'unfed', lane: cell.lane, code: null,
      jobs: 0, ticks: cell.ticks, slotTicks: cell.slotTicks,
      days: [...cell.days].sort(),
      blocked: topEntries(cell.blocked, MAX_PROMPT_CODES),
      pairs: [], reasonCodes: [],
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound: false,
    });
  }
  return cells.sort((a, b) => b.slotTicks - a.slotTicks || (a.lane ?? '').localeCompare(b.lane ?? ''));
}

const mechanical = (code: string): boolean =>
  MECHANICAL_REJECT_CODES.has(code) || code.startsWith('hysteresis_');

/**
 * Pure: recurring decision cells from the latest-per-job collapse.
 *  - 'reject': a lane kept rejecting distinct jobs for one recorded
 *    reason code (mechanical codes excluded — see MECHANICAL_REJECT_CODES);
 *  - 'unrouted': distinct jobs whose latest decision chose no lane;
 *  - 'unknown-preference': distinct jobs whose override record says the
 *    declared preferred_lane is not a lane the market view knows — the
 *    signature of hint vocabulary drifting from lane names.
 * Each emits only at MARKET_CELL_MIN_JOBS distinct jobs across
 * MARKET_CELL_MIN_DAYS distinct UTC days.
 */
export function marketDecisionCells(fold: MarketFold): EmittedCell[] {
  const cells = new Map<string, DecisionCell>();
  const cellFor = (kind: DecisionCell['kind'], lane: string | null, code: string | null): DecisionCell => {
    const key = `${kind}${lane ?? ''}${code ?? ''}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { kind, lane, code, jobs: 0, days: new Set(), pairs: new Map(), reasonCodes: new Map(), firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    return cell;
  };
  const bumpMap = (map: Map<string, number>, key: string): void => {
    if (!map.has(key) && map.size >= MAX_CODES) return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const decision of fold.latest.values()) {
    const atMs = decision.ts * 1000;
    if (decision.chosen === null) {
      const cell = cellFor('unrouted', null, null);
      cell.jobs += 1;
      cell.days.add(decision.day);
      for (const code of decision.decisionCodes) bumpMap(cell.reasonCodes, code);
      cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
      cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    }
    if (decision.overrideReason === 'unknown_preference' && decision.overrideFrom !== null && decision.overrideTo !== null) {
      const cell = cellFor('unknown-preference', null, null);
      cell.jobs += 1;
      cell.days.add(decision.day);
      bumpMap(cell.pairs, `${decision.overrideFrom}→${decision.overrideTo}`);
      cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
      cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    }
    for (const rej of decision.rejected) {
      for (const code of rej.codes) {
        if (mechanical(code)) continue;
        const cell = cellFor('reject', rej.lane, code);
        cell.jobs += 1;
        cell.days.add(decision.day);
        cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
        cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
      }
    }
  }
  const emitted: EmittedCell[] = [];
  for (const cell of cells.values()) {
    if (cell.jobs < MARKET_CELL_MIN_JOBS || cell.days.size < MARKET_CELL_MIN_DAYS) continue;
    emitted.push({
      kind: cell.kind, lane: cell.lane, code: cell.code,
      jobs: cell.jobs, ticks: 0, slotTicks: 0,
      days: [...cell.days].sort(),
      blocked: [],
      pairs: cell.kind === 'unknown-preference' ? topEntries(cell.pairs, MAX_PROMPT_PAIRS) : [],
      reasonCodes: cell.kind === 'unrouted' ? topEntries(cell.reasonCodes, MAX_PROMPT_CODES) : [],
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound: false,
    });
  }
  return emitted.sort((a, b) => b.jobs - a.jobs || a.kind.localeCompare(b.kind)
    || (a.lane ?? '').localeCompare(b.lane ?? '') || (a.code ?? '').localeCompare(b.code ?? ''));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/work-market.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s market_metric appends the work market\'s auditable rows each tick — route_decision (chosen lane, preferred lane, override, per-lane rejected_lanes reason codes, ranking inputs), one unfed_capacity row per tick that left a lane unfed, and session_handoff_advisory quota verdicts — written by contrib/mac/work_market.py choose()/unfed_capacity() driven from contrib/mac/dispatchd.py. The journal is append-only with no rotation. `phm fleet unfed --json` folds the same bounded tail into the fleet.unfed.v1 report (history, overrides, claims, decisionOutcomes, rejections sections in src/core/fleet/unfed-capacity.ts, read by src/core/fleet/unfed-read.ts); src/core/router/outcomes.ts and weight-proposals.ts fold route_decision rows for work_class and lane joins. Until this feed none of those readers queued work.';

const PINNED_NOTE = ' contrib/mac/work_market.py and contrib/mac/dispatchd.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository\'s src/ where the cause lives (the queue producers\' needs/preferred_lane specs, the lane advertisement readers, the unfed and router folds), and document pinned-side findings for the owner rather than working around them.';

const NO_CHANGE = 'If the window has rolled forward, the condition was a one-off burst the fleet recovered from, the recorded codes trace to a deliberate operator state (a held lane, a quota window that reset, a maintenance pause) or owner-only cause (credentials, billing, host capacity, pinned dispatch machinery), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const codeTallyText = (entries: readonly [string, number][]): string =>
  entries.map(([code, n]) => `'${fieldText(code, MAX_NAME_CHARS)}' ×${n}`).join(', ');

function unfedPrompt(cell: EmittedCell): string {
  const blocked = cell.blocked.length === 0 ? 'no blocked codes recorded' : codeTallyText(cell.blocked);
  return [
    `Phantom's work market keeps leaving lane '${cell.lane}' unfed — ${cell.ticks} unfed tick(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) with about ${cell.slotTicks} slot-tick(s) of capacity rows waited for elsewhere could have used, the self-improvement work this backlog exists for.`,
    '',
    `Each unfed_capacity row records the lane's headroom, the waiting rows counted against it and the reason codes those rows carried for not running there: ${blocked}.${seenText(cell.firstSeen, cell.lastSeen)}${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `An unfed lane is only a problem when the waiting rows could have run there: join the blocked codes against the lane's advertisement — capabilities, repos allowlist, data_class, tiers and cost_class as slots.json/models.json publish them — and the queue specs' needs/min_tier/max_tier/data_class/preferred_lane. recurring missing_capability, repo_unserved, data_class_exceeded, tier_unavailable or cost_class_* codes say the lane's advertisement and the queue's asks have drifted apart; quota_exhausted, auth_failed_or_zero_quota or provider_backoff say the capacity evidence is stale or the lane is spent; held or admission-stopped codes say the wait was deliberate.`,
    '',
    `Fix what lives here — the lane advertisement readers, the market requirement/cost vocabulary in this repository's src/, the queue producers' specs — or retune the pinned market's inputs where this repo owns them.${PINNED_NOTE} If the unfed ticks trace to deliberate holds, a quiet queue or owner-side capacity, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function rejectPrompt(cell: EmittedCell): string {
  const lane = fieldText(cell.lane ?? '', MAX_NAME_CHARS);
  const code = fieldText(cell.code ?? '', MAX_NAME_CHARS);
  return [
    `Phantom's work market keeps rejecting queued jobs on lane '${lane}' for '${code}' — ${cell.jobs} distinct job(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each route_decision row's rejected_lanes records why the market would not run that job on that lane; collapsing to each job's latest in-window decision, this (lane, code) cell is the recurring recorded reason.${seenText(cell.firstSeen, cell.lastSeen)}${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Read the code family before changing anything: missing_capability, tier_unavailable, tier_ceiling_exceeded, repo_unserved, data_class_exceeded, local_opt_in_required, local_execution_required and cost_class_unknown/cost_class_exceeded are requirement mismatches — either the lane's advertised capabilities/repos/clearance/tiers/cost in slots.json and models.json is wrong or stale, or producers keep minting job specs (needs, min_tier, max_tier, data_class, repo, max_cost_class, preferred_lane) the lane can never serve. quota_exhausted, auth_failed_or_zero_quota and provider_backoff are capacity evidence — the lane's quota reading, auth state or backoff flag is chronically spent; invalid_capability_advertisement is a slot-config bug.`,
    '',
    `Fix what lives here — the spec producers, the advertisement readers and folds in src/, or the market inputs this repo owns — and keep mechanical codes (lower_rank, saturated, held, hysteresis_*) out of scope: they are the market working as designed.${PINNED_NOTE} If the rejections trace to a deliberate hold, a quota window that reset or owner-side state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unroutedPrompt(cell: EmittedCell): string {
  const codes = cell.reasonCodes.length === 0 ? 'no decision codes recorded' : codeTallyText(cell.reasonCodes);
  return [
    `Phantom's work market keeps routing queued jobs nowhere — ${cell.jobs} distinct job(s) recorded a decision with no chosen lane across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `A route_decision row with chosen_lane null is the market's unrouted verdict: no_runnable_lane when nothing was eligible, or a hysteresis hold when residency damping kept the prior pool off the chosen lane. Recorded decision reason codes across the cell: ${codes}.${seenText(cell.firstSeen, cell.lastSeen)}${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Unrouted work sits in ready.tsv forever: find which requirement makes these jobs unsatisfiable — needs no lane advertises, a tier above every lane's ceiling, a data_class or repo no lane serves, a cost_class ceiling nothing meets — or whether every lane was genuinely down. The queue specs live in the ready.tsv requirements column and router-queue.md envelopes; the lane advertisements live in queue/slots.json, models.json, budget-overrides.json and adaptive.json under the runs dir.`,
    '',
    `Fix what lives here — the spec producers minting unsatisfiable requirements, or the market/queue code in this repository's src/ that should have refused or re-scoped them.${PINNED_NOTE} If the unrouted window traces to a fleet-wide stop, a quiet queue or owner-side state, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function unknownPrefPrompt(cell: EmittedCell): string {
  const pairs = cell.pairs.length === 0 ? 'no lane pairs recorded' : codeTallyText(cell.pairs);
  return [
    `Phantom's work market keeps overriding lane hints that name executors it does not know — ${cell.jobs} distinct job(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `The override record's reason 'unknown_preference' fires only when the job's declared preferred_lane is not a lane in the market view — the hint vocabulary and the lane names have drifted apart. Recorded from→to pairs: ${pairs}.${seenText(cell.firstSeen, cell.lastSeen)}${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `A preferred_lane that names no known lane means producers are minting hints against a stale or wrong lane vocabulary — a renamed lane, a lane that left slots.json/models.json, a typo in the spec template, or an envelope field the market never learned. Find which producer writes the hint (queue specs' preferred_lane, router-queue.md envelopes, restock templates) and whether the lane set or the hint vocabulary should move.`,
    '',
    `Fix what lives here — the hint producers and the market's lane-name handling in this repository's src/ — rather than the pinned dispatcher copy.${PINNED_NOTE} If the hints were a transitional rename that already landed, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const AREAS: Record<EmittedCell['kind'], string> = {
  'unfed': 'unfed-capacity',
  'reject': 'route-rejection',
  'unrouted': 'unrouted-work',
  'unknown-preference': 'hint-mismatch',
};

const TITLES: Record<EmittedCell['kind'], (cell: EmittedCell) => string> = {
  'unfed': (c) => `Work market keeps lane ${c.lane} unfed while rows wait elsewhere`,
  'reject': (c) => `Work market keeps rejecting jobs on ${c.lane}: ${c.code}`,
  'unrouted': () => 'Work market keeps routing queued jobs nowhere',
  'unknown-preference': () => 'Work market keeps overriding hints for unknown lanes',
};

const PROMPTS: Record<EmittedCell['kind'], (cell: EmittedCell) => string> = {
  'unfed': unfedPrompt,
  'reject': rejectPrompt,
  'unrouted': unroutedPrompt,
  'unknown-preference': unknownPrefPrompt,
};

function unfedItem(cell: EmittedCell, repo: string, truncated: boolean): CloudBacklogItem {
  const identity = cell.kind === 'unfed' ? `unfed:${cell.lane}`
    : cell.kind === 'reject' ? `reject:${cell.lane}:${cell.code}`
    : cell.kind;
  return {
    id: `fleet-unfed-${sha(identity)}`,
    title: TITLES[cell.kind](cell).slice(0, MAX_TITLE_CHARS),
    prompt: PROMPTS[cell.kind]({ ...cell, lowerBound: cell.lowerBound || truncated }),
    area: AREAS[cell.kind],
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the work market's recurring unfed-capacity and
 * route-decision evidence. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function unfedBacklogItems(opts: UnfedItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? UNFED_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, UNFED_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldWorkMarket(tail.text, nowMs, windowHours);
    if (fold.unfed.size === 0 && fold.latest.size === 0) return [];
    const truncated = tail.truncated;
    const cells = [...unfedLaneCells(fold), ...marketDecisionCells(fold)];
    const limit = Math.max(1, Math.min(opts.limit ?? UNFED_BACKLOG_MAX_ITEMS, UNFED_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => unfedItem(cell, repo, truncated));
  } catch {
    return [];
  }
}
