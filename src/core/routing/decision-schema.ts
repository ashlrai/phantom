import { z } from 'zod';
import { TASK_CLASSES } from '../decide/registry.js';
import { MODE_TIERS, type ModeTier } from '../run/model-mode-data.js';
import type { ResetCalendarPool } from './reset-pressure.js';

export const modeTierSchema = z.enum(MODE_TIERS);
export const modelModeTierSchema = modeTierSchema.exclude(['fusion']);
export const routeModelSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/);

export const routeTierSchema = z.enum(['frontier', 'work', 'mid', 'fast']);
export const routeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export const speedTierSchema = z.enum(['everyday', 'workhorse', 'premium']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const routeFailureKindSchema = z.enum(['quota', '5xx', 'timeout', 'near_reset']);
export const routeCostClassSchema = z.enum(['local', 'included', 'metered']);
export const routeDataClassSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);

export const routeRequestSchema = z.object({
  task_class: z.enum(TASK_CLASSES),
  repo: routeIdSchema,
  tier_hint: routeTierSchema,
  mode: modeTierSchema.optional(),
  job: routeIdSchema.optional(),
  needs: z.array(z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,63}$/)).max(32).optional(),
  min_tier: routeTierSchema.optional(),
  max_cost_class: routeCostClassSchema.optional(),
  data_class: routeDataClassSchema.optional(),
  fallback: z.array(z.object({ lane: routeIdSchema, on: z.array(routeFailureKindSchema).min(1).max(4) }).strict()).max(3)
    .refine(rows => new Set(rows.map(row => row.lane)).size === rows.length, 'Duplicate fallback lane').optional(),
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
  'mode-tier', 'reset-pressure', 'free-capacity', 'cheapest', 'cost-prior',
]);
export const routeDecisionSchema = z.object({
  lane: routeIdSchema.nullable(),
  model: routeModelSchema.nullable(),
  mode_tier: modelModeTierSchema.nullable().default(null),
  effort: effortSchema.nullable(),
  speed_tier: speedTierSchema.nullable(),
  /** The capped model this job left (routing/model-caps.ts). Absent when no fallback happened. */
  fallback_from: routeModelSchema.optional(),
  reason_codes: z.array(routeReasonSchema).min(1).max(16),
}).strict().refine(d => [d.lane, d.model, d.effort, d.speed_tier, d.mode_tier].every(v => v === null)
  || [d.lane, d.model, d.effort, d.speed_tier].every(v => v !== null), 'Incomplete route');

export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type RouteDecision = z.infer<typeof routeDecisionSchema>;
export type RouteReason = z.infer<typeof routeReasonSchema>;
export interface RouteCandidate {
  mode_tier: z.infer<typeof modelModeTierSchema> | null;
  capacity?: ResetCalendarPool;
  lane: string;
  model: string;
  /** Set when the configured model was capped and this one replaced it. */
  fallback_from?: string;
  effort: z.infer<typeof effortSchema>;
  speed_tier: z.infer<typeof speedTierSchema>;
  /** Ordinal policy priors, never measured dollars or milliseconds. */
  cost_rank: number;
  latency_rank: number;
}
export interface RouteReport extends RouteDecision {
  local_models_refused: import('../resources/local-memory-fit.js').MemoryFit[];
  requested_mode: ModeTier | null;
  capacity: ResetCalendarPool | null;
  schema: 'route.decision.v1';
  advisory: true;
  path: 'local-fast' | 'jev' | 'local-strong' | 'fallback';
  duration_ms: number;
  attempts: number;
  candidate_count: number;
}
