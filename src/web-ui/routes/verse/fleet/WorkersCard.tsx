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
import { ageText, describeWorkers, emptyReason, publishFor, sortWorkers } from './workers-card-model.js';
import { laneShort } from './lane-label.js';
import { notInBuild, workersQuery } from './workers-card-queries.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { ageStateText, workerAgeState } from './worker-age-state.js';
import styles from './workers-card.module.css';

export function WorkersCard() {
  const id = useId();
  const read = useQuery(workersQuery);
  const refresh = useRefresh(workersQuery);
  const [job, setJob] = useState<string | null>(null);
  usePollWhileVisible(() => { void runQuery(workersQuery.key, () => workersQuery.fetch()); }, 5_000, { enabled: !notInBuild(read.error) });
  const data = read.data;
  const healthy = data?.sources.workers === 'healthy' && !read.error;
  const stuckCount = healthy ? data.workers.filter(worker => workerAgeState(worker.lane, worker.ageSeconds) === 'stuck').length : 0;
  return <section className={styles.panel} aria-labelledby={id}>
    <header className={styles.header}><h2 id={id}>Working on this Mac</h2>
      {healthy ? <span>{describeWorkers(data.workers.length)}</span> : null}
      {stuckCount ? <span>{stuckCount} look stuck</span> : null}
      {read.status === 'refreshing' ? <RefreshIndicator /> : null}
      <Button size="sm" onClick={refresh} disabled={notInBuild(read.error)}>Refresh</Button>
    </header>
    {data && data.sources.workers !== 'healthy' ? <StatusBadge status="degraded">worker list {data.sources.workers === 'degraded' ? 'degraded' : 'missing'}</StatusBadge> : null}
    {read.status === 'loading' ? <SkeletonLine /> : !healthy ? <EmptyState compact title="Worker list unavailable" body={notInBuild(read.error) ? 'The worker API is not in this build yet.' : undefined} />
      : !data.workers.length ? <p data-tone={emptyReason(data).tone}>{emptyReason(data).text}</p>
      : <div className={styles.scroll}><table><thead><tr>{['Job', 'Repo', 'Lane', 'Tier', 'Age', 'PR'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{sortWorkers(data.workers).map(worker => {
          const url = publishFor(worker.job, data.publishesLastHour);
          const state = workerAgeState(worker.lane, worker.ageSeconds);
          return <tr key={worker.job} className={state === 'stuck' ? styles.rowStuck : state === 'long' ? styles.rowLong : undefined}><td><button className={styles.job} onClick={() => setJob(worker.job)} aria-label={`Job ${worker.job}`}>{worker.job}</button></td>
            <td>{worker.repo}</td><td><Tag title={worker.lane}>{laneShort(worker.lane)}</Tag></td><td aria-label={`Tier ${worker.tier}`}>{worker.tier}</td>
            <td data-age-state={state} aria-label={worker.ageSeconds === null ? 'Age unknown' : `Age ${Math.floor(worker.ageSeconds)} seconds`}>{worker.ageSeconds === null ? '—' : ageText(worker.ageSeconds)}{state !== 'normal' ? <> <Tag title={ageStateText(state, worker.lane) ?? undefined}>{state === 'long' ? 'long' : 'stuck?'}</Tag></> : null}</td>
            <td>{url ? <a href={url} target="_blank" rel="noreferrer" aria-label={`PR for job ${worker.job}`}>PR</a> : '—'}</td></tr>;
        })}</tbody></table></div>}
    {job ? <JobDetailSheet key={job} job={job} onClose={() => setJob(null)} /> : null}
  </section>;
}
