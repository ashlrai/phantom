/**
 * replay.ts — the offline replay the acceptance asks for: the bandit's reward
 * versus the current (static) router's reward over the existing outcome logs.
 *
 * METHOD — rejection-sampling bandit evaluation (the standard unbiased
 * estimator for a logged contextual-bandit problem, Li et al. 2011):
 *
 *   The log records, per queue line, the lane the STATIC router took and the
 *   reward the world returned. We replay the log in order. For each record
 *   the bandit — seeded deterministically, trained only on what it has kept
 *   so far — draws its Thompson pick among the lanes that clear the credit
 *   floor at that record. When the pick equals the logged lane, the record's
 *   REAL reward is credited to the bandit and folded into its posteriors;
 *   when it differs, the record is dropped — the log cannot tell us what an
 *   unchosen lane would have earned, and pretending otherwise would be a
 *   fabricated counterfactual.
 *
 * The kept records are exactly those where the bandit independently reached
 * the logged choice, so the bandit's mean reward over them estimates its
 * policy's expected reward under its own exploration. The static baseline is
 * the same log's mean reward — reported over ALL records (the policy as run)
 * and over the kept subset (an apples-to-apples comparison on identical
 * evidence). `before`/`after` carry those means under names the dev-cycle
 * dashboard's `policy` label (static|bandit) maps to directly.
 *
 * Honest limits, documented in docs/BANDIT-ROUTER.md: the estimate is only as
 * wide as the logged support — a context where the static router never tried
 * a lane contributes nothing, and a small kept count is a thin estimate, not
 * a hidden zero.
 */
import { laneContextOf } from './context.js';
import {
  emptyBanditState,
  floorEligibleLanes,
  sampleLanes,
  updateBanditState,
} from './model.js';
import { mulberry32 } from './rng.js';
import {
  outcomeRecordFrom,
  rewardOf,
  type OutcomeRecord,
} from './rewards.js';
import {
  DEFAULT_BANDIT_CONFIG,
  type BanditConfig,
  type BanditLane,
  type BanditState,
} from './types.js';

export const REPLAY_SCHEMA = 'phantom-router-bandit-replay/v1';
export const REPLAY_ESTIMATOR = 'rejection-sampling';

export interface ReplaySummary {
  readonly records: number;
  readonly meanReward: number | null;
  readonly meanRawReward: number | null;
  readonly successRate: number | null;
}

export interface ReplayLaneBreakdown {
  readonly logged: number;
  readonly kept: number;
  readonly meanRewardLogged: number | null;
  readonly meanRewardKept: number | null;
}

export interface ReplayReport {
  readonly schema: typeof REPLAY_SCHEMA;
  readonly estimator: typeof REPLAY_ESTIMATOR;
  readonly seed: number;
  readonly records: number;
  readonly kept: number;
  readonly keptRate: number | null;
  /** Records where no lane cleared the credit floor (always dropped). */
  readonly floorDenials: number;
  /** Static router = the logged policy, over every record. */
  readonly before: ReplaySummary;
  /** Bandit counterfactual over the kept records. */
  readonly after: ReplaySummary;
  /** The logged policy over the SAME kept subset — matched-evidence control. */
  readonly staticOnKept: ReplaySummary;
  readonly delta: { meanReward: number | null; meanRawReward: number | null };
  readonly lanes: Readonly<Record<string, ReplayLaneBreakdown>>;
  readonly config: {
    readonly creditFloor: number;
    readonly minCellSamples: number;
    readonly reward: BanditConfig['reward'];
    readonly lanes: readonly string[];
  };
}

export interface ReplayOptions {
  readonly seed?: number;
  readonly config?: BanditConfig;
  /**
   * The arm set the bandit chooses among. Absent ⇒ every lane id the log
   * records (sorted), each spending against its own pool — the degenerate
   * case where pools ARE the lanes.
   */
  readonly lanes?: readonly BanditLane[];
}

