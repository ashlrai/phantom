import type { RouterOutcome } from './outcomes.js';

export const LANE_AUTO_MIN_SAMPLES = 5;
export interface LaneAutoScore {
  model: string;
  samples: number;
  heldMergeRate: number | null;
  firstPassCiRate: number | null;
  usdPerHeldMerge: number | null;
}

type Observation = Pick<RouterOutcome, 'lane' | 'model' | 'tier' | 'work_class' | 'merged' | 'reverted' | 'ci_first_pass' | 'cost_usd'>;
type Tally = { resolved: number; held: number; ci: number; passed: number; costs: number; cost: number; costedMerges: number };
const key = (lane: string, tier: string, workClass: string, model: string) => JSON.stringify([lane, tier, workClass, model]);
const outcomeLane = (lane: string): string => {
  switch (lane) {
    case 'claude': return 'claude-cli';
    case 'grok': return 'grok-cli';
    default: return lane;
  }
};

export function indexLaneAutoScores(outcomes: readonly Observation[]) {
  const totals = new Map<string, Tally>();
  for (const row of outcomes) {
    if (!row.lane || !row.model || !row.tier || !row.work_class || (row.merged === null && row.reverted !== true)) continue;
    const id = key(outcomeLane(row.lane), row.tier, row.work_class, row.model);
    const total = totals.get(id) ?? { resolved: 0, held: 0, ci: 0, passed: 0, costs: 0, cost: 0, costedMerges: 0 };
    const held = row.merged === true && row.reverted !== true;
    total.resolved++;
    if (held) total.held++;
    if (row.ci_first_pass !== null) {
      total.ci++;
      if (row.ci_first_pass) total.passed++;
    }
    if (row.cost_usd !== null && Number.isFinite(row.cost_usd) && row.cost_usd >= 0) {
      total.costs++;
      total.cost += row.cost_usd;
      if (held) total.costedMerges++;
    }
    totals.set(id, total);
  }
  return (lane: string, tier: string, model: string, workClass: string | null): LaneAutoScore => {
    const total = workClass ? totals.get(key(lane, tier, workClass, model)) : undefined;
    return {
      model, samples: total?.resolved ?? 0,
      heldMergeRate: total ? total.held / total.resolved : null,
      firstPassCiRate: total?.ci ? total.passed / total.ci : null,
      usdPerHeldMerge: total?.costedMerges && total.costs === total.resolved && Number.isFinite(total.cost)
        ? total.cost / total.costedMerges : null,
    };
  };
}

export function rankLaneAutoScores(left: LaneAutoScore, right: LaneAutoScore): number {
  return (right.heldMergeRate ?? -1) - (left.heldMergeRate ?? -1)
    || (right.firstPassCiRate ?? -1) - (left.firstPassCiRate ?? -1)
    || (left.usdPerHeldMerge !== null && right.usdPerHeldMerge !== null ? left.usdPerHeldMerge - right.usdPerHeldMerge : 0);
}
