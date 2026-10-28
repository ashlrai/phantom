/**
 * select.ts — the admission-time routing decision the host queue calls.
 *
 * `selectLane` is the single entry a host needs: give it the line's context,
 * the candidate lanes, the pools' current credit headroom, the static
 * route's lane, and the resolved flag mode; get back the lane to route
 * (or a hold), the bandit's shadow pick, and a one-sentence reason.
 *
 * MODE SEMANTICS
 *  - off:     the bandit is not consulted. laneId = staticLaneId verbatim;
 *             sampledLaneId is null. Byte-identical to the static router.
 *  - shadow:  the bandit draws a Thompson sample among floor-eligible lanes
 *             and reports it as sampledLaneId, but laneId stays the static
 *             pick. `divergent` flags every disagreement for the shadow log.
 *  - enforce: laneId = the bandit's pick, drawn only among lanes whose pool
 *             clears the credit floor. If NO lane clears the floor the
 *             decision is a HOLD — the bandit never routes past the plan,
 *             even where the static route would have.
 *
 * The credit floor is enforced identically in every mode the bandit is
 * consulted in: eligible lanes are always computed before sampling, so a
 * Thompson draw can never land on an over-plan pool. In shadow mode that
 * filtering applies to the sampled pick only — the applied lane remains the
 * static route's, exactly as before.
 *
 * State persistence is an explicit store seam (loadState/saveState with an
 * injected directory): the model itself is pure, and the host owns when to
 * persist. `recordOutcome` folds a settled outcome into the posteriors in
 * every mode — shadow learns from real traffic so its posteriors are
 * trained before the flag is ever promoted.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { laneContextOf, CONTEXT_LEVEL_NAMES } from './context.js';
import {
  banditStateFrom,
  emptyBanditState,
  floorEligibleLanes,
  sampleLanes,
  updateBanditState,
  type LaneSample,
} from './model.js';
import { mulberry32, type UniformSource } from './rng.js';
import { rewardOf, type OutcomeRecord } from './rewards.js';
import {
  DEFAULT_BANDIT_CONFIG,
  type BanditConfig,
  type BanditLane,
  type BanditMode,
  type BanditState,
  type CreditPlan,
  type LaneContext,
  type LaneDecision,
} from './types.js';

export const BANDIT_STATE_FILE = 'router-bandit-state.json';

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

export interface SelectLaneInput {
  readonly context: LaneContext;
  readonly lanes: readonly BanditLane[];
  /** The lane the static router would route to (the declared pool's lane). */
  readonly staticLaneId: string | null;
  readonly credits?: CreditPlan;
  readonly mode: BanditMode;
  readonly state: BanditState;
  readonly config?: BanditConfig;
  readonly uniform?: UniformSource;
}

/**
 * One routing decision. Never throws: a bandit that cannot answer leaves the
 * static route in place (off/shadow) or holds (enforce).
 */
export function selectLane(input: SelectLaneInput): LaneDecision {
  const config = input.config ?? DEFAULT_BANDIT_CONFIG;
  const staticLane = input.staticLaneId;
  const base = {
    mode: input.mode,
    sampledLaneId: null as string | null,
    divergent: false,
    eligibleLaneIds: input.lanes.map((lane) => lane.id),
  };
  if (input.mode === 'off') {
    return { ...base, laneId: staticLane, holdReason: null, reason: 'The bandit flag is off; the static route stands.' };
  }
  const eligible = floorEligibleLanes(input.lanes, input.credits, config.creditFloor);
  const eligibleLaneIds = eligible.map((lane) => lane.id);
  const eligibleReason = eligible.length === input.lanes.length
    ? ''
    : ` ${input.lanes.length - eligible.length} lane(s) sit below their pool's credit floor.`;
  let selection: ReturnType<typeof sampleLanes> = null;
  try {
    selection = sampleLanes(input.state, input.context, eligible, config, input.uniform ?? mulberry32(Date.now() >>> 0));
  } catch {
    selection = null;
  }
  const sampledLaneId = selection?.lane.id ?? null;
  const levelName = (sample: LaneSample | undefined): string =>
    sample === undefined || sample.level < 0 ? 'prior' : CONTEXT_LEVEL_NAMES[sample.level] ?? 'global';
  if (input.mode === 'shadow') {
    return {
      ...base,
      laneId: staticLane,
      sampledLaneId,
      divergent: sampledLaneId !== null && sampledLaneId !== staticLane,
      eligibleLaneIds,
      holdReason: null,
      reason: selection === null
        ? 'Shadow mode: no eligible lane to sample; the static route stands.'
        : `Shadow mode: sampled ${selection.lane.id} at ${levelName(selection.sample)} level; the static route stands.${eligibleReason}`,
    };
  }
  // enforce
  if (selection === null) {
    return {
      ...base,
      laneId: null,
      sampledLaneId: null,
      eligibleLaneIds,
      holdReason: 'no lane clears the credit floor',
      reason: `Enforce mode holds: no candidate lane's pool has headroom at the ${config.creditFloor} credit floor; the bandit never routes past the plan.`,
    };
  }
  return {
    ...base,
    laneId: selection.lane.id,
    sampledLaneId,
    divergent: selection.lane.id !== staticLane,
    eligibleLaneIds,
    holdReason: null,
    reason: `Enforce mode: sampled ${selection.lane.id} at ${levelName(selection.sample)} level.${eligibleReason}`,
  };
}

// ---------------------------------------------------------------------------
// Learning from settled outcomes
// ---------------------------------------------------------------------------

/**
 * Fold one outcome record into bandit state. The context is rebuilt from the
 * RECORD (not re-requested), so learning uses exactly the line shape the
 * recorder saw. Lane must be one the caller accepts — the model updates for
 * any logged lane id so shadow training covers every historical arm.
 */
export function recordOutcome(
  state: BanditState,
  record: OutcomeRecord,
  config: BanditConfig = DEFAULT_BANDIT_CONFIG,
): BanditState {
  const context = laneContextOf(
    { sizeLines: record.sizeLines, repo: record.repo, tier: record.tier, pool: record.pool },
    config,
  );
  return updateBanditState(state, context, record.lane, rewardOf(record, config.reward).unit);
}

// ---------------------------------------------------------------------------
// Store seam
// ---------------------------------------------------------------------------

/** Read persisted posteriors; a missing or corrupt file yields fresh state. */
export function loadBanditState(dir: string, file = BANDIT_STATE_FILE): BanditState {
  try {
    return banditStateFrom(JSON.parse(readFileSync(join(dir, file), 'utf8')));
  } catch {
    return emptyBanditState();
  }
}

/**
 * Persist posteriors atomically (temp file + rename). Bounded honesty: the
 * write is fsync'ed before rename so a crash mid-write cannot leave a torn
 * state file that a later read would mistake for learned evidence.
 */
export function saveBanditState(dir: string, state: BanditState, file = BANDIT_STATE_FILE): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, file);
  const temp = join(dir, `.${file}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, target);
}
