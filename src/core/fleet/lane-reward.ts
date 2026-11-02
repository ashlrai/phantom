/**
 * lane-reward.ts — per-lane one-ask reward rollup over a host metrics jobs
 * ledger (`~/.ashlr-runs/metrics/jobs.jsonl` by default). Every job folds
 * into one attempt scored by {@link inspectOneAskReward} at uniform weight 1.
 * Observation only: never writes, never routes, never releases merge credit.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProposal } from '../inbox/store.js';
import type { Proposal } from '../types.js';
import { inspectOneAskReward, type OneAskReward } from './one-ask-reward.js';

export const LANE_REWARD_SCHEMA = 'fleet.lane-reward.v1' as const;
/** Uniform caller weight: every recorded attempt counts the same. */
export const LANE_REWARD_WEIGHT = 1;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/, LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LAUNCH_EVENTS = new Set(['launch', 'launched', 'start', 'started']),
  FINISH_EVENTS = new Set(['finish', 'finished', 'complete', 'completed']),
  PUBLISH_EVENTS = new Set(['publish', 'published']),
  OUTCOME_EVENTS = new Set(['outcome', 'result', 'resolved', 'resolution']),
  TERMINAL_PHASES = new Set(['MERGED', 'CLOSED']);

export interface LaneRewardLane {
  lane: string; attempts: number; scored: number; unscored: number;
  meanReward: number | null; // mean rewardPerToken over scored attempts
  outcomes: { published: number; stable: number; reverted: number };
  reasons: Record<string, number>; // unscored attempts by reason
}
export interface LaneRewardV1 {
  schema: typeof LANE_REWARD_SCHEMA; generatedAt: string; source: 'healthy' | 'missing' | 'degraded';
  weight: number; attempts: number; scored: number; unscored: number;
  meanReward: number | null; lanes: LaneRewardLane[];
}
export interface LaneRewardDeps {
  jobsText(path: string): Promise<string | null>; // null = unreadable
  proposal(id: string): Proposal | null; // trusted inbox lookup (loadProposal)
  score(input: Parameters<typeof inspectOneAskReward>[0]): OneAskReward; // the inspector
  nowMs(): number;
}

export const defaultLaneRewardDeps: LaneRewardDeps = {
  async jobsText(path) {
    try {
      const file = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(16 * 1024 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    } catch { return null; }
  },
  proposal: loadProposal,
  score: inspectOneAskReward,
  nowMs: Date.now,
};

export interface LaneRewardAttempt {
  lane: string | null; tokens: number | null;
  published: boolean; outcome: 'merged' | 'closed' | null; outcomeTsMs: number;
}

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : null);
const pickString = (row: Row, ...names: string[]): string | null => {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  } return null;
};
const boundedId = (value: string | null, re: RegExp): string | null =>
  value !== null && re.test(value) ? value : null;
const jobOf = (row: Row): string | null => boundedId(pickString(row, 'job', 'job_id', 'jobId', 'id'), JOB_ID);
const laneOf = (row: Row): string | null => boundedId(pickString(row, 'lane', 'pool', 'arm'), LANE_ID);
const urlOf = (row: Row): string | null => pickString(row, 'url', 'pr_url', 'prUrl', 'pr');
const eventOf = (row: Row): string => (pickString(row, 'event', 'type', 'kind') ?? '').toLowerCase();
const phaseOf = (row: Row): string => (pickString(row, 'state', 'outcome', 'status') ?? '').toUpperCase();
const tokensOf = (row: Row): number | null => {
  const value = row['tokens_total'] ?? row['tokens'] ?? row['total_tokens'];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
};

/** Fold a jobs ledger into attempts; malformed lines are counted, never thrown. */
export function foldLaneRewardAttempts(text: string): { attempts: Map<string, LaneRewardAttempt>; dropped: number } {
  const rows: Row[] = [];
  let dropped = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    let row: Row | null;
    try { row = asRow(JSON.parse(line)); } catch { dropped++; continue; }
    if (!row) { dropped++; continue; }
    rows.push(row);
  }
  // Publish rows bind a job to its PR url; outcome rows may carry only the url.
  const jobByUrl = new Map<string, string>();
  for (const row of rows) {
    const job = jobOf(row), url = urlOf(row);
    if (job && url) jobByUrl.set(url, job);
  }
  const attempts = new Map<string, LaneRewardAttempt>();
  for (const row of rows) {
    const event = eventOf(row), phase = phaseOf(row);
    const launch = LAUNCH_EVENTS.has(event), finish = FINISH_EVENTS.has(event);
    if (!launch && !finish && !PUBLISH_EVENTS.has(event) && phase !== 'PUBLISHED' &&
        !OUTCOME_EVENTS.has(event) && !TERMINAL_PHASES.has(phase)) continue;
    const url = urlOf(row);
    const job = jobOf(row) ?? (url !== null ? jobByUrl.get(url) ?? null : null);
    if (job === null) continue;
    const attempt = attempts.get(job) ??
      { lane: null, tokens: null, published: false, outcome: null, outcomeTsMs: -1 };
    attempt.lane = laneOf(row) ?? attempt.lane;
    if (finish) attempt.tokens = tokensOf(row) ?? attempt.tokens;
    attempt.published ||= PUBLISH_EVENTS.has(event) || phase === 'PUBLISHED' || url !== null;
    if (TERMINAL_PHASES.has(phase)) {
      const tsMs = Date.parse(pickString(row, 'ts', 'timestamp', 'at', 'mergedAt', 'closedAt') ?? '') || 0;
      if (tsMs >= attempt.outcomeTsMs) {
        attempt.outcome = phase === 'MERGED' ? 'merged' : 'closed';
        attempt.outcomeTsMs = tsMs;
      }
    }
    attempts.set(job, attempt);
  }
  return { attempts, dropped };
}