/** Parse the outcome log: a JSON array, or one JSON object per line. */
export function parseOutcomeLog(text: string): OutcomeRecord[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  let rows: unknown[];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid outcome log JSON: ${error instanceof Error ? error.message : 'parse failed'}`);
    }
    if (!Array.isArray(parsed)) throw new Error('Invalid outcome log: top-level JSON must be an array');
    rows = parsed;
  } else {
    rows = trimmed.split(/\r?\n/).map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid outcome log JSON on line ${index + 1}`);
      }
    });
  }
  return rows.map((row, index) => {
    try {
      return outcomeRecordFrom(row);
    } catch (error) {
      throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : 'invalid row'}`);
    }
  });
}

function summarize(rewards: readonly { unit: number; raw: number; success: boolean }[]): ReplaySummary {
  if (rewards.length === 0) return { records: 0, meanReward: null, meanRawReward: null, successRate: null };
  const unit = rewards.reduce((sum, r) => sum + r.unit, 0) / rewards.length;
  const raw = rewards.reduce((sum, r) => sum + r.raw, 0) / rewards.length;
  const success = rewards.filter((r) => r.success).length / rewards.length;
  return { records: rewards.length, meanReward: unit, meanRawReward: raw, successRate: success };
}

const round = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 1_000_000) / 1_000_000;

function roundSummary(summary: ReplaySummary): ReplaySummary {
  return {
    records: summary.records,
    meanReward: round(summary.meanReward),
    meanRawReward: round(summary.meanRawReward),
    successRate: round(summary.successRate),
  };
}

/**
 * Run the replay. Deterministic for a fixed seed: the same log and seed
 * always produce the same report — a replay is evidence, not a dice roll.
 */
export function replayOutcomeRecords(records: readonly OutcomeRecord[], options: ReplayOptions = {}): ReplayReport {
  const config = options.config ?? DEFAULT_BANDIT_CONFIG;
  const seed = options.seed ?? 1;
  const lanes: BanditLane[] = options.lanes !== undefined
    ? [...options.lanes]
    : [...new Set(records.map((record) => record.lane))].sort().map((id) => ({ id, pool: id }));

  const uniform = mulberry32(seed);
  let state: BanditState = emptyBanditState();
  const staticRewards: { unit: number; raw: number; success: boolean }[] = [];
  const keptRewards: { unit: number; raw: number; success: boolean }[] = [];
  const keptStaticRewards: { unit: number; raw: number; success: boolean }[] = [];
  const laneStats = new Map<string, { logged: { unit: number; raw: number; success: boolean }[]; kept: { unit: number; raw: number; success: boolean }[] }>();
  let floorDenials = 0;

  for (const record of records) {
    const reward = rewardOf(record, config.reward);
    staticRewards.push(reward);
    const stats = laneStats.get(record.lane) ?? { logged: [], kept: [] };
    stats.logged.push(reward);
    laneStats.set(record.lane, stats);

    const context = laneContextOf(
      { sizeLines: record.sizeLines, repo: record.repo, tier: record.tier, pool: record.pool },
      config,
    );
    const eligible = floorEligibleLanes(
      lanes,
      record.credits !== undefined ? { remaining: record.credits } : undefined,
      config.creditFloor,
    );
    if (eligible.length === 0) {
      floorDenials++;
      continue;
    }
    const selection = sampleLanes(state, context, eligible, config, uniform);
    if (selection === null || selection.lane.id !== record.lane) continue;
    keptRewards.push(reward);
    keptStaticRewards.push(reward);
    stats.kept.push(reward);
    state = updateBanditState(state, context, record.lane, reward.unit);
  }

  const before = summarize(staticRewards);
  const after = summarize(keptRewards);
  const laneBreakdown: Record<string, ReplayLaneBreakdown> = {};
  for (const [laneId, stats] of [...laneStats.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    laneBreakdown[laneId] = {
      logged: stats.logged.length,
      kept: stats.kept.length,
      meanRewardLogged: round(stats.logged.length === 0 ? null : stats.logged.reduce((s, r) => s + r.unit, 0) / stats.logged.length),
      meanRewardKept: round(stats.kept.length === 0 ? null : stats.kept.reduce((s, r) => s + r.unit, 0) / stats.kept.length),
    };
  }
  return {
    schema: REPLAY_SCHEMA,
    estimator: REPLAY_ESTIMATOR,
    seed,
    records: records.length,
    kept: keptRewards.length,
    keptRate: round(records.length === 0 ? null : keptRewards.length / records.length),
    floorDenials,
    before: roundSummary(before),
    after: roundSummary(after),
    staticOnKept: roundSummary(summarize(keptStaticRewards)),
    delta: {
      meanReward: after.meanReward === null || before.meanReward === null ? null : round(after.meanReward - before.meanReward),
      meanRawReward: after.meanRawReward === null || before.meanRawReward === null ? null : round(after.meanRawReward - before.meanRawReward),
    },
    lanes: laneBreakdown,
    config: {
      creditFloor: config.creditFloor,
      minCellSamples: config.minCellSamples,
      reward: config.reward,
      lanes: lanes.map((lane) => lane.id),
    },
  };
}

/** Convenience: parse a log file's text and replay it. */
export function replayOutcomeText(text: string, options: ReplayOptions = {}): ReplayReport {
  return replayOutcomeRecords(parseOutcomeLog(text), options);
}
