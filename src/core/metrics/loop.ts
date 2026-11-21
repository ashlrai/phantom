/**
 * Self-awareness loop (RQ-BETS-LANE-1): throughput, idea-to-merged-to-installed
 * loop time, cost per merged PR and capacity per node, folded into one report
 * plus a ranked problem-selection hint file routing can read.
 *
 * Pure module: every input is passed in already read; no I/O, no clock. A
 * value that could not be measured is `{ missing: <reason> }`, never guessed
 * and never zero-filled.
 */
import type { Bet, BetObservation } from './bets.js';

export const LOOP_SCHEMA = 'metrics.loop.v1';
export const HINTS_SCHEMA = 'metrics.selection-hints.v1';

export interface Missing { missing: string }
export type Measured<T> = T | Missing;
export const missing = (reason: string): Missing => ({ missing: reason });
export const isMissing = (v: unknown): v is Missing => !!v && typeof v === 'object' && typeof (v as Missing).missing === 'string';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** jobs.jsonl timestamps come as ISO with or without a colon in the offset (dispatchd writes %z). */
export function parseLedgerTs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/ (?=\d{2}:)/, 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** One job's lifecycle as the jobs ledger records it. Earliest stamp wins for each event. */
export interface JobTimeline {
  id: string;
  lane: string | null;
  repo: string | null;
  enqueuedAt: number | null;
  launchedAt: number | null;
  finishedAt: number | null;
  /** Wall seconds the dispatcher measured on its finish row, when present. */
  wallSeconds: number | null;
  openedAt: number | null;
  mergedAt: number | null;
  prUrl: string | null;
}

const PR_URL = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/**
 * jobs.jsonl field dialects, the same sets visit-sync.classifyRow,
 * queue/job-outcomes.parseJobOutcomeRows, agent-activity.parseLedger,
 * job-latency.boundaryEvent, fleet/throughput.marksOf and
 * metrics/reward-feed.foldJobsLedgerRewards accept: job ids take
 * job|job_id|jobId|id, the event name event|type|kind, the phase
 * state|outcome|status plus the producer aliases phase|result|conclusion,
 * timestamps ts|timestamp|at|time|mergedAt|closedAt|
 * recordedAt|updatedAt (mergedAt/closedAt preferred on terminal rows), PR
 * links url|pr_url|prUrl|pr|html_url and the lane aliases pool|arm.
 */
const JOB_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const TS_FIELDS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const URL_KEYS = ['url', 'pr_url', 'prUrl', 'pr', 'html_url'] as const;
const LANE_KEYS = ['lane', 'pool', 'arm'] as const;

