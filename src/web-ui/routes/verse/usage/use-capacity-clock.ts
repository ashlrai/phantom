import { useEffect, useState } from 'react';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';

export const ACCOUNT_CLOCK_MS = 30_000;
type Reading = { quotaExpiresAt?: string | null; expiresAt?: string | null; creditsExpiresAt?: string | null; windows?: readonly {resetsAt?: string | null}[] } | null | undefined;
/** Invalidation never restamps evidence or fetches. Exact source deadlines supplement the visible clock. */
export function useCapacityClock(fixedNow?: number, readings: readonly Reading[] = []): number {
  const [, invalidate] = useState(0);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const visible = sectionVisible && documentVisible;
  const now = fixedNow ?? Date.now();
  usePollWhileVisible(() => invalidate(tick => tick + 1), ACCOUNT_CLOCK_MS, { enabled: fixedNow === undefined });
  const next = readings.flatMap(reading => [reading?.quotaExpiresAt, reading?.expiresAt, reading?.creditsExpiresAt, ...(reading?.windows ?? []).map(window => window.resetsAt)])
    .reduce((soon, value) => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return at > now ? Math.min(soon, at) : soon; }, Infinity);
  useEffect(() => {
    if (!visible || fixedNow !== undefined || next - now > ACCOUNT_CLOCK_MS || !Number.isFinite(next)) return;
    const id = setTimeout(() => invalidate(tick => tick + 1), Math.max(0, next - Date.now()));
    return () => clearTimeout(id);
  }, [visible, fixedNow, next, now]);
  return now;
}
