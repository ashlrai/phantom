import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { enumerateRouteCandidates, rankRouteCandidates, type RouteSources } from '../routing/decision-candidates.js';
import { routeIdSchema, type RouteCandidate, type RouteReport, type RouteRequest } from '../routing/decision-schema.js';
import { type ControllerQualityReceipt } from './controller-quality.js';
import { readLedgerTail, readRouterOutcomes, type RouterOutcome } from './outcomes.js';

export const SHADOW_POLICY_LEDGER_RELATIVE = join('metrics', 'route.shadow.jsonl');
export const SHADOW_POLICY_RECORD_SCHEMA = 'route.shadow.v1' as const;
export const SHADOW_POLICY_REPORT_SCHEMA = 'route.shadow-report.v1' as const;
export const SHADOW_POLICY_LEDGER_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_SHADOW_POLICY = 'class-failure-avoidance' as const;
export const DEFAULT_MIN_SUPPORT = 3;
export const FAILURE_RATE_DEADBAND = 0.1;

export type ShadowPolicyName = typeof DEFAULT_SHADOW_POLICY;
export type ShadowSupportStatus = 'supported' | 'insufficient_support' | 'no_candidates';

const SHADOW_POLICIES: ReadonlySet<string> = new Set([DEFAULT_SHADOW_POLICY]);
const SPEED_RANK: Record<RouteCandidate['speed_tier'], number> = { everyday: 0, workhorse: 1, premium: 2 };
const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

export interface ShadowLaneStats {
  lane: string; resolved: number; good: number; failures: number; unknown: number;
  failure_rate: number | null; supported: boolean; controller_quality_score: number | null;
}

export interface ShadowPolicyRecord {
  schema: typeof SHADOW_POLICY_RECORD_SCHEMA; advisory: true; dispatched: false; at: string;
  policy: ShadowPolicyName; job: string | null; repo: string; task_class: string;
  tier_hint: RouteRequest['tier_hint']; eligible_lanes: string[];
  live_lane: string | null; shadow_lane: string | null; disagreed: boolean;
  support_status: ShadowSupportStatus; reason_codes: string[]; lane_stats: ShadowLaneStats[];
  behavior_propensities?: Record<string, number> | null;
}

export interface ShadowOffPolicySummary {
  observations: number; supported_rows: number; unsupported_rows: number;
  ips: number | null; snips: number | null; effective_sample_size: number | null; max_weight: number | null;
}

export interface ShadowTaskClassGroup {
  repo: string; task_class: string; decisions: number; agreed: number; disagreed: number;
  insufficient_support: number; resolved_outcomes: number; unknown_outcomes: number; live_good_rate: number | null;
}

export interface ShadowPolicyReport {
  schema: typeof SHADOW_POLICY_REPORT_SCHEMA; advisory: true; dispatched: false;
  policy: ShadowPolicyName | null; state: 'read' | 'missing' | 'unreadable' | 'not-file';
  truncated: boolean; path: string; invalid_rows: number;
  total_decisions: number; agreed: number; disagreed: number; insufficient_support: number; no_candidates: number;
  outcomes: {
    resolved: number; unknown: number; live_good_rate: number | null;
    agreed_good_rate: number | null; disagreed_live_good_rate: number | null;
  };
  off_policy: ShadowOffPolicySummary;
  by_task_class: ShadowTaskClassGroup[];
  promotion_gate: {
    ready: false; causal_claim: false; requires_prospective_matched_evidence: true;
    automatic_escalation: false; reason: string;
  };
}

export function isShadowPolicyName(value: string): value is ShadowPolicyName {
  return SHADOW_POLICIES.has(value);
}

function classifyOutcome(o: Pick<RouterOutcome, 'merged' | 'reverted'>): { outcome: 'good' | 'failure' | null; reward: number | null } {
  if (o.reverted === true || o.merged === false) return { outcome: 'failure', reward: 0 };
  if (o.merged === true) return { outcome: 'good', reward: 1 };
  return { outcome: null, reward: null };
}

