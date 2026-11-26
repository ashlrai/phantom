/**
 * Per-resource utilization and unfed capacity for the shared work queue
 * (RQ-SHARED-QUEUE-1). A resource is unfed when it has free slots while
 * runnable rows wait under another lane's hint. Pure: text in, report out.
 * Counts and reason codes only; no job ids, task text or credentials.
 */
import { parseLedgerTs } from '../metrics/loop.js';
import { foldRouterOutcomes } from '../router/outcomes.js';
import { laneLaunchTarget } from './lane-launch-target.js';
import { derivedRowCodes, marketContext, marketLaneView, parseReadyMarketRows, stoppedReadyHints, type ReadyMarketRow, type UnfedMarketInputs } from './unfed-market.js';

export const FLEET_UNFED_SCHEMA = 'fleet.unfed.v1';

/** Reason codes are short lowercase identifiers written by the dispatcher. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const MAX_CODES = 32;
/** Same freshness rule as the spend projection: a dispatcher tick in the last two minutes. */
const STATUS_FRESH_MS = 120_000;

export interface UnfedResource {
  lane: string;
  running: number;
  target: number;
  held: boolean;
  /** running / target, capped at 1; null when the target is 0. */
  utilization: number | null;
  /** Free slots: target minus running, never negative. */
  headroom: number;
  /** Ready rows whose lane hint names this resource. */
  readyHinted: number | null;
  /** Ready rows hinted elsewhere (or unhinted) while this resource had headroom. */
  waitingElsewhere: number | null;
  unfed: boolean | null;
  /** Why those rows did not run here, by reason code. Empty when neither the dispatcher nor derivable market inputs say. */
  blocked: Record<string, number>;
}

export interface UnfedHistoryLane {
  lane: string;
  /** Dispatcher ticks in the window that left this lane unfed. */
  unfedTicks: number;
  /** Sum over those ticks of min(headroom, waiting rows): slots that could have been filled. */
  slotTicks: number;
  lastUnfedAt: string | null;
  blocked: Record<string, number>;
}

export interface UnfedHistory {
  windowHours: number;
  /** False when metrics/work-market.jsonl is absent or unreadable. */
  available: boolean;
  /** Ticks with at least one unfed lane. */
  ticks: number;
  lanes: UnfedHistoryLane[];
}

/** One hinted->chosen lane pair an override took, with its reason. */
export interface UnfedOverrideLane {
  /** Hinted lane, or null when the job carried an open (undeclared) hint. */
  from: string | null;
  /** Lane the market chose. */
  to: string;
  /** Why the decision left the hint: resource_fit, preferred_lane_fallback or unknown_preference. */
  reason: string;
  /** Distinct jobs whose latest in-window decision took this route. */
  jobs: number;
}

/** lane_override accounting over the window's route_decision rows. */
export interface UnfedOverrides {
  /** False when metrics/work-market.jsonl is absent or unreadable. */
  available: boolean;
  /** Distinct jobs with a route decision in the window. */
  decided: number;
  /** Distinct jobs whose latest decision left the hinted lane. */
  overridden: number;
  /** overridden count by override reason. */
  byReason: Record<string, number>;
  /** overridden count by hinted->chosen lane and reason, largest first. */
  lanes: UnfedOverrideLane[];
}

/** One hinted->launched lane pair a claim override took, with its reason. */
export interface UnfedClaimLane {
  /** Hinted lane, or null when the claim carried an open (undeclared) hint. */
  from: string | null;
  /** Lane the job actually launched on. */
  to: string;
  /** Why the claim left the hint: batch_session, resource_fit, preferred_lane_fallback or unknown_preference. */
  reason: string;
  /** Claim launches that took this route. */
  claims: number;
}

/** lane_override accounting over the window's jobs.jsonl claim events. */
export interface UnfedClaims {
  /** False when metrics/jobs.jsonl is absent or unreadable. */
  available: boolean;
  /** True when the ledger exceeded the retained tail: counts are a lower bound. */
  truncated: boolean;
  /** Job claim events in the window, including batch members. */
  claimed: number;
  /** Of those, launches that left their hinted lane (a lane_override was recorded). */
  overridden: number;
  /** overridden count by lane_override reason. */
  byReason: Record<string, number>;
  /** overridden count by hinted->launched lane and reason, largest first. */
  lanes: UnfedClaimLane[];
}

export type FleetStopCode = 'admission_stopped' | 'global_admission';

/** Outcome tallies for one group of decided jobs; every count is explicit ledger evidence. */
export interface UnfedDecisionOutcomeTally {
  /** Distinct jobs whose latest in-window decision fell in this group. */
  decided: number;
  /** Decided jobs with a recorded terminal merge state in the retained jobs tail. */
  known: number;
  /** Known jobs whose latest recorded state is merged. */
  merged: number;
  /** Known jobs whose latest recorded state is closed without a merge. */
  unmerged: number;
  /** Decided jobs carrying explicit revert evidence (usually also counted merged: the work landed, then was reverted). */
  reverted: number;
  /** Decided jobs with no terminal outcome in the retained jobs tail — still running or never launched. */
  unresolved: number;
}

/**
 * Route-decision outcome correlation: each waiting job counts once, by its
 * latest in-window decision, and joins the job id to the newest recorded
 * outcome in the retained jobs.jsonl tail. `overrides` counts how often the
 * market left a hint; this answers whether those routed jobs merged.
 */
