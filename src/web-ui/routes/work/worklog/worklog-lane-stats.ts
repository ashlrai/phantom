import type { WorklogEntry } from '../../../../core/fleet/worklog.js';

export function laneStats(entries: WorklogEntry[]) {
  const lanes = new Map<string, WorklogEntry[]>();
  for (const entry of entries) {
    const lane = entry.lane ?? 'unknown';
    const group = lanes.get(lane) ?? [];
    group.push(entry);
    lanes.set(lane, group);
  }
  return [...lanes].map(([lane, group]) => {
    const timings = group.flatMap(entry => entry.openToMergeSeconds === null ? [] : [entry.openToMergeSeconds]).sort((a, b) => a - b);
    const middle = Math.floor(timings.length / 2);
    const medianSeconds = timings.length === 0 ? null : timings.length % 2 ? timings[middle]! : (timings[middle - 1]! + timings[middle]!) / 2;
    const models = new Map<string, number>();
    for (const entry of group) {
      if (entry.model !== null) models.set(entry.model, (models.get(entry.model) ?? 0) + 1);
    }
    const topModel = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    return { lane, count: group.length, medianSeconds, unknownTiming: group.length - timings.length, topModel };
  }).sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane));
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}
