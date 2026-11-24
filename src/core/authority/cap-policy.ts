/**
 * Product limits for standing grants and seat budgets.
 *
 * Compiled signing ceilings in types.ts stay the hard max the custody helper
 * will sign. KILL, signing, secrets, no new spend, and the disk guard are not
 * settings here. The grant lifetime and the local-enforcement risk bound
 * default to current behavior until that decision changes; a value above the
 * compiled ceiling is clamped back down.
 *
 * A seat reserve of 0 uses included allowance only. It never authorizes
 * metered spend or on-demand overage.
 */
import { MERGE_RISK_RANK, type MergeRisk } from '../fleet/fleet-types.js';
import { STANDING_GRANT_CEILINGS } from './types.js';

export const CAP_POLICY = Object.freeze({
  /** Weekly share kept back for the operator. 0 keeps nothing back. */
  reserveFloorPercent: 0,
  /**
   * Short-window stop. 100 uses the included session window fully.
   * The grant parser refuses 0, so "no early stop" is 100, not 0.
   */
  maxSessionWindowPercent: 100,
  /** Pending decision. Drafts last this long, never past the compiled ceiling. */
  grantLifetimeMs: STANDING_GRANT_CEILINGS.maxTtlMs,
  /** Pending decision. Local enforcement stays at this risk. */
  localEnforcementMaxRisk: STANDING_GRANT_CEILINGS.localEnforcement.maxRisk,
  /** Configured local-authored size bound. The compiled ceiling matches it. */
  localAuthoredMaxFiles: STANDING_GRANT_CEILINGS.localAuthored.maxFiles,
  localAuthoredMaxLines: STANDING_GRANT_CEILINGS.localAuthored.maxLines,
  /** New drafts start here. Reserve changes cannot raise it. */
  meteredUsdPerDay: 0,
});

/** Lifetime a draft may use: the configured value, never above the signed ceiling. */
export function configuredGrantLifetimeMs(): number {
  const configured = CAP_POLICY.grantLifetimeMs;
  if (!Number.isSafeInteger(configured) || configured < 1) return STANDING_GRANT_CEILINGS.maxTtlMs;
  return Math.min(configured, STANDING_GRANT_CEILINGS.maxTtlMs);
}

/** Local-enforcement risk: the configured value, never above the signed ceiling. */
export function configuredLocalEnforcementRisk(): MergeRisk {
  const configured = CAP_POLICY.localEnforcementMaxRisk;
  const ceiling = STANDING_GRANT_CEILINGS.localEnforcement.maxRisk;
  if (MERGE_RISK_RANK[configured] > MERGE_RISK_RANK[ceiling]) return ceiling;
  return configured;
}

/**
 * A reserve, including 0, never turns on paid overage. Metered dollars and
 * on-demand billing stay separate decisions and default off.
 */
export function reserveEnablesPaidOverage(_reserveFloorPercent: number): false {
  return false;
}