export interface UnfedDecisionOutcomes {
  /** False when metrics/work-market.jsonl is absent or unreadable. */
  available: boolean;
  /** False when metrics/jobs.jsonl is absent or unreadable; every decided job then reads unresolved. */
  jobsAvailable: boolean;
  /** True when the jobs ledger exceeded the retained tail: outcome joins are a lower bound. */
  jobsTruncated: boolean;
  /** Latest in-window route decisions collapsed per job (same window as overrides). */
  decided: number;
  /** Chosen lane equals the declared preferred lane. */
  hinted: UnfedDecisionOutcomeTally;
  /** The decision recorded a well-formed lane_override (left the hint with a reason). */
  overridden: UnfedDecisionOutcomeTally;
  /** A lane was chosen with no declared preference to honor. */
  open: UnfedDecisionOutcomeTally;
  /** The latest decision chose no lane (e.g. no_runnable_lane); never joined as a route. */
  unrouted: UnfedDecisionOutcomeTally;
  /** A lane was chosen off a declared preference with no well-formed override record — the market's own account is incomplete. */
  unexplained: UnfedDecisionOutcomeTally;
  /** Overridden decided count by override reason (same reasons as overrides.byReason). */
  byReason: Record<string, number>;
  /** Outcome tallies per recorded work_class; 'unclassified' holds decisions without a valid class. */
  byClass: Record<string, UnfedDecisionOutcomeTally>;
}

/** One lane the market rejected for decided jobs, with its reason tally. */
export interface UnfedRejectionLane {
  lane: string;
  /** Distinct jobs whose latest in-window decision rejected this lane. */
  jobs: number;
  /** Rejection reason counts for this lane, per job-lane pair. */
  reasons: Record<string, number>;
}

/**
 * Per-lane rejection accounting over the window's route_decision rows. The
 * market records every lane it would not run each job on, with the reason
 * codes that say why — evidence the overrides and outcome folds do not
 * carry. Each job counts once, by its latest in-window decision (the same
 * collapse `overrides` and `decisionOutcomes` use), so a job that waited
 * for hours is not re-counted every tick.
 */
export interface UnfedRejections {
  /** False when metrics/work-market.jsonl is absent or unreadable. */
  available: boolean;
  /** Latest in-window route decisions collapsed per job (same set as overrides.decided). */
  decided: number;
  /** Of those, decisions that chose no lane. */
  unrouted: number;
  /** Rejected-lane tallies, most jobs first. */
  lanes: UnfedRejectionLane[];
  /** Jobs affected per reason code: a job counts once per reason however many lanes rejected it. */
  byReason: Record<string, number>;
}

export interface UnfedReport {
  schema: typeof FLEET_UNFED_SCHEMA;
  readOnly: true;
  resourcePlan?: { lane: string; running: number | null; target: number | null; unfedSlots: number | null }[] | null;
  /**
   * `dispatcher`: the tick's own verdict from status.json, with reason codes.
   * `derived`: computed here from lane counts and ready.tsv, because the
   * running dispatcher does not publish the block.
   */
  source: 'dispatcher' | 'derived';
  /** True when a derived report also recomputed reason codes from market inputs (slots.json and friends). */
  derivedReasons: boolean;
  /**
   * status.json's `last_tick` as ISO-8601, or null when absent or unparseable.
   * Every "now" figure in this report is only as current as this timestamp.
   */
  statusAsOf: string | null;
  /**
   * Whether the snapshot is fresh enough to describe now: `last_tick` parses,
   * is not in the future, and is within STATUS_FRESH_MS of the evaluation
   * instant — the same rule metrics-glance and the spend projection apply.
   * Null when no evaluation clock was supplied (market.nowMs): freshness stays
   * unknown rather than guessed.
   */
  statusFresh: boolean | null;
  /**
   * The fleet-wide stop in effect this tick, in the dispatcher's own codes:
   * `admission_stopped` when the launch gate (pause, disk hard stop or a
   * tripped load gate) kept the market from running, `global_admission` when
   * the per-tick launch budget or fleet-wide cap was spent. Read from
   * status.json's own admission verdict, with published blocked codes as
   * fallback evidence. Null when no stop is recorded.
   */
  fleetStop: FleetStopCode | null;
  /** Ready rows still waiting (market-evaluated rows; see invalidRows). */
  waiting: number | null;
  /**
   * Ready rows the work market cannot evaluate — a malformed job id, tier or
   * requirements spec, including a router-queue envelope that fails
   * validation. They never launch; a market-evaluated tick excludes them from
   * `waiting`, exactly like the dispatcher's `_waiting` set. On an
   * admission-stopped tick the dispatcher counts them anyway (its stopped
   * `_waiting` never parses requirements), so they can appear in `waiting`
   * while still being listed here.
   */
  invalidRows: number | null;
  unfedLanes: string[];
  /** Upper bound from lane headroom and waiting rows, capped by total waiting work. */
  unfedSlots: number | null;
  resources: UnfedResource[];
  /** Whether older work-market journal bytes were omitted from the window folds. */
  marketTruncated: boolean;
  history: UnfedHistory;
  /** lane_override accounting over the same window's route_decision rows. */
  overrides: UnfedOverrides;
  /** lane_override accounting over the same window's jobs.jsonl claim events. */
  claims: UnfedClaims;
  /** Route-decision outcome correlation over the same window's decisions joined to jobs.jsonl outcomes. */
  decisionOutcomes: UnfedDecisionOutcomes;
  /** Per-lane rejection accounting over the same window's route_decision rows. */
  rejections: UnfedRejections;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Keep only well-formed reason codes with nonnegative counts. */
function codes(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [code, n] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_CODES) break;
    if (CODE.test(code) && count(n) && n > 0) out[code] = n;
  }
  return out;
}

