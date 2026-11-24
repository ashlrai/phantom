import { releaseRepoLine, type ReleaseRepoStatus } from '../../../../core/release/release-repos.js';

/** Identical compact rows on desktop and phone, including reasons for missing evidence. */
export function ReleaseRepoRows({ rows, checkedAt }: { rows: ReleaseRepoStatus[]; checkedAt: string }) {
  return <ul aria-label="Release cadence" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{rows.map(row => <li key={row.repo} data-state={row.state} style={{ padding: '0.4rem 0' }}>
    <div>{releaseRepoLine(row, Date.parse(checkedAt))}</div><small>{row.state}: {row.reason}</small>
  </li>)}</ul>;
}
