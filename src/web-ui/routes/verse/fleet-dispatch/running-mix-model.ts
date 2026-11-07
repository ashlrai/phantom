import { classifyLaneJob } from '../../../../core/fleet/lane-class-share.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';

export interface RunningMixRow {
  lane: string;
  running: number;
  phx: number;
  fixup: number;
  filler: number;
  other: number;
  fillerPct: number | null;
  claimedPhx: number;
  claimedOther: number;
}

export function runningMix(runs: FleetRuns | null): RunningMixRow[] {
  const lanes = new Map<string, RunningMixRow>();
  const rowFor = (lane: string): RunningMixRow => {
    let row = lanes.get(lane);
    if (!row) {
      row = { lane, running: 0, phx: 0, fixup: 0, filler: 0, other: 0, fillerPct: null, claimedPhx: 0, claimedOther: 0 };
      lanes.set(lane, row);
    }
    return row;
  };
  for (const worker of runs?.workers ?? []) {
    const row = rowFor(worker.lane);
    row.running++;
    row[classifyLaneJob(worker.job)]++;
  }
  for (const claim of runs?.claimed ?? []) {
    const row = rowFor(claim.lane);
    if (classifyLaneJob(claim.job) === 'phx') row.claimedPhx++;
    else row.claimedOther++;
  }
  return [...lanes.values()].map(row => ({ ...row, fillerPct: row.running ? row.filler * 100 / row.running : null }))
    .sort((a, b) => b.running - a.running || a.lane.localeCompare(b.lane));
}

export function mixHeadline(rows: readonly RunningMixRow[]): string {
  const row = rows.find(item => item.running > 0);
  if (!row) return 'nothing running';
  const parts = [`${row.phx} Phantom`];
  if (row.fixup) parts.push(`${row.fixup} fix-ups`);
  parts.push(`${row.filler} filler (${Math.round(row.fillerPct!)}%)`);
  if (row.other) parts.push(`${row.other} other`);
  return `${row.running} running on ${row.lane}: ${parts.join(', ')}`;
}

export function fillerTellPrefill(row: RunningMixRow): string | null {
  if (row.fillerPct === null || row.fillerPct < 30) return null;
  return `Lane ${row.lane} is running ${row.filler} filler jobs of ${row.running} (${Math.round(row.fillerPct)}%). Prefer Phantom drop jobs; keep 20+ PHX lines in ready.`;
}