function utilization(running: number, target: number): number | null {
  return target > 0 ? Math.round(Math.min(1, running / target) * 1000) / 1000 : null;
}

/**
 * Dispatcher ready.tsv rows: job, repo, lane hint, tier, prompt[, requirements].
 * Parked rows are not runnable. The hint is each row's resolved preferred_lane
 * (the requirements column — or the router-queue.md envelope for a spec-less
 * row — may override the lane column), matching the dispatcher's own unfed
 * accounting. Rows the market would reject (bad job id, tier or spec) are
 * counted in `invalid`. Each job contributes once, using its first valid row.
 */
export function readyHints(readyTsv: string, routerQueue?: string | null):
  { waiting: number; byLane: Map<string, number>; rows: ReadyMarketRow[]; invalid: number } {
  const { rows: parsed, invalid } = parseReadyMarketRows(readyTsv, routerQueue);
  const jobs = new Set<string>();
  const rows: ReadyMarketRow[] = [];
  const byLane = new Map<string, number>();
  for (const row of parsed) {
    if (jobs.has(row.id)) continue;
    jobs.add(row.id);
    rows.push(row);
    const lane = row.hint ?? '';
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  }
  return { waiting: rows.length, byLane, rows, invalid };
}

/**
 * The fleet-stop verdict status.json carries, in the dispatcher's own codes.
 * `admission_stopped`: dispatchd's launch gate (PAUSE file, disk hard stop or
 * a tripped load gate — disk feeds the gate's reasons) failed before the
 * market ran, so every waiting row recorded admission_stopped on every unfed
 * lane. `global_admission`: the market ran but the per-tick launch budget or
 * the fleet-wide cap was spent; rows evaluated after the limit record
 * global_admission on every lane. Null when the tick admitted work or
 * published no admission verdict (older dispatcher).
 */
function fleetStopVerdict(data: Record<string, unknown>): FleetStopCode | null {
  if (data.paused) return 'admission_stopped';
  const admission = isRecord(data.admission) ? data.admission : null;
  if (admission === null || (admission.ts !== undefined && admission.ts !== data.last_tick)) return null;
  const gateReason = admission.gate_reason;
  if (typeof gateReason === 'string' && gateReason.trim().length > 0) return 'admission_stopped';
  const cap = count(admission.cap) ? admission.cap : null;
  const running = count(admission.running) ? admission.running : null;
  const launched = Array.isArray(data.launched_this_tick) ? data.launched_this_tick.length : null;
  const claimLimit = count(admission.claim_limit) ? admission.claim_limit : null;
  if ((cap !== null && running !== null && running >= cap)
      || (launched !== null && claimLimit !== null && launched >= claimLimit)
      || admission.admit === false || admission.decision === 'stop') {
    return 'global_admission';
  }
  return null;
}

/** Read the fleet-stop code back out of dispatcher-published blocked reasons. */
function publishedFleetStop(resources: readonly UnfedResource[]): FleetStopCode | null {
  let global = false;
  for (const r of resources) {
    if (r.blocked['admission_stopped']) return 'admission_stopped';
    if (r.blocked['global_admission']) global = true;
  }
  return global ? 'global_admission' : null;
}

/**
 * The current picture from queue/status.json and queue/ready.tsv (null when unavailable).
 * Throws when status.json has no usable lanes map. `market` carries the
 * dispatcher's own input files; when present and slots.json parses, a derived
 * report recomputes per-lane reason codes instead of leaving them unknown.
 */