function validDistribution(value: unknown, eligible: readonly string[]): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const map = value as Record<string, unknown>;
  if (eligible.length === 0 || Object.keys(map).length !== eligible.length) return null;
  let sum = 0;
  const out: Record<string, number> = {};
  for (const lane of eligible) {
    const p = map[lane];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
    sum += p; out[lane] = p;
  }
  return Math.abs(sum - 1) <= 1e-10 ? out : null;
}

/**
 * Evaluate a candidate adaptation policy next to the live decision on the same
 * eligible candidates. Never mutates live routing, crosses repo boundaries, or
 * escalates provider/cost/tier.
 */
export function evaluateShadowPolicy(
  request: RouteRequest, sources: RouteSources, liveDecision: Pick<RouteReport, 'lane'>,
  outcomes: readonly RouterOutcome[],
  opts: {
    policy?: ShadowPolicyName; nowMs?: number; minSupport?: number;
    qualityReceipts?: readonly ControllerQualityReceipt[]; behaviorPropensities?: Record<string, number> | null;
  } = {},
): ShadowPolicyRecord {
  const policy = opts.policy ?? DEFAULT_SHADOW_POLICY;
  const nowMs = opts.nowMs ?? Date.now();
  const minSupport = Math.max(1, opts.minSupport ?? DEFAULT_MIN_SUPPORT);
  const eligible = rankRouteCandidates(request, enumerateRouteCandidates(request, sources), nowMs, sources.familyYield);
  const eligibleLanes = eligible.map(c => c.lane);
  const qualityByLane = new Map((opts.qualityReceipts ?? []).map(r => [r.lane, r.score]));
  const base = {
    schema: SHADOW_POLICY_RECORD_SCHEMA, advisory: true as const, dispatched: false as const,
    at: new Date(nowMs).toISOString(), policy, job: request.job ?? null, repo: request.repo,
    task_class: request.task_class, tier_hint: request.tier_hint, eligible_lanes: eligibleLanes, live_lane: liveDecision.lane,
    ...(opts.behaviorPropensities !== undefined ? { behavior_propensities: validDistribution(opts.behaviorPropensities, eligibleLanes) } : {}),
  };
  if (eligible.length === 0 || liveDecision.lane === null) {
    return { ...base, shadow_lane: null, disagreed: false, support_status: 'no_candidates', reason_codes: ['no_candidates'], lane_stats: [] };
  }
  const counts = new Map(eligibleLanes.map(lane => [lane, { good: 0, failures: 0, unknown: 0 }]));
  for (const o of outcomes) {
    if (o.repo !== request.repo || o.work_class !== request.task_class || o.lane === null) continue;
    const cell = counts.get(o.lane);
    if (!cell) continue;
    const { outcome } = classifyOutcome(o);
    if (outcome === 'good') cell.good += 1; else if (outcome === 'failure') cell.failures += 1; else cell.unknown += 1;
  }
  const laneStats: ShadowLaneStats[] = eligibleLanes.map(lane => {
    const c = counts.get(lane)!;
    const resolved = c.good + c.failures;
    return {
      lane, resolved, good: c.good, failures: c.failures, unknown: c.unknown,
      failure_rate: resolved > 0 ? round4(c.failures / resolved) : null,
      supported: resolved >= minSupport, controller_quality_score: qualityByLane.get(lane) ?? null,
    };
  });
  const liveCandidate = eligible.find(c => c.lane === liveDecision.lane);
  const liveStats = laneStats.find(s => s.lane === liveDecision.lane);
  if (!liveCandidate || !liveStats || !liveStats.supported || liveStats.failure_rate === null) {
    return { ...base, shadow_lane: liveDecision.lane, disagreed: false, support_status: 'insufficient_support', reason_codes: ['insufficient_support'], lane_stats: laneStats };
  }
  if (eligible.length === 1) {
    return { ...base, shadow_lane: liveDecision.lane, disagreed: false, support_status: 'supported', reason_codes: ['single_candidate'], lane_stats: laneStats };
  }
  const alts = eligible.filter(c => c.lane !== liveCandidate.lane
    && c.cost_rank <= liveCandidate.cost_rank && SPEED_RANK[c.speed_tier] <= SPEED_RANK[liveCandidate.speed_tier]
    && laneStats.find(s => s.lane === c.lane)?.supported === true);
  if (alts.length === 0) {
    return { ...base, shadow_lane: liveDecision.lane, disagreed: false, support_status: 'insufficient_support', reason_codes: ['no_supported_alternative'], lane_stats: laneStats };
  }
  let best = liveCandidate, bestRate = liveStats.failure_rate;
  for (const alt of alts) {
    const rate = laneStats.find(s => s.lane === alt.lane)!.failure_rate!;
    if (rate <= liveStats.failure_rate - FAILURE_RATE_DEADBAND && rate < bestRate) { best = alt; bestRate = rate; }
  }
  const disagreed = best.lane !== liveDecision.lane;
  return {
    ...base, shadow_lane: best.lane, disagreed, support_status: 'supported',
    reason_codes: disagreed ? ['task_class_failure_avoidance', 'no_escalation'] : ['within_deadband'], lane_stats: laneStats,
  };
}

