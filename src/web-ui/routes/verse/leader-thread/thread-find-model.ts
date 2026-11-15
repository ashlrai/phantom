import type { LabeledLine } from './owner-thread-lines.js';
import type { BusReply } from './thread-bus-replies.js';

export type ThreadFindItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'line'; key: string; line: LabeledLine }
  | { type: 'bus'; key: string; row: BusReply };

export function threadMatches(items: readonly ThreadFindItem[], query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return items.flatMap(item => {
    if (item.type === 'day') return [];
    const fields = item.type === 'line' ? [item.line.text] : [item.row.excerpt, item.row.from];
    return fields.some(field => field.toLowerCase().includes(needle)) ? [item.key] : [];
  });
}

export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  return total > 0 ? (current + dir + total) % total : 0;
}