export function currentUnfed(statusJson: string, readyTsv: string | null, market?: UnfedMarketInputs): Omit<UnfedReport, 'marketTruncated' | 'history' | 'overrides' | 'claims' | 'decisionOutcomes' | 'rejections'> {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const tickMs = typeof data.last_tick === 'string' ? Date.parse(data.last_tick) : NaN;
  const statusAsOf = Number.isFinite(tickMs) ? new Date(tickMs).toISOString() : null;
  const nowMs = market?.nowMs;
  const statusFresh = nowMs === undefined || !Number.isFinite(nowMs) ? null
    : data.schema === 'dispatchd.status.v1' && Number.isFinite(tickMs) && nowMs >= tickMs && nowMs - tickMs <= STATUS_FRESH_MS;
  const published = isRecord(data.unfed_capacity) && isRecord(data.unfed_capacity.lanes) ? data.unfed_capacity : null;
  const ctx = published === null ? marketContext(market) : null;
  const operatorHolds = published === null && ctx === null
    ? new Set((market?.hold ?? '').split(/\s+/u).filter(Boolean)) : null;
  const stop = fleetStopVerdict(data);
  // An admission-stopped tick never ran the market: the dispatcher's own
  // _waiting then uses the raw lane column from JID+tier-valid rows.
  const strict = readyTsv === null ? null : readyHints(readyTsv, market?.routerQueue);
  const hints = strict !== null && readyTsv !== null && published === null && stop === 'admission_stopped'
    ? { ...stoppedReadyHints(readyTsv), rows: strict.rows, invalid: strict.invalid }
    : strict;
  const publishedLanes = published && isRecord(published.lanes) ? published.lanes : {};
  const waiting = published === null ? hints?.waiting ?? null
    : count(published.waiting) ? published.waiting : null;
  const resources: UnfedResource[] = [];
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!LANE.test(lane) || !isRecord(value) || !count(value.running)) throw new Error('invalid lane');
    if (!count(value.target)) throw new Error('invalid lane');
    const tickTarget = laneLaunchTarget(value.target, count(value.effective_target) ? value.effective_target : null);
    const slot = ctx?.slots[lane];
    const configuredTarget = isRecord(slot) && count(slot.target) ? slot.target : null;
    const target = laneLaunchTarget(tickTarget, configuredTarget);
    const statusHeld = value.held === true;
    const view = ctx === null ? null : marketLaneView(lane, value.running, target, statusHeld, ctx);
    const held = view?.held ?? (statusHeld || operatorHolds?.has(lane) === true);
    const headroom = Math.max(0, target - value.running);
    const readyHinted = hints === null ? null : hints.byLane.get(lane) ?? 0;
    const entry = publishedLanes[lane];
    const canBeUnfed = headroom > 0 && !held;
    // The live ready file may already differ from the dispatcher's tick.
    let waitingElsewhere: number | null = canBeUnfed && waiting !== 0 ? null : 0;
    let blocked: Record<string, number> = {};
    if (isRecord(entry) && count(entry.waiting_elsewhere)) {
      waitingElsewhere = entry.waiting_elsewhere;
      blocked = codes(entry.blocked);
    } else if (!published && hints !== null && readyHinted !== null && canBeUnfed) {
      waitingElsewhere = hints.waiting - readyHinted;
      // A fleet stop outranks every per-lane code: the dispatcher never ran
      // (or never launched past) the market, so eligibility was not the
      // binding constraint for the rows still waiting.
      if (stop !== null) {
        if (waitingElsewhere > 0) blocked[stop] = waitingElsewhere;
      } else if (view !== null) {
        for (const row of hints.rows) {
          if (row.hint === lane) continue;
          for (const code of derivedRowCodes(row, lane, view)) blocked[code] = (blocked[code] ?? 0) + 1;
        }
      }
    }
    resources.push({
      lane, running: value.running, target, held, utilization: utilization(value.running, target), headroom,
      readyHinted, waitingElsewhere, unfed: canBeUnfed && (waitingElsewhere === null ? null : waitingElsewhere > 0), blocked,
    });
  }
  resources.sort((a, b) => a.lane.localeCompare(b.lane));
  const unfed = resources.filter(r => r.unfed === true);
  const slotBound = unfed.reduce((sum, r) => sum + Math.min(r.headroom, r.waitingElsewhere ?? 0), 0);
  return {
    schema: FLEET_UNFED_SCHEMA,
    readOnly: true,
    source: published ? 'dispatcher' : 'derived',
    derivedReasons: ctx !== null && readyTsv !== null,
    statusAsOf,
    statusFresh,
    fleetStop: stop ?? publishedFleetStop(resources),
    waiting,
    invalidRows: strict?.invalid ?? null,
    unfedLanes: unfed.map(r => r.lane),
    unfedSlots: resources.some(r => r.unfed === null) ? null
      : waiting === null ? (slotBound === 0 ? 0 : null) : Math.min(waiting, slotBound),
    resources,
  };
}

/** Exit status for the live verdict in a successfully read unfed report. */
export function unfedExitCode(report: UnfedReport): 0 | 1 | 2 {
  if (report.statusFresh !== true) return 2;
  if (report.unfedLanes.length > 0) return 1;
  return report.unfedSlots === null ? 2 : 0;
}

/**
 * Fold `unfed_capacity` rows from metrics/work-market.jsonl over a window.
 * Null text means the file was absent or unreadable. Malformed rows are skipped.
 * The last usable snapshot for each dispatcher tick wins.
 */
export function foldUnfedHistory(jsonl: string | null, nowMs: number, windowHours: number): UnfedHistory {
  const history: UnfedHistory = { windowHours, available: jsonl !== null, ticks: 0, lanes: [] };
  if (jsonl === null) return history;
  const until = nowMs / 1000;
  const since = until - windowHours * 3600;
  const ticks = new Map<number, { lane: string; slots: number; blocked: Record<string, number> }[]>();
  const lanes = new Map<string, UnfedHistoryLane & { last: number }>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: the file is mostly route decisions.
    if (!line.includes('"unfed_capacity"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row.schema !== 'work-market.v1' || row.event !== 'unfed_capacity' || !isRecord(row.lanes)) continue;
    const ts = row.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since || ts > until) continue;
    const snapshot = [];
    for (const [lane, value] of Object.entries(row.lanes)) {
      if (!LANE.test(lane) || !isRecord(value) || value.unfed !== true
        || !count(value.headroom) || value.headroom === 0
        || !count(value.waiting_elsewhere) || value.waiting_elsewhere === 0) continue;
      snapshot.push({ lane, slots: Math.min(value.headroom, value.waiting_elsewhere), blocked: codes(value.blocked) });
    }
    if (snapshot.length > 0) ticks.set(ts, snapshot);
  }
  history.ticks = ticks.size;
  for (const [ts, snapshot] of ticks) {
    for (const { lane, slots, blocked } of snapshot) {
      const entry = lanes.get(lane) ?? { lane, unfedTicks: 0, slotTicks: 0, lastUnfedAt: null, blocked: {}, last: 0 };
      entry.unfedTicks++;
      entry.slotTicks += slots;
      entry.last = Math.max(entry.last, ts);
      for (const [code, n] of Object.entries(blocked)) {
        if (code in entry.blocked || Object.keys(entry.blocked).length < MAX_CODES) entry.blocked[code] = (entry.blocked[code] ?? 0) + n;
      }
      lanes.set(lane, entry);
    }
  }
  history.lanes = [...lanes.values()]
    .map(({ last, ...entry }) => ({ ...entry, lastUnfedAt: new Date(last * 1000).toISOString() }))
    .sort((a, b) => b.slotTicks - a.slotTicks || a.lane.localeCompare(b.lane));
  return history;
}

