import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { DropIngestedRow, JournalPass } from './leader-journal-model.js';

export type JobFate = 'merged' | 'published' | 'running' | 'claimed' | 'waiting';
export type FateCounts = Record<JobFate | 'wrote', number>;

function containsJobId(title: string, id: string): boolean {
  if (!id) return false;
  let start = title.indexOf(id);
  while (start !== -1) {
    const before = title[start - 1] ?? '';
    const after = title[start + id.length] ?? '';
    if (!/[A-Za-z0-9._-]/.test(before) && !/[A-Za-z0-9._-]/.test(after)) return true;
    start = title.indexOf(id, start + 1);
  }
  return false;
}

export function jobFate(id: string, runs: FleetRuns): JobFate {
  if (runs.mergesLastHour.items.some((item) => containsJobId(item.title, id))) return 'merged';
  if (runs.publishesLastHour.some((item) => item.job === id)) return 'published';
  if (runs.workers.some((item) => item.job === id)) return 'running';
  if (runs.claimed?.some((item) => item.job === id)) return 'claimed';
  return 'waiting';
}

export function passFates(_pass: JournalPass, ingestedForPass: readonly DropIngestedRow[], runs: FleetRuns): {
  counts: FateCounts; chips: Array<{ id: string; lane: string; state: JobFate }>;
} {
  const counts: FateCounts = { wrote: ingestedForPass.length, running: 0, published: 0, merged: 0, claimed: 0, waiting: 0 };
  const chips = ingestedForPass.map(({ id, lane }) => {
    const state = jobFate(id, runs);
    counts[state]++;
    return { id, lane, state };
  });
  return { counts, chips };
}

export function fateLine(counts: FateCounts): string {
  const states: JobFate[] = ['running', 'published', 'merged', 'claimed', 'waiting'];
  return [`wrote ${counts.wrote}`, ...states.filter((state) => counts[state] > 0).map((state) => `${state} ${counts[state]}`)].join(' · ');
}
