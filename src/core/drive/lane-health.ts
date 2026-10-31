import type { DriveJob } from './supervisor.js';

const HOUR = 3_600_000;
export const RECOVERY_PROBE_MS = 300_000;
export interface LaneHealth { reason: string | null; probeAtMs: number | null; }

/** Replay retained finishes so a quiet hour cannot itself prove recovery. */
export function claudeApiHealth(jobs: readonly DriveJob[], nowMs: number): LaneHealth {
  let reason: string | null = null;
  let probeAtMs: number | null = null;
  let start = 0;
  let code13 = 0;
  let empty = 0;
  const finishes = jobs.filter(j => j.pool === 'claude-api' && j.completedAtMs !== undefined && j.completedAtMs <= nowMs)
    .sort((a, b) => a.completedAtMs! - b.completedAtMs!);
  for (let index = 0; index < finishes.length; index++) {
    const job = finishes[index]!;
    const at = job.completedAtMs!;
    if (reason && job.exitCode === 0 && job.emptyFinish === false) {
      reason = null;
      probeAtMs = null;
      start = index + 1;
      code13 = empty = 0;
      continue;
    }
    while (start < index && finishes[start]!.completedAtMs! <= at - HOUR) {
      const expired = finishes[start++]!;
      code13 -= Number(expired.exitCode === 13);
      empty -= Number(expired.emptyFinish === true);
    }
    code13 += Number(job.exitCode === 13);
    empty += Number(job.emptyFinish === true);
    if (code13 >= 2) reason = 'repeated-code-13';
    else if (empty > (index - start + 1) / 2) reason = 'empty-finishes-over-50-percent';
    if (reason) probeAtMs = at + RECOVERY_PROBE_MS;
  }
  return { reason, probeAtMs };
}
