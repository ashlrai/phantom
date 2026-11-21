/** Pure shaping for the Throughput board's share bar: how the window's merged PRs split between the groups the report holds
 * (lanes, repos or tiers, whichever `by` the route was asked for). Every count is the report's own; the only arithmetic is
 * adding the groups up and dividing. A group the job records do not name stays "unknown" and is never given an identity colour. */
import type { ThroughputBy, ThroughputGroup } from '../../../../core/fleet/throughput.js';
import { SERIES_SLOT_COUNT } from '../../../components/charts/colors.js';
import { usedPercentText } from '../percent-text.js';

export interface GroupWords { one: string; many: string; title: string; column: string }
export const GROUP_WORDS: Readonly<Record<ThroughputBy, GroupWords>> = {
  lane: { one: 'lane', many: 'lanes', title: 'Lanes', column: 'Lane' },
  repo: { one: 'repo', many: 'repos', title: 'Repos', column: 'Repo' },
  tier: { one: 'tier', many: 'tiers', title: 'Tiers', column: 'Tier' },
};
/** An answer from a server that names no grouping is read as lanes, the route's default. */
export const groupWords = (by: ThroughputBy | undefined): GroupWords => (by && GROUP_WORDS[by]) || GROUP_WORDS.lane;
/** The report files marks whose job record names no lane, repo or tier under this name. */
export const UNNAMED = 'unknown';
/** "lane unknown" for the unnamed group, otherwise the name as the report gives it. */
export const groupLabel = (name: string, by: ThroughputBy | undefined): string => name === UNNAMED ? `${groupWords(by).one} unknown` : name;

export interface ShareSegment {
  /** The group's name, or null for the folded tail. */
  name: string | null;
  label: string;
  merged: number;
  /** Share of the merged PRs counted across the groups, 0..1. */
  share: number;
  percent: string;
  /** Categorical colour slot, 0-based. Null for the unnamed group (hatched) and for the folded tail (neutral). */
  slot: number | null;
  kind: 'named' | 'unnamed' | 'others';
}
export interface MergedShare { total: number; segments: ShareSegment[]; words: string }

/**
 * The groups that merged at least one PR, most first, as parts of their sum. Past six named groups the rest fold into one
 * "N other" part, as the chart colours ask. Null when a count is unknown or nothing merged: there is no split to draw.
 * Colour follows the name's place in the alphabet among the parts shown, so two groups trading places keep their colours.
 */
export function mergedShare(groups: readonly ThroughputGroup[], by: ThroughputBy | undefined): MergedShare | null {
  if (groups.some(group => group.totals.merged === null)) return null;
  const merged = groups.map(group => ({ name: group.name, merged: group.totals.merged ?? 0 })).filter(group => group.merged > 0)
    .sort((a, b) => b.merged - a.merged || a.name.localeCompare(b.name));
  const total = merged.reduce((sum, group) => sum + group.merged, 0);
  if (total === 0) return null;
  const named = merged.filter(group => group.name !== UNNAMED);
  const shown = named.slice(0, SERIES_SLOT_COUNT), folded = named.slice(SERIES_SLOT_COUNT);
  const slots = new Map([...shown].sort((a, b) => a.name.localeCompare(b.name)).map((group, slot) => [group.name, slot]));
  const words = groupWords(by);
  const part = (name: string | null, label: string, count: number, slot: number | null, kind: ShareSegment['kind']): ShareSegment =>
    ({ name, label, merged: count, share: count / total, percent: usedPercentText((count / total) * 100), slot, kind });
  const segments = shown.map(group => part(group.name, group.name, group.merged, slots.get(group.name) ?? null, 'named'));
  if (folded.length) segments.push(part(null, `${folded.length} other ${folded.length === 1 ? words.one : words.many}`, folded.reduce((sum, group) => sum + group.merged, 0), null, 'others'));
  const unnamed = merged.find(group => group.name === UNNAMED);
  if (unnamed) segments.push(part(UNNAMED, groupLabel(UNNAMED, by), unnamed.merged, null, 'unnamed'));
  return {
    total, segments,
    words: `${total} merged ${total === 1 ? 'PR' : 'PRs'} by ${words.one}: ${segments.map(segment => `${segment.label} ${segment.merged} (${segment.percent})`).join(', ')}.`,
  };
}
