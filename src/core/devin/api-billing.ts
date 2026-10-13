/** Fleet API spending authority only; no provider funding or quota attestation. */
import type { EffectivePolicy } from '../authority/types.js';
import type { DevinGate } from './types.js';

/**
 * Cloud API creates can consume on-demand credits. A human attribution, Max
 * label or local ACU budget cannot prove included-only billing. Keep this
 * separate from shared Devin native CLI authorization and metadata reads.
 * A positive allowance preserves existing behavior; it does NOT establish
 * exact USD accounting, remaining provider funding or a dollar reservation.
 */
export function devinFleetApiBillingGate(policy: Pick<EffectivePolicy, 'spend'> | null): DevinGate {
  const allowance = policy?.spend?.meteredUsdPerDay;
  if (typeof allowance === 'number' && Number.isFinite(allowance) && allowance > 0) {
    return { ok: true, reason: null };
  }
  return { ok: false, reason: `${allowance === 0 ? 'The standing metered API allowance is $0/day.' : 'The standing metered API allowance is unavailable.'} `
    + 'Devin fleet API launches are held. Review and authorize a positive metered allowance before using this lane; subscription quota and human attribution do not establish included API billing.' };
}