/** Append one advisory shadow record to `<root>/metrics/route.shadow.jsonl`. Never dispatches. */
export async function recordShadowPolicyDecision(root: string, record: ShadowPolicyRecord): Promise<string> {
  if (!isAbsolute(root)) throw new RangeError('root must be an absolute path');
  if (record.job !== null) routeIdSchema.parse(record.job);
  routeIdSchema.parse(record.repo);
  const path = join(root, SHADOW_POLICY_LEDGER_RELATIVE);
  await mkdir(join(root, 'metrics'), { recursive: true });
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!(await fd.stat()).isFile()) throw new Error('Invalid shadow ledger');
    await fd.writeFile(JSON.stringify(record) + '\n');
  } finally { await fd.close(); }
  return path;
}

function parseShadowRecord(raw: unknown): ShadowPolicyRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['schema'] !== SHADOW_POLICY_RECORD_SCHEMA || r['advisory'] !== true || r['dispatched'] !== false) return null;
  if (typeof r['policy'] !== 'string' || !isShadowPolicyName(r['policy'])) return null;
  if (typeof r['repo'] !== 'string' || !routeIdSchema.safeParse(r['repo']).success) return null;
  if (typeof r['task_class'] !== 'string' || !r['task_class']) return null;
  if (!Array.isArray(r['eligible_lanes']) || !r['eligible_lanes'].every(l => typeof l === 'string' && routeIdSchema.safeParse(l).success)) return null;
  const support = r['support_status'];
  if (support !== 'supported' && support !== 'insufficient_support' && support !== 'no_candidates') return null;
  const live = r['live_lane'], shadow = r['shadow_lane'], job = r['job'];
  if ((live !== null && typeof live !== 'string') || (shadow !== null && typeof shadow !== 'string')) return null;
  if (job !== null && (typeof job !== 'string' || !routeIdSchema.safeParse(job).success)) return null;
  const prop = r['behavior_propensities'] === undefined ? undefined : validDistribution(r['behavior_propensities'], r['eligible_lanes'] as string[]);
  return {
    schema: SHADOW_POLICY_RECORD_SCHEMA, advisory: true, dispatched: false, at: typeof r['at'] === 'string' ? r['at'] : '',
    policy: r['policy'], job, repo: r['repo'], task_class: r['task_class'],
    tier_hint: (typeof r['tier_hint'] === 'string' ? r['tier_hint'] : 'work') as RouteRequest['tier_hint'],
    eligible_lanes: r['eligible_lanes'] as string[], live_lane: live, shadow_lane: shadow, disagreed: live !== shadow,
    support_status: support,
    reason_codes: Array.isArray(r['reason_codes']) ? r['reason_codes'].filter((c): c is string => typeof c === 'string') : [],
    lane_stats: Array.isArray(r['lane_stats']) ? r['lane_stats'] as ShadowLaneStats[] : [],
    ...(prop !== undefined ? { behavior_propensities: prop } : {}),
  };
}