type ScoredAttempt =
  | { scored: true; reward: number; outcome: 'published' | 'stable' | 'reverted' }
  | { scored: false; reason: string };

/** Score one folded attempt through the one-ask reward inspector. */
function scoreAttempt(job: string, attempt: LaneRewardAttempt, deps: LaneRewardDeps): ScoredAttempt {
  const merged = attempt.outcome === 'merged';
  if (!merged && !attempt.published && attempt.outcome !== 'closed') return { scored: false, reason: 'unresolved' };
  const tokens = attempt.tokens;
  if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0)
    return { scored: false, reason: 'invalid-usage' };
  const input = { tokens, weight: LANE_REWARD_WEIGHT, nowMs: deps.nowMs() };
  let result: OneAskReward;
  if (merged) {
    const proposal = deps.proposal(job);
    if (!proposal) return { scored: false, reason: 'proposal-unavailable' };
    result = deps.score({ ...input, outcome: { kind: 'merged', proposal } });
  } else result = deps.score({ ...input, outcome: { kind: 'published' } });
  return result.state === 'scored'
    ? { scored: true, reward: result.rewardPerToken, outcome: result.outcome }
    : { scored: false, reason: result.reason };
}

/** Read the ledger, score every attempt and aggregate per lane. Never throws. */
export async function readLaneReward(opts: {
  jobsPath?: string;
  deps?: Partial<LaneRewardDeps>;
} = {}): Promise<LaneRewardV1> {
  const deps: LaneRewardDeps = { ...defaultLaneRewardDeps, ...opts.deps };
  const nowMs = deps.nowMs();
  // Pin one observation time across every attempt's window inspection.
  const pinned: LaneRewardDeps = { ...deps, nowMs: () => nowMs };
  const path = resolve(
    opts.jobsPath?.startsWith('~/')
      ? join(homedir(), opts.jobsPath.slice(2))
      : opts.jobsPath ?? join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'),
  );
  const text = await deps.jobsText(path);
  const base: LaneRewardV1 = { schema: LANE_REWARD_SCHEMA,
    generatedAt: new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString(), source: 'healthy',
    weight: LANE_REWARD_WEIGHT, attempts: 0, scored: 0, unscored: 0, meanReward: null, lanes: [] };
  if (text === null) return { ...base, source: 'missing' };

  const fold = foldLaneRewardAttempts(text);
  const lanes = new Map<string, LaneRewardLane & { rewardSum: number }>();
  let rewardSum = 0;
  for (const [job, attempt] of fold.attempts) {
    const name = attempt.lane ?? 'unattributed';
    const lane = lanes.get(name) ??
      { lane: name, attempts: 0, scored: 0, unscored: 0, meanReward: null,
        outcomes: { published: 0, stable: 0, reverted: 0 }, reasons: {}, rewardSum: 0 };
    lanes.set(name, lane);
    lane.attempts++;
    base.attempts++;
    const result = scoreAttempt(job, attempt, pinned);
    if (result.scored) {
      lane.scored++;
      lane.outcomes[result.outcome]++;
      lane.rewardSum += result.reward;
      rewardSum += result.reward;
      base.scored++;
    } else {
      lane.unscored++;
      lane.reasons[result.reason] = (lane.reasons[result.reason] ?? 0) + 1;
      base.unscored++;
    }
  }
  base.lanes = [...lanes.values()]
    .map(({ rewardSum: sum, ...lane }) => ({ ...lane, meanReward: lane.scored > 0 ? sum / lane.scored : null }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  base.meanReward = base.scored > 0 ? rewardSum / base.scored : null;
  if (fold.dropped > 0) base.source = 'degraded';
  return base;
}
