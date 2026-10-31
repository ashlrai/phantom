import { useState } from 'react';
import { Swimlane } from '../../../components/charts/Swimlane.js';
import type { ChartTone } from '../../../components/charts/colors.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { steerPrefill } from '../fleet/job-sheet-actions.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { ageText } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { groupByLane, jobFromItem, laneGroupHeadline, stuckWorkers, timelineLanes } from './fleet-timeline-model.js';
import { readGroupByLane, writeGroupByLane } from './timeline-prefs.js';
import styles from './fleet-timeline.module.css';

function toneOf(status: string): ChartTone {
  return status === 'running' ? 'success' : status === 'slow' ? 'warning' : status === 'stuck' ? 'danger' : 'unknown';
}

export function FleetTimelinePane({ visible }: Pick<PaneProps, 'visible'>) {
  const [grouped, setGrouped] = useState(readGroupByLane);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(opsRunsQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const now = Date.now();
  const timeline = data ? timelineLanes(data, now) : null;

  function openLog(job: string | null): void {
    if (!job || !JOB_ID_RE.test(job)) return;
    requestWorkerLogJob(job);
    openDockPane('worker-log');
  }

  function steer(job: string, lane: string): void {
    openInterjectDialog({ prefill: steerPrefill(job, lane) });
  }

  return <div className={styles.pane} aria-label="Worker timeline">
    <header className={styles.header}>
      <p className={styles.headline}>{timeline && data
        ? <>{data.workers.length} workers · longest {timeline.longest ? <><button type="button" className={styles.longest} onClick={() => openLog(timeline.longest!.job)}>{timeline.longest.job}</button> {ageText(timeline.longest.ageSeconds)}</> : '—'} · {timeline.unknownAge} unknown age</>
        : 'Worker timeline'}</p>
      {timeline?.longest && timeline.longest.ageSeconds > 45 * 60 && JOB_ID_RE.test(timeline.longest.job)
        ? <button type="button" className={styles.refresh} aria-label={`Steer ${timeline.longest.job}`} onClick={() => steer(timeline.longest!.job, timeline.longest!.lane)}>Steer</button> : null}
      <button type="button" className={styles.refresh} aria-pressed={grouped} onClick={() => {
        const next = !grouped; setGrouped(next); writeGroupByLane(next);
      }}>Group by lane</button>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data || !timeline ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {grouped ? groupByLane(data.workers, now).map((group) => {
          const items = timelineLanes({ ...data, lanes: [], workers: group.rows }, now).lanes.flatMap((lane) => lane.items);
          const lanes = items.map((item, index) => ({ id: String(index), label: item.id, items: [item] }));
          const stuck = stuckWorkers(group.rows);
          return <section key={group.lane} aria-label={`${group.lane} lane`}>
            <p className={styles.groupHeadline}>{laneGroupHeadline(group)}</p>
            {stuck.slice(0, 5).map((worker, index) => <p className={styles.groupHeadline} key={`${worker.job}-${index}`}>
              Stuck: {worker.job} {Math.floor(worker.ageSeconds / 60)} m{' '}
              <button type="button" className={styles.refresh} aria-label={`Steer ${worker.job}`} onClick={() => steer(worker.job, worker.lane)}>Steer</button>
            </p>)}
            {stuck.length > 5 ? <p className={styles.groupHeadline}>+{stuck.length - 5} more</p> : null}
            <Swimlane title={`${group.lane} workers`} lanes={lanes} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={(item) => openLog(jobFromItem(item))} />
          </section>;
        }) : <Swimlane title="Worker timeline" lanes={timeline.lanes} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={(item) => openLog(jobFromItem(item))} />}
        <p className={styles.hint}>Click a bar to open its log.</p>
      </>}
  </div>;
}