const firstString = (row: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

function stateOf(row: Record<string, unknown>): string {
  return (firstString(row, PHASE_KEYS) ?? '').toUpperCase();
}

/** First parseable stamp among the ledger's timestamp fields; MERGED prefers mergedAt, CLOSED closedAt. */
function eventTs(row: Record<string, unknown>, state: string): number | null {
  const preferred = state === 'MERGED' ? 'mergedAt' : state === 'CLOSED' ? 'closedAt' : null;
  const fields = preferred === null ? TS_FIELDS : [preferred, ...TS_FIELDS.filter(f => f !== preferred)];
  for (const field of fields) {
    const at = parseLedgerTs(row[field]);
    if (at !== null) return at;
  }
  return null;
}

/** Canonical github.com pull URL from the row's link fields, or null. */
function prUrlOf(row: Record<string, unknown>): string | null {
  const value = firstString(row, URL_KEYS)?.replace(/\/+$/, '');
  return value !== undefined && PR_URL.test(value) ? value : null;
}

/**
 * Lifecycle event in ledger vocabulary, or null for operational rows and
 * eventless rows with no phase. Mirrors dispatchd _vc_event and
 * agent-activity.inferredEvent: a named event|type|kind wins ('published'
 * normalizes to 'publish'); a row with none infers from phase — PUBLISHED is
 * a publish claim, MERGED/CLOSED/OPEN a reconciled outcome.
 */
function ledgerEvent(row: Record<string, unknown>, state: string): string | null {
  const named = firstString(row, EVENT_KEYS);
  if (named !== null) return named === 'published' ? 'publish' : named;
  if (state === 'PUBLISHED') return 'publish';
  if (state === 'MERGED' || state === 'CLOSED' || state === 'OPEN') return 'outcome';
  return null;
}

/**
 * Fold jobs.jsonl text into per-job timelines. Reads the fleet's canonical
 * ledger dialect (see the field sets above): reconciler rows copied from a
 * publish row keep their jobId/prUrl fields and resolve through phase, an
 * eventless {outcome:'MERGED'} row still counts, and 'enqueued'/'queued' name
 * the same queue arrival as 'enqueue'. Rows stamped after `now` are ignored
 * so a skewed clock cannot fabricate rates.
 */
export function jobTimelines(text: string | null, now: number): Map<string, JobTimeline> {
  const jobs = new Map<string, JobTimeline>();
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const id = firstString(row, JOB_KEYS);
    const state = stateOf(row);
    const event = ledgerEvent(row, state);
    if (id === null || event === null) continue;
    const at = eventTs(row, state);
    if (at === null || at > now) continue;
    const job = jobs.get(id) ?? { id, lane: null, repo: null, enqueuedAt: null, launchedAt: null, finishedAt: null, wallSeconds: null, openedAt: null, mergedAt: null, prUrl: null };
    jobs.set(id, job);
    const earliest = (prev: number | null) => prev === null ? at : Math.min(prev, at);
    const lane = firstString(row, LANE_KEYS);
    if (lane !== null && (event === 'launch' || job.lane === null)) job.lane = lane;
    const repo = firstString(row, ['repo']);
    if (repo !== null && job.repo === null) job.repo = repo;
    const url = prUrlOf(row);
    if (url !== null && job.prUrl === null) job.prUrl = url;
    if (event === 'enqueue' || event === 'enqueued' || event === 'queued') job.enqueuedAt = earliest(job.enqueuedAt);
    else if (event === 'launch') job.launchedAt = earliest(job.launchedAt);
    else if (event === 'finish') {
      job.finishedAt = earliest(job.finishedAt);
      const wall = row['wall_s'] ?? row['wallS'];
      if (typeof wall === 'number' && Number.isFinite(wall) && wall >= 0) job.wallSeconds = wall;
    }
    // A resolved PR state makes a publish-spelled row merge/close evidence,
    // never a fresh open claim (dispatchd _vc_event treats it as a resolution).
    const resolved = state === 'MERGED' || state === 'CLOSED';
    if (url !== null && !resolved && (event === 'publish' || state === 'PUBLISHED' || state === 'OPEN')) job.openedAt = earliest(job.openedAt);
    if (event === 'merged' || (state === 'MERGED' && (event === 'outcome' || event === 'publish'))) job.mergedAt = earliest(job.mergedAt);
  }
  return jobs;
}

