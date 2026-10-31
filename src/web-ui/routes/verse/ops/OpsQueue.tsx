import { useEffect, useRef } from 'react';
import { StatTile } from '../../../components/charts/StatTile.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { explainReason, explainSkip, laneRows, queueTiles } from './ops-queue-model.js';
import { opsQueueQuery } from './ops-queue-queries.js';
import { relativeText } from './ops-runs-model.js';
import styles from './ops.module.css';
import runs from './ops-runs.module.css';
import queue from './ops-queue.module.css';

export function OpsQueue() {
  const read = useQuery(opsQueueQuery, { freshMs: 0 });
  const refetch = useRefetch(opsQueueQuery);
  const visible = useSectionVisible();
  const wasVisible = useRef(visible);
  const data = read.data;
  useEffect(() => {
    if (visible && !wasVisible.current && data === null) refetch();
    wasVisible.current = visible;
  }, [visible, data, refetch]);
  usePollWhileVisible(refetch, 15_000, { enabled: data !== null });
  if (data === null) return <p>The queue API has not landed in this build yet.</p>;
  if (!data) return <p role="status">{read.status === 'error' ? 'Queue is unavailable.' : 'Reading queue…'}</p>;
  const now = Date.now();
  return <section className={`${styles.panel} ${runs.root}`} aria-label="Queue">
    <div className={runs.tiles}>{queueTiles(data).map(([label, value]) => <div key={label} role="group" aria-label={`${label}: ${value}`}>
      <StatTile label={label} value={value} />
    </div>)}</div>
    {read.status === 'error' ? <p role="status">Queue could not refresh. Showing the last reading.</p> : null}
    {data.sources.ready !== 'healthy' ? <p role="status">Queue data is {data.sources.ready}; counts and parked groups may be incomplete.</p> : null}
    {data.sources.skips !== 'healthy' ? <p role="status">Precheck history is {data.sources.skips}; dropped jobs may be incomplete.</p> : null}
    <h3 className={styles.groupTitle}>Parked, by reason</h3>
    {data.groups.length === 0 ? <p className={styles.empty}>{data.sources.ready === 'healthy' ? 'Nothing parked. Every queued job is READY.' : 'No parked groups available.'}</p> :
      <table className={runs.table} aria-label="Parked, by reason"><thead><tr>{['Reason', 'Lane', 'Count', 'First jobs'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{data.groups.map((group, i) => {
          const explanation = explainReason(group.reason);
          return <tr key={`${group.reason}:${group.lane}:${i}`}>
            <th scope="row">{explanation.title}<span className={queue.detail}>{explanation.detail}</span></th>
            <td>{group.lane ?? '—'}</td><td>{group.count}</td><td>{group.jobs.length ? group.jobs.join(', ') : '—'}</td>
          </tr>;
        })}</tbody>
      </table>}
    <h3 className={styles.groupTitle}>By lane</h3>
    {data.byLane.length === 0 ? <p className={styles.empty}>No lane counts available.</p> : <table className={runs.table} aria-label="By lane">
      <thead><tr><th scope="col">Lane</th><th scope="col">Ready</th><th scope="col">Parked</th></tr></thead>
      <tbody>{laneRows(data).map((lane) => <tr key={lane.lane}><th scope="row">{lane.lane}</th><td>{lane.ready}</td><td>{lane.parked}</td></tr>)}</tbody>
    </table>}
    <h3 className={styles.groupTitle}>Dropped by precheck</h3>
    {data.skips.length === 0 ? <p className={styles.empty}>No precheck drops available.</p> : <ul className={styles.compact}>
      {data.skips.map((skip, i) => <li key={`${skip.at}:${skip.job}:${i}`}><time dateTime={skip.at}>{relativeText(skip.at, now)}</time> · <code>{skip.job}</code> · {explainSkip(skip.code, skip.reason)}</li>)}
    </ul>}
  </section>;
}
