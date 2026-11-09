/** One routed completion: the single code path behind the loopback endpoint
 * and `phm run --model auto|<lane:model>`; `phm router pick` and the read-only
 * `phm_router_plan` MCP tool preview the same routing step.
 *
 * `auto` asks `routeSeat` to rank the configured lanes; `<lane>:<model>` pins
 * one lane but still passes the same admission (standing grant, budget mode,
 * reserves, headroom, context fit). Nothing here holds a credential: native
 * seats run through the host's account-bound role adapter, local models
 * through a loopback-only runtime. A failed call falls through to the next
 * ranked seat, up to the config's `maxAttempts`. */
import type { AshlrConfig } from '../types.js';
import type { BudgetPolicy, RoutingDifficulty, RoutingRequest, RoutingTask, SeatDecision, SeatExclusion } from '../routing/types.js';
import type { SeatCapacity } from '../routing/headroom.js';
import type { EffectivePolicy } from '../authority/types.js';
import type { VerseSeat } from '../verse/types.js';
import type { LeaderComplete, LeaderSeatCandidate } from '../vision/leader-seat.js';
import type { LocalLeaderBinding } from '../vision/local-leader-transport.js';
import type { NativeRoleEngine } from '../run/role-completion.js';
import { enginePermitted } from '../policy/local-only.js';
import { subscriptionOnlyCurrent } from '../routing/subscription-only.js';
import { seatTier } from '../routing/tiers.js';
import { isLoopbackHost } from '../local-runtime/llama/config.js';
import {
  parseRouterModelSpec,
  ROUTER_GATEWAY_ENGINES,
  type RouterGatewayConfig,
  type RouterGatewayEngine,
  type RouterModelSpec,
} from './config.js';

export const ROUTER_COMPLETION_SCHEMA = 'router.completion.v1';
export const ROUTER_PLAN_SCHEMA = 'router.plan.v1';
/** Prompt plus system text accepted per call (characters). */
export const ROUTER_MAX_PROMPT_CHARS = 400_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** The grant's engine name for each native engine (role-completion's own map). */
const GRANT_ENGINE: Record<NativeRoleEngine, string> = { claude: 'claude-cli', codex: 'codex', grok: 'grok-cli', devin: 'devin' };
/** Gateway calls are worker turns: a seat must be granted for the producer role. */
const GRANT_ROLE = 'producer';

export interface RouterGatewayCallOptions {
  timeoutMs: number;
  maxOutputTokens: number;
  contextTokens: number | null;
}

export interface RouterGatewayTransports {
  /** Ollama `/api/chat`, free text. The caller has already checked the base is loopback. */
  local(baseUrl: string, model: string, opts: RouterGatewayCallOptions): LeaderComplete;
  llama?(binding: LocalLeaderBinding, opts: RouterGatewayCallOptions, invocation: { seatId: string }): LeaderComplete;
  /** The host's account-bound native adapter for one exact seat and model. */
  native?(seatId: string, engine: NativeRoleEngine, model: string, admitted: () => boolean, opts: RouterGatewayCallOptions): LeaderComplete;
}

export interface RouterGatewayDeps {
  cfg: AshlrConfig;
  gateway: RouterGatewayConfig;
  now(): number;
  candidates(): Promise<LeaderSeatCandidate[]>;
  capacitySnapshot(): { publishedAt: string; seats: SeatCapacity[] } | null;
  budgetPolicy(): BudgetPolicy;
  standingPolicy(): EffectivePolicy | null;
  clampBudget(policy: BudgetPolicy, standing: Pick<EffectivePolicy, 'spend'>): BudgetPolicy;
  route(req: RoutingRequest, capacity: readonly SeatCapacity[], policy: BudgetPolicy, nowMs: number): SeatDecision;
  capacityFromSeat(seat: VerseSeat): SeatCapacity;
  recordDecision(req: RoutingRequest, decision: SeatDecision): void;
  /** ~/.ashlr/KILL: when on, nothing is called (routing previews still work). */
  killSwitchOn(): boolean;
  transports: RouterGatewayTransports;
}