/** work_class values the market producer writes (contrib/mac/work_market.py requirements). */
const MARKET_WORK_CLASSES: ReadonlySet<string> = new Set(['bulk', 'standard', 'judgment']);

/** One job's latest in-window route decision, with the fields outcome joins need. */
interface LatestRouteDecision {
  ts: number;
  override: { from: string | null; to: string; reason: string } | null;
  /** Declared preferred lane, or null when the job carried an open hint. */
  preferred: string | null;
  /** Lane the market chose, or null when the decision routed nowhere. */
  chosen: string | null;
  /** Recorded work_class when it is one of the market's closed values. */
  workClass: string | null;
  /** Lanes the market rejected for this job, with their recorded reason codes. */
  rejected: { lane: string; codes: string[] }[];
}

const laneField = (value: unknown): string | null =>
  typeof value === 'string' && LANE.test(value) ? value : null;

/**
 * A decision's `rejected_lanes` entries: each names a lane the market would
 * not run the job on, with the closed reason-code list that says why
 * (missing_capability, quota_exhausted, saturated, lower_rank, ...). Only
 * well-formed lane/code pairs survive — a malformed entry or code is
 * skipped, never guessed, matching the override and claim folds' strictness.
 */
const rejectedLanes = (value: unknown): { lane: string; codes: string[] }[] => {
  if (!Array.isArray(value)) return [];
  const out: { lane: string; codes: string[] }[] = [];
  const seenLanes = new Set<string>();
  for (const entry of value) {
    if (out.length >= MAX_CODES || !isRecord(entry)) continue;
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
};

/**
 * Collapse work-market.jsonl route_decision rows to each job's latest
 * in-window decision. The dispatcher re-decides every waiting job each tick,
 * so rows collapse before counting — a job that waited for hours counts once,
 * by where the market currently sends it. For equal tick timestamps, the
 * later valid append wins. Rows outside the window, malformed
 * JSON, non-route_decision events and missing or malformed decision fields
 * are skipped. An explicit null lane is valid evidence.
 */
function latestRouteDecisions(jsonl: string, nowMs: number, windowHours: number): Map<string, LatestRouteDecision> {
  const until = nowMs / 1000;
  const since = until - windowHours * 3600;
  const latest = new Map<string, LatestRouteDecision>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: route decisions are the bulk of the file.
    if (!line.includes('"route_decision"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row.schema !== 'work-market.v1' || row.event !== 'route_decision') continue;
    const ts = row.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since || ts > until) continue;
    const job = row.job;
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const prev = latest.get(job);
    if (prev !== undefined && prev.ts > ts) continue;
    const preferred = laneField(row.preferred_lane);
    const chosen = laneField(row.chosen_lane);
    if (chosen === null && row.chosen_lane !== null) continue;
    // Requirements validation fails before the dispatcher can decode a lane hint.
    const invalidRequirements = row.chosen_lane === null && row.preferred_lane === undefined
      && Array.isArray(row.reason_codes) && row.reason_codes.includes('invalid_requirements');
    if (preferred === null && row.preferred_lane !== null && !invalidRequirements) continue;
    let override: LatestRouteDecision['override'] = null;
    if (preferred !== null && chosen !== null && preferred !== chosen && isRecord(row.override)) {
      const { from, to, reason } = row.override;
      if (from === preferred && to === chosen && typeof reason === 'string' && CODE.test(reason)) {
        override = { from: preferred, to: chosen, reason };
      }
    }
    const workClass = typeof row.work_class === 'string' && MARKET_WORK_CLASSES.has(row.work_class)
      ? row.work_class : null;
    latest.set(job, {
      ts,
      override,
      preferred,
      chosen,
      workClass,
      rejected: rejectedLanes(row.rejected_lanes),
    });
  }
  return latest;
}

/**
 * Fold `route_decision` rows from metrics/work-market.jsonl over a window:
 * lane_override accounting. Counts and lane/reason codes only; no job ids,
 * task text or credentials. Null text means the file was absent or unreadable;
 * malformed rows are skipped.
 */
export function foldMarketOverrides(jsonl: string | null, nowMs: number, windowHours: number): UnfedOverrides {
  const tally: UnfedOverrides = { available: jsonl !== null, decided: 0, overridden: 0, byReason: {}, lanes: [] };
  if (jsonl === null) return tally;
  const latest = latestRouteDecisions(jsonl, nowMs, windowHours);
  const pairs = new Map<string, UnfedOverrideLane>();
  for (const decision of latest.values()) {
    tally.decided++;
    const override = decision.override;
    if (override === null) continue;
    tally.overridden++;
    if (tally.byReason[override.reason] !== undefined || Object.keys(tally.byReason).length < MAX_CODES) {
      tally.byReason[override.reason] = (tally.byReason[override.reason] ?? 0) + 1;
    }
    const key = `${override.from ?? ''}\t${override.to}\t${override.reason}`;
    const entry = pairs.get(key) ?? { from: override.from, to: override.to, reason: override.reason, jobs: 0 };
    entry.jobs++;
    pairs.set(key, entry);
  }
  tally.lanes = [...pairs.values()]
    .sort((a, b) => b.jobs - a.jobs || (a.from ?? '').localeCompare(b.from ?? '')
      || a.to.localeCompare(b.to) || a.reason.localeCompare(b.reason))
    .slice(0, MAX_OVERRIDE_LANES);
  return tally;
}

/**
 * Fold `claim`/`batch_claim` rows from metrics/jobs.jsonl over a window:
 * lane_override accounting at launch time — the record the dispatcher writes
 * when a claim actually leaves its hinted lane. `overrides` counts market
 * decisions; this counts what launched, including `batch_session` moves a
 * combined session makes after each member's own decision. The synthetic
 * RQ-BATCH-* session claim is excluded because members have their own events.
 * Each re-launched job attempt counts again. Timestamps are
 * the ledger's ISO strings (parseLedgerTs handles dispatchd's %z offset);
 * rows outside the window, malformed fields and non-claim events are skipped.
 * Null text means the file was absent or unreadable. Counts and lane/reason
 * codes only; no job ids, task text or credentials.
 */
export function foldClaimOverrides(
  jsonl: string | null, nowMs: number, windowHours: number, truncated = false,
): UnfedClaims {
  const tally: UnfedClaims = {
    available: jsonl !== null, truncated: jsonl !== null && truncated,
    claimed: 0, overridden: 0, byReason: {}, lanes: [],
  };
  if (jsonl === null) return tally;
  const since = nowMs - windowHours * 3_600_000;
  const pairs = new Map<string, UnfedClaimLane>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: claim events are a minority of the ledger.
    if (!line.includes('claim')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || (row.event !== 'claim' && row.event !== 'batch_claim')) continue;
    const job = row.job;
    if (typeof job !== 'string' || job.length === 0 || job.length > 200 || job.startsWith('RQ-BATCH-')) continue;
    const lane = row.lane;
    if (typeof lane !== 'string' || !LANE.test(lane)) continue;
    const at = parseLedgerTs(row.ts);
    if (at === null || at < since || at > nowMs) continue;
    tally.claimed++;
    const reason = row.lane_override;
    if (typeof reason !== 'string' || !CODE.test(reason)) continue;
    // lane_override is only meaningful with its recorded origin: absent or
    // malformed lane_hint means the pair cannot be named honestly.
    const hint = row.lane_hint;
    if (hint !== null && (typeof hint !== 'string' || !LANE.test(hint))) continue;
    if (hint === lane) continue;
    tally.overridden++;
    if (tally.byReason[reason] !== undefined || Object.keys(tally.byReason).length < MAX_CODES) {
      tally.byReason[reason] = (tally.byReason[reason] ?? 0) + 1;
    }
    const from = typeof hint === 'string' ? hint : null;
    const key = `${from ?? ''}\t${lane}\t${reason}`;
    const entry = pairs.get(key) ?? { from, to: lane, reason, claims: 0 };
    entry.claims++;
    pairs.set(key, entry);
  }
  tally.lanes = [...pairs.values()]
    .sort((a, b) => b.claims - a.claims || (a.from ?? '').localeCompare(b.from ?? '')
      || a.to.localeCompare(b.to) || a.reason.localeCompare(b.reason))
    .slice(0, MAX_OVERRIDE_LANES);
  return tally;
}

