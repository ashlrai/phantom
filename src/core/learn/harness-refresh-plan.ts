import type { HarnessDigest } from './harness-digest-reader.js';

/** A single queued source, never mutating the original digest. */
export interface RefreshQueueEntry {
  id: string;
  title: string;
  urls: string[];
  checkedAt: string | null;
  reason: 'repair' | 'stale';
}

/** Plan a deterministic, bounded research queue from a parsed harness digest. */
export function planHarnessRefresh(
  digest: HarnessDigest,
  limit: number,
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
    if (issuesBy.has(src.id) || src.stale === null) {
      repair.push({ id: src.id, title: src.title, urls: src.urls, checkedAt: src.checkedAt, reason: 'repair' });
    } else if (src.stale === true) {
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
