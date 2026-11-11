export interface UsagePaceInput {
  usedFrac: number | null;
  ratePerHour: number | null;
  resetAt: string | null;
  now: number;
}

export type UsagePace =
  | { kind: 'unknown' | 'on-pace' }
  | { kind: 'waste'; wastePct: number }
  | { kind: 'runs-out'; runsOutAt: number };

/** Rates are fractions of the allowance per hour, not percentage points. */
export function usagePace({ usedFrac, ratePerHour, resetAt, now }: UsagePaceInput): UsagePace {
  const reset = resetAt === null ? NaN : Date.parse(resetAt);
  if (usedFrac === null || !Number.isFinite(usedFrac) || usedFrac < 0 || usedFrac > 1 ||
      ratePerHour === null || !Number.isFinite(ratePerHour) || ratePerHour < 0 ||
      !Number.isFinite(now) || !Number.isFinite(reset) || reset <= now) return { kind: 'unknown' };
  const projected = usedFrac + ratePerHour * (reset - now) / 3_600_000;
  if (projected > 1) return { kind: 'runs-out', runsOutAt: now + (1 - usedFrac) / ratePerHour * 3_600_000 };
  if (projected < 0.9) return { kind: 'waste', wastePct: (1 - projected) * 100 };
  return { kind: 'on-pace' };
}