const MAX_CLASS_KEYS = 8;

const emptyOutcomeTally = (): UnfedDecisionOutcomeTally =>
  ({ decided: 0, known: 0, merged: 0, unmerged: 0, reverted: 0, unresolved: 0 });

const tallyOutcome = (
  tally: UnfedDecisionOutcomeTally,
  outcome: { merged: boolean | null; reverted: boolean | null } | undefined,
): void => {
  tally.decided++;
  if (outcome === undefined || outcome.merged === null) { tally.unresolved++; return; }
  tally.known++;
  if (outcome.merged) tally.merged++; else tally.unmerged++;
  if (outcome.reverted === true) tally.reverted++;
};

/**
 * Fold the window's route decisions against the retained jobs.jsonl tail:
 * outcome correlation for market routing. Each waiting job counts once, by
 * its latest in-window decision (the same collapse foldMarketOverrides
 * uses), then joins the job id to the newest recorded outcome — merged,
 * closed-unmerged or unresolved — through the router outcome fold, so revert
 * evidence keeps the same sticky-true semantics as `phm router outcomes`.
 * Groups partition the decided jobs: `hinted` chose the declared preferred
 * lane, `overridden` recorded a well-formed lane_override, `open` chose a
 * lane with no declared preference, `unrouted` chose no lane, and
 * `unexplained` left a declared preference with no well-formed override
 * record. `byReason` counts overridden jobs by override reason and `byClass`
 * tallies outcomes per recorded work_class ('unclassified' when absent or
 * outside the market's closed values). Counts and class/reason codes only;
 * no job ids, task text or credentials. Null market text means the journal
 * was absent or unreadable; null jobs text means no outcome join ran and
 * every decided job reads unresolved. jobsTruncated marks a retained-tail
 * lower bound on outcomes.
 */
