/**
 * Configured standing-grant bounds.
 *
 * The compiled ceilings stay the hard maximum. These two policy values are
 * config so the owner can decide them without a new constant in the drafter:
 * the grant lifetime and the local-enforcement risk bound. Absent config
 * keeps today's ceiling. A value above the ceiling is ignored.
 */
import { MERGE_RISK_RANK, type MergeRisk } from '../fleet/fleet-types.js';
import type { AshlrConfig } from '../types.js';
import { STANDING_GRANT_CEILINGS } from './types.js';

export interface AuthorityBoundsConfig {
  authority?: {
    grantLifetimeMs?: number;
    localEnforcementMaxRisk?: string;
    deployWindowOpen?: boolean;
  };
}

/** Draft lifetime. Absent, invalid, or above the compiled ceiling stays at the ceiling. */
export function configuredGrantLifetimeMs(config: AuthorityBoundsConfig | AshlrConfig | null | undefined): number {
  const ceiling = STANDING_GRANT_CEILINGS.maxTtlMs;
  const raw = config?.authority?.grantLifetimeMs;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= ceiling) return raw;
  return ceiling;
}

/** Local-enforcement risk bound. Absent or above the compiled ceiling stays at the ceiling. */
export function configuredLocalEnforcementMaxRisk(config: AuthorityBoundsConfig | AshlrConfig | null | undefined): MergeRisk {
  const ceiling = STANDING_GRANT_CEILINGS.localEnforcement.maxRisk;
  const raw = config?.authority?.localEnforcementMaxRisk;
  if (raw === 'low' || raw === 'medium') {
    return MERGE_RISK_RANK[raw] <= MERGE_RISK_RANK[ceiling] ? raw : ceiling;
  }
  return ceiling;
}

/** The owner opens this when a different authority digest may install. Absent is closed. */
export function configuredDeployWindowOpen(config: AuthorityBoundsConfig | AshlrConfig | null | undefined): boolean {
  return config?.authority?.deployWindowOpen === true;
}
