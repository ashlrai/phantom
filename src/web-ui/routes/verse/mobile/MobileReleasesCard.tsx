/**
 * routes/verse/mobile/MobileReleasesCard.tsx — which repo is most overdue for a release, in one row.
 * Same report as `phm releases --json` and the Mac card (shared query key). Never tags or publishes.
 * "All repos" opens the full list in place, so there is no second screen.
 */
import { useState } from 'react';
import { releaseDueLine } from '../../../../core/release/releases-lines.js';
import type { ReleasesReport } from '../../../../core/release/status.js';
import { useQuery } from '../../../data/hooks.js';
import { releasesQuery } from '../fleet-metrics/releases-query.js';
import { ReleaseRepoRows } from '../fleet-metrics/ReleaseRepoRows.js';
import { Row, Section } from './ui-parts.js';
import { SkeletonList } from './ui.js';

const name = (repo: string): string => repo.replace(/^ashlrai\//, '');

export function MobileReleasesCard() {
  // Tags move slowly: read once, keep for five minutes.
  const query = useQuery(releasesQuery, { freshMs: 300_000 });
  const [open, setOpen] = useState(false);
  const report: ReleasesReport | undefined = query.data?.schema === 'phantom.releases.v1' && Array.isArray(query.data.repos) ? query.data : undefined;

  return (
    <Section title="Releases">
      {report?.releaseRepos ? <ReleaseRepoRows rows={report.releaseRepos} checkedAt={report.checkedAt} /> : report ? <>
        <Row
          title={report.next ? `${name(report.next.repo)}: ${report.next.verdict}` : releaseDueLine(report)}
          subtitle={report.next ? report.next.suggestion : undefined}
        />
        {report.repos.length > 1 ? <Row title={open ? 'Hide full list' : `All repos (${report.repos.length})`} onClick={() => setOpen(value => !value)} /> : null}
        {open ? report.repos.map(row => <Row key={row.repo} title={`${name(row.repo)}: ${row.verdict}`} subtitle={row.suggestion} />) : null}
      </> : query.status === 'idle' || query.status === 'loading' ? (
        <SkeletonList rows={1} label="Loading releases" />
      ) : (
        <Row title="Releases: unknown" />
      )}
    </Section>
  );
}
