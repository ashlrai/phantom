import { useEffect, useMemo } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claudeLaneNote, dropRows, formatPulseAge, leaderRows, pulseHeadline } from './leader-pulse-model.js';
import { createLeaderPulseQuery } from './leader-pulse-queries.js';
import styles from './ops.module.css';

export function LeaderPulse() {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const source = useMemo(createLeaderPulseQuery, []);
  useEffect(() => { if (!sectionVisible) source.resetMissing(); }, [sectionVisible, source]);
  const read = useQuery(source.query, { enabled: sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(source.query);
  const missing = read.error instanceof ApiError && read.error.status === 404;
  usePollWhileVisible(refetch, 10_000, { enabled: !missing, refreshOnShow: false });
  const data = read.data;
  const now = Date.now();
  const rows = data ? leaderRows(data, now) : [];
  const drop = data ? dropRows(data) : [];
  const note = data ? claudeLaneNote(data.claudeLane) : null;

  return <div>
    <h3 className={styles.groupTitle}>Leader passes</h3>
    {missing ? <p className={styles.empty}>Leader passes are not in this build yet.</p>
      : read.status === 'error' ? <p className={styles.rowMeta}>Leader passes unavailable. <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button></p>
      : !data ? <div aria-label="Loading leader passes"><SkeletonLine /><SkeletonLine /></div>
      : <>
        <p className={styles.rowMeta}>{pulseHeadline(data, now)}</p>
        {data.paused === false ? <p className={styles.rowMeta}>Dispatcher active</p> : null}
        <ul className={styles.members}>
          {rows.map((row, index) => <li className={styles.chip} key={`${row.label}-${index}`}>
            <StatusBadge status={row.tone} tone={row.tone === 'good' ? 'success' : row.tone === 'warn' ? 'warning' : 'unknown'}>
              {row.label} · {formatPulseAge(row.ageMs)}{row.tone === 'warn' ? ' · stale' : ''}
            </StatusBadge>
          </li>)}
        </ul>
        {note ? <p className={styles.rowMeta}><StatusBadge status="warning" tone="warning">{note}</StatusBadge> Run the lane fix script from the runs dir bin folder.</p> : null}
        {data.drop !== null ? <div className={styles.row}>
          <p className={styles.rowMeta}>{drop.length ? `Waiting for ingest: ${drop.map(row => `${row.lane} ${row.pending}`).join(' · ')}` : 'Drop queue clear'} ({data.drop.done} ingested)</p>
          {drop.length ? <ul className={styles.compact}>{drop.map(row => <li key={row.lane}>{row.lane}: {row.files.join(', ')}</li>)}</ul> : null}
        </div> : null}
      </>}
  </div>;
}
