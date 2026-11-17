import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { effortSchema, modelModeTierSchema, routeModelSchema, type RouteCandidate, type RouteRequest } from './decision-schema.js';
import { modelModeTier } from '../run/model-catalog.js';
import { MODE_RANK } from '../run/model-mode-data.js';
import { compareSpendPriority, validResetCalendarPool } from './reset-pressure.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const slotSchema = z.object({
  target: count, hard_cap: count, effective_target: count.optional(), held: z.boolean().optional(),
});
const requirementsEvidence = z.object({
  capabilities: z.array(z.string()).optional(), cost_class: z.enum(['local', 'included', 'metered']).optional(),
  data_class: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  work_classes: z.array(z.enum(['bulk', 'standard', 'judgment'])).optional(),
  tiers: z.array(z.enum(['frontier', 'work', 'mid', 'fast'])).optional(), observed_at: z.string().datetime().optional(),
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
      ...(requirementsEvidence.safeParse(slots[lane]).success ? requirementsEvidence.parse(slots[lane]) : {}),
      ...(capacity ? { capacity } : {}), ...modelPrior(model.data, tier) });
  }
  return result;
}

export function rankRouteCandidates(request: RouteRequest, candidates: readonly RouteCandidate[], nowMs = Date.now()): RouteCandidate[] {
  const desired = request.tier_hint === 'frontier' ? 'premium' : request.tier_hint === 'work' ? 'workhorse' : 'everyday';
  const ranks = { everyday: 0, workhorse: 1, premium: 2 };
  const minimum = ranks[desired];
  return candidates.filter(c => {
    if (routeCandidateRejections(request, c, nowMs).length) return false;
    const pool = c.capacity;
    if (pool && (pool.remainingPercent === 0 || pool.resetAt !== null && Date.parse(pool.resetAt) <= nowMs) && !((pool.creditBalance ?? 0) > 0)) return false;
    return request.mode ? c.mode_tier !== null && (request.mode === 'fusion' || MODE_RANK[c.mode_tier] >= MODE_RANK[request.mode])
      : ranks[c.speed_tier] >= minimum;
  }).sort((a, b) => compareSpendPriority(a.capacity, b.capacity, nowMs) ||
    a.cost_rank - b.cost_rank || a.latency_rank - b.latency_rank || a.lane.localeCompare(b.lane));
}

/** Generic requirements opt into evidence-only admission; legacy requests are unchanged. */
export function routeCandidateRejections(request: RouteRequest, candidate: RouteCandidate, nowMs: number): string[] {
  if (request.needs === undefined && request.max_cost_class === undefined && request.data_class === undefined && request.work_class === undefined) return [];
  const reasons: string[] = [];
  if (request.needs?.length && !candidate.capabilities) reasons.push('unknown capability');
  else if (request.needs?.some(need => !candidate.capabilities?.includes(need))) reasons.push('missing capability');
  const costs = ['local', 'included', 'metered'], data = ['public', 'internal', 'confidential', 'restricted'];
  if (request.max_cost_class !== undefined) {
    if (!candidate.cost_class) reasons.push('unknown cost class');
    else if (costs.indexOf(candidate.cost_class) > costs.indexOf(request.max_cost_class)) reasons.push('cost class exceeded');
  }
  if (request.data_class !== undefined) {
    if (!candidate.data_class) reasons.push('unknown data class');
    else if (data.indexOf(candidate.data_class) < data.indexOf(request.data_class)) reasons.push('data class exceeded');
  }
  if (request.work_class !== undefined && !candidate.work_classes?.includes(request.work_class)) reasons.push(candidate.work_classes ? 'work class unsupported' : 'unknown work class');
  if (!candidate.tiers) reasons.push('unknown tier capability');
  else if (!candidate.tiers.includes(request.tier_hint)) reasons.push('tier unavailable');
  const observed = Date.parse(candidate.observed_at ?? '');
  if (!Number.isFinite(observed) || observed > nowMs || nowMs - observed > 15 * 60_000) reasons.push('capacity stale or unknown');
  const pool = candidate.capacity;
  if (!pool || pool.remainingPercent === null || pool.resetAt === null) reasons.push('capacity window unknown');
  else {
    if (pool.remainingPercent <= 0) reasons.push('quota exhausted');
    if (Date.parse(pool.resetAt) <= nowMs) reasons.push('capacity window expired');
  }
  return reasons;
}
