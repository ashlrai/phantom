/**
 * model.ts — the contextual Thompson-sampling lane bandit.
 *
 * The model is a set of Beta posteriors, one per (context cell × lane), over
 * the UNIT reward the reward function produces (see rewards.ts). Thompson
 * selection draws one sample per eligible lane from the deepest context level
 * with enough evidence and routes to the argmax; the draw is exactly the
 * exploration the spec asks for — an uncertain lane wins in proportion to
 * its posterior probability of being best, never more often.
 *
 * Why Beta posteriors over a normalized composite reward instead of a linear
 * model: the queue's context is four bounded categoricals (size bucket, repo,
 * tier, pool), so an exact context is a cell, and the reward "merged≤24h∧green
 * CI − normalized cost − normalized CI wall" lands in [0,1] once clipped.
 * Fractional updates (α += r, β += 1−r) make the posterior mean track the
 * expected composite reward while keeping every cell interpretable and the
 * whole model serializable to plain JSON.
 *
 * PURE: selection reads state and the injected uniform source; update returns
 * a NEW state (callers persist via select.ts's store seam). No clock, no I/O.
 */
import { beta, type UniformSource } from './rng.js';
import { contextCellKeys } from './context.js';
import type {
  ArmPosterior,
  BanditConfig,
  BanditLane,
  BanditState,
  CreditPlan,
  LaneContext,
} from './types.js';

export interface LaneSample {
  readonly laneId: string;
  /** Index into contextCellKeys' L0..L3 order; -1 = uninformed prior draw. */
  readonly level: number;
  readonly theta: number;
  readonly posterior: ArmPosterior;
}

export interface LaneSelection {
  readonly lane: BanditLane;
  readonly sample: LaneSample;
  /** Every eligible lane's draw, for shadow logging and replay output. */
  readonly samples: readonly LaneSample[];
}

/** The posterior a lane has earned at one cell; absent ⇒ the prior. */
function posteriorAt(state: BanditState, cellKey: string, laneId: string): ArmPosterior | null {
  const cell = state.cells[cellKey];
  const posterior = cell?.[laneId];
  return posterior && Number.isFinite(posterior.a) && Number.isFinite(posterior.b)
    ? { a: posterior.a, b: posterior.b, n: Number.isFinite(posterior.n) ? posterior.n : 0 }
    : null;
}

/**
 * Lanes whose pool's remaining credits satisfy the floor. Unknown headroom
 * (pool absent from `remaining`, or a non-finite reading) is NEVER eligible —
 * the floor is the guard that keeps the bandit from routing past the plan.
 * When no credit plan is supplied at all the caller has no plan to exceed,
 * so every lane is eligible.
 */
export function floorEligibleLanes(
  lanes: readonly BanditLane[],
  credits: CreditPlan | undefined,
  floor: number,
): BanditLane[] {
  if (credits === undefined) return [...lanes];
  const threshold = credits.floor !== undefined && Number.isFinite(credits.floor) ? credits.floor : floor;
  return lanes.filter((lane) => {
    const remaining = credits.remaining[lane.pool];
    return typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= threshold;
  });
}

/**
 * Draw one Thompson sample per lane: the deepest cell level whose posterior
 * for that lane has `minCellSamples` observations wins; with no level that
 * deep the draw comes from the configured prior (level -1).
 */
export function sampleLanes(
  state: BanditState,
  context: LaneContext,
  lanes: readonly BanditLane[],
  config: BanditConfig,
  uniform: UniformSource,
): LaneSelection | null {
  if (lanes.length === 0) return null;
  const keys = contextCellKeys(context);
  const samples = lanes.map((lane): LaneSample => {
    for (let level = 0; level < keys.length; level++) {
      const posterior = posteriorAt(state, keys[level]!, lane.id);
      if (posterior && posterior.n >= config.minCellSamples) {
        return { laneId: lane.id, level, theta: beta(posterior.a, posterior.b, uniform), posterior };
      }
    }
    const prior = { a: config.priorAlpha, b: config.priorBeta, n: 0 };
    return { laneId: lane.id, level: -1, theta: beta(prior.a, prior.b, uniform), posterior: prior };
  });
  // Argmax with first-draw wins on exact ties (deterministic under a seeded
  // stream; ties on continuous draws are a measure-zero event anyway).
  let best = samples[0]!;
  for (const sample of samples) if (sample.theta > best.theta) best = sample;
  const lane = lanes.find((candidate) => candidate.id === best.laneId)!;
  return { lane, sample: best, samples };
}

/**
 * Fold one observed unit reward into every level's cell for the lane that
 * earned it. `reward` must already be in [0,1] (rewards.ts clips) — a
 * fractional update puts `r` mass on α and `1−r` on β.
 */
export function updateBanditState(
  state: BanditState,
  context: LaneContext,
  laneId: string,
  reward: number,
): BanditState {
  if (!Number.isFinite(reward)) return state;
  const clipped = Math.min(1, Math.max(0, reward));
  const cells: Record<string, Record<string, ArmPosterior>> = { ...state.cells } as Record<string, Record<string, ArmPosterior>>;
  for (const key of contextCellKeys(context)) {
    const cell = { ...(cells[key] ?? {}) };
    const previous = cell[laneId] ?? { a: 0, b: 0, n: 0 };
    cell[laneId] = { a: previous.a + clipped, b: previous.b + (1 - clipped), n: previous.n + 1 };
    cells[key] = cell;
  }
  return { v: 1, cells };
}

/** Fresh state. */
export function emptyBanditState(): BanditState {
  return { v: 1, cells: {} };
}

/**
 * Validate persisted state. Corrupt or foreign shapes fail CLOSED to a fresh
 * prior rather than propagating poisoned posteriors into routing decisions.
 */
export function banditStateFrom(value: unknown): BanditState {
  if (typeof value !== 'object' || value === null || (value as { v?: unknown }).v !== 1) return emptyBanditState();
  const cells = (value as { cells?: unknown }).cells;
  if (typeof cells !== 'object' || cells === null || Array.isArray(cells)) return emptyBanditState();
  const out: Record<string, Record<string, ArmPosterior>> = {};
  for (const [key, cell] of Object.entries(cells as Record<string, unknown>)) {
    if (typeof cell !== 'object' || cell === null || Array.isArray(cell)) continue;
    const laneCell: Record<string, ArmPosterior> = {};
    for (const [laneId, posterior] of Object.entries(cell as Record<string, unknown>)) {
      const p = posterior as ArmPosterior;
      if (typeof p !== 'object' || p === null) continue;
      if (!Number.isFinite(p.a) || !Number.isFinite(p.b) || !Number.isFinite(p.n)) continue;
      if (p.a < 0 || p.b < 0 || p.n < 0) continue;
      laneCell[laneId] = { a: p.a, b: p.b, n: p.n };
    }
    if (Object.keys(laneCell).length > 0) out[key] = laneCell;
  }
  return { v: 1, cells: out };
}
