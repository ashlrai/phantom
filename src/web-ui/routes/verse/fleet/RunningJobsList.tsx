import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetLiveQuery } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

/** Desktop and phone read the same typed report as jobs live and the tick file. */
export function RunningJobsList({ enabled = true }: { enabled?: boolean }) {
  const read = useQuery(fleetLiveQuery, { enabled });
  const refresh = useRefetch(fleetLiveQuery);
  usePollWhileVisible(refresh, 15_000, { enabled });
  const report = read.data?.value?.liveJobs;
  const known = read.status !== 'error' && report?.known && Date.now() - Date.parse(report.generatedAt) < 180_000;
  return <section aria-label="Running now"><strong>Running now</strong>
    {!known ? <p>Running jobs: unknown</p> : !report.jobs.length ? <p>No running jobs.</p> : <ul>{report.jobs.map(job => <li key={job.id} style={job.status === 'stuck' ? { color: 'var(--status-danger-fg)' } : undefined}>
      <span title={`Started ${job.started} · Last log write ${job.lastLogWrite}`}>{job.id} · {job.lane} · {job.repo} · {job.elapsed === 'unknown' ? 'unknown' : `${Math.floor(job.elapsed / 60)}m`} · {job.status}</span>
      <div>{job.lastLine}</div>
    </li>)}</ul>}
  </section>;
}
