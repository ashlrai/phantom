import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { effortSchema, modelModeTierSchema, routeModelSchema, routeTierSchema, routeCostClassSchema, routeDataClassSchema, type RouteCandidate, type RouteRequest } from './decision-schema.js';
import { modelModeTier } from '../run/model-catalog.js';
import { MODE_RANK } from '../run/model-mode-data.js';
import { compareSpendPriority, validResetCalendarPool } from './reset-pressure.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const baseSlotSchema = z.object({
  target: count, hard_cap: count, effective_target: count.optional(), held: z.boolean().optional(),
});
const slotSchema = baseSlotSchema.extend({
  capabilities: z.array(z.string()).optional(), tiers: z.array(routeTierSchema).optional(),
  cost_class: routeCostClassSchema.optional(), data_class: routeDataClassSchema.optional(),
});
export interface RouteSources { models: unknown; slots: unknown; admission: unknown; capacity?: unknown; request?: unknown }
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
  return { models, slots, admission, ...(capacity === null ? {} : { capacity }), ...(request === null ? {} : { request }) };
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
    const slot = baseSlotSchema.safeParse(slots[lane]);
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

export function rankRouteCandidates(request: RouteRequest, candidates: readonly RouteCandidate[], nowMs = Date.now()): RouteCandidate[] {
  const desired = request.tier_hint === 'frontier' ? 'premium' : request.tier_hint === 'work' ? 'workhorse' : 'everyday';
  const ranks = { everyday: 0, workhorse: 1, premium: 2 };
  const minimum = ranks[desired];
  return candidates.filter(c => {
    const pool = c.capacity;
    if (pool && (pool.remainingPercent === 0 || pool.resetAt !== null && Date.parse(pool.resetAt) <= nowMs) && !((pool.creditBalance ?? 0) > 0)) return false;
    return request.mode ? c.mode_tier !== null && (request.mode === 'fusion' || MODE_RANK[c.mode_tier] >= MODE_RANK[request.mode])
      : ranks[c.speed_tier] >= minimum;
  }).sort((a, b) => compareSpendPriority(a.capacity, b.capacity, nowMs) ||
    a.cost_rank - b.cost_rank || a.latency_rank - b.latency_rank || a.lane.localeCompare(b.lane));
}

/** Failover uses a fresh snapshot and fails closed on unmeasured lane policy. */
export function routeCandidateRejections(request: RouteRequest, sources: RouteSources, nowMs: number,
  options: { failover?: boolean; pinned?: readonly string[] } = {}) {
  const strict = options.failover ?? false;
  const tiers = { fast: 0, mid: 1, work: 2, frontier: 3 };
  const costs = { local: 0, included: 1, metered: 2 };
  const classes = { public: 0, internal: 1, confidential: 2, restricted: 3 };
  return [...new Set(request.lane_candidates)].sort().map(lane => {
    const reasons: string[] = [];
    if (!request.machine_state.admit || object(sources.admission).admit !== true) reasons.push('admission_blocked');
    if (request.quota_state[lane] !== 'available') reasons.push('quota_unavailable');
    const slot = slotSchema.safeParse(object(sources.slots)[lane]);
    const running = request.machine_state.running_by_lane[lane];
    if (!slot.success) reasons.push('slot_invalid');
    if (running === undefined) reasons.push('running_unknown');
    if (slot.success) {
      const s = slot.data;
      if (s.held) reasons.push('held');
      if (running !== undefined && running >= Math.min(s.target, s.hard_cap, s.effective_target ?? s.target)) reasons.push('saturated');
      if (request.needs?.some(need => !s.capabilities?.includes(need))) reasons.push('missing_capability');
      if (s.tiers ? !s.tiers.includes(request.tier_hint) : false) reasons.push('tier_unavailable');
      if (!s.tiers && strict) reasons.push('tier_unknown');
      if (!s.cost_class && strict) reasons.push('cost_class_unknown');
      if (s.cost_class && costs[s.cost_class] > costs[request.max_cost_class ?? (strict ? 'included' : 'metered')]) reasons.push('cost_class_exceeded');
      if (classes[request.data_class ?? 'public'] > classes[s.data_class ?? 'public']) reasons.push('data_class_exceeded');
    }
    if (request.min_tier && tiers[request.tier_hint] < tiers[request.min_tier]) reasons.push('tier_below_minimum');
    const models = object(sources.models), tier = request.tier_hint;
    const family = lane.startsWith('codex-') && lane !== 'codex-local' ? 'codex' : lane;
    const model = routeModelSchema.safeParse([models[`${lane}.${tier}`], models[lane], models[`${family}.${tier}`], models[family]].find(Boolean));
    const effort = effortSchema.safeParse(models[`effort.${lane}.${tier}`] || models[`effort.${family}.${tier}`] || (tier === 'frontier' ? 'xhigh' : 'high'));
    if (!model.success || !effort.success) reasons.push('model_invalid');
    if (model.success) {
      const mode = modelModeTierSchema.safeParse(models[`mode.${model.data}`] ?? modelModeTier(model.data));
      const speed = { everyday: 0, workhorse: 1, premium: 2 };
      if (request.mode ? !mode.success || request.mode !== 'fusion' && MODE_RANK[mode.data] < MODE_RANK[request.mode]
        : speed[modelPrior(model.data, tier).speed_tier] < speed[tier === 'frontier' ? 'premium' : tier === 'work' ? 'workhorse' : 'everyday']) reasons.push('tier_inadequate');
    }
    const raw = object(sources.capacity)[lane], cap = { ...object(raw), pool: lane };
    if (raw !== undefined && !validResetCalendarPool(cap)) reasons.push('capacity_invalid');
    if (validResetCalendarPool(cap)) {
      const credits = (cap.creditBalance ?? 0) > 0;
      if (cap.remainingPercent === 0 && !credits || cap.resetAt !== null && Date.parse(cap.resetAt) <= nowMs) reasons.push('capacity_exhausted');
      if (strict && cap.remainingPercent === null && !credits) reasons.push('capacity_unknown');
    } else if (strict && raw === undefined) reasons.push('capacity_unknown');
    if (strict) {
      const observed = object(raw).observedAt;
      const at = typeof observed === 'string' && z.string().datetime({ offset: true }).safeParse(observed).success ? Date.parse(observed) : NaN;
      if (!Number.isFinite(at)) reasons.push('capacity_unknown');
      else if (nowMs - at > 900_000 || at - nowMs > 5_000) reasons.push('capacity_stale');
      if (['codex-local', 'omlx'].includes(lane) && !options.pinned?.includes(lane)) reasons.push('local_opt_in_required');
    }
    return { lane, reason_codes: [...new Set(reasons)] };
  });
}
