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

/**
 * Engine classification, three explicit tiers:
 *   - 'frontier': a known hosted id (HOSTED_ENGINE_IDS) or an engine listed in
 *     `engines` whose endpoint is http(s) to a public host;
 *   - 'local': a known local id or family, or a listed non-public endpoint;
 *   - 'unclassified': anything else, including any id when `engines` is missing.
 * Unclassified is unprivileged: never merge, merge-rights, credential or publish work.
 *
 * Secrets: routing inputs carry only engine ids, endpoints, tiers and limits.
 * `engineIdentityOf` projects each configured entry to { engineId, baseUrl, tier },
 * so no key, token or other credential value enters any seat's routing context,
 * and an endpoint carrying userinfo (user:pass@) is unclassified.
 */
export type EngineClass = 'frontier' | 'local' | 'unclassified';

/** Hosted provider engine ids (BudgetEngine minus 'local'). Explicit allowlist: a new id is unclassified until added. */
export const HOSTED_ENGINE_IDS: ReadonlySet<string> = new Set(['claude', 'claude-api', 'codex', 'grok', 'devin']);

type EngineMap = LocalRouteContext['engines'];

/** Pure. The only fields of a configured engine routing ever reads. */
export function engineIdentityOf(engineId: string, engines: EngineMap = {}): EngineIdentity {
  const c = Object.prototype.hasOwnProperty.call(engines, engineId) ? engines[engineId] : undefined;
  const baseUrl = typeof c?.baseUrl === 'string' ? c.baseUrl : undefined;
  const tier = typeof c?.tier === 'string' ? c.tier : undefined;
  return { engineId, ...(baseUrl !== undefined ? { baseUrl } : {}), ...(tier !== undefined ? { tier } : {}) };
}

const hasUserinfo = (raw: string): boolean => {
  try { const u = new URL(raw.trim()); return u.username !== '' || u.password !== ''; } catch { return false; }
};

/** Pure. Classifies a seat's engine; unknown or unlisted fails to 'unclassified'. */
export function classifyEngine(capacity: Pick<SeatCapacity, 'engine'>, engines: EngineMap = {}): EngineClass {
  const id = engineIdentityOf(String(capacity.engine), engines);
  if (isLocalEngine(id)) return 'local';
  if (typeof id.baseUrl === 'string' && id.baseUrl.trim() !== '') return hasUserinfo(id.baseUrl) ? 'unclassified' : 'frontier';
  return HOSTED_ENGINE_IDS.has(id.engineId.trim().toLowerCase()) ? 'frontier' : 'unclassified';
}

/** Pure. A seat is local if its engine is local by id or by configured endpoint. */
export function isLocalSeat(capacity: Pick<SeatCapacity, 'engine'>, engines: EngineMap = {}): boolean {
  return classifyEngine(capacity, engines) === 'local';
}

/**
 * Single decision point for authority eligibility (merge, merge-rights,
 * credential, publish). Local is refused pending an explicit policy change;
 * there is deliberately no config knob. Unclassified is always refused.
 */
export function engineClassMayHoldAuthority(cls: EngineClass): boolean {
  switch (cls) {
    case 'frontier': return true;
    case 'local': return false;
    case 'unclassified': return false;
  }
}

/** Pure. Fail-closed authority eligibility for a seat. */
export function isKnownRemoteSeat(capacity: Pick<SeatCapacity, 'engine'>, engines: EngineMap = {}): boolean {
  return engineClassMayHoldAuthority(classifyEngine(capacity, engines));
}

/** Routing input: the escalation input plus publish work (publish needs credentials). */
export type LocalRouteInput = EscalationInput & { publishes?: boolean };

const holdsAuthority = (i: LocalRouteInput): boolean =>
  Boolean(i.mergesToMain) || Boolean(i.holdsMergeRights) || Boolean(i.needsCredentials) || Boolean(i.publishes);

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
  input: LocalRouteInput,
  ctx: LocalRouteContext,
): LocalRouteDecision {
  const local = (c: SeatCapacity): boolean => isLocalSeat(c, ctx.engines);
  const policyInput: EscalationInput = { ...input, needsCredentials: Boolean(input.needsCredentials) || Boolean(input.publishes) };
  // Authority work only sees positively-remote seats; other work excludes known-local seats.
  const frontierSeats = holdsAuthority(input)
    ? capacity.filter((c) => isKnownRemoteSeat(c, ctx.engines))
    : capacity.filter((c) => !local(c));
  const frontier = (laneReason: LocalRouteDecision['laneReason']): LocalRouteDecision =>
    ({ ...routeSeat(req, frontierSeats, budget, opts), lane: 'frontier', laneReason });

  const parsed = parseLocalInferenceConfig(ctx.localInference);
  if (!parsed.ok || parsed.config === null) {
    if (holdsAuthority(input)) return frontier(decideLocalEscalation(policyInput).reason);
    return { ...routeSeat(req, capacity, budget, opts), lane: 'frontier', laneReason: 'policy-off' };
  }
  const choice = decideLocalEscalation(
    { ...policyInput, localAvailable: Boolean(input.localAvailable) && parsed.config.loopback },
    ctx.policy ?? DEFAULT_ESCALATION_POLICY,
  );
  if (choice.lane === 'local') {
    const d = routeSeat(req, capacity.filter(local), budget, opts);
    if (d.seatId !== null) return { ...d, lane: 'local', laneReason: choice.reason };
    return frontier('local-unavailable');
  }
  return frontier(choice.reason);
}
