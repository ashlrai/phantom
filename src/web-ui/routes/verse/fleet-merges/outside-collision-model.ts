import type { OutsideOverlap, OutsidePr } from './fleet-merges-model.js';

const pathCount = (pr: OutsidePr): number => pr.overlaps.reduce((count, overlap) => count + overlap.paths.length, 0);
const timestamp = (at: string | null): number => {
  const value = at === null ? NaN : Date.parse(at);
  return Number.isFinite(value) ? value : -Infinity;
};

export function orderOutsidePrs(prs: readonly OutsidePr[]): OutsidePr[] {
  return [...prs].sort((a, b) => {
    const left = timestamp(a.at), right = timestamp(b.at);
    return Number(b.overlaps.length > 0) - Number(a.overlaps.length > 0)
      || pathCount(b) - pathCount(a) || (left === right ? 0 : right - left);
  });
}

export function collisionHeadline(prs: readonly OutsidePr[], sourceState: string | null): string {
  if (sourceState === 'missing') return 'Outside PRs unread (gh missing)';
  if (sourceState === 'degraded') return 'Outside PRs unread (degraded)';
  const count = prs.filter(pr => pr.overlaps.length > 0).length;
  if (count === 0) return 'No outside PR collides with running work';
  return `${count} outside PR${count === 1 ? ' touches' : 's touch'} files of running jobs`;
}

const compact = (value: string, max: number): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
};

export function collisionSteerPrefill(pr: OutsidePr, overlap: OutsideOverlap): string {
  const prefix = `Job ${compact(overlap.job, 120)} and outside PR #${pr.number} (${compact(pr.author, 70)}, ${compact(pr.head, 70)}) both change ${overlap.paths.length} files: `;
  const suffix = '. Decide: let the job finish, or pause it until the PR merges.';
  const paths = compact(overlap.paths.slice(0, 5).join(', '), 599 - prefix.length - suffix.length);
  return `${prefix}${paths}${suffix}`;
}
