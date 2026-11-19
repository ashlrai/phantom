/**
 * Lane-override accounting for the shared work market (RQ-SHARED-QUEUE-1).
 *
 * The dispatcher writes one `route_decision` row per candidate job per tick to
 * metrics/work-market.jsonl. Each row names the job's resolved preferred_lane,
 * the lane the market chose, and — when the choice left the hint — an
 * `override` object with its reason and the reason codes that blocked the
 * hinted lane. This module folds those rows over a window into per-job
 * accounting: how much hinted work the market moved, why, and which lanes
 * gained or lost it. A job repeats once per tick, so only its latest in-window
 * decision counts.
 *
 * Honesty rules: unknown stays unknown. `overrideRate` is null when no job
 * carried a hint — never 0. Rows that fail validation are counted as dropped,
 * never guessed into a lane. Counts and reason codes only; no task text,
 * prompts or credentials leave this module.
 */

export const FLEET_LANE_OVERRIDES_SCHEMA = 'fleet.lane-overrides.v1';

/** Lane ids as the dispatcher writes them (pool names, never paths). */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** Reason codes are short lowercase identifiers written by the dispatcher. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/;
const MAX_CODES = 32;
const MAX_PAIRS = 64;

export interface LaneOverridePair {
  /** The hinted lane that lost the job. */
  from: string;
  /** The lane the market chose instead. */
  to: string;
  count: number;
}

export interface LaneOverridesReport {
  schema: typeof FLEET_LANE_OVERRIDES_SCHEMA;
  readOnly: true;
  windowHours: number;
  /** False when metrics/work-market.jsonl is absent or unreadable. */
  available: boolean;
  /** Distinct jobs with at least one valid route_decision row in the window. */
  jobs: number;
  /** Valid route_decision rows seen before per-job dedup. */
  rows: number;
  /** route_decision-looking lines that failed validation. */
  dropped: number;
  /** Jobs whose latest decision carried a preferred_lane hint. */
  hinted: number;
  /** Jobs whose latest decision placed them off their hint. */
  overrides: number;
  /** overrides / hinted; null when nothing was hinted (unknown, never 0). */
  overrideRate: number | null;
  /** override.reason counts (resource_fit, preferred_lane_fallback, unknown_preference). */
  reasons: Record<string, number>;
  /** Reason codes from override.preferred_lane_blocked_by across overridden jobs. */
  blockedBy: Record<string, number>;
  /** Hinted lane -> chosen lane for overridden jobs, most frequent first. */
  pairs: LaneOverridePair[];
  /** Jobs whose latest decision found no runnable lane. */
  unrouted: number;
  /** reason_codes histogram over those unrouted latest decisions. */
  unroutedReasons: Record<string, number>;
}