/** IPS/SNIPS/ESS matching scripts/evaluators/routing-off-policy.mjs; unsupported rows stay separate. */
function summarizeOffPolicy(rows: readonly { eligible: string[]; action: string; targetLane: string; reward: number; behavior: Record<string, number> | null }[]): ShadowOffPolicySummary {
  let supported = 0, unsupported = 0, sumW = 0, sumSq = 0, sumR = 0, maxW = 0;
  for (const row of rows) {
    if (!row.eligible.includes(row.action) || !row.eligible.includes(row.targetLane)) { unsupported += 1; continue; }
    const behavior = row.behavior ?? Object.fromEntries(row.eligible.map(l => [l, l === row.action ? 1 : 0]));
    const target = Object.fromEntries(row.eligible.map(l => [l, l === row.targetLane ? 1 : 0]));
    if (behavior[row.action]! <= 0 || row.eligible.some(l => target[l]! > 0 && behavior[l]! === 0)) { unsupported += 1; continue; }
    const w = target[row.action]! / behavior[row.action]!;
    if (!Number.isFinite(w) || !Number.isFinite(sumW + w) || !Number.isFinite(sumSq + w * w)) { unsupported += 1; continue; }
    supported += 1; sumW += w; sumSq += w * w; sumR += w * row.reward; maxW = Math.max(maxW, w);
  }
  const ok = supported > 0 && [sumW, sumSq, sumR, sumW * sumW].every(Number.isFinite);
  return {
    observations: rows.length, supported_rows: supported, unsupported_rows: unsupported,
    ips: ok ? round4(sumR / supported) : null, snips: ok && sumW > 0 ? round4(sumR / sumW) : null,
    effective_sample_size: ok && sumSq > 0 ? round4((sumW * sumW) / sumSq) : null, max_weight: ok ? round4(maxW) : null,
  };
}

