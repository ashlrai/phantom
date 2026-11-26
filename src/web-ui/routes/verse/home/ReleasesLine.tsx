/**
 * One line on the desktop Leader card and the phone Home status: which repo is due a release, or "all fresh".
 * "Release due: locus (23 PRs since v1.4.0, 9 days)", "Releases: all fresh", "Releases: unknown".
 * Same typed report as `phm releases --json` (shared query key with the Releases cards); the words come from
 * core/release/status.ts. Tags move slowly, so it reads once and keeps the answer for five minutes.
 */
import { releasesLeaderLine } from '../../../../core/release/releases-lines.js';
import type { ReleasesReport } from '../../../../core/release/status.js';
import { useQuery } from '../../../data/hooks.js';
import { releasesQuery } from '../fleet-metrics/releases-query.js';

export function ReleasesLine({ className }: { className?: string }) {
  const data = useQuery(releasesQuery, { freshMs: 300_000 }).data;
  const report: ReleasesReport | null = data?.schema === 'phantom.releases.v1' && Array.isArray(data.repos) ? data : null;
  const line = releasesLeaderLine(report);
  return <p className={className} role="status" aria-label="Release due" data-tone={report?.next ? 'amber' : report ? 'ok' : 'unknown'}>{line}</p>;
}