export function foldDecisionOutcomes(
  marketJsonl: string | null,
  jobsJsonl: string | null,
  nowMs: number,
  windowHours: number,
  jobsTruncated = false,
): UnfedDecisionOutcomes {
  const report: UnfedDecisionOutcomes = {
    available: marketJsonl !== null,
    jobsAvailable: jobsJsonl !== null,
    jobsTruncated: jobsJsonl !== null && jobsTruncated,
    decided: 0,
    hinted: emptyOutcomeTally(),
    overridden: emptyOutcomeTally(),
    open: emptyOutcomeTally(),
    unrouted: emptyOutcomeTally(),
    unexplained: emptyOutcomeTally(),
    byReason: {},
    byClass: {},
  };
  if (marketJsonl === null) return report;
  const outcomes = new Map<string, { merged: boolean | null; reverted: boolean | null }>();
  if (jobsJsonl !== null) {
    for (const outcome of foldRouterOutcomes(jobsJsonl, { verdictAsOfMs: nowMs }).outcomes) {
      outcomes.set(outcome.job_id, { merged: outcome.merged, reverted: outcome.reverted });
    }
  }
  const bumpClass = (workClass: string | null, outcome: { merged: boolean | null; reverted: boolean | null } | undefined): void => {
    const key = workClass ?? 'unclassified';
    if (report.byClass[key] === undefined && Object.keys(report.byClass).length >= MAX_CLASS_KEYS) return;
    const tally = report.byClass[key] ??= emptyOutcomeTally();
    tallyOutcome(tally, outcome);
  };
  for (const [job, decision] of latestRouteDecisions(marketJsonl, nowMs, windowHours)) {
    report.decided++;
    const outcome = outcomes.get(job);
    const group = decision.chosen === null
      ? report.unrouted
      : decision.override !== null
        ? report.overridden
        : decision.preferred !== null && decision.chosen === decision.preferred
          ? report.hinted
          : decision.preferred === null
            ? report.open
            : report.unexplained;
    tallyOutcome(group, outcome);
    if (group === report.overridden && decision.override !== null
        && (report.byReason[decision.override.reason] !== undefined
          || Object.keys(report.byReason).length < MAX_CODES)) {
      report.byReason[decision.override.reason] = (report.byReason[decision.override.reason] ?? 0) + 1;
    }
    bumpClass(decision.workClass, outcome);
  }
  return report;
}

const MAX_REJECTION_LANES = 16;

/**
 * Fold `rejected_lanes` from the window's route_decision rows: for each
 * job's latest in-window decision, every lane the market rejected with its
 * recorded reason codes. `lanes` keeps the per-lane detail (a job counts
 * once under each lane that rejected it); `byReason` counts each job once
 * per reason across all its rejected lanes, so a job rejected by three
 * lanes for the same cause is one affected job, not three. Null text means
 * the journal was absent or unreadable; malformed rows and entries are
 * skipped. Counts and lane/reason codes only; no job ids, task text or
 * credentials.
 */
export function foldRouteRejections(
  marketJsonl: string | null,
  nowMs: number,
  windowHours: number,
): UnfedRejections {
  const report: UnfedRejections = { available: marketJsonl !== null, decided: 0, unrouted: 0, lanes: [], byReason: {} };
  if (marketJsonl === null) return report;
  const perLane = new Map<string, { jobs: number; reasons: Record<string, number> }>();
  for (const [, decision] of latestRouteDecisions(marketJsonl, nowMs, windowHours)) {
    report.decided++;
    if (decision.chosen === null) report.unrouted++;
    const jobReasons = new Set<string>();
    for (const rej of decision.rejected) {
      const entry = perLane.get(rej.lane) ?? { jobs: 0, reasons: {} };
      entry.jobs++;
      for (const code of rej.codes) {
        if (entry.reasons[code] !== undefined || Object.keys(entry.reasons).length < MAX_CODES) {
          entry.reasons[code] = (entry.reasons[code] ?? 0) + 1;
        }
        jobReasons.add(code);
      }
      perLane.set(rej.lane, entry);
    }
    for (const code of jobReasons) {
      if (report.byReason[code] !== undefined || Object.keys(report.byReason).length < MAX_CODES) {
        report.byReason[code] = (report.byReason[code] ?? 0) + 1;
      }
    }
  }
  report.lanes = [...perLane.entries()]
    .map(([lane, value]) => ({ lane, jobs: value.jobs, reasons: value.reasons }))
    .sort((a, b) => b.jobs - a.jobs || a.lane.localeCompare(b.lane))
    .slice(0, MAX_REJECTION_LANES);
  return report;
}

const MAX_OVERRIDE_LANES = 16;

const topCodes = (blocked: Record<string, number>): string =>
  Object.entries(blocked).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([code, n]) => `${code} ${n}`).join(', ');

