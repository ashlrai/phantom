/** The Shipped today card's arithmetic, kept apart from its markup. It only arranges what `fleet.shipped.v1` lists: nothing here invents a merge. */
import type { ShippedPr } from '../../../../core/fleet/shipped.js';

const HOUR_MS = 3_600_000;
export const SHIPPED_HOURS = 24;

export interface HourlyMerges {
  /** One count per hour, oldest first; the last is the hour that ended when the report was read. */
  counts: number[];
  /** Listed PRs that could not be placed: no readable merge time, or one outside the window. */
  unplaced: number;
}

/** Listed PRs per hour of the report's own 24 hours. An unreadable report time gives no chart at all, never 24 empty hours. */
export function hourlyMerges(items: readonly Pick<ShippedPr, 'mergedAt'>[], generatedAt: string | undefined): HourlyMerges | null {
  const end = Date.parse(generatedAt ?? '');
  if (!Number.isFinite(end)) return null;
  const counts = Array.from({ length: SHIPPED_HOURS }, () => 0);
  let unplaced = 0;
  for (const item of items) {
    const ago = end - Date.parse(item.mergedAt ?? '');
    // A merge stamped exactly at the read time belongs to the newest hour.
    const index = SHIPPED_HOURS - 1 - Math.min(SHIPPED_HOURS - 1, Math.floor(ago / HOUR_MS));
    if (!Number.isFinite(ago) || ago < 0 || ago > SHIPPED_HOURS * HOUR_MS) unplaced += 1;
    else counts[index]! += 1;
  }
  return { counts, unplaced };
}

/** Repos with at least one merge, busiest first; ties keep the report's order. */
export function repoShares(byRepo: Record<string, number> | undefined): Array<{ repo: string; count: number }> {
  return Object.entries(byRepo ?? {}).filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([repo, count]) => ({ repo: repo.replace('ashlrai/', ''), count })).sort((a, b) => b.count - a.count);
}

/** How long a PR stayed open, in the largest unit that keeps it readable. */
export function openFor(seconds: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (seconds < 90) return unit(Math.max(0, Math.round(seconds)), 'second');
  if (seconds < 5400) return unit(Math.round(seconds / 60), 'minute');
  if (seconds < 129_600) return unit(Math.round(seconds / 3600), 'hour');
  return unit(Math.round(seconds / 86_400), 'day');
}
