/**
 * Router wiring for the local inference escalation policy (local-inference-plan.md, after P4).
 *
 * `routeSeatWithLocalEscalation` is the router entry point for work that may
 * run on a local engine. It asks `decideLocalEscalation` for a lane, then
 * routes through the existing pure `routeSeat` over a capacity list narrowed
 * to that lane:
 *   - lane 'frontier': every `engine === 'local'` seat is excluded;
 *   - lane 'local': only local seats are offered; if none is eligible the
 *     request escalates to frontier (reason 'local-unavailable').
 *
 * Authority rules applied here before the policy, stricter than P4 alone:
 *   - a step that merges to main, or holds merge rights, is frontier-only;
 *   - a step that holds credentials (phantom exec, OAuth, API keys) is
 *     frontier-only, whatever the local model (abliterated or not).
 * Local is therefore never chosen for a role holding credentials or merge rights.
 */
import { decideLocalEscalation, DEFAULT_ESCALATION_POLICY, type EscalationInput, type EscalationPolicy, type EscalationReason } from './local-escalation.js';
import { routeSeat, type RouteOptions } from './router.js';
import type { SeatCapacity } from './headroom.js';
import type { BudgetPolicy, RoutingRequest, SeatDecision } from './types.js';

export type LocalRouteReason = EscalationReason | 'credentials-frontier-only' | 'merge-rights-frontier-only';

export interface LocalRouteInput extends Omit<EscalationInput, 'localAvailable'> {
  /** The role holds merge rights (even when this step is not itself a merge). */
  holdsMergeRights?: boolean;
  /** Local server configured and reachable (P3 probe). */
  localAvailable: boolean;
}

export interface LocalRouteDecision extends SeatDecision {
  lane: 'local' | 'frontier';
  laneReason: LocalRouteReason;
}

export const isLocalSeat = (capacity: Pick<SeatCapacity, 'engine'>): boolean => capacity.engine === 'local';

/** Pure lane choice with the authority rules first. */
export function decideLocalRouteLane(input: LocalRouteInput, policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY): { lane: 'local' | 'frontier'; reason: LocalRouteReason } {
  if (input.mergesToMain === true) return { lane: 'frontier', reason: 'merge-to-main-frontier-only' };
  if (input.holdsMergeRights === true) return { lane: 'frontier', reason: 'merge-rights-frontier-only' };
  if (input.needsCredentials === true) return { lane: 'frontier', reason: 'credentials-frontier-only' };
  return decideLocalEscalation(input, policy);
}

/** Pure. Routes `req` on the lane the escalation policy picks. */
export function routeSeatWithLocalEscalation(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  budget: BudgetPolicy,
  opts: RouteOptions,
  input: LocalRouteInput,
  policy: EscalationPolicy = DEFAULT_ESCALATION_POLICY,
): LocalRouteDecision {
  const frontierSeats = capacity.filter((c) => !isLocalSeat(c));
  const choice = decideLocalRouteLane(input, policy);
  if (choice.lane === 'local') {
    const local = routeSeat(req, capacity.filter(isLocalSeat), budget, opts);
    if (local.seatId !== null) return { ...local, lane: 'local', laneReason: choice.reason };
    return { ...routeSeat(req, frontierSeats, budget, opts), lane: 'frontier', laneReason: 'local-unavailable' };
  }
  return { ...routeSeat(req, frontierSeats, budget, opts), lane: 'frontier', laneReason: choice.reason };
}
