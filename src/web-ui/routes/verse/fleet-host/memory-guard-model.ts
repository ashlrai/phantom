import type { FleetMemoryView } from '../../../../core/fleet/memory-view.js';

export interface MemoryGuardCardView {
  tone: 'ok' | 'warn' | 'neutral';
  lines: string[];
  /** Job ids the guard reports as stopped; null when the file does not say. */
  stoppedJobs: string[] | null;
  /** Present only when the sample is stale. */
  staleText: string | null;
}

const num = (value: number | null): string => value === null ? 'unknown' : String(value);
const pct = (value: number | null): string => value === null ? 'unknown' : `${value}%`;
const gb = (value: number | null): string => value === null ? 'unknown' : `${value} GB`;

/** Unknown stays "unknown", never 0; a stale sample or a stopped worker warns. */
export function memoryGuardCard(memory: FleetMemoryView | null | undefined): MemoryGuardCardView | null {
  if (!memory) return null;
  const { sample, memguard } = memory;
  const stoppedJobs = memguard.stopped;
  const staleText = sample.stale === true
    ? sample.age_ms === null
      ? 'Memory sample is stale. The guard may not be running.'
      : `Memory sample is ${Math.max(1, Math.round(sample.age_ms / 60_000))} min old. The guard may not be running.`
    : null;
  const lines = [
    `Memory free ${pct(sample.free_pct)} · disk free ${gb(sample.disk_gb)}`,
    `Swap ${gb(sample.swap_gb)} · ${num(sample.swapouts_per_min)} swapouts/min`,
    `oMLX ${memguard.omlx_down === undefined ? 'unknown' : memguard.omlx_down ? 'unloaded' : 'loaded'}`,
    `Guard calm ${memguard.calm === undefined ? 'unknown' : memguard.calm}`,
  ];
  const tone = staleText !== null || (stoppedJobs !== null && stoppedJobs.length > 0) ? 'warn'
    : sample.free_pct === null && stoppedJobs === null ? 'neutral'
    : 'ok';
  return { tone, lines, stoppedJobs, staleText };
}
