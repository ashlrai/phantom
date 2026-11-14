/** Offline promotion policy. Rates are fractions in [0, 1], latency is milliseconds. */
export interface FtMeasurements {
  heldOutPass: number;
  sweLitePass: number;
  toolValidity: number;
  loopRate: number;
  p50LatencyMs: number;
}

export type FtGate = 'held-out' | 'swe-lite' | 'tool-validity' | 'loop-rate' | 'latency';

function valid(m: FtMeasurements): boolean {
  return m !== null && typeof m === 'object' &&
    [m.heldOutPass, m.sweLitePass, m.toolValidity, m.loopRate].every(
      n => Number.isFinite(n) && n >= 0 && n <= 1,
    ) && Number.isFinite(m.p50LatencyMs) && m.p50LatencyMs > 0;
}

/** Refuse incomplete or invalid evidence rather than treating missing values as zero. */
export function evaluateFtPromotion(baseline: FtMeasurements, candidate: FtMeasurements): {
  eligible: boolean; failed: FtGate[];
} {
  if (!valid(baseline) || !valid(candidate)) throw new Error('Invalid fine-tuning measurements');
  const failed: FtGate[] = [];
  if (candidate.heldOutPass < baseline.heldOutPass + 0.03 - Number.EPSILON) failed.push('held-out');
  if (candidate.sweLitePass < baseline.sweLitePass) failed.push('swe-lite');
  if (candidate.toolValidity < 0.98) failed.push('tool-validity');
  if (candidate.loopRate > baseline.loopRate) failed.push('loop-rate');
  if (candidate.p50LatencyMs > baseline.p50LatencyMs * 1.2) failed.push('latency');
  return { eligible: failed.length === 0, failed };
}

/** Compare measured merge outcomes; an absent denominator is unknown, not a pass. */
export function ftMergeRateDropped(baseline: { merged: number; total: number }, shadow: { merged: number; total: number }): boolean {
  for (const sample of [baseline, shadow]) {
    if (!Number.isSafeInteger(sample.total) || sample.total <= 0 ||
        !Number.isSafeInteger(sample.merged) || sample.merged < 0 || sample.merged > sample.total) {
      throw new Error('Invalid merge-rate sample');
    }
  }
  return BigInt(shadow.merged) * BigInt(baseline.total) < BigInt(baseline.merged) * BigInt(shadow.total);
}
