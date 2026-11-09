/**
 * Router wiring for the local inference escalation policy (stacked on #926).
 *
 * `routeSeatWithLocalEscalation` routes through the existing pure `routeSeat`
 * over a capacity list narrowed to the lane `decideLocalEscalation` picks.
 *
 * Invariants:
 *   - Default-off: with no valid `localInference` config, non-authority work
 *     routes exactly as `routeSeat` over the full capacity list.
 *   - Merge and publish work fails closed: only frontier and loopback local
 *     seats are eligible (`engineClassMayMergeOrPublish`); unclassified seats,
 *     including any unknown id with no `ctx.engines` entry, are refused.
 *   - No model seat holds secrets: credentialed steps route to no seat.
 *   - The local lane is loopback-only: a config with `allowRemote` pointing off
 *     this machine escalates to frontier.
 */
import { isAbliteratedModel, isLoopbackHost, parseLocalInferenceConfig } from '../run/local-inference.js';
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
 * Single decision point for merge and publish eligibility (ENGINEER-RULES hard
 * limit 5, Mason 02:00 ET Oct 26: all engines, local or cloud, are gated the
 * same way, by outcome). Eligibility only means the seat may be chosen; the
 * outcome gates (green required checks, cross-model review, path checks, merge
 * queue, sanctioned release workflow) are enforced elsewhere and unchanged.
 * Unknown engine ids get no privileges. There is deliberately no config knob.
 *
 * 'Publish eligible' means only that the seat may author or trigger the
 * sanctioned release workflow, which holds the publish key itself. No model
 * seat ever holds secrets or the publish key.
 */
export function engineClassMayMergeOrPublish(cls: EngineClass): boolean {
  switch (cls) {
    case 'frontier': return true;
    case 'local': return true;
    case 'unclassified': return false;
  }
}

/**
 * Secret-value access (credentials, API keys, the publish key) is denied to
 * every model seat, whatever its class. Credentialed steps run through
 * `phantom exec` outside any model context, so no seat is routed for them.
 */
export function engineClassMayHoldSecrets(_cls: EngineClass): false {
  return false;
}

/** Pure. A local seat is loopback-only: a listed endpoint must be a loopback host. */
export function isLoopbackLocalSeat(capacity: Pick<SeatCapacity, 'engine'>, engines: EngineMap = {}): boolean {
  if (classifyEngine(capacity, engines) !== 'local') return false;
  const { baseUrl } = engineIdentityOf(String(capacity.engine), engines);
  if (baseUrl === undefined || baseUrl === null) return true; // known local runtime id, no network endpoint
  try {
    const u = new URL(baseUrl.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username === '' && u.password === '' && isLoopbackHost(u.hostname);
  } catch { return false; }
}

/** Routing input: the escalation input plus publish work. */
export type LocalRouteInput = EscalationInput & { publishes?: boolean };

const mergesOrPublishes = (i: LocalRouteInput): boolean =>
  Boolean(i.mergesToMain) || Boolean(i.holdsMergeRights) || Boolean(i.publishes);

/**
 * Pure. Routes `req` on the lane the escalation policy picks. No fetching
 * happens here: the dispatch slice that calls a local endpoint must disable
 * redirect following and connect to 127.0.0.1 or ::1 rather than resolving
 * `localhost` (Security nits on #943).
 *
 * Merge and publish work is routed over every eligible seat: frontier seats,
 * plus loopback local seats when localInference is configured on loopback and
 * the local model is not abliterated. Unclassified seats are never offered.
 */
export function routeSeatWithLocalEscalation(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  budget: BudgetPolicy,
  opts: RouteOptions,
  input: LocalRouteInput,
  ctx: LocalRouteContext,
): LocalRouteDecision {
  const engines = ctx.engines;
  const local = (c: SeatCapacity): boolean => isLocalSeat(c, engines);
  const frontierSeats = capacity.filter((c) => !local(c));
  const frontier = (laneReason: LocalRouteDecision['laneReason']): LocalRouteDecision =>
    ({ ...routeSeat(req, frontierSeats, budget, opts), lane: 'frontier', laneReason });
  const parsed = parseLocalInferenceConfig(ctx.localInference);
  const config = parsed.ok ? parsed.config : null;

  if (input.needsCredentials) {
    // No model seat may hold secrets: route nowhere.
    const none = routeSeat(req, capacity.filter((c) => engineClassMayHoldSecrets(classifyEngine(c, engines))), budget, opts);
    return { ...none, lane: 'frontier', laneReason: 'credentials-frontier-only' };
  }
  if (mergesOrPublishes(input)) {
    const localOk = config !== null && config.loopback && !(input.localModel && isAbliteratedModel(input.localModel));
    const eligible = capacity.filter((c) => {
      const cls = classifyEngine(c, engines);
      if (!engineClassMayMergeOrPublish(cls)) return false;
      return cls !== 'local' || (localOk && isLoopbackLocalSeat(c, engines));
    });
    const d = routeSeat(req, eligible, budget, opts);
    const chosen = capacity.find((c) => c.seatId === d.seatId);
    const lane = chosen && local(chosen) ? 'local' : 'frontier';
    const laneReason = input.mergesToMain ? 'merge-to-main-frontier-only' : input.holdsMergeRights ? 'merge-rights-frontier-only' : 'local-ok';
    return { ...d, lane, laneReason: lane === 'local' ? 'local-ok' : laneReason };
  }

  if (config === null) {
    return { ...routeSeat(req, capacity, budget, opts), lane: 'frontier', laneReason: 'policy-off' };
  }
  const choice = decideLocalEscalation(
    { ...input, localAvailable: Boolean(input.localAvailable) && config.loopback },
    ctx.policy ?? DEFAULT_ESCALATION_POLICY,
  );
  if (choice.lane === 'local') {
    const d = routeSeat(req, capacity.filter((c) => isLoopbackLocalSeat(c, engines)), budget, opts);
    if (d.seatId !== null) return { ...d, lane: 'local', laneReason: choice.reason };
    return frontier('local-unavailable');
  }
  return frontier(choice.reason);
}
