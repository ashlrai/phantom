/**
 * Per-resource utilization and unfed capacity for the shared work queue
 * (RQ-SHARED-QUEUE-1). A resource is unfed when it has free slots while
 * runnable rows wait under another lane's hint. Pure: text in, report out.
 * Counts and reason codes only; no job ids, task text or credentials.
 */
import { derivedRowCodes, marketContext, marketLaneView, parseReadyMarketRows, type ReadyMarketRow, type UnfedMarketInputs } from './unfed-market.js';

export const FLEET_UNFED_SCHEMA = 'fleet.unfed.v1';

/** Reason codes are short lowercase identifiers written by the dispatcher. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const MAX_CODES = 32;

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
  readyHinted: number;
  /** Ready rows hinted elsewhere (or unhinted) while this resource had headroom. */
  waitingElsewhere: number;
  unfed: boolean;
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

export type FleetStopCode = 'admission_stopped' | 'global_admission';

export interface UnfedReport {
  schema: typeof FLEET_UNFED_SCHEMA;
  readOnly: true;
  /**
   * `dispatcher`: the tick's own verdict from status.json, with reason codes.
   * `derived`: computed here from lane counts and ready.tsv, because the
   * running dispatcher does not publish the block.
   */
  source: 'dispatcher' | 'derived';
  /** True when a derived report also recomputed reason codes from market inputs (slots.json and friends). */
  derivedReasons: boolean;
  /**
   * The fleet-wide stop in effect this tick, in the dispatcher's own codes:
   * `admission_stopped` when the launch gate (pause, disk hard stop or a
   * tripped load gate) kept the market from running, `global_admission` when
   * the per-tick launch budget or fleet-wide cap was spent. Read back from
   * published blocked codes for a dispatcher report, or from status.json's
   * own admission verdict for a derived one. Null when the market ran
   * normally or no verdict exists.
   */
  fleetStop: FleetStopCode | null;
  /** Ready rows still waiting. */
  waiting: number;
  unfedLanes: string[];
  /** Slots that could be filled now: sum of min(headroom, waiting rows) over unfed lanes. */
  unfedSlots: number;
  resources: UnfedResource[];
  history: UnfedHistory;
  /** lane_override accounting over the same window's route_decision rows. */
  overrides: UnfedOverrides;
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
 * (the requirements column may override the lane column), matching the
 * dispatcher's own unfed accounting.
 */
export function readyHints(readyTsv: string): { waiting: number; byLane: Map<string, number>; rows: ReadyMarketRow[] } {
  const rows = parseReadyMarketRows(readyTsv);
  const byLane = new Map<string, number>();
  for (const row of rows) {
    const lane = row.hint ?? '';
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  }
  return { waiting: rows.length, byLane, rows };
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
  const gateReason = admission?.gate_reason;
  if (typeof gateReason === 'string' && gateReason.trim().length > 0) return 'admission_stopped';
  if (admission === null) return null;
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
 * The current picture from queue/status.json and queue/ready.tsv ('' when absent).
 * Throws when status.json has no usable lanes map. `market` carries the
 * dispatcher's own input files; when present and slots.json parses, a derived
 * report recomputes per-lane reason codes instead of leaving them unknown.
 */
export function currentUnfed(statusJson: string, readyTsv: string, market?: UnfedMarketInputs): Omit<UnfedReport, 'history' | 'overrides'> {
  const data: unknown = JSON.parse(statusJson);
  if (!isRecord(data) || !isRecord(data.lanes)) throw new Error('invalid status');
  const hints = readyHints(readyTsv);
  const published = isRecord(data.unfed_capacity) && isRecord(data.unfed_capacity.lanes) ? data.unfed_capacity : null;
  const ctx = published === null ? marketContext(market) : null;
  const stop = published === null ? fleetStopVerdict(data) : null;
  const publishedLanes = published && isRecord(published.lanes) ? published.lanes : {};
  const waiting = published && count(published.waiting) ? published.waiting : hints.waiting;
  const resources: UnfedResource[] = [];
  for (const [lane, value] of Object.entries(data.lanes)) {
    if (!LANE.test(lane) || !isRecord(value) || !count(value.running)) throw new Error('invalid lane');
    // The effective target is what the lane may launch against after load shedding.
    const target = count(value.effective_target) ? value.effective_target : value.target;
    if (!count(target)) throw new Error('invalid lane');
    const held = value.held === true;
    const headroom = Math.max(0, target - value.running);
    const readyHinted = hints.byLane.get(lane) ?? 0;
    const entry = publishedLanes[lane];
    let waitingElsewhere = 0;
    let blocked: Record<string, number> = {};
    if (isRecord(entry) && count(entry.waiting_elsewhere)) {
      waitingElsewhere = entry.waiting_elsewhere;
      blocked = codes(entry.blocked);
    } else if (!published) {
      if (headroom > 0 && !held) {
        waitingElsewhere = hints.waiting - readyHinted;
        // A fleet stop outranks every per-lane code: the dispatcher never ran
        // (or never launched past) the market, so eligibility was not the
        // binding constraint for the rows still waiting.
        if (stop !== null) {
          if (waitingElsewhere > 0) blocked[stop] = waitingElsewhere;
        } else if (ctx !== null) {
          const view = marketLaneView(lane, value.running, target, held, ctx);
          for (const row of hints.rows) {
            if (row.hint === lane) continue;
            for (const code of derivedRowCodes(row, lane, view)) blocked[code] = (blocked[code] ?? 0) + 1;
          }
        }
      }
    }
    resources.push({
      lane, running: value.running, target, held, utilization: utilization(value.running, target), headroom,
      readyHinted, waitingElsewhere, unfed: headroom > 0 && !held && waitingElsewhere > 0, blocked,
    });
  }
  resources.sort((a, b) => a.lane.localeCompare(b.lane));
  const unfed = resources.filter(r => r.unfed);
  return {
    schema: FLEET_UNFED_SCHEMA,
    readOnly: true,
    source: published ? 'dispatcher' : 'derived',
    derivedReasons: ctx !== null,
    fleetStop: stop ?? publishedFleetStop(resources),
    waiting,
    unfedLanes: unfed.map(r => r.lane),
    unfedSlots: unfed.reduce((sum, r) => sum + Math.min(r.headroom, r.waitingElsewhere), 0),
    resources,
  };
}

/**
 * Fold `unfed_capacity` rows from metrics/work-market.jsonl over a window.
 * Null text means the file was absent or unreadable. Malformed rows are skipped.
 */
export function foldUnfedHistory(jsonl: string | null, nowMs: number, windowHours: number): UnfedHistory {
  const history: UnfedHistory = { windowHours, available: jsonl !== null, ticks: 0, lanes: [] };
  if (jsonl === null) return history;
  const since = nowMs / 1000 - windowHours * 3600;
  const lanes = new Map<string, UnfedHistoryLane & { last: number }>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: the file is mostly route decisions.
    if (!line.includes('"unfed_capacity"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row.schema !== 'work-market.v1' || row.event !== 'unfed_capacity' || !isRecord(row.lanes)) continue;
    const ts = row.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since || ts > nowMs / 1000 + 300) continue;
    let any = false;
    for (const [lane, value] of Object.entries(row.lanes)) {
      if (!LANE.test(lane) || !isRecord(value) || value.unfed !== true || !count(value.headroom) || !count(value.waiting_elsewhere)) continue;
      any = true;
      const entry = lanes.get(lane) ?? { lane, unfedTicks: 0, slotTicks: 0, lastUnfedAt: null, blocked: {}, last: 0 };
      entry.unfedTicks++;
      entry.slotTicks += Math.min(value.headroom, value.waiting_elsewhere);
      entry.last = Math.max(entry.last, ts);
      for (const [code, n] of Object.entries(codes(value.blocked))) {
        if (code in entry.blocked || Object.keys(entry.blocked).length < MAX_CODES) entry.blocked[code] = (entry.blocked[code] ?? 0) + n;
      }
      lanes.set(lane, entry);
    }
    if (any) history.ticks++;
  }
  history.lanes = [...lanes.values()]
    .map(({ last, ...entry }) => ({ ...entry, lastUnfedAt: new Date(last * 1000).toISOString() }))
    .sort((a, b) => b.slotTicks - a.slotTicks || a.lane.localeCompare(b.lane));
  return history;
}

/**
 * Fold `route_decision` rows from metrics/work-market.jsonl over a window:
 * lane_override accounting. The dispatcher re-decides every waiting job each
 * tick, so rows collapse to each job's latest in-window decision before
 * counting — a job that waited for hours counts once, by where the market
 * currently sends it. Counts and lane/reason codes only; no job ids, task
 * text or credentials. Null text means the file was absent or unreadable;
 * malformed rows are skipped.
 */
export function foldMarketOverrides(jsonl: string | null, nowMs: number, windowHours: number): UnfedOverrides {
  const tally: UnfedOverrides = { available: jsonl !== null, decided: 0, overridden: 0, byReason: {}, lanes: [] };
  if (jsonl === null) return tally;
  const since = nowMs / 1000 - windowHours * 3600;
  const latest = new Map<string, { ts: number; override: { from: string | null; to: string; reason: string } | null }>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: route decisions are the bulk of the file.
    if (!line.includes('"route_decision"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row) || row.schema !== 'work-market.v1' || row.event !== 'route_decision') continue;
    const ts = row.ts;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < since || ts > nowMs / 1000 + 300) continue;
    const job = row.job;
    if (typeof job !== 'string' || job.length === 0 || job.length > 200) continue;
    const prev = latest.get(job);
    if (prev !== undefined && prev.ts >= ts) continue;
    let override: { from: string | null; to: string; reason: string } | null = null;
    if (isRecord(row.override)) {
      const from = row.override.from, to = row.override.to, reason = row.override.reason;
      if ((from === null || (typeof from === 'string' && LANE.test(from)))
          && typeof to === 'string' && LANE.test(to)
          && typeof reason === 'string' && CODE.test(reason)) {
        override = { from: from as string | null, to, reason };
      }
    }
    latest.set(job, { ts, override });
  }
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

const MAX_OVERRIDE_LANES = 16;

const topCodes = (blocked: Record<string, number>): string =>
  Object.entries(blocked).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([code, n]) => `${code} ${n}`).join(', ');

/** Plain-text rendering; one line per resource, then the window summary. */
export function renderUnfed(report: UnfedReport): string[] {
  const lines: string[] = [];
  for (const r of report.resources) {
    const use = r.utilization === null ? 'no target' : `${Math.round(r.utilization * 100)}%`;
    const state = r.held ? '  HELD' : r.unfed ? `  UNFED: ${r.headroom} free, ${r.waitingElsewhere} rows waiting elsewhere${Object.keys(r.blocked).length ? ` (${topCodes(r.blocked)})` : ''}` : '';
    lines.push(`${r.lane}  ${r.running}/${r.target} running (${use}), ${r.readyHinted} hinted here${state}`);
  }
  if (report.resources.length === 0) lines.push('No lanes in queue/status.json.');
  lines.push(report.unfedLanes.length === 0
    ? `No unfed capacity: ${report.waiting} rows waiting.`
    : `${report.unfedSlots} slot(s) could be filled now across ${report.unfedLanes.join(', ')}; ${report.waiting} rows waiting.`);
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
  return lines;
}
