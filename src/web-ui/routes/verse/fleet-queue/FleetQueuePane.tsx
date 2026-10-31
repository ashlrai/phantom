import { SkeletonLine } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { explainReason, explainSkip, laneRows } from '../ops/ops-queue-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-queue.module.css';

export function FleetQueuePane({ visible, host }: PaneProps) {
  const read = useQuery(opsQueueQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(opsQueueQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  const data = read.data;
  const openJob = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };

  if (data === null) return <p className={styles.message}>Queue not in this build</p>;
  if (data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Queue is unavailable.' : <><span>Reading queue…</span><SkeletonLine /><SkeletonLine /></>}</div>;

  return <section className={styles.root} aria-label="Queue">
    <p className={styles.header}>{data.total} jobs · {data.ready} ready · {data.parked} parked · {data.skipsLast24h ?? '—'} precheck skips in 24 h</p>
    {read.status === 'error' && <p className={styles.notice} role="status">Queue could not refresh. Showing the last reading.</p>}
    {Object.values(data.sources).some((source) => source !== 'healthy') && <p className={styles.notice} role="status">Queue data may be incomplete.</p>}
    <section aria-label="By lane"><h3 className={styles.heading}>By lane</h3>
      {data.byLane.length === 0 ? <p className={styles.message}>No lane counts available.</p> : <ul className={styles.list}>{laneRows(data).map((lane) => <li className={styles.row} key={lane.lane}>{lane.lane}: {lane.ready} ready · {lane.parked} parked</li>)}</ul>}
    </section>
    <section aria-label="Parked groups"><h3 className={styles.heading}>Parked groups</h3>
      {data.groups.length === 0 ? <p className={styles.message}>No parked jobs.</p> : <ul className={styles.list}>{data.groups.map((group, index) => <li className={styles.row} key={`${group.reason}:${group.lane}:${index}`}>
        <span>{explainReason(group.reason).title} · {group.lane ?? 'any lane'} · {group.count}</span>
        {group.jobs.length > 0 && <span className={styles.muted}><JobRefs text={group.jobs.slice(0, 8).join(', ')} onOpenJob={openJob} />{group.jobs.length > 8 ? ` +${group.jobs.length - 8} more` : ''}</span>}
      </li>)}</ul>}
    </section>
    <section aria-label="Precheck skips"><h3 className={styles.heading}>Precheck skips</h3>
      {data.skips.length === 0 ? <p className={styles.message}>No precheck skips.</p> : <ul className={styles.list}>{[...data.skips].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map((skip, index) => <li className={styles.row} key={`${skip.at}:${skip.job}:${index}`}>
        <span><JobRefs text={`${skip.job} · ${skip.code} · ${explainSkip(skip.code, skip.reason)}`} onOpenJob={openJob} /></span> <time className={styles.muted} dateTime={skip.at}>{formatRelative(skip.at)}</time>
      </li>)}</ul>}
    </section>
  </section>;
}
