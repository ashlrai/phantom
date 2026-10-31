import { useId, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { runQuery } from '../../../data/cache.js';
import { useQuery, useRefresh } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ageText, describeWorkers, publishFor, sortWorkers } from './workers-card-model.js';
import { notInBuild, workersQuery } from './workers-card-queries.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import styles from './workers-card.module.css';

export function WorkersCard() {
  const id = useId();
  const read = useQuery(workersQuery);
  const refresh = useRefresh(workersQuery);
  const [job, setJob] = useState<string | null>(null);
  usePollWhileVisible(() => { void runQuery(workersQuery.key, () => workersQuery.fetch()); }, 5_000, { enabled: !notInBuild(read.error) });
  const data = read.data;
  const healthy = data?.sources.workers === 'healthy' && !read.error;
  return <section className={styles.panel} aria-labelledby={id}>
    <header className={styles.header}><h2 id={id}>Working on this Mac</h2>
      {healthy ? <span>{describeWorkers(data.workers.length)}</span> : null}
      {read.status === 'refreshing' ? <RefreshIndicator /> : null}
      <Button size="sm" onClick={refresh} disabled={notInBuild(read.error)}>Refresh</Button>
    </header>
    {data && data.sources.workers !== 'healthy' ? <StatusBadge status="degraded">worker list {data.sources.workers === 'degraded' ? 'degraded' : 'missing'}</StatusBadge> : null}
    {read.status === 'loading' ? <SkeletonLine /> : !healthy ? <EmptyState compact title="Worker list unavailable" body={notInBuild(read.error) ? 'The worker API is not in this build yet.' : undefined} />
      : !data.workers.length ? <p>No workers running. Leaders write jobs every 15 minutes.</p>
      : <div className={styles.scroll}><table><thead><tr>{['Job', 'Repo', 'Lane', 'Tier', 'Age', 'PR'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{sortWorkers(data.workers).map(worker => {
          const url = publishFor(worker.job, data.publishesLastHour);
          return <tr key={worker.job}><td><button className={styles.job} onClick={() => setJob(worker.job)} aria-label={`Job ${worker.job}`}>{worker.job}</button></td>
            <td>{worker.repo}</td><td><Tag>{worker.lane}</Tag></td><td aria-label={`Tier ${worker.tier}`}>{worker.tier}</td>
            <td aria-label={worker.ageSeconds === null ? 'Age unknown' : `Age ${Math.floor(worker.ageSeconds)} seconds`}>{worker.ageSeconds === null ? '—' : ageText(worker.ageSeconds)}</td>
            <td>{url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`PR for job ${worker.job}`}>PR</a> : '—'}</td></tr>;
        })}</tbody></table></div>}
    {job ? <JobDetailSheet key={job} job={job} onClose={() => setJob(null)} /> : null}
  </section>;
}