/** Plain-text rendering; one line per resource, then the window summary. */
export function renderUnfed(report: UnfedReport): string[] {
  const lines: string[] = [];
  for (const r of report.resources) {
    const use = r.utilization === null ? 'no target' : `${Math.round(r.utilization * 100)}%`;
    const state = r.held ? '  HELD' : r.unfed ? `  UNFED: ${r.headroom} free, ${r.waitingElsewhere} rows waiting elsewhere${Object.keys(r.blocked).length ? ` (${topCodes(r.blocked)})` : ''}` : '';
    lines.push(`${r.lane}  ${r.running}/${r.target} running (${use}), ${r.readyHinted ?? 'unknown'} hinted here${state}`);
  }
  for (const lane of report.resourcePlan ?? []) {
    if (lane.target === null) continue;
    lines.push(`plan ${lane.lane}: ${lane.running ?? 'unknown'}/${lane.target ?? 'unknown'} running, ${lane.unfedSlots ?? 'unknown'} unfilled plan slots with waiting work`);
  }
  if (report.resources.length === 0) lines.push('No lanes in queue/status.json.');
  lines.push(report.unfedSlots === null
    ? `Unfed capacity unknown: ${report.waiting ?? 'unknown'} rows waiting.`
    : report.unfedLanes.length === 0
    ? `No unfed capacity: ${report.waiting ?? 'unknown'} rows waiting.`
    : `Up to ${report.unfedSlots} unfed slot(s) across ${report.unfedLanes.join(', ')}; ${report.waiting ?? 'unknown'} rows waiting.`);
  if (report.statusFresh === false) {
    lines.push(report.statusAsOf === null
      ? 'Status snapshot age unknown: status.json has no readable last_tick; counts above are the last published state.'
      : `Status snapshot is stale: last dispatcher tick ${report.statusAsOf}; counts above are the last published state, not live.`);
  }
  if (report.invalidRows !== null && report.invalidRows > 0) {
    lines.push(`${report.invalidRows} ready row(s) fail work-market validation (job id, tier or requirements) and can never launch; fix or drop them.`);
  }
  if (report.fleetStop !== null) {
    lines.push(report.fleetStop === 'admission_stopped'
      ? 'Fleet admission stopped (pause, disk guard or load gate): the market was not evaluated this tick.'
      : 'Fleet admission closed at the global cap or launch budget: rows evaluated after the limit record global_admission.');
  }
  if (report.source === 'derived') {
    lines.push(report.derivedReasons
      ? 'Derived from lane counts, ready.tsv requirements and slots.json advertisements: the dispatcher did not publish its verdict.'
      : report.fleetStop !== null
        ? 'Derived from lane counts, ready.tsv hints and the status.json admission verdict: the dispatcher did not publish reasons, but the fleet stop above is its own record.'
        : 'Derived from lane counts and ready.tsv hints: this dispatcher does not publish reasons.');
  }
  const h = report.history;
  if (report.marketTruncated) {
    lines.push(`Last ${h.windowHours}h: work-market journal tail only. History, route decisions, rejections and linked outcomes may be incomplete.`);
  }
  if (!h.available) lines.push(`Last ${h.windowHours}h: no metrics/work-market.jsonl history.`);
  else if (h.lanes.length === 0) lines.push(`Last ${h.windowHours}h: no unfed ticks recorded.`);
  else {
    lines.push(`Last ${h.windowHours}h: ${h.ticks} tick(s) left capacity unfed.`);
    for (const l of h.lanes) {
      lines.push(`  ${l.lane}: ${l.unfedTicks} tick(s), ${l.slotTicks} slot-tick(s) lost${Object.keys(l.blocked).length ? ` (${topCodes(l.blocked)})` : ''}`);
    }
  }
  const o = report.overrides;
  if (o.available) {
    if (o.decided === 0) lines.push(`Last ${h.windowHours}h: no route decisions recorded.`);
    else {
      lines.push(`Last ${h.windowHours}h: ${o.decided} job(s) decided, ${o.overridden} left their hinted lane.`);
      if (o.overridden > 0) {
        lines.push(`  override reasons: ${topCodes(o.byReason)}`);
        for (const l of o.lanes.slice(0, 3)) {
          lines.push(`  ${l.from ?? 'open'} -> ${l.to} (${l.reason}): ${l.jobs} job(s)`);
        }
      }
    }
  }
  const j = report.rejections;
  if (j.available && j.decided > 0) {
    const nowhere = j.unrouted > 0 ? `, ${j.unrouted} routed nowhere` : '';
    if (j.lanes.length === 0) {
      lines.push(`Last ${h.windowHours}h: no lane rejections recorded across ${j.decided} decided job(s)${nowhere}.`);
    } else {
      lines.push(`Last ${h.windowHours}h: lane rejections across ${j.decided} decided job(s)${nowhere}: ${topCodes(j.byReason)}`);
      for (const l of j.lanes.slice(0, 3)) {
        lines.push(`  ${l.lane}: ${l.jobs} job(s) rejected${Object.keys(l.reasons).length ? ` (${topCodes(l.reasons)})` : ''}`);
      }
    }
  }
  const c = report.claims;
  if (c.available) {
    if (c.claimed === 0) lines.push(`Last ${h.windowHours}h: no claims recorded.`);
    else {
      lines.push(`Last ${h.windowHours}h: ${c.claimed} claim(s) launched, ${c.overridden} left their hinted lane${c.truncated ? ' (ledger tail only)' : ''}.`);
      if (c.overridden > 0) {
        lines.push(`  claim override reasons: ${topCodes(c.byReason)}`);
        for (const l of c.lanes.slice(0, 3)) {
          lines.push(`  ${l.from ?? 'open'} -> ${l.to} (${l.reason}): ${l.claims} claim(s)`);
        }
      }
    }
  }
  const d = report.decisionOutcomes;
  if (d.available) {
    if (!d.jobsAvailable) {
      lines.push(`Last ${h.windowHours}h: route-decision outcomes unknown — metrics/jobs.jsonl is missing or unreadable.`);
    } else {
      const groups: [string, UnfedDecisionOutcomeTally][] = [
        ['hinted', d.hinted], ['overridden', d.overridden], ['open', d.open],
        ['unrouted', d.unrouted], ['unexplained', d.unexplained],
      ];
      const used = groups.filter(([, t]) => t.decided > 0);
      // decided === 0 needs no line here: the overrides block above already
      // reports "no route decisions recorded" for the same collapsed set.
      if (d.decided > 0) {
        const total = groups.reduce((sum, [, t]) => sum + t.decided, 0);
        const merged = groups.reduce((sum, [, t]) => sum + t.merged, 0);
        const unmerged = groups.reduce((sum, [, t]) => sum + t.unmerged, 0);
        const unresolved = groups.reduce((sum, [, t]) => sum + t.unresolved, 0);
        const reverted = groups.reduce((sum, [, t]) => sum + t.reverted, 0);
        lines.push(`Last ${h.windowHours}h: outcomes for ${total} decided job(s): ${merged} merged${reverted ? ` (${reverted} reverted)` : ''}, ${unmerged} unmerged, ${unresolved} unresolved${d.jobsTruncated ? ' (jobs tail only)' : ''}.`);
        for (const [label, t] of used) {
          lines.push(`  ${label}: ${t.decided} decided, ${t.merged} merged, ${t.unmerged} unmerged, ${t.unresolved} unresolved${t.reverted ? `, ${t.reverted} reverted` : ''}`);
        }
      }
    }
  }
  return lines;
}
