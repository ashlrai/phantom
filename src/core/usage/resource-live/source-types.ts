/**
 * Source contract for the live resource reader. Types and one sentinel only,
 * so the engine and its tests do not load any provider reader.
 */
import type { ResourceLiveId, ResourceLiveTier, ResourceLiveUnit } from './types.js';

export interface ResourceLiveObservation {
  account_id?: string;
  model?: string;
  window_start?: string;
  used: number | null;
  limit: number | null;
  unit: ResourceLiveUnit;
  reset_at: string | null;
  source: string;
  observed_at: string;
  stale_after?: string;
  /** Overrides the source's tier, for a store that mixes operator entries with readings. */
  tier?: ResourceLiveTier;
}

export const NEEDS_SIGNIN = { needs_signin: true } as const;
export type ResourceLiveSourceResult = ResourceLiveObservation | typeof NEEDS_SIGNIN | null;

export interface ResourceLiveSource {
  tier: ResourceLiveTier;
  read(nowMs: number): Promise<ResourceLiveSourceResult> | ResourceLiveSourceResult;
}

export type ResourceLiveSources = Record<ResourceLiveId, readonly ResourceLiveSource[]>;
