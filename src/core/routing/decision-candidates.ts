import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { effortSchema, modelModeTierSchema, routeModelSchema, type RouteCandidate, type RouteRequest } from './decision-schema.js';
import { modelModeTier } from '../run/model-catalog.js';
import { MODE_RANK } from '../run/model-mode-data.js';
import { compareSpendPriority, validResetCalendarPool } from './reset-pressure.js';
import { readRouterWeights, type RouterWeight } from '../router/tune.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slotSchema = z.object({
  target: count, hard_cap: count, effective_target: count.optional(), held: z.boolean().optional(),
});
export interface RouteSources { models: unknown; slots: unknown; admission: unknown; capacity?: unknown; request?: unknown; weights?: RouterWeight[] }
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** No credential/config discovery. Missing, nonregular and oversized snapshots fail closed. */
export async function loadRouteSources(root: string): Promise<RouteSources> {
  const read = async (path: string): Promise<unknown> => {
    try {
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) return null;
        const bytes = Buffer.alloc(1024 * 1024 + 1);
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
        return bytesRead > 1024 * 1024 ? null : JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      } finally { await fd.close(); }
    } catch { return null; }
  };
  const [models, slots, admission, capacity, request] = await Promise.all([
    read(join(root, 'models.json')), read(join(root, 'queue/slots.json')), read(join(root, 'queue/admission.json')),
    read(join(root, 'queue/route-capacity.json')),
    read(join(root, 'queue/route-request.json')),
  ]);
  const weights = await readRouterWeights();
  return { models, slots, admission, ...(weights.length ? { weights } : {}), ...(capacity === null ? {} : { capacity }), ...(request === null ? {} : { request }) };
}

/** Directive's model table is a policy prior. Unknown models have no inferred price/latency. */
export function modelPrior(model: string, tier: RouteRequest['tier_hint']): Pick<RouteCandidate, 'speed_tier' | 'cost_rank' | 'latency_rank'> {
  const mode = modelModeTier(model);
  if (mode) {
    const rank = MODE_RANK[mode] + 1;
    return { speed_tier: mode === 'ultra' ? 'premium' : mode === 'normal' ? 'workhorse' : 'everyday', cost_rank: rank, latency_rank: rank };
  }
  return { speed_tier: tier === 'frontier' ? 'premium' : tier === 'work' ? 'workhorse' : 'everyday', cost_rank: 4, latency_rank: 4 };
}

export function enumerateRouteCandidates(request: RouteRequest, sources: RouteSources): RouteCandidate[] {
  if (!request.machine_state.admit || object(sources.admission)['admit'] !== true) return [];
  const models = object(sources.models), slots = object(sources.slots);
  const result: RouteCandidate[] = [];
  for (const lane of [...new Set(request.lane_candidates)].sort()) {
    if (request.quota_state[lane] !== 'available') continue;
    const slot = slotSchema.safeParse(slots[lane]);
    const running = request.machine_state.running_by_lane[lane];
    if (!slot.success || slot.data.held || running === undefined
      || running >= Math.min(slot.data.target, slot.data.hard_cap, slot.data.effective_target ?? slot.data.target)) continue;
    // Match the launch registry precedence; local pools never inherit a cloud model.
    const family = lane.startsWith('codex-') && lane !== 'codex-local' ? 'codex' : lane;
    const tier = request.tier_hint;
    const raw = [models[`${lane}.${tier}`], models[lane], models[`${family}.${tier}`], models[family]].find(Boolean);
    const model = routeModelSchema.safeParse(raw);
    const rawEffort = models[`effort.${lane}.${tier}`] || models[`effort.${family}.${tier}`];
    const effort = effortSchema.safeParse(rawEffort ?? (tier === 'frontier' ? 'xhigh' : 'high'));
    if (!model.success || !effort.success) continue;
    const configuredMode = models[`mode.${model.data}`];
    const mode = modelModeTierSchema.safeParse(configuredMode ?? modelModeTier(model.data));
    const rawCapacity = object(sources.capacity)[lane];
    const capacity = rawCapacity === undefined ? undefined : { ...object(rawCapacity), pool: lane };
    if (capacity && !validResetCalendarPool(capacity)) continue;
    result.push({ lane, model: model.data, effort: effort.data, mode_tier: mode.success ? mode.data : null,
      ...(capacity ? { capacity } : {}), ...modelPrior(model.data, tier) });
  }
  return result;
}

export function rankRouteCandidates(request: RouteRequest, candidates: readonly RouteCandidate[], nowMs = Date.now(), weights: readonly RouterWeight[] = []): RouteCandidate[] {
  const weight = (lane: string) => request.work_class ? weights.find(w => w.work_class === request.work_class && w.lane === lane)?.weight ?? 0.5 : 0.5;
  const desired = request.tier_hint === 'frontier' ? 'premium' : request.tier_hint === 'work' ? 'workhorse' : 'everyday';
  const ranks = { everyday: 0, workhorse: 1, premium: 2 };
  const minimum = ranks[desired];
  return candidates.filter(c => {
    const pool = c.capacity;
    if (pool && (pool.remainingPercent === 0 || pool.resetAt !== null && Date.parse(pool.resetAt) <= nowMs) && !((pool.creditBalance ?? 0) > 0)) return false;
    return request.mode ? c.mode_tier !== null && (request.mode === 'fusion' || MODE_RANK[c.mode_tier] >= MODE_RANK[request.mode])
      : ranks[c.speed_tier] >= minimum;
  }).sort((a, b) => compareSpendPriority(a.capacity, b.capacity, nowMs) ||
    a.cost_rank - b.cost_rank || weight(b.lane) - weight(a.lane) || a.latency_rank - b.latency_rank || a.lane.localeCompare(b.lane));
}
