/** The `phm releases` report: which repo is due a release, and the one to release next. */
import type { ReleasesReport } from '../../../../core/release/status.js';
import { ReleaseRepoRows } from './ReleaseRepoRows.js';
import styles from './fleet-metrics.module.css';

const shown = (value: number | string | null): string => value === null ? 'unknown' : String(value);

/** `report` is undefined while loading, on a read error, or when the server predates the report. */
export function ReleasesCard({ report }: { report: ReleasesReport | undefined }) {
  const known = report?.schema === 'phantom.releases.v1' && Array.isArray(report.repos) ? report : undefined;
  return <section className={styles.card} aria-label="Releases">
    <h3 className={styles.heading}>Releases</h3>
    {known?.releaseRepos ? <ReleaseRepoRows rows={known.releaseRepos} checkedAt={known.checkedAt} /> : !known ? <p className={styles.note}>Releases: unknown</p>
      : !known.repos.length ? <p className={styles.note}>No repos to check.</p> : <>
        <p className={styles.note}>{known.next ? `Release next: ${known.next.suggestion}.` : 'No release is due.'} Due means over {known.dueWhen.days} days or over {known.dueWhen.mergedPrs} merged PRs since the latest tag.</p>
        <div className={styles.scroll}>
          <table className={styles.table}><caption>Read from local clones. Same report as phm releases.</caption>
            <thead><tr><th scope="col">Repo</th><th scope="col">Latest tag</th><th scope="col">Days ago</th><th scope="col">Merged PRs since</th><th scope="col">Verdict</th></tr></thead>
            <tbody>{known.repos.map(row => <tr key={row.repo} data-due={row.verdict === 'due' ? 'true' : undefined}>
              <th scope="row">{row.repo.replace(/^ashlrai\//, '')}</th>
              <td>{row.verdict === 'no release yet' ? 'none' : shown(row.latestTag)}</td><td>{row.latestTag === null ? '' : shown(row.ageDays)}</td>
              <td>{shown(row.mergedPrsSince)}</td><td>{row.verdict}</td></tr>)}</tbody></table>
        </div>
        {known.repos.filter(row => row.recentPrs?.length).map(row => <div key={row.repo} className={styles.note}>
          <strong>{row.repo.replace(/^ashlrai\//, '')}</strong> merged since {row.latestTag}:
          <ul>{row.recentPrs!.map(pr => <li key={pr.number}>#{pr.number} {pr.title}</li>)}</ul>
          {row.mergedPrsSince !== null && row.mergedPrsSince > row.recentPrs!.length ? `and ${row.mergedPrsSince - row.recentPrs!.length} more` : null}
        </div>)}
      </>}
  </section>;
}
