import type { HarnessDigest } from './harness-digest-reader.js';

const DAY_MS = 86_400_000;

/** A single queued source, never mutating the original digest. */
export interface RefreshQueueEntry {
  id: string;
  title: string;
  urls: string[];
  checkedAt: string | null;
  reason: 'repair' | 'stale';
}

/** Return true when `entry`'s checkedAt falls outside `staleDays` of `now`. */
function staleSince(
  entry: { checkedAt: string | null },
  now: Date,
  staleDays = 7,
): boolean {
  if (entry.checkedAt === null) return false;
  const date = Date.parse(`${entry.checkedAt}T00:00:00Z`);
  if (!Number.isFinite(date)) return false;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return today - date > staleDays * DAY_MS;
}

/** Plan a deterministic, bounded research queue from a parsed harness digest. */
export function planHarnessRefresh(
  digest: HarnessDigest,
  limit: number,
  now: Date = new Date(),
): RefreshQueueEntry[] {
  const floored = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (floored <= 0) return [];

  /* De-duplicate: keep the first record per id, tracking issues by id. */
  const seen = new Map<string, { id: string; title: string; checkedAt: string | null; urls: string[] }>();
  const issuesBy = new Map<string, boolean>();
  for (const iss of digest.issues) issuesBy.set(iss.id, true);

  for (const src of digest.sources) {
    if (!seen.has(src.id)) seen.set(src.id, src);
  }

  const repair: RefreshQueueEntry[] = [];
  const stale: RefreshQueueEntry[] = [];

  for (const src of seen.values()) {
    if (issuesBy.has(src.id)) {
      repair.push({ id: src.id, title: src.title, urls: src.urls, checkedAt: src.checkedAt, reason: 'repair' });
    } else if (staleSince(src, now)) {
      stale.push({ id: src.id, title: src.title, urls: src.urls, checkedAt: src.checkedAt, reason: 'stale' });
    }
  }

  /* Repair first, then stale — both oldest-checkedAt-first (null before dated), then id. */
  return [...repair.sort(dualSort), ...stale.sort(dualSort)].slice(0, floored);
}

/** Sort: oldest checkedAt first (null = never = before any date), then id lexical. */
function dualSort(a: RefreshQueueEntry, b: RefreshQueueEntry): number {
  const ac = a.checkedAt;
  const bc = b.checkedAt;
  if (ac === null && bc === null) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (ac === null) return -1;
  if (bc === null) return 1;
  return ac < bc ? -1 : ac > bc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
