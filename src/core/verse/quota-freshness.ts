/** Display freshness only. Original source expiry never grants execution or billing authority. */
export function currentQuotaReading(observedAt: unknown, expiresAt: unknown, now: number, resets: readonly unknown[] = []): boolean {
  const canonical = (value: unknown): value is string => typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
  return Number.isFinite(now) && now >= 0 && canonical(observedAt) && canonical(expiresAt) &&
    Date.parse(observedAt) <= now && Date.parse(expiresAt) > Date.parse(observedAt) && now < Date.parse(expiresAt) && resets.every(reset => reset === null || canonical(reset) && now < Date.parse(reset));
}
