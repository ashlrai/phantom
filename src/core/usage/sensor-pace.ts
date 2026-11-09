/**
 * Pace a lane so included usage is spent as the window resets.
 * target = remaining * (1 - margin) / hoursLeft / burnPerJob.
 * Missing inputs stay unknown. They are not zero and they are not idle room.
 * Pay-per-use stays at 0 unless measured spend is below the owner budget and a fresh balance exists. The default budget is 0.
 * KILL and the caller's ceiling always win.
 */
import type { FleetEngine } from '../fleet/fleet-types.js';
import { spendAllowsPayPerUse } from '../spend/budget-policy.js';
import type { UsageSensorLaneView, UsageSensorReport } from './sensor-reading.js';

export const PACE_SAFETY_MARGIN = 0.15;

export type PaceReason = 'kill' | 'pay-per-use' | 'unknown' | 'paced' | 'uncapped';

export interface PaceInput {
  lane: string;
  remaining: number | null;
  resetAt: string | null;
  /** Usage units one running job consumes per hour. Zero is a measured flat burn. */
  burnPerJob: number | null;
  ceiling: number;
  floor: number;
  killed: boolean;
  nowMs: number;
  margin?: number;
  payPerUse?: boolean;
  balanceFresh?: boolean;
  /** Owner budget for this provider and period. Missing means 0. */
  budgetUsd?: number;
  /** Measured spend in that period. Null is unknown and is not under the budget. */
  spentUsd?: number | null;
  /** Local models have no allowance. The target is the throughput ceiling. */
  uncapped?: boolean;
}

export interface PaceDecision {
  lane: string;
  target: number | null;
  reason: PaceReason;
}

function clamp(value: number, floor: number, ceiling: number): number {
  const low = Number.isFinite(floor) && floor > 0 ? Math.floor(floor) : 0;
  const high = Number.isFinite(ceiling) && ceiling >= 0 ? Math.floor(ceiling) : 0;
  return Math.min(high, Math.max(low, value));
}

/** Integer concurrency for one lane. Null means the scheduler must not invent a pace. */
export function paceLane(input: PaceInput): PaceDecision {
  const lane = input.lane;
  if (input.killed || !Number.isFinite(input.ceiling) || input.ceiling < 0) {
    return { lane, target: input.killed ? 0 : null, reason: input.killed ? 'kill' : 'unknown' };
  }
  const ceiling = Math.floor(input.ceiling);
  const floor = Number.isFinite(input.floor) && input.floor > 0 ? Math.floor(input.floor) : 0;
  if (input.payPerUse === true) {
    const gate = spendAllowsPayPerUse({
      killed: false,
      budgetUsd: input.budgetUsd ?? 0,
      spentUsd: input.spentUsd === undefined ? null : input.spentUsd,
      balanceFresh: input.balanceFresh === true,
    });
    if (!gate.allow) return { lane, target: 0, reason: 'pay-per-use' };
  }
  if (input.uncapped === true) return { lane, target: clamp(ceiling, floor, ceiling), reason: 'uncapped' };
  const resetMs = input.resetAt ? Date.parse(input.resetAt) : NaN;
  const hours = Number.isFinite(resetMs) ? (resetMs - input.nowMs) / 3_600_000 : NaN;
  if (input.remaining === null || !(input.remaining >= 0) || !(hours > 0) || input.burnPerJob === null || input.burnPerJob < 0) {
    return { lane, target: null, reason: 'unknown' };
  }
  if (input.burnPerJob === 0) return { lane, target: clamp(ceiling, floor, ceiling), reason: 'paced' };
  const margin = input.margin ?? PACE_SAFETY_MARGIN;
  const kept = Number.isFinite(margin) && margin >= 0 && margin < 1 ? margin : PACE_SAFETY_MARGIN;
  const raw = (input.remaining * (1 - kept)) / hours / input.burnPerJob;
  if (!Number.isFinite(raw) || raw < 0) return { lane, target: null, reason: 'unknown' };
  return { lane, target: clamp(Math.floor(raw), floor, ceiling), reason: 'paced' };
}

export interface SchedulerPaceAdvice {
  remaining: number | null;
  resetAt: string | null;
  /** Lane-wide usage units per hour. The scheduler divides by its current slots. */
  burnPerHour: number | null;
  payPerUse?: boolean;
  balanceFresh?: boolean;
  budgetUsd?: number;
  spentUsd?: number | null;
  uncapped?: boolean;
}

const FLEET_FROM_SENSOR: Partial<Record<UsageSensorLaneView['lane'], FleetEngine>> = {
  'codex-personal': 'codex',
  'claude-max': 'claude-cli',
  'grok-bot': 'grok-cli',
  local: 'local',
};

/** Advice for the fleet scheduler. Devin's ACU row is not a CLI slot change. */
export function fleetPaceAdvice(report: UsageSensorReport): Partial<Record<FleetEngine, SchedulerPaceAdvice>> {
  const byLane = new Map(report.lanes.map((lane) => [lane.lane, lane]));
  const grok = byLane.get('grok-bot')?.status === 'fresh' ? byLane.get('grok-bot') : byLane.get('grok-ultra');
  const chosen: [FleetEngine, UsageSensorLaneView | undefined][] = [
    ['codex', byLane.get('codex-personal')],
    ['claude-cli', byLane.get('claude-max')],
    ['grok-cli', grok],
    ['local', byLane.get('local')],
  ];
  const advice: Partial<Record<FleetEngine, SchedulerPaceAdvice>> = {};
  for (const [engine, row] of chosen) {
    if (!row || row.status !== 'fresh') continue;
    if (!FLEET_FROM_SENSOR[row.lane] && engine !== 'grok-cli') continue;
    advice[engine] = {
      remaining: row.remaining,
      resetAt: row.resetAt,
      burnPerHour: row.burnRate,
      uncapped: row.lane === 'local',
    };
  }
  return advice;
}

export function paceReason(reason: PaceReason, target: number): string {
  switch (reason) {
    case 'kill':
      return 'The fleet KILL switch is on.';
    case 'pay-per-use':
      return 'This pay-per-use lane stays at 0 until measured spend is below the owner budget and a fresh balance exists.';
    case 'uncapped':
      return `Local throughput allows ${target}.`;
    case 'paced':
      return `Pacing holds this lane to ${target} so included usage meets the reset.`;
    case 'unknown':
      return 'Usage pace is unknown.';
    default: {
      const never: never = reason;
      return never;
    }
  }
}

/** Divide a lane burn by the slots already allowed, then pace under that ceiling. */
export function paceAgainstCeiling(advice: SchedulerPaceAdvice, ceiling: number, nowMs: number, killed: boolean): PaceDecision {
  const jobs = Math.max(1, Math.floor(ceiling));
  const burnPerJob = advice.burnPerHour === null ? null : advice.burnPerHour / jobs;
  return paceLane({
    lane: 'lane',
    remaining: advice.remaining,
    resetAt: advice.resetAt,
    burnPerJob,
    ceiling,
    floor: 0,
    killed,
    nowMs,
    payPerUse: advice.payPerUse,
    balanceFresh: advice.balanceFresh,
    budgetUsd: advice.budgetUsd,
    spentUsd: advice.spentUsd,
    uncapped: advice.uncapped,
  });
}
