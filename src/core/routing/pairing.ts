import type { DelegationStage } from '../types/delegation.js';
import { compareSpendPriority, resetLaneOrder, validResetCalendarPool, type ResetCalendarPool } from './reset-pressure.js';
import type { ModelModeTier } from '../run/model-mode-data.js';
import { STAGE_LANE_CLASS, stageDelegationViolation, type DelegationLaneClass } from './stage-delegation.js';

export const PAIRING_REASONS = ['reset-pressure', 'credits-only', 'no-capacity-evidence',
  'no-frontier-lane', 'no-cheap-lane', 'implement-escalated', 'paired', 'free-capacity', 'cheapest'] as const;
export type PairingReason = typeof PAIRING_REASONS[number];
export interface PairingLane {
  model?: string;
  mode_tier?: ModelModeTier | null;
  lane: string;
  laneClass: DelegationLaneClass;
  available: boolean;
  pool: ResetCalendarPool;
}
export interface Assignment {
  model: string | null;
  mode_tier: ModelModeTier | null;
  lane: string;
  laneClass: DelegationLaneClass;
  stages: DelegationStage[];
  resetAt: string | null;
  remainingPercent: number | null;
  pacePerHour: number | null;
  reason_codes: PairingReason[];
}

export function decidePairing(lanes: readonly PairingLane[], nowMs: number,
  { bottleneck = null }: { bottleneck?: DelegationStage | null } = {}) {
  const eligible = lanes.filter(row => row.available && validResetCalendarPool(row.pool) &&
    (row.mode_tier == null || row.laneClass === (row.mode_tier === 'ultra' ? 'frontier' : 'cheap')) &&
    ((row.pool.remainingPercent !== 0 && (row.pool.resetAt === null || Date.parse(row.pool.resetAt) > nowMs)) || (row.pool.creditBalance ?? 0) > 0));
  const ranked = (cls: DelegationLaneClass) => {
    const rows = eligible.filter(row => row.laneClass === cls).sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0);
    const order = resetLaneOrder(rows.map(row => ({ ...row.pool, pool: row.lane })), nowMs);
    return rows.sort((a, b) => {
      const rank = (id: string) => { const i = order.findIndex(row => row.pool === id); return i < 0 ? Infinity : i; };
      return compareSpendPriority(a.pool, b.pool, nowMs) || rank(a.lane) - rank(b.lane);
    }).map(row => ({ row, evidence: order.find(item => item.pool === row.lane) }));
  };
  const assign = (candidate: ReturnType<typeof ranked>[number] | undefined, stages: DelegationStage[]): Assignment | null => {
    if (!candidate) return null;
    const { row, evidence } = candidate;
    for (const stage of stages) {
      const violation = stageDelegationViolation(stage, row.laneClass, bottleneck);
      if (violation) throw new Error(violation);
    }
    return { lane: row.lane, model: row.model ?? null, mode_tier: row.mode_tier ?? null, laneClass: row.laneClass, stages,
      resetAt: evidence?.resetAt ?? null, remainingPercent: evidence?.remainingPercent ?? null,
      pacePerHour: evidence?.pacePerHour ?? null,
      reason_codes: [evidence?.kind === 'weekly' && evidence.resetAt !== null ? 'reset-pressure' : row.pool.costPerMTok === 0
        ? 'free-capacity' : row.pool.costPerMTok != null ? 'cheapest' : evidence?.kind === 'credits' ? 'credits-only' : 'no-capacity-evidence'] };
  };
  const frontier = ranked(STAGE_LANE_CLASS.plan);
  const lead = assign(frontier[0], ['plan', 'verify']);
  let sidekick = assign(ranked(STAGE_LANE_CLASS.implement)[0], ['implement']);
  const reason_codes: PairingReason[] = [];
  if (!lead) reason_codes.push('no-frontier-lane');
  if (!sidekick) {
    reason_codes.push('no-cheap-lane');
    if (bottleneck === 'implement') {
      sidekick = assign(frontier.find(candidate => candidate.row.lane !== lead?.lane), ['implement']);
      if (sidekick) { sidekick.reason_codes.push('implement-escalated'); reason_codes.push('implement-escalated'); }
    }
  }
  if (lead && sidekick) reason_codes.push('paired');
  return { schema: 'route.pairing.v1' as const, mode_tier: 'fusion' as const, advisory: true as const, lead, sidekick,
    reason_codes: [...new Set([...reason_codes, ...lead?.reason_codes ?? [], ...sidekick?.reason_codes ?? []])] };
}