interface LatestDecision {
  job: string;
  ts: number;
  preferred: string | null;
  chosen: string | null;
  override: { from: string; to: string; reason: string | null; blockedBy: string[] } | null;
  reasonCodes: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A lane field: absent/null means no lane; a malformed value is undefined. */
function laneField(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && LANE.test(value) ? value : undefined;
}

function codeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && CODE.test(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/** Validate one route_decision row into a LatestDecision, or null when malformed. */
function decisionOf(row: Record<string, unknown>): LatestDecision | null {
  const job = row['job'];
  const ts = row['ts'];
  const preferred = laneField(row['preferred_lane']);
  const chosen = laneField(row['chosen_lane']);
  if (typeof job !== 'string' || !JOB.test(job)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (preferred === undefined || chosen === undefined) return null;
  let override: LatestDecision['override'] = null;
  const raw = row['override'];
  if (raw !== undefined && raw !== null) {
    if (!isRecord(raw)) return null;
    const fromRaw = laneField(raw['from']);
    const toRaw = laneField(raw['to']);
    if (fromRaw === undefined || toRaw === undefined) return null;
    const from = fromRaw ?? preferred;
    const to = toRaw ?? chosen;
    if (from === null || to === null || from === to) return null;
    const reason = raw['reason'];
    override = {
      from,
      to,
      reason: typeof reason === 'string' && CODE.test(reason) ? reason : null,
      blockedBy: codeList(raw['preferred_lane_blocked_by']),
    };
  }
  return { job, ts, preferred, chosen, override, reasonCodes: codeList(row['reason_codes']) };
}

/** Sorted count record: most frequent first, ties by code. Bounded at MAX_CODES. */
function countRecord(counts: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, n] of [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CODES)) out[code] = n;
  return out;
}

/**
 * Fold `route_decision` rows from metrics/work-market.jsonl over a window.
 * Null text means the file was absent or unreadable. The file is mostly other
 * events, so lines without the marker are skipped before parsing; lines that
 * carry the marker but fail validation count as dropped. Per job, only the
 * latest in-window decision counts.
 */
export function foldLaneOverrides(jsonl: string | null, nowMs: number, windowHours: number): LaneOverridesReport {
  const report: LaneOverridesReport = {
    schema: FLEET_LANE_OVERRIDES_SCHEMA,
    readOnly: true,
    windowHours,
    available: jsonl !== null,
    jobs: 0,
    rows: 0,
    dropped: 0,
    hinted: 0,
    overrides: 0,
    overrideRate: null,
    reasons: {},
    blockedBy: {},
    pairs: [],
    unrouted: 0,
    unroutedReasons: {},
  };
  if (jsonl === null) return report;
  const since = nowMs / 1000 - windowHours * 3600;
  const until = nowMs / 1000 + 300;
  const latest = new Map<string, LatestDecision>();
  const reasonCounts = new Map<string, number>();
  const blockedCounts = new Map<string, number>();
  const unroutedCounts = new Map<string, number>();
  const pairCounts = new Map<string, LaneOverridePair>();
  for (const line of jsonl.split('\n')) {
    // Cheap prefilter: the file is mostly posture, unfed and handoff rows.
    if (!line.includes('"route_decision"')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { report.dropped++; continue; }
    if (!isRecord(row) || row['schema'] !== 'work-market.v1' || row['event'] !== 'route_decision') {
      report.dropped++;
      continue;
    }
    const decision = decisionOf(row);
    if (decision === null) { report.dropped++; continue; }
    if (decision.ts < since || decision.ts > until) continue;
    report.rows++;
    const prev = latest.get(decision.job);
    if (prev === undefined || decision.ts >= prev.ts) latest.set(decision.job, decision);
  }
  report.jobs = latest.size;
  for (const decision of latest.values()) {
    if (decision.preferred !== null) report.hinted++;
    if (decision.chosen === null) {
      report.unrouted++;
      for (const code of decision.reasonCodes) unroutedCounts.set(code, (unroutedCounts.get(code) ?? 0) + 1);
    }
    if (decision.override === null) continue;
    report.overrides++;
    if (decision.override.reason !== null) {
      reasonCounts.set(decision.override.reason, (reasonCounts.get(decision.override.reason) ?? 0) + 1);
    }
    for (const code of decision.override.blockedBy) {
      blockedCounts.set(code, (blockedCounts.get(code) ?? 0) + 1);
    }
    const key = `${decision.override.from} ${decision.override.to}`;
    const pair = pairCounts.get(key) ?? { from: decision.override.from, to: decision.override.to, count: 0 };
    pair.count++;
    pairCounts.set(key, pair);
  }
  report.overrideRate = report.hinted > 0 ? Math.round((report.overrides / report.hinted) * 1000) / 1000 : null;
  report.reasons = countRecord(reasonCounts);
  report.blockedBy = countRecord(blockedCounts);
  report.unroutedReasons = countRecord(unroutedCounts);
  report.pairs = [...pairCounts.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .slice(0, MAX_PAIRS);
  return report;
}

const pct = (rate: number | null): string => (rate === null ? 'unknown' : `${Math.round(rate * 100)}%`);

const topCodes = (blocked: Record<string, number>): string =>
  Object.entries(blocked).slice(0, 3).map(([code, n]) => `${code} ${n}`).join(', ');

/** Plain-text rendering; one summary block, then the override evidence. */
export function renderLaneOverrides(report: LaneOverridesReport): string[] {
  const lines: string[] = [];
  if (!report.available) {
    lines.push(`Last ${report.windowHours}h: no metrics/work-market.jsonl history.`);
    return lines;
  }
  lines.push(`Last ${report.windowHours}h: ${report.jobs} job(s) evaluated (${report.rows} decision(s)${report.dropped ? `, ${report.dropped} dropped` : ''}).`);
  lines.push(`Hinted ${report.hinted}, overridden ${report.overrides} (${pct(report.overrideRate)}), unrouted ${report.unrouted}.`);
  if (report.overrides > 0) {
    if (Object.keys(report.reasons).length) lines.push(`Override reasons: ${topCodes(report.reasons)}.`);
    if (Object.keys(report.blockedBy).length) lines.push(`Hinted lanes refused because: ${topCodes(report.blockedBy)}.`);
    for (const pair of report.pairs.slice(0, 10)) lines.push(`  ${pair.from} -> ${pair.to}: ${pair.count}`);
  }
  if (report.unrouted > 0 && Object.keys(report.unroutedReasons).length) {
    lines.push(`No runnable lane: ${topCodes(report.unroutedReasons)}.`);
  }
  if (report.jobs === 0) lines.push('No route decisions recorded in the window.');
  return lines;
}