/**
 * Router wiring for the local inference escalation policy (stacked on #926).
 *
 * `routeSeatWithLocalEscalation` routes through the existing pure `routeSeat`
 * over a capacity list narrowed to the lane `decideLocalEscalation` picks.
 *
 * Invariants:
 *   - Default-off: with no valid `localInference` config, non-authority work
 *     routes exactly as `routeSeat` over the full capacity list.
 *   - A step or role that merges, holds merge rights or holds credentials never
 *     gets a local seat, configured or not. Locality is judged by
 *     `isLocalEngine` (id or endpoint), so a local engine that config promotes
 *     to tier 'frontier' is still refused.
 *   - Authority work fails closed: a seat is eligible only when its engine is
 *     positively known remote (`isKnownRemoteSeat`). Anything else, including
 *     an unknown id with no `ctx.engines` entry, is refused.
 *   - The local lane is loopback-only: a config with `allowRemote` pointing off
 *     this machine escalates to frontier.
 */
import { parseLocalInferenceConfig } from '../run/local-inference.js';
import {
  decideLocalEscalation,
  DEFAULT_ESCALATION_POLICY,
  isLocalEngine,
  type EngineIdentity,
  type EscalationInput,
  type EscalationPolicy,
  type EscalationReason,
} from './local-escalation.js';
import { routeSeat, type RouteOptions } from './router.js';
import type { SeatCapacity } from './headroom.js';
import type { BudgetPolicy, RoutingRequest, SeatDecision } from './types.js';

export interface LocalRouteDecision extends SeatDecision {
  lane: 'local' | 'frontier';
  /** 'policy-off' when localInference is not configured (or invalid). */
  laneReason: EscalationReason | 'policy-off';
}

export interface LocalRouteContext {
  /** Raw `localInference` config value; absent or invalid keeps the policy off. */
  localInference: unknown;
  /** Configured engine identities by engine id (baseUrl, tier), for promoted or custom engines. */
  engines?: Readonly<Record<string, Omit<EngineIdentity, 'engineId'>>>;
  policy?: EscalationPolicy;
}

/** Pure. A seat is local if its engine is local by id or by configured endpoint. */
export function isLocalSeat(capacity: Pick<SeatCapacity, 'engine'>, engines: LocalRouteContext['engines'] = {}): boolean {
  const engineId = String(capacity.engine);
  const configured = Object.prototype.hasOwnProperty.call(engines, engineId) ? engines[engineId] : undefined;
  return isLocalEngine({ ...configured, engineId });
}

/** Hosted provider engine ids (BudgetEngine minus 'local'). Explicit allowlist: a new id is refused authority until added. */
export const HOSTED_ENGINE_IDS: ReadonlySet<string> = new Set(['claude', 'claude-api', 'codex', 'grok', 'devin']);

/**
 * Pure. Fail-closed eligibility for merge, merge-rights and credential work:
 * true only for a hosted id from HOSTED_ENGINE_IDS, or an engine listed in
 * `engines` with an http(s) endpoint to a public host, and never for an engine
 * `isLocalEngine` calls local. A missing `engines` map counts as unknown.
 */
export function isKnownRemoteSeat(capacity: Pick<SeatCapacity, 'engine'>, engines: LocalRouteContext['engines'] = {}): boolean {
  const engineId = String(capacity.engine);
  const configured = Object.prototype.hasOwnProperty.call(engines, engineId) ? engines[engineId] : undefined;
  if (isLocalEngine({ ...configured, engineId })) return false;
  const listedPublic = typeof configured?.baseUrl === 'string' && configured.baseUrl.trim() !== '';
  return listedPublic || HOSTED_ENGINE_IDS.has(engineId.trim().toLowerCase());
}

const holdsAuthority = (i: EscalationInput): boolean =>
  Boolean(i.mergesToMain) || Boolean(i.holdsMergeRights) || Boolean(i.needsCredentials);

/**
 * Pure. Routes `req` on the lane the escalation policy picks. No fetching
 * happens here: the dispatch slice that calls a local endpoint must disable
 * redirect following and connect to 127.0.0.1 or ::1 rather than resolving
 * `localhost` (Security nits on #943).
 */
export function routeSeatWithLocalEscalation(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  budget: BudgetPolicy,
  opts: RouteOptions,
  input: EscalationInput,
  ctx: LocalRouteContext,
): LocalRouteDecision {
  const local = (c: SeatCapacity): boolean => isLocalSeat(c, ctx.engines);
  // Authority work only sees positively-remote seats; other work excludes known-local seats.
  const frontierSeats = holdsAuthority(input)
    ? capacity.filter((c) => isKnownRemoteSeat(c, ctx.engines))
    : capacity.filter((c) => !local(c));
  const frontier = (laneReason: LocalRouteDecision['laneReason']): LocalRouteDecision =>
    ({ ...routeSeat(req, frontierSeats, budget, opts), lane: 'frontier', laneReason });

  const parsed = parseLocalInferenceConfig(ctx.localInference);
  if (!parsed.ok || parsed.config === null) {
    if (holdsAuthority(input)) return frontier(decideLocalEscalation(input).reason);
    return { ...routeSeat(req, capacity, budget, opts), lane: 'frontier', laneReason: 'policy-off' };
  }
  const choice = decideLocalEscalation(
    { ...input, localAvailable: Boolean(input.localAvailable) && parsed.config.loopback },
    ctx.policy ?? DEFAULT_ESCALATION_POLICY,
  );
  if (choice.lane === 'local') {
    const d = routeSeat(req, capacity.filter(local), budget, opts);
    if (d.seatId !== null) return { ...d, lane: 'local', laneReason: choice.reason };
    return frontier('local-unavailable');
  }
  return frontier(choice.reason);
}
