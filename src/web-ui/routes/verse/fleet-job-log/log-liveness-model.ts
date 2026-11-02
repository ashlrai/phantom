import type { FleetJobDetailV1 } from './worker-log-model.js';

type State = FleetJobDetailV1['state'];
export interface TrackedLog {
  lastGrowthAt: number | null;
  unseenLines: number;
  bytes: number;
  lines: string[];
}

export function trackGrowth(previous: TrackedLog | null, detail: FleetJobDetailV1 & { follow: boolean }, nowMs: number): TrackedLog {
  const lines = detail.log?.tail ?? [];
  const bytes = detail.log?.bytes ?? 0;
  const grew = bytes > (previous?.bytes ?? 0) || lines.length > (previous?.lines.length ?? 0);
  let added = 0;
  if (previous && grew) {
    // A truncated tail can slide while its length stays fixed.
    let overlap = Math.min(previous.lines.length, lines.length);
    while (overlap > 0 && !previous.lines.slice(-overlap).every((line, index) => line === lines[index] || (previous.lines.length - overlap + index === previous.lines.length - 1 && lines[index].startsWith(line)))) overlap--;
    added = lines.length - overlap;
  }
  return { lastGrowthAt: grew ? nowMs : previous?.lastGrowthAt ?? null,
    unseenLines: detail.follow ? 0 : (previous?.unseenLines ?? 0) + added, bytes, lines };
}

const finished = (state: State) => state === 'published' || state === 'archived';
export function livenessText(lastGrowthAt: number | null, state: State, nowMs: number): string {
  if (finished(state)) return 'Finished';
  if (lastGrowthAt === null) return 'No output yet';
  const seconds = Math.floor(Math.max(0, nowMs - lastGrowthAt) / 1000);
  return seconds < 60 ? `Output ${seconds} s ago` : `Output ${Math.floor(seconds / 60)} min ago`;
}
export function livenessTone(lastGrowthAt: number | null, state: State, nowMs: number): 'running' | 'neutral' | 'warning' {
  if (state !== 'running' || lastGrowthAt === null) return 'neutral';
  const age = nowMs - lastGrowthAt;
  return age < 120_000 ? 'running' : age <= 600_000 ? 'neutral' : 'warning';
}
export function newLinesLabel(n: number): string { return `${n} new ${n === 1 ? 'line' : 'lines'}`; }
