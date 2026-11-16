/** Pure lease partition; callers persist releases under their store's writer lock. */
export function reapExpiredClaims<T extends { agent: string; claimedAt: number; expiresAt: number }>(
  records: readonly T[], now: number, graceMs: number,
): { keep: T[]; released: Array<T & { owner: string; state: 'RELEASED'; reason: 'lease-expired' }> } {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error('Invalid lease clock or grace');
  }
  const keep: T[] = [];
  const released: Array<T & { owner: string; state: 'RELEASED'; reason: 'lease-expired' }> = [];
  for (const record of records) {
    if (record.claimedAt < now && record.expiresAt <= now - graceMs) {
      released.push({ ...record, owner: record.agent, state: 'RELEASED', reason: 'lease-expired' });
    } else keep.push(record);
  }
  return { keep, released };
}
