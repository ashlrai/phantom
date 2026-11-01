import { classifyLaneJob } from '../../../../core/fleet/lane-class-share.js';
import type { LaneJobClass } from '../../../../core/fleet/lane-class-share.js';

const labels: Record<LaneJobClass, 'Phantom' | 'fix-up' | 'filler' | 'other'> = {
  phx: 'Phantom', fixup: 'fix-up', filler: 'filler', other: 'other',
};
const classes: readonly LaneJobClass[] = ['phx', 'fixup', 'filler', 'other'];

export function nextUpClasses(jobs: readonly string[]) {
  return jobs.map(job => {
    const cls = classifyLaneJob(job);
    return { job, cls, label: labels[cls] };
  });
}

export function nextUpCaption(lane: string, jobs: readonly string[]): string {
  if (jobs.length === 0) return 'nothing next';
  const counts: Record<LaneJobClass, number> = { phx: 0, fixup: 0, filler: 0, other: 0 };
  for (const { cls } of nextUpClasses(jobs)) counts[cls]++;
  return `next ${jobs.length} on ${lane}: ${classes.filter(cls => counts[cls] > 0).map(cls => `${counts[cls]} ${labels[cls]}`).join(', ')}`;
}

export function fillerFirst(jobs: readonly string[]): boolean {
  return jobs.length > 1 && classifyLaneJob(jobs[0]!) === 'filler' && jobs.slice(1).some(job => classifyLaneJob(job) === 'phx');
}
