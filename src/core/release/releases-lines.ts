import type { ReleasesReport } from './status.js';

export const releaseCount = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The one line on the Leader card (desktop and phone): the most overdue repo, or "all fresh".
 * "Release due: locus (23 PRs since v1.4.0, 9 days)" | "Releases: all fresh" | "Releases: none due (1 unknown)" | "Releases: unknown".
 */
export function releasesLeaderLine(report: ReleasesReport | null | undefined): string {
  if (!report || !Array.isArray(report.repos) || !report.repos.length || report.counts.unknown === report.repos.length) return 'Releases: unknown';
  const next = report.next;
  if (next) return `Release due: ${next.repo.replace(/^ashlrai\//, '')} (${next.mergedPrsSince === null ? 'unknown PRs' : releaseCount(next.mergedPrsSince, 'PR')} since ${next.latestTag ?? 'unknown'}, ${next.ageDays === null ? 'unknown days' : releaseCount(next.ageDays, 'day')})`;
  if (report.counts.fresh === report.repos.length) return 'Releases: all fresh';
  const other = report.counts.unknown + report.counts['no release yet'];
  return `Releases: none due${other ? ` (${report.counts.unknown ? `${report.counts.unknown} unknown` : ''}${report.counts.unknown && report.counts['no release yet'] ? ', ' : ''}${report.counts['no release yet'] ? `${report.counts['no release yet']} with no release yet` : ''})` : ''}`;
}

/**
 * The one digest line: "Release due: <repo>, <N> PRs since <tag>, <D> days" for the most overdue repo,
 * "Release due: none" when nothing is due, and "Release due: unknown" when nothing could be read.
 */
export function releaseDueLine(report: ReleasesReport | null | undefined): string {
  if (!report || !report.repos.length) return 'Release due: unknown';
  const next = report.next;
  if (next) return `Release due: ${next.repo.replace(/^ashlrai\//, '')}, ${next.mergedPrsSince === null ? 'unknown PRs' : releaseCount(next.mergedPrsSince, 'PR')} since ${next.latestTag ?? 'unknown'}, ${next.ageDays === null ? 'unknown days' : releaseCount(next.ageDays, 'day')}`;
  if (report.counts.unknown === report.repos.length) return 'Release due: unknown';
  return `Release due: none${report.counts.unknown ? ` (${report.counts.unknown} unknown)` : ''}`;
}
