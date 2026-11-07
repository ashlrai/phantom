import { classifyLaneJob, type LaneJobClass } from '../../../../core/fleet/lane-class-share.js';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import type { Tone } from './ui-parts.js';

export interface RunningMixLine { lane: string; running: number; text: string; tone: Tone }

/** Count workers, not claimed jobs: a claim is not necessarily running. */
export function runningMixLines(runs: FleetRunsV1 | null): RunningMixLine[] {
  const lanes = new Map<string, Record<LaneJobClass, number>>();
  for (const worker of runs?.workers ?? []) {
    const counts = lanes.get(worker.lane) ?? { phx: 0, fixup: 0, filler: 0, other: 0 };
    counts[classifyLaneJob(worker.job)]++;
    lanes.set(worker.lane, counts);
  }
  return [...lanes].map(([lane, counts]) => {
    const running = counts.phx + counts.fixup + counts.filler + counts.other;
    const percentage = Math.floor(counts.filler * 1000 / running) / 10;
    const text = [
      counts.phx && `${counts.phx} Phantom`,
      counts.fixup && `${counts.fixup} fix-up`,
      counts.filler && `${counts.filler} filler (${percentage}%)`,
      counts.other && `${counts.other} other`,
    ].filter(Boolean).join(' · ');
    return { lane, running, text, tone: counts.filler * 10 >= running * 3 ? 'warning' as const : 'neutral' as const };
  }).sort((a, b) => b.running - a.running || a.lane.localeCompare(b.lane));
}

export function runningMixSummary(lines: RunningMixLine[]): string {
  const running = lines.reduce((sum, line) => sum + line.running, 0);
  const filler = lines.reduce((sum, line) => sum + Number(line.text.match(/(?:^| · )(\d+) filler \(/)?.[1] ?? 0), 0);
  return `${running} running · ${filler} filler`;
}