/** Compare recorded shadow decisions against recorded outcomes; unknown outcomes stay null. */
export async function buildShadowPolicyReport(opts: { runsDir?: string; policy?: ShadowPolicyName } = {}): Promise<ShadowPolicyReport> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  const path = join(runsDir, SHADOW_POLICY_LEDGER_RELATIVE);
  const tail = await readLedgerTail(path, SHADOW_POLICY_LEDGER_LIMIT);
  const gate = {
    ready: false as const, causal_claim: false as const, requires_prospective_matched_evidence: true as const,
    automatic_escalation: false as const,
    reason: 'Shadow replay is observational only; prospective matched evidence is required before changing live routing.',
  };
  if (tail.state !== 'read') {
    return {
      schema: SHADOW_POLICY_REPORT_SCHEMA, advisory: true, dispatched: false, policy: opts.policy ?? null,
      state: tail.state, truncated: false, path, invalid_rows: 0, total_decisions: 0, agreed: 0, disagreed: 0,
      insufficient_support: 0, no_candidates: 0,
      outcomes: { resolved: 0, unknown: 0, live_good_rate: null, agreed_good_rate: null, disagreed_live_good_rate: null },
      off_policy: { observations: 0, supported_rows: 0, unsupported_rows: 0, ips: null, snips: null, effective_sample_size: null, max_weight: null },
      by_task_class: [], promotion_gate: gate,
    };
  }
  const records: ShadowPolicyRecord[] = [];
  let invalidRows = 0;
  for (const line of tail.text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = parseShadowRecord(JSON.parse(line));
      if (!parsed) { invalidRows += 1; continue; }
      if (!opts.policy || parsed.policy === opts.policy) records.push(parsed);
    } catch { invalidRows += 1; }
  }
  const outcomesRead = await readRouterOutcomes({ runsDir });
  const outcomeByJob = new Map(outcomesRead.outcomes.map(o => [o.job_id, o]));
  let agreed = 0, disagreed = 0, insufficientSupport = 0, noCandidates = 0;
  let resolved = 0, unknown = 0, goodTotal = 0, agreedRes = 0, agreedGood = 0, disagreedRes = 0, disagreedGood = 0;
  const offRows: { eligible: string[]; action: string; targetLane: string; reward: number; behavior: Record<string, number> | null }[] = [];
  const groups = new Map<string, { repo: string; task_class: string; decisions: number; agreed: number; disagreed: number; insufficient_support: number; resolved: number; unknown: number; good: number }>();

  for (const rec of records) {
    if (rec.support_status === 'no_candidates') noCandidates += 1;
    else if (rec.support_status === 'insufficient_support') insufficientSupport += 1;
    if (rec.disagreed) disagreed += 1; else agreed += 1;
    const key = `${rec.repo}\0${rec.task_class}`;
    const g = groups.get(key) ?? { repo: rec.repo, task_class: rec.task_class, decisions: 0, agreed: 0, disagreed: 0, insufficient_support: 0, resolved: 0, unknown: 0, good: 0 };
    g.decisions += 1;
    if (rec.disagreed) g.disagreed += 1; else g.agreed += 1;
    if (rec.support_status === 'insufficient_support') g.insufficient_support += 1;
    const joined = rec.job !== null ? outcomeByJob.get(rec.job) : undefined;
    const matched = joined && (joined.repo === null || joined.repo === rec.repo) ? joined : undefined;
    const { reward } = matched ? classifyOutcome(matched) : { reward: null };
    if (reward === null) { unknown += 1; g.unknown += 1; } else {
      resolved += 1; goodTotal += reward; g.resolved += 1; g.good += reward;
      if (rec.disagreed) { disagreedRes += 1; disagreedGood += reward; } else { agreedRes += 1; agreedGood += reward; }
      if (rec.live_lane !== null && rec.shadow_lane !== null) {
        offRows.push({ eligible: rec.eligible_lanes, action: rec.live_lane, targetLane: rec.shadow_lane, reward, behavior: rec.behavior_propensities ?? null });
      }
    }
    groups.set(key, g);
  }
  const byTaskClass: ShadowTaskClassGroup[] = [...groups.values()]
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.task_class.localeCompare(b.task_class))
    .map(g => ({
      repo: g.repo, task_class: g.task_class, decisions: g.decisions, agreed: g.agreed, disagreed: g.disagreed,
      insufficient_support: g.insufficient_support, resolved_outcomes: g.resolved, unknown_outcomes: g.unknown,
      live_good_rate: g.resolved > 0 ? round4(g.good / g.resolved) : null,
    }));
  return {
    schema: SHADOW_POLICY_REPORT_SCHEMA, advisory: true, dispatched: false, policy: opts.policy ?? null,
    state: 'read', truncated: tail.truncated, path, invalid_rows: invalidRows,
    total_decisions: records.length, agreed, disagreed, insufficient_support: insufficientSupport, no_candidates: noCandidates,
    outcomes: {
      resolved, unknown,
      live_good_rate: resolved > 0 ? round4(goodTotal / resolved) : null,
      agreed_good_rate: agreedRes > 0 ? round4(agreedGood / agreedRes) : null,
      disagreed_live_good_rate: disagreedRes > 0 ? round4(disagreedGood / disagreedRes) : null,
    },
    off_policy: summarizeOffPolicy(offRows),
    by_task_class: byTaskClass,
    promotion_gate: gate,
  };
}
