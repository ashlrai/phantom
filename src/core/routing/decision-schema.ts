import { z } from 'zod';
import { TASK_CLASSES } from '../decide/registry.js';

export const routeTierSchema = z.enum(['frontier', 'work', 'mid', 'fast']);
export const routeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const speedTierSchema = z.enum(['everyday', 'workhorse', 'premium']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const routeRequestSchema = z.object({
  task_class: z.enum(TASK_CLASSES),
  repo: routeIdSchema,
  tier_hint: routeTierSchema,
  lane_candidates: z.array(routeIdSchema).max(64),
  quota_state: z.record(routeIdSchema, z.enum(['available', 'exhausted', 'unknown'])),
  machine_state: z.object({
    admit: z.boolean(),
    running_by_lane: z.record(routeIdSchema, count),
    load1: z.number().nonnegative().nullable().optional(),
    procs: count.optional(),
    worktrees: count.optional(),
    tick_age_s: z.number().nonnegative().nullable().optional(),
  }).strict(),
}).strict();

export const routeReasonSchema = z.enum([
  'local-fast', 'jev', 'local-strong', 'schema-invalid', 'schema-retry',
  'backend-unavailable', 'deadline', 'deterministic-fallback',
  'admission-blocked', 'no-candidates', 'single-candidate', 'adequate-tier',
]);
export const routeDecisionSchema = z.object({
  lane: routeIdSchema.nullable(),
  model: routeIdSchema.nullable(),
  effort: effortSchema.nullable(),
  speed_tier: speedTierSchema.nullable(),
  reason_codes: z.array(routeReasonSchema).min(1).max(16),
}).strict().refine(d => [d.lane, d.model, d.effort, d.speed_tier].every(v => v === null)
  || [d.lane, d.model, d.effort, d.speed_tier].every(v => v !== null), 'Incomplete route');

export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type RouteReason = z.infer<typeof routeReasonSchema>;
export interface RouteCandidate {
  lane: string;
  model: string;
  effort: z.infer<typeof effortSchema>;
  speed_tier: z.infer<typeof speedTierSchema>;
  /** Ordinal policy priors, never measured dollars or milliseconds. */
  cost_rank: number;
  latency_rank: number;
}
export interface RouteReport extends RouteDecision {
  schema: 'route.decision.v1';
  advisory: true;
  path: 'local-fast' | 'jev' | 'local-strong' | 'fallback';
  duration_ms: number;
  attempts: number;
  candidate_count: number;
}
