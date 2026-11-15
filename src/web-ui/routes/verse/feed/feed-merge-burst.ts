import type { FeedItem } from './feed-model.js';

/** Collapse each UTC hour into one stable id; the timestamp-based unseen count
 * sees at most one item for that hour, even when another merge updates it. */
export function groupMergeBursts(items: FeedItem[], opts?: { minGroup?: number }): FeedItem[] {
  const buckets = new Map<string, FeedItem[]>();
  for (const item of items) {
    if (item.kind !== 'merge') continue;
    const ms = Date.parse(item.at);
    if (!Number.isFinite(ms)) continue;
    const bucket = new Date(ms).toISOString().slice(0, 13);
    const group = buckets.get(bucket) ?? [];
    group.push(item);
    buckets.set(bucket, group);
  }
  const grouped = new Map<FeedItem, FeedItem | null>();
  for (const [bucket, group] of buckets) {
    if (group.length < (opts?.minGroup ?? 3)) continue;
    const newest = [...group].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const lines = newest.slice(0, 5).map(item => item.body ? `${item.title} (${item.body})` : item.title);
    if (group.length > 5) lines.push(`and ${group.length - 5} more`);
    for (const item of group) grouped.set(item, null);
    grouped.set(newest[0]!, { id: `merge-hour:${bucket}`, kind: 'merge', at: newest[0]!.at,
      title: `${group.length} PRs merged`, body: lines.join('\n'), pane: 'fleet-merges' });
  }
  return items.flatMap(item => grouped.has(item) ? (grouped.get(item) ? [grouped.get(item)!] : []) : [item]);
}
