/**
 * Role slots: leader, planner and reviewer are CAPABILITY SLOTS, not model
 * bindings. A role names requirements (task shape, context floor, capabilities);
 * resolution runs the shared seat router over every admitted lane and returns
 * the ranked candidates. Any engine or local model may hold any slot.
 *
 *   role -> requirements -> candidate lanes (router order) -> failover
 *
 * Preferences are HINTS: they reorder lanes the router already admitted and
 * never admit an ineligible one. A hinted lane that is exhausted, signed out or
 * over reserve simply loses to the next candidate. Capabilities are enforced
 * only where a lane declares them; unknown stays neutral (as in the router).
 *
 * Pure and browser-safe: no I/O, no clock reads (caller supplies `opts.nowMs`).
 */
import type { SeatCapacity } from './headroom.js';
import type { BudgetEngine } from './policy.js';
import { routeSeat, type RouteOptions } from './router.js';
import type { BudgetPolicy, RoutingDifficulty, RoutingTask, SeatExclusion } from './types.js';

export type RoleSlot = 'leader' | 'planner' | 'reviewer';

export const ROLE_SLOTS: readonly RoleSlot[] = ['leader', 'planner', 'reviewer'];

export type LaneCapability = 'tools' | 'reasoning' | 'long-context' | 'structured-output';

export interface RoleRequirements {
  task: RoutingTask;
  difficulty: RoutingDifficulty;
  /** Context the role needs; the router keeps ROUTER_CONTEXT_FIT_FRACTION headroom on top. */
  minContextTokens: number;
  /** Required of lanes that DECLARE capabilities; undeclared lanes are not excluded. */
  needs: readonly LaneCapability[];
}

export const ROLE_REQUIREMENTS: Readonly<Record<RoleSlot, RoleRequirements>> = Object.freeze({
  leader: { task: 'leader', difficulty: 'high', minContextTokens: 32_000, needs: ['tools', 'reasoning'] },
  planner: { task: 'plan', difficulty: 'high', minContextTokens: 24_000, needs: ['reasoning'] },
  reviewer: { task: 'review', difficulty: 'medium', minContextTokens: 16_000, needs: ['reasoning'] },
});

/** Ordered, best-first. Matches a lane by seat id, engine, or model substring (case-insensitive). */
export interface RoleHint {
  seatIds?: readonly string[];
  engines?: readonly BudgetEngine[];
  models?: readonly string[];
}

export interface RoleResolveInput {
  role: RoleSlot;
  capacities: readonly SeatCapacity[];
  policy: BudgetPolicy;
  opts: RouteOptions;
  /** Raises the role's context floor for this request. */
  contextTokens?: number;
  /** Per-role preferences; hints, never pins. */
  hints?: Partial<Record<RoleSlot, RoleHint>>;
  /** Declared lane capabilities by seat id. */
  capabilities?: Readonly<Record<string, readonly LaneCapability[]>>;
  /** Lanes to skip, e.g. the one that just exhausted (failover). */
  exclude?: readonly string[];
  /** Fleet work reserves headroom for Mason; default true. */
  autonomous?: boolean;
}

export interface RoleLane {
  seatId: string;
  engine: BudgetEngine;
  label: string;
  /** This lane matched the role's preference hint. */
  hinted: boolean;
}

export interface RoleResolution {
  role: RoleSlot;
  requirements: RoleRequirements;
  /** First candidate, or null when no lane can hold the slot right now. */
  lane: RoleLane | null;
  /** Ranked best-first; every entry is router-eligible. */
  candidates: RoleLane[];
  exclusions: SeatExclusion[];
  /** Hints exist and the chosen lane matched one; null when no hint applies. */
  hintHonored: boolean | null;
  why: string;
}

function hintRank(cap: SeatCapacity, hint: RoleHint | undefined): number {
  if (!hint) return Number.POSITIVE_INFINITY;
  const ranks: number[] = [];
  const text = `${cap.seatId} ${cap.label}`.toLowerCase();
  hint.seatIds?.forEach((id, i) => { if (id === cap.seatId) ranks.push(i); });
  hint.engines?.forEach((e, i) => { if (e === cap.engine) ranks.push(i); });
  hint.models?.forEach((m, i) => { if (m && text.includes(m.toLowerCase())) ranks.push(i); });
  return ranks.length ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
}

/** Resolve a slot to ranked candidate lanes. Pure; the same input gives the same answer. */
export function resolveRole(input: RoleResolveInput): RoleResolution {
  const requirements = ROLE_REQUIREMENTS[input.role];
  const skipped = new Set(input.exclude ?? []);
  const gaps: SeatExclusion[] = [];
  const pool: SeatCapacity[] = [];
  for (const cap of input.capacities) {
    const declared = input.capabilities?.[cap.seatId];
    const missing = declared ? requirements.needs.filter((n) => !declared.includes(n)) : [];
    if (skipped.has(cap.seatId)) {
      gaps.push({ seatId: cap.seatId, reasons: ['The lane was set aside for failover.'], nextEligibleAt: null });
    } else if (missing.length) {
      gaps.push({
        seatId: cap.seatId,
        reasons: [`The lane does not declare ${missing.join(' or ')}, which the ${input.role} slot needs.`],
        nextEligibleAt: null,
      });
    } else {
      pool.push(cap);
    }
  }

  const decision = routeSeat(
    {
      task: requirements.task,
      difficulty: requirements.difficulty,
      contextTokens: Math.max(requirements.minContextTokens, input.contextTokens ?? 0),
      autonomous: input.autonomous ?? true,
    },
    pool,
    input.policy,
    input.opts,
  );

  const hint = input.hints?.[input.role];
  const byId = new Map(pool.map((c) => [c.seatId, c]));
  const ranked = decision.candidates
    .map((id, index) => ({ cap: byId.get(id)!, index, rank: hintRank(byId.get(id)!, hint) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const candidates: RoleLane[] = ranked.map((r) => ({
    seatId: r.cap.seatId,
    engine: r.cap.engine,
    label: r.cap.label,
    hinted: Number.isFinite(r.rank),
  }));
  const lane = candidates[0] ?? null;
  const exclusions = [...decision.exclusions, ...gaps].sort((a, b) => (a.seatId < b.seatId ? -1 : a.seatId > b.seatId ? 1 : 0));
  const hasHint = !!hint && !!(hint.seatIds?.length || hint.engines?.length || hint.models?.length);

  return {
    role: input.role,
    requirements,
    lane,
    candidates,
    exclusions,
    hintHonored: hasHint && lane ? lane.hinted : null,
    why: lane
      ? `${input.role} slot -> ${lane.label} (${lane.seatId}); ${decision.summary ?? decision.why}`
        + (hasHint && !lane.hinted ? ' No preferred lane was available, so the hint yielded.' : '')
      : `No lane can hold the ${input.role} slot right now. ${decision.why}`,
  };
}

/** Failover: resolve again with the exhausted lane(s) set aside. */
export function failoverRole(input: RoleResolveInput, exhausted: string | readonly string[]): RoleResolution {
  const lanes = typeof exhausted === 'string' ? [exhausted] : exhausted;
  return resolveRole({ ...input, exclude: [...(input.exclude ?? []), ...lanes] });
}
