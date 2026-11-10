/**
 * Bottleneck-only stage delegation policy (research digest item 6, Cohere
 * finding): frontier lanes plan and verify; cheap lanes implement; only the
 * stage that is the actual bottleneck earns delegated extra capacity.
 *
 * A decomposed task has three stages, `plan`, `implement`, `verify`
 * (`DELEGATION_STAGES` below). Judgment stages (`plan`,
 * `verify`) never move to cheap lanes: a cheap verify proves nothing, and a
 * cheap plan cannot plan. `implement` is the cheap-lane stage by default and
 * only escalates when implementation itself is the declared bottleneck —
 * spending a frontier seat on mechanical work the cheap lane can carry is
 * pure waste. Delegation is surgical: `delegated` is true for the bottleneck
 * stage only, never for a stage that is merely busy.
 *
 * Consumers: `tierPreference` (routing/router.ts) keeps judgment tasks off the
 * free-first implement ordering; `renderDelegationScopeForPrompt`
 * (run/delegation-scope.ts) renders the declared stage; the Leader prompt
 * (vision/leader.ts) carries the doctrine line. PURE and browser-safe: no
 * I/O, no clock, no model calls.
 */
import type { DelegationStage } from '../types/delegation.js';

/** Runtime list of the shared stage vocabulary. The types module stays type-only. */
export const DELEGATION_STAGES = ['plan', 'implement', 'verify'] as const satisfies readonly DelegationStage[];
import type { SwarmPhaseName } from '../types/swarm.js';
import type { ResourceTier } from './tiers.js';
import type { RoutingTask } from './types.js';

/** The two lane classes this policy distinguishes. */
export type DelegationLaneClass = 'frontier' | 'cheap';

/** Stages whose output is judgment; they may never run on cheap lanes. */
export const JUDGMENT_STAGES: readonly DelegationStage[] = ['plan', 'verify'];

/** The lane class each stage defaults to under this policy. */
export const STAGE_LANE_CLASS: Readonly<Record<DelegationStage, DelegationLaneClass>> = Object.freeze({
  plan: 'frontier',
  implement: 'cheap',
  verify: 'frontier',
});

/**
 * Autonomy's frontier-first seat ordering for judgment stages: frontier lanes
 * first, free local last. This is the same order reserve/high and all-in/medium
 * already use; it exists here so the judgment ordering has one owner.
 */
export const JUDGMENT_STAGE_ORDER: readonly ResourceTier[] = ['fast', 'elite', 'free'];

/** One-line policy text shared by the Leader prompt and docs. */
export const DELEGATION_DOCTRINE =
  'Bottleneck-only delegation: frontier lanes plan and verify; cheap lanes implement. ' +
  'Delegate only the stage that is the actual bottleneck — judgment stages never move ' +
  'to cheap lanes, and no stage escalates to frontier unless it is the constraint.';

export function isDelegationStage(value: unknown): value is DelegationStage {
  return typeof value === 'string' && (DELEGATION_STAGES as readonly string[]).includes(value);
}

/** Which pipeline stage a router task kind performs. */
export function routingTaskStage(task: RoutingTask): DelegationStage {
  switch (task) {
    case 'plan':
    case 'leader':
      return 'plan';
    case 'review':
      return 'verify';
    default: // 'code' | 'bulk'
      return 'implement';
  }
}

/** True when the task performs a judgment stage (plan or verify). */
export function isJudgmentRoutingTask(task: RoutingTask): boolean {
  return JUDGMENT_STAGES.includes(routingTaskStage(task));
}

/**
 * Which delegation stage a swarm phase performs (swarm/runner.ts): verify and
 * review are judgment; scaffold, build and integrate are implementation.
 */
export function delegationStageForSwarmPhase(phase: SwarmPhaseName): DelegationStage {
  return phase === 'verify' || phase === 'review' ? 'verify' : 'implement';
}

export interface StageDelegation {
  stage: DelegationStage;
  /** Policy lane class for the stage; never reassignable by the caller. */
  laneClass: DelegationLaneClass;
  /** True only for the declared bottleneck — the one stage allowed delegated extra capacity. */
  delegated: boolean;
}

/**
 * Project the delegation plan for one decomposed task. Every listed stage
 * keeps its policy lane class; `delegated` is set on the bottleneck stage and
 * nowhere else. Pure: the bottleneck is declared by the caller (the Leader's
 * memo or a planner), never inferred here.
 */
export function planStageDelegation(input: {
  bottleneck: DelegationStage;
  stages?: readonly DelegationStage[];
}): StageDelegation[] {
  if (!isDelegationStage(input.bottleneck)) throw new Error('invalid delegation bottleneck stage');
  const stages = input.stages ?? DELEGATION_STAGES;
  for (const stage of stages) {
    if (!isDelegationStage(stage)) throw new Error('invalid delegation stage');
  }
  if (!stages.includes(input.bottleneck)) {
    throw new Error('delegation bottleneck must be one of the task stages');
  }
  return stages.map((stage) => ({
    stage,
    laneClass: STAGE_LANE_CLASS[stage],
    delegated: stage === input.bottleneck,
  }));
}

/**
 * Why a concrete stage→lane-class assignment violates the policy, or null when
 * it conforms. `bottleneck` is the task's declared bottleneck stage (null when
 * none is declared): implement may draw frontier capacity only when it is the
 * bottleneck; judgment stages may never run cheap.
 */
export function stageDelegationViolation(
  stage: DelegationStage,
  laneClass: DelegationLaneClass,
  bottleneck: DelegationStage | null,
): string | null {
  if (!isDelegationStage(stage)) return `unknown delegation stage "${String(stage)}"`;
  if (laneClass !== 'frontier' && laneClass !== 'cheap') return `unknown delegation lane class "${String(laneClass)}"`;
  if (JUDGMENT_STAGES.includes(stage) && laneClass === 'cheap') {
    return `${stage} is a judgment stage; cheap lanes cannot judge — it stays on frontier lanes`;
  }
  if (stage === 'implement' && laneClass === 'frontier' && bottleneck !== 'implement') {
    return 'implement is the cheap-lane stage; only the actual bottleneck stage may escalate to frontier';
  }
  return null;
}