/** Wall hours a job held a lane slot; null when neither the finish wall time nor both stamps are known. */
export function jobLaneHours(job: JobTimeline): number | null {
  if (job.wallSeconds !== null) return job.wallSeconds / 3600;
  if (job.launchedAt !== null && job.finishedAt !== null && job.finishedAt >= job.launchedAt) return (job.finishedAt - job.launchedAt) / HOUR;
  return null;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export interface Rates { merges_per_hour: { '1h': number; '6h': number }; opens_per_hour: { '1h': number; '6h': number }; merged_6h: number; opened_6h: number }

/** Fleet-wide merges and PR opens per hour over the trailing 1h and 6h windows. */
export function throughput(jobs: Map<string, JobTimeline>, now: number): Rates {
  const count = (pick: (j: JobTimeline) => number | null, hours: number) =>
    [...jobs.values()].filter(j => { const at = pick(j); return at !== null && at > now - hours * HOUR && at <= now; }).length;
  const merged1 = count(j => j.mergedAt, 1), merged6 = count(j => j.mergedAt, 6);
  const opened1 = count(j => j.openedAt, 1), opened6 = count(j => j.openedAt, 6);
  return { merges_per_hour: { '1h': merged1, '6h': round(merged6 / 6) }, opens_per_hour: { '1h': opened1, '6h': round(opened6 / 6) }, merged_6h: merged6, opened_6h: opened6 };
}

export interface Distribution { samples: number; p50: number; p90: number }
function distribution(values: number[]): Distribution | null {
  if (!values.length) return null;
  return { samples: values.length, p50: round(percentile(values, 0.5)!, 1), p90: round(percentile(values, 0.9)!, 1) };
}

/** Enqueue (first sight of the ready.tsv row) to MERGED, for merges inside the window. */
export function ideaToMerged(jobs: Map<string, JobTimeline>, now: number, windowHours = 24): Measured<Distribution> {
  const values: number[] = [];
  for (const j of jobs.values()) {
    if (j.mergedAt === null || j.mergedAt <= now - windowHours * HOUR || j.enqueuedAt === null || j.enqueuedAt > j.mergedAt) continue;
    values.push((j.mergedAt - j.enqueuedAt) / MINUTE);
  }
  return distribution(values) ?? missing(`no job in the last ${windowHours}h has both an enqueue row and a MERGED outcome in jobs.jsonl`);
}

export interface MergedPr { number: number; mergedAt: number }
export interface ReleaseRef { tag: string; createdAt: number }
export interface InstalledBundle { version: string; installedAt: number }

export interface MergedToInstalled {
  installedVersion: string;
  installedTag: string;
  /** Merges first shipped by the installed release (after the previous release, at or before the installed one). */
  distribution: Distribution | null;
  /** PR number to minutes, for joining with idea-to-merged. */
  perPr: Record<string, number>;
  /** Merged after the installed release: not yet installed. */
  pendingInstall: number;
}

/**
 * Merge to the installed bundle containing it. A merge is contained in a
 * release when it merged at or before the release's commit time (squash
 * merges on a linear default branch). Only merges the installed release
 * shipped first are timed, against the bundle's install time.
 */
export function mergedToInstalled(merges: readonly MergedPr[], releases: readonly ReleaseRef[], installed: InstalledBundle | null): Measured<MergedToInstalled> {
  if (!installed) return missing('installed bundle Info.plist unreadable or not a Phantom release build');
  const sorted = [...releases].sort((a, b) => a.createdAt - b.createdAt);
  const idx = sorted.findIndex(r => r.tag === `v${installed.version}` || r.tag === installed.version);
  if (idx < 0) return missing(`installed version ${installed.version} not found among the fetched GitHub releases`);
  const current = sorted[idx]!, previous = idx > 0 ? sorted[idx - 1]! : null;
  if (!previous) return missing(`no release before ${current.tag} fetched; cannot bound the merges it shipped`);
  const perPr: Record<string, number> = {};
  const values: number[] = [];
  let pending = 0;
  for (const m of merges) {
    if (m.mergedAt > current.createdAt) { pending++; continue; }
    if (m.mergedAt <= previous.createdAt || installed.installedAt < m.mergedAt) continue;
    const minutes = (installed.installedAt - m.mergedAt) / MINUTE;
    perPr[String(m.number)] = round(minutes, 1);
    values.push(minutes);
  }
  return { installedVersion: installed.version, installedTag: current.tag, distribution: distribution(values), perPr, pendingInstall: pending };
}

/** Idea (enqueue) to installed, for jobs whose PR was both merged and shipped in the installed bundle. */
export function feedbackLoop(jobs: Map<string, JobTimeline>, installed: Measured<MergedToInstalled>, repo: string, installedAt: number | null): Measured<Distribution> {
  if (isMissing(installed)) return missing(`merged-to-installed missing: ${installed.missing}`);
  if (installedAt === null) return missing('install time unknown');
  const values: number[] = [];
  for (const j of jobs.values()) {
    const m = j.prUrl ? PR_URL.exec(j.prUrl) : null;
    if (!m || m[1]!.toLowerCase() !== repo.toLowerCase() || !(m[2]! in installed.perPr) || j.enqueuedAt === null) continue;
    if (installedAt >= j.enqueuedAt) values.push((installedAt - j.enqueuedAt) / MINUTE);
  }
  return distribution(values) ?? missing(`no ${repo} PR in the installed release has an enqueue row in jobs.jsonl`);
}

export interface SlotLane { lane: string; target: number | null; held: boolean; hardCap: number | null }
/** slots.json lane rows; accepts the direct map and the `lanes`-wrapped form. Global keys are skipped. */
export function slotLanes(raw: unknown): SlotLane[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  const map = obj.lanes && typeof obj.lanes === 'object' && !Array.isArray(obj.lanes) ? obj.lanes as Record<string, unknown> : obj;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return Object.entries(map).filter(([lane, v]) => !['hard_cap', 'last_change_by', 'lanes'].includes(lane) && v && typeof v === 'object' && !Array.isArray(v))
    .map(([lane, v]) => { const r = v as Record<string, unknown>; return { lane, target: count(r.target), held: r.held === true, hardCap: count(r.hard_cap) }; })
    .sort((a, b) => a.lane.localeCompare(b.lane));
}

export interface LaneRow {
  lane: string;
  inSlots: boolean;
  target: number | null;
  held: boolean;
  running: number | null;
  merged_6h: number;
  lane_hours_6h: number;
  merged_per_lane_hour: Measured<number>;
}

/** Per lane: merges and lane-hours over 6h. Every slots.json lane is listed, measured or not. */
export function laneRows(jobs: Map<string, JobTimeline>, slots: readonly SlotLane[], running: Record<string, number> | null, now: number, windowHours = 6): LaneRow[] {
  const since = now - windowHours * HOUR;
  const acc = new Map<string, { merged: number; hours: number }>();
  const touch = (lane: string) => { const v = acc.get(lane) ?? { merged: 0, hours: 0 }; acc.set(lane, v); return v; };
  for (const j of jobs.values()) {
    if (!j.lane) continue;
    if (j.mergedAt !== null && j.mergedAt > since) touch(j.lane).merged++;
    const hours = jobLaneHours(j);
    const end = j.finishedAt ?? (j.launchedAt !== null && hours !== null ? j.launchedAt + hours * HOUR : null);
    if (hours !== null && end !== null && end > since) {
      // Only the part of the run inside the window counts.
      const start = end - hours * HOUR;
      touch(j.lane).hours += (end - Math.max(start, since)) / HOUR;
    }
  }
  const lanes = new Set([...slots.map(s => s.lane), ...acc.keys()]);
  return [...lanes].map(lane => {
    const slot = slots.find(s => s.lane === lane);
    const a = acc.get(lane) ?? { merged: 0, hours: 0 };
    return {
      lane, inSlots: !!slot, target: slot?.target ?? null, held: slot?.held ?? false,
      running: running ? running[lane] ?? 0 : null,
      merged_6h: a.merged, lane_hours_6h: round(a.hours),
      merged_per_lane_hour: a.hours > 0 ? round(a.merged / a.hours, 3) : missing(`no finished lane time in the last ${windowHours}h`),
    };
  }).sort((a, b) => a.lane.localeCompare(b.lane));
}

export interface NodeCapacityRow {
  node: string;
  source: 'registry' | 'profile' | 'local';
  status: string;
  max: Measured<number>;
  live: Measured<number>;
  spare: Measured<number>;
}
export function nodeCapacityRow(node: string, source: NodeCapacityRow['source'], status: string, max: number | null, live: number | null, why: { max?: string; live?: string } = {}): NodeCapacityRow {
  const m = max === null ? missing(why.max ?? 'no declared capacity') : max;
  const l = live === null ? missing(why.live ?? 'no live load reading') : live;
  return { node, source, status, max: m, live: l, spare: max === null || live === null ? missing('max or live load unknown') : Math.max(0, max - live) };
}

export interface ResourceRow { resource: string; kind: 'lane' | 'node' | 'peer'; measured: boolean; detail: Record<string, unknown> | Missing }

export interface LoopReport {
  schema: typeof LOOP_SCHEMA;
  at: string;
  sources: Record<string, string>;
  /** Sources whose bounded tail read was cut at the cap: every count folded from them covers only the newest bytes. Empty when nothing was cut or no read reported truncation. */
  truncated_sources: string[];
  throughput: Measured<Rates>;
  idea_to_merged_minutes: Measured<Distribution>;
  merged_to_installed_minutes: Measured<MergedToInstalled>;
  feedback_loop_minutes: Measured<Distribution>;
  cost_per_merged_pr: Measured<{ usd: number; at: string; source: string }>;
  lanes: LaneRow[];
  capacity_per_node: NodeCapacityRow[];
  resources: ResourceRow[];
  bets: { launched: number; kept: number; killed: number; active: string[] } | Missing;
}

/** Numeric metric keys a bet may target. Each maps to one number in the report, or null when missing. */
export const LOOP_METRIC_KEYS = [
  'merges_per_hour.1h', 'merges_per_hour.6h', 'opens_per_hour.1h', 'opens_per_hour.6h',
  'idea_to_merged_minutes.p50', 'merged_to_installed_minutes.p50', 'feedback_loop_minutes.p50',
  'cost_per_merged_pr', 'spare_slots',
] as const;

export function loopMetricValue(report: LoopReport, key: string): number | null {
  const dist = (v: Measured<Distribution>) => isMissing(v) ? null : v.p50;
  switch (key) {
    case 'merges_per_hour.1h': return isMissing(report.throughput) ? null : report.throughput.merges_per_hour['1h'];
    case 'merges_per_hour.6h': return isMissing(report.throughput) ? null : report.throughput.merges_per_hour['6h'];
    case 'opens_per_hour.1h': return isMissing(report.throughput) ? null : report.throughput.opens_per_hour['1h'];
    case 'opens_per_hour.6h': return isMissing(report.throughput) ? null : report.throughput.opens_per_hour['6h'];
    case 'idea_to_merged_minutes.p50': return dist(report.idea_to_merged_minutes);
    case 'merged_to_installed_minutes.p50': {
      const v = report.merged_to_installed_minutes;
      return isMissing(v) || !v.distribution ? null : v.distribution.p50;
    }
    case 'feedback_loop_minutes.p50': return dist(report.feedback_loop_minutes);
    case 'cost_per_merged_pr': return isMissing(report.cost_per_merged_pr) ? null : report.cost_per_merged_pr.usd;
    case 'spare_slots': {
      const known = report.capacity_per_node.filter(n => !isMissing(n.spare));
      return known.length ? known.reduce((s, n) => s + (n.spare as number), 0) : null;
    }
    default: return null;
  }
}

/** Observation for one bet from the jobs ledger: every job whose id starts with the bet id belongs to it. */
export function betObservation(bet: Pick<Bet, 'id' | 'metric'>, jobs: Map<string, JobTimeline>, report: LoopReport | null): BetObservation {
  let merged = 0, count = 0, hours = 0, unknownHours = 0;
  for (const j of jobs.values()) {
    if (!j.id.startsWith(bet.id)) continue;
    count++;
    if (j.mergedAt !== null) merged++;
    const h = jobLaneHours(j);
    if (h === null) { if (j.launchedAt !== null) unknownHours++; } else hours += h;
  }
  return {
    value: report ? loopMetricValue(report, bet.metric) : null,
    // A launched job with no finish yet still burns budget we cannot size; report the known part.
    laneHours: count === 0 ? 0 : hours === 0 && unknownHours > 0 ? null : round(hours, 3),
    merged, jobs: count,
  };
}

export interface SelectionHints {
  schema: typeof HINTS_SCHEMA;
  at: string;
  advisory: true;
  /** Lanes ranked by merged per lane-hour (6h); unmeasured lanes follow, flagged. */
  lanes: { lane: string; merged_per_lane_hour: number | null; merged_6h: number; held: boolean; reason?: string }[];
  /** Nodes with spare capacity, most spare first. */
  nodes_with_spare: { node: string; spare: number }[];
  top_constraint: { name: string; evidence: string };
  bets_share: { reserved: number; usable: number } | Missing;
}

/**
 * Pick the binding constraint from the report. Order: nothing merging, no
 * spare capacity, slow install (shipping lags merging), slow idea-to-merge.
 */
export function topConstraint(report: LoopReport): { name: string; evidence: string } {
  const merges6 = isMissing(report.throughput) ? null : report.throughput.merged_6h;
  const opens6 = isMissing(report.throughput) ? null : report.throughput.opened_6h;
  const spare = loopMetricValue(report, 'spare_slots');
  const ideaP50 = loopMetricValue(report, 'idea_to_merged_minutes.p50');
  const installP50 = loopMetricValue(report, 'merged_to_installed_minutes.p50');
  if (merges6 === null) return { name: 'measurement', evidence: 'jobs.jsonl unreadable: throughput unknown' };
  if (merges6 === 0 && (opens6 ?? 0) > 0) return { name: 'merge', evidence: `${opens6} PRs opened and 0 merged in 6h` };
  if (merges6 === 0) return { name: 'supply', evidence: '0 PRs opened and 0 merged in 6h' };
  if (spare === 0) return { name: 'capacity', evidence: 'no node reports a spare slot' };
  if (installP50 !== null && ideaP50 !== null && installP50 > ideaP50) return { name: 'install', evidence: `merged-to-installed p50 ${installP50} min exceeds idea-to-merged p50 ${ideaP50} min` };
  if (ideaP50 !== null) return { name: 'idea-to-merge', evidence: `idea-to-merged p50 ${ideaP50} min at ${merges6} merges in 6h` };
  return { name: 'unknown', evidence: 'loop times missing; see loop report reasons' };
}

export function selectionHints(report: LoopReport, share: { reserved: number; usable: number } | null): SelectionHints {
  const lanes = report.lanes.map(l => ({
    lane: l.lane, merged_6h: l.merged_6h, held: l.held,
    merged_per_lane_hour: isMissing(l.merged_per_lane_hour) ? null : l.merged_per_lane_hour,
    ...(isMissing(l.merged_per_lane_hour) ? { reason: l.merged_per_lane_hour.missing } : {}),
  })).sort((a, b) => Number(a.held) - Number(b.held)
    || (b.merged_per_lane_hour ?? -1) - (a.merged_per_lane_hour ?? -1) || b.merged_6h - a.merged_6h || a.lane.localeCompare(b.lane));
  const nodes = report.capacity_per_node.filter(n => !isMissing(n.spare) && (n.spare as number) > 0)
    .map(n => ({ node: n.node, spare: n.spare as number })).sort((a, b) => b.spare - a.spare || a.node.localeCompare(b.node));
  return {
    schema: HINTS_SCHEMA, at: report.at, advisory: true, lanes, nodes_with_spare: nodes, top_constraint: topConstraint(report),
    bets_share: share ? { reserved: share.reserved, usable: share.usable } : missing('bets share not computed'),
  };
}

export interface MorningFields {
  bets: { launched: number; kept: number; killed: number } | Missing;
  feedback_loop_minutes: number | Missing;
  cost_per_merged_pr: number | Missing;
  capacity_per_node: Record<string, { max: number | Missing; live: number | Missing; spare: number | Missing }>;
}
export function morningFields(report: LoopReport): MorningFields {
  const fl = report.feedback_loop_minutes;
  return {
    bets: isMissing(report.bets) ? report.bets : { launched: report.bets.launched, kept: report.bets.kept, killed: report.bets.killed },
    feedback_loop_minutes: isMissing(fl) ? fl : fl.p50,
    cost_per_merged_pr: isMissing(report.cost_per_merged_pr) ? report.cost_per_merged_pr : report.cost_per_merged_pr.usd,
    capacity_per_node: Object.fromEntries(report.capacity_per_node.map(n => [n.node, { max: n.max, live: n.live, spare: n.spare }])),
  };
}

/**
 * Merge loop fields into an existing morning report without dropping any of
 * its keys. A non-object existing value is refused (returns null) so a
 * corrupt file is never silently overwritten.
 */
export function mergeMorning(existing: unknown, fields: MorningFields): Record<string, unknown> | null {
  if (existing === undefined || existing === null) return { ...fields };
  if (typeof existing !== 'object' || Array.isArray(existing)) return null;
  return { ...(existing as Record<string, unknown>), ...fields };
}

/** Local calendar day stamp (YYYYMMDD) for the loop and morning file names. */
export function dayStamp(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
}