export interface RoutedCompletionRequest {
  /** `auto`, `<lane>:<model>`, or an alias from the config's `models`. */
  model: string;
  system: string;
  prompt: string;
  task?: RoutingTask;
  difficulty?: RoutingDifficulty;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface RouterSeatStep {
  seatId: string;
  engine: RouterGatewayEngine;
  model: string;
}

export interface RouterAttempt extends RouterSeatStep {
  outcome: 'completed' | 'failed' | 'skipped';
  reason: string | null;
  ms: number | null;
}

export interface RouterDecisionView {
  why: string;
  summary: string;
  mode: SeatDecision['mode'];
  candidates: string[];
  exclusions: SeatExclusion[];
}

export type RouterFailureStatus = 'bad-request' | 'no-route' | 'failed' | 'cancelled';

export interface RouterPlan {
  schema: typeof ROUTER_PLAN_SCHEMA;
  ok: boolean;
  requested: string;
  /** What `requested` resolved to after aliases. */
  route: string;
  request: RoutingRequest;
  /** Seats in the order they would be tried, already cut to `maxAttempts`. */
  steps: RouterSeatStep[];
  /** Seats removed before ranking (lane filter, grant, adapter), with the reason. */
  ruledOut: Array<{ seatId: string; engine: string; reason: string }>;
  decision: RouterDecisionView | null;
  reason: string;
  status?: RouterFailureStatus;
}

export type RoutedCompletionResult =
  | {
    schema: typeof ROUTER_COMPLETION_SCHEMA; ok: true; text: string; requested: string; route: string;
    seatId: string; engine: RouterGatewayEngine; model: string;
    decision: RouterDecisionView | null; attempts: RouterAttempt[]; elapsedMs: number;
  }
  | {
    schema: typeof ROUTER_COMPLETION_SCHEMA; ok: false; status: RouterFailureStatus; reason: string;
    requested: string; route: string | null; decision: RouterDecisionView | null; attempts: RouterAttempt[]; elapsedMs: number;
  };

interface Resolved {
  spec: RouterModelSpec;
  route: string;
  task: RoutingTask;
  difficulty: RoutingDifficulty;
}

/** Resolve aliases and defaults. Returns a sentence on refusal. */
export function resolveRouterModel(gateway: RouterGatewayConfig, model: string,
  overrides: { task?: RoutingTask; difficulty?: RoutingDifficulty } = {}): Resolved | string {
  const alias = Object.hasOwn(gateway.models, model) ? gateway.models[model] : undefined;
  const route = alias?.route ?? model;
  const spec = parseRouterModelSpec(route);
  if (!spec) return `Model "${model.slice(0, 80)}" is not "auto", "<lane>:<model>" or a configured alias.`;
  return {
    spec,
    route,
    task: overrides.task ?? alias?.task ?? gateway.defaults.task,
    difficulty: overrides.difficulty ?? alias?.difficulty ?? gateway.defaults.difficulty,
  };
}

function runnableModels(seat: VerseSeat): string[] {
  return seat.models.filter((m) => !(m as { unavailableReason?: unknown }).unavailableReason).map((m) => m.id);
}

function isGatewayEngine(engine: string): engine is RouterGatewayEngine {
  return (ROUTER_GATEWAY_ENGINES as readonly string[]).includes(engine);
}

function laneAllowed(gateway: RouterGatewayConfig, seat: VerseSeat): boolean {
  return gateway.lanes.includes(seat.id) || gateway.lanes.includes(seat.engine);
}

function unknownCapacity(seat: VerseSeat): SeatCapacity {
  // No reading = no headroom: the router marks it ineligible for autonomy.
  return {
    seatId: seat.id, engine: seat.engine as SeatCapacity['engine'], label: seat.label, free: false, windows: [],
    signedOut: false, reachable: null, contextWindow: seat.contextWindow, observedAt: null, spentTodayUsd: null,
  };
}

function loopbackBase(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function grantAdmits(standing: EffectivePolicy | null, seatId: string, engine: NativeRoleEngine, nowMs: number): boolean {
  if (!standing) return false;
  const seat = standing.spend.seats[seatId];
  return seat !== undefined && seat.enabled && seat.roles.includes(GRANT_ROLE)
    && (standing.engines as readonly string[]).includes(GRANT_ENGINE[engine])
    && Date.parse(standing.expiresAt) > nowMs;
}

function decisionView(decision: SeatDecision): RouterDecisionView {
  return {
    why: decision.why, summary: decision.summary ?? decision.why, mode: decision.mode,
    candidates: decision.candidates, exclusions: decision.exclusions,
  };
}

interface Routed {
  plan: RouterPlan;
  /** Candidate + capacity per routable seat, keyed by seat id. */
  bySeat: Map<string, { candidate: LeaderSeatCandidate; capacity: SeatCapacity; model: string }>;
  policy: BudgetPolicy | null;
}

async function routeRequest(deps: RouterGatewayDeps, req: Omit<RoutedCompletionRequest, 'signal'>, record: boolean): Promise<Routed> {
  const nowMs = deps.now();
  const promptChars = req.system.length + req.prompt.length;
  const maxOutputTokens = req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const plan: RouterPlan = {
    schema: ROUTER_PLAN_SCHEMA, ok: false, requested: req.model, route: req.model,
    request: { task: req.task ?? deps.gateway.defaults.task, difficulty: req.difficulty ?? deps.gateway.defaults.difficulty, autonomous: true },
    steps: [], ruledOut: [], decision: null, reason: '',
  };
  const empty: Routed = { plan, bySeat: new Map(), policy: null };
  const resolved = resolveRouterModel(deps.gateway, req.model, { task: req.task, difficulty: req.difficulty });
  if (typeof resolved === 'string') return { ...empty, plan: { ...plan, reason: resolved, status: 'bad-request' } };
  plan.route = resolved.route;
  // Gateway callers are agents, so the owner's reserves always apply.
  plan.request = {
    task: resolved.task, difficulty: resolved.difficulty, autonomous: true,
    contextTokens: Math.ceil(promptChars / 4) + maxOutputTokens,
  };
  const { spec } = resolved;

  let candidates: LeaderSeatCandidate[];
  try {
    candidates = await deps.candidates();
  } catch {
    return { ...empty, plan: { ...plan, reason: 'Seat discovery failed.', status: 'no-route' } };
  }
  const standing = deps.standingPolicy();
  const capacity: SeatCapacity[] = [];
  const bySeat: Routed['bySeat'] = new Map();
  const snapshot = deps.capacitySnapshot();
  const snapshotById = new Map((snapshot?.seats ?? []).map((row) => [row.seatId, row]));
  const ruleOut = (seat: VerseSeat, reason: string): void => { plan.ruledOut.push({ seatId: seat.id, engine: seat.engine, reason }); };

  // A pin whose model no matching seat offers is a bad request, not a capacity hold.
  let pinOffered = false;
  for (const candidate of candidates) {
    const { seat } = candidate;
    const pinned = spec.kind === 'pin';
    if (pinned && seat.id !== spec.lane && seat.engine !== spec.lane) continue;
    if (pinned && seat.models.some((m) => m.id === spec.model)) pinOffered = true;
    if (!isGatewayEngine(seat.engine)) { ruleOut(seat, 'The router gateway has no completion adapter for this engine.'); continue; }
    if (!laneAllowed(deps.gateway, seat)) { ruleOut(seat, 'Not listed in the router config lanes.'); continue; }
    const models = runnableModels(seat);
    const model = pinned ? models.find((id) => id === spec.model) : models[0];
    if (!model) { ruleOut(seat, pinned ? `Model ${spec.model} is not runnable on this seat.` : 'No runnable model.'); continue; }
    let base: SeatCapacity;
    if (seat.engine === 'local') {
      const llama = candidate.localDispatch?.kind === 'llama-server';
      if (llama ? !candidate.localDispatch?.binding || !deps.transports.llama : !loopbackBase(candidate.ollamaBaseUrl)) {
        ruleOut(seat, 'Local models are loopback-only, and this runtime is not on 127.0.0.1.');
        continue;
      }
      base = deps.capacityFromSeat(seat);
    } else {
      const engine = seat.engine as NativeRoleEngine;
      if (!deps.transports.native) { ruleOut(seat, 'The account-bound native adapter is unavailable.'); continue; }
      if (!enginePermitted(GRANT_ENGINE[engine], deps.cfg).permitted) { ruleOut(seat, `Local-only mode refuses ${engine}.`); continue; }
      if (!grantAdmits(standing, seat.id, engine, nowMs)) { ruleOut(seat, 'The standing grant does not list this seat for producer work.'); continue; }
      base = snapshotById.get(seat.id) ?? unknownCapacity(seat);
      if (engine === 'codex' && !subscriptionOnlyCurrent(base, nowMs)) { ruleOut(seat, 'A current subscription-only billing boundary is unconfirmed.'); continue; }
    }
    const contextWindow = seat.models.find((m) => m.id === model)?.contextWindow ?? seat.contextWindow;
    const row: SeatCapacity = { ...base, contextWindow, tier: seatTier(seat.engine, model) };
    capacity.push(row);
    bySeat.set(seat.id, { candidate, capacity: row, model });
  }

  if (spec.kind === 'pin' && !pinOffered) {
    return { ...empty, plan: { ...plan, reason: `No seat named "${spec.lane}" runs ${spec.model}.`, status: 'bad-request' } };
  }
  let policy = deps.budgetPolicy();
  if (standing) policy = deps.clampBudget(policy, standing);
  const decision = deps.route(plan.request, capacity, policy, nowMs);
  if (record) {
    try { deps.recordDecision(plan.request, decision); } catch { /* shadow log is best-effort */ }
  }
  plan.decision = decisionView(decision);
  plan.steps = decision.candidates.slice(0, deps.gateway.maxAttempts).flatMap((id) => {
    const entry = bySeat.get(id);
    return entry ? [{ seatId: id, engine: entry.candidate.seat.engine as RouterGatewayEngine, model: entry.model }] : [];
  });
  plan.ok = plan.steps.length > 0;
  if (plan.ok) {
    plan.reason = decision.why;
  } else {
    plan.status = 'no-route';
    plan.reason = capacity.length > 0 ? decision.why
      : plan.ruledOut.at(-1)?.reason ?? 'No seat is available to the router gateway.';
  }
  return { plan, bySeat, policy };
}

/** Routing only: which seats would be tried, in order, and why. Writes no decision log and calls no model. */
export async function planRoutedCompletion(deps: RouterGatewayDeps, req: Omit<RoutedCompletionRequest, 'signal'>): Promise<RouterPlan> {
  const bad = validateRequest(req);
  if (bad) {
    return {
      schema: ROUTER_PLAN_SCHEMA, ok: false, requested: req.model, route: req.model, steps: [], ruledOut: [], decision: null,
      request: { task: deps.gateway.defaults.task, difficulty: deps.gateway.defaults.difficulty, autonomous: true },
      reason: bad, status: 'bad-request',
    };
  }
  return (await routeRequest(deps, req, false)).plan;
}

function validateRequest(req: Omit<RoutedCompletionRequest, 'signal'>): string | null {
  if (typeof req.model !== 'string' || req.model.length === 0 || req.model.length > 200) return 'A model is required: "auto", "<lane>:<model>" or an alias.';
  if (typeof req.prompt !== 'string' || req.prompt.trim().length === 0) return 'The prompt is empty.';
  if (typeof req.system !== 'string') return 'The system text must be a string.';
  if (req.prompt.length + req.system.length > ROUTER_MAX_PROMPT_CHARS) return `The prompt is longer than ${ROUTER_MAX_PROMPT_CHARS} characters.`;
  if (req.maxOutputTokens !== undefined && (!Number.isSafeInteger(req.maxOutputTokens) || req.maxOutputTokens < 1 || req.maxOutputTokens > 128_000)) {
    return 'maxOutputTokens must be a whole number from 1 to 128000.';
  }
  return null;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Adapters already keep credentials out of their errors; this only bounds length.
  return text.replace(/\s+/g, ' ').slice(0, 300) || 'The call failed.';
}

/** Route, then call the ranked seats in order until one answers. Never throws. */
export async function routedComplete(deps: RouterGatewayDeps, req: RoutedCompletionRequest): Promise<RoutedCompletionResult> {
  const started = deps.now();
  const elapsed = (): number => Math.max(0, deps.now() - started);
  const fail = (status: RouterFailureStatus, reason: string, route: string | null, decision: RouterDecisionView | null,
    attempts: RouterAttempt[]): RoutedCompletionResult =>
    ({ schema: ROUTER_COMPLETION_SCHEMA, ok: false, status, reason, requested: String(req.model ?? ''), route, decision, attempts, elapsedMs: elapsed() });
  const bad = validateRequest(req);
  if (bad) return fail('bad-request', bad, null, null, []);
  if (deps.killSwitchOn()) return fail('no-route', 'The kill switch is on (~/.ashlr/KILL); no model is called.', null, null, []);
  let routed: Routed;
  try {
    routed = await routeRequest(deps, req, true);
  } catch (error) {
    return fail('no-route', `Routing failed: ${errorText(error)}`, null, null, []);
  }
  const { plan, bySeat, policy } = routed;
  if (!plan.ok || !policy) return fail(plan.status ?? 'no-route', plan.reason, plan.route, plan.decision, []);

  const attempts: RouterAttempt[] = [];
  const opts: RouterGatewayCallOptions = {
    timeoutMs: deps.gateway.timeoutMs,
    maxOutputTokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    contextTokens: plan.request.contextTokens ?? null,
  };
  for (const step of plan.steps) {
    if (req.signal?.aborted) return fail('cancelled', 'The caller cancelled the request.', plan.route, plan.decision, attempts);
    if (deps.killSwitchOn()) return fail('no-route', 'The kill switch is on (~/.ashlr/KILL); no model is called.', plan.route, plan.decision, attempts);
    const entry = bySeat.get(step.seatId)!;
    const built = buildCompletion(deps, entry, policy, plan.request, opts);
    if (typeof built === 'string') {
      attempts.push({ ...step, outcome: 'skipped', reason: built, ms: null });
      continue;
    }
    const t0 = deps.now();
    try {
      const text = await built(req.system, req.prompt, req.signal);
      if (typeof text !== 'string' || text.trim().length === 0) throw new Error('The seat returned no text.');
      attempts.push({ ...step, outcome: 'completed', reason: null, ms: Math.max(0, deps.now() - t0) });
      return {
        schema: ROUTER_COMPLETION_SCHEMA, ok: true, text, requested: req.model, route: plan.route,
        seatId: step.seatId, engine: step.engine, model: step.model, decision: plan.decision, attempts, elapsedMs: elapsed(),
      };
    } catch (error) {
      attempts.push({ ...step, outcome: 'failed', reason: errorText(error), ms: Math.max(0, deps.now() - t0) });
    }
  }
  if (req.signal?.aborted) return fail('cancelled', 'The caller cancelled the request.', plan.route, plan.decision, attempts);
  return fail('failed', attempts.at(-1)?.reason ?? 'Every ranked seat failed.', plan.route, plan.decision, attempts);
}

function buildCompletion(deps: RouterGatewayDeps, entry: { candidate: LeaderSeatCandidate; capacity: SeatCapacity; model: string },
  policy: BudgetPolicy, request: RoutingRequest, opts: RouterGatewayCallOptions): LeaderComplete | string {
  const { candidate, capacity, model } = entry;
  const { seat } = candidate;
  if (seat.engine === 'local') {
    if (candidate.localDispatch?.kind === 'llama-server') {
      const binding = candidate.localDispatch.binding;
      if (!binding || binding.model !== model || !deps.transports.llama) return 'The local model has no current llama-server binding.';
      return deps.transports.llama(binding, opts, { seatId: seat.id });
    }
    if (!loopbackBase(candidate.ollamaBaseUrl)) return 'Local models are loopback-only.';
    return deps.transports.local(candidate.ollamaBaseUrl!, model, opts);
  }
  const engine = seat.engine as NativeRoleEngine;
  if (!deps.transports.native) return 'The account-bound native adapter is unavailable.';
  // Rechecked through the whole call: grant, budget clamp and this seat's own admission.
  const admitted = (): boolean => {
    try {
      const nowMs = deps.now();
      const standing = deps.standingPolicy();
      if (!grantAdmits(standing, seat.id, engine, nowMs)) return false;
      const live = deps.capacitySnapshot()?.seats.find((row) => row.seatId === seat.id);
      if (!live) return false;
      if (engine === 'codex' && !subscriptionOnlyCurrent(live, nowMs)) return false;
      const current = standing ? deps.clampBudget(deps.budgetPolicy(), standing) : policy;
      return deps.route(request, [{ ...live, contextWindow: capacity.contextWindow, tier: capacity.tier }], current, nowMs).seatId === seat.id;
    } catch {
      return false;
    }
  };
  return deps.transports.native(seat.id, engine, model, admitted, opts);
}

/** One row per addressable model, for `/v1/models` and `phm router models`. */
export interface RouterModelEntry {
  id: string;
  kind: 'auto' | 'alias' | 'lane';
  /** For aliases: the route it resolves to. For lanes: the seat id. */
  target: string;
  engine: string | null;
}

export async function listRouterModels(deps: Pick<RouterGatewayDeps, 'gateway' | 'candidates'>): Promise<RouterModelEntry[]> {
  const rows: RouterModelEntry[] = [{ id: 'auto', kind: 'auto', target: 'auto', engine: null }];
  for (const [name, alias] of Object.entries(deps.gateway.models)) rows.push({ id: name, kind: 'alias', target: alias.route, engine: null });
  let candidates: LeaderSeatCandidate[] = [];
  try { candidates = await deps.candidates(); } catch { /* discovery is best-effort for a listing */ }
  const seen = new Set<string>();
  for (const { seat } of candidates) {
    if (!isGatewayEngine(seat.engine) || !laneAllowed(deps.gateway, seat)) continue;
    // Local seat ids already read `local:<tag>`; native seats are `<seat>:<model>`.
    const lane = seat.engine === 'local' ? 'local' : seat.id;
    for (const model of runnableModels(seat)) {
      const id = `${lane}:${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, kind: 'lane', target: seat.id, engine: seat.engine });
    }
  }
  return rows;
}
