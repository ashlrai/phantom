/**
 * index.ts — barrel for the contextual Thompson-sampling lane bandit.
 * See docs/BANDIT-ROUTER.md for the contract and docs/observability/README.md
 * for the dashboard metric this feeds.
 */
export {
  BANDIT_MODES,
  DEFAULT_BANDIT_CONFIG,
  DEFAULT_REWARD_WEIGHTS,
  DEFAULT_SIZE_EDGES,
  LANE_SIZE_BUCKETS,
} from './types.js';
export type {
  ArmPosterior,
  BanditConfig,
  BanditLane,
  BanditMode,
  BanditState,
  CreditPlan,
  LaneContext,
  LaneDecision,
  LaneSizeBucket,
  RewardWeights,
} from './types.js';
export { contextLabel, laneContextOf, sizeBucketOf, contextCellKeys, CONTEXT_LEVEL_NAMES } from './context.js';
export { mulberry32, standardNormal, gamma, beta, type UniformSource } from './rng.js';
export {
  banditStateFrom,
  emptyBanditState,
  floorEligibleLanes,
  sampleLanes,
  updateBanditState,
  type LaneSample,
  type LaneSelection,
} from './model.js';
export {
  MERGE_WINDOW_MS,
  ROUTER_OUTCOME_SCHEMA,
  outcomeRecordFrom,
  rewardOf,
  type OutcomeRecord,
  type RecordReward,
} from './rewards.js';
export {
  BANDIT_FLAG_ENV,
  BANDIT_FLAG_FILE,
  banditConfigFrom,
  banditFlagRoot,
  parseBanditFileConfig,
  resolveBanditFlag,
  type BanditFileConfig,
  type ResolvedBanditFlag,
} from './flag.js';
export {
  BANDIT_STATE_FILE,
  loadBanditState,
  recordOutcome,
  saveBanditState,
  selectLane,
  type SelectLaneInput,
} from './select.js';
export {
  REPLAY_ESTIMATOR,
  REPLAY_SCHEMA,
  parseOutcomeLog,
  replayOutcomeRecords,
  replayOutcomeText,
  type ReplayLaneBreakdown,
  type ReplayOptions,
  type ReplayReport,
  type ReplaySummary,
} from './replay.js';
