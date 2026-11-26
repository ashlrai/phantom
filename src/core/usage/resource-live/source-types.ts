/**
 * Source contract for the live resource reader. Types and one sentinel only,
 * so the engine and its tests do not load any provider reader.
 */
import type { AntigravityExecutionContext, AntigravityUsageGroup, BuiltInResourceLiveId, ResourceLiveId, ResourceLiveReason, ResourceLiveTier, ResourceLiveUnit } from './types.js';

export interface ResourceLiveObservation {
  groups?: AntigravityUsageGroup[];
  execution_context?: AntigravityExecutionContext;
  account_id?: string;
  model?: string;
  window_start?: string;
  used: number | null;
  limit: number | null;
  unit: ResourceLiveUnit;
  reset_at: string | null;
  expires_at?: string;
  source: string;
  observed_at: string;
  stale_after?: string;
  /** Overrides the source's tier, for a store that mixes operator entries with readings. */
  tier?: ResourceLiveTier;
}

export const NEEDS_SIGNIN = { needs_signin: true } as const;
export type ResourceLiveSourceResult = ResourceLiveObservation | typeof NEEDS_SIGNIN |
  { reason: ResourceLiveReason; execution_context?: AntigravityExecutionContext } | null;

export interface ResourceLiveSource {
  tier: ResourceLiveTier;
  deadlineMs?: number;
  read(nowMs: number): Promise<ResourceLiveSourceResult> | ResourceLiveSourceResult;
}

export type ResourceLiveSources = Record<BuiltInResourceLiveId, readonly ResourceLiveSource[]>
  & Partial<Record<ResourceLiveId, readonly ResourceLiveSource[]>>;
