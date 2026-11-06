import { useMemo, useState } from 'react';
import { Swimlane, type SwimlaneItem } from '../../../components/charts/Swimlane.js';
import type { ChartTone } from '../../../components/charts/colors.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { busFeedMissing, busFeedQuery } from '../fleet/bus-feed-queries.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { steerPrefill } from '../fleet/job-sheet-actions.js';
import { pullUrl } from '../fleet/job-refs.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { requestSteeringFocus } from '../fleet-steering/steering-focus.js';
import { ageText } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { groupByLane, isMasonItem, jobFromItem, laneGroupHeadline, masonLane, mergesLane, stuckWorkers, timelineLanes } from './fleet-timeline-model.js';
import { ciLane, ciRunUrl } from './ci-lane.js';
import { ciRunsQuery } from './ci-runs-query.js';
import { readGroupByLane, readShowCi, writeGroupByLane, writeShowCi } from './timeline-prefs.js';
import styles from './fleet-timeline.module.css';

function toneOf(status: string): ChartTone {
  return status === 'running' || status === 'merged' || status === 'done' ? 'success' : status === 'slow' || status === 'interjection' ? 'warning' : status === 'stuck' || status === 'failed' ? 'danger' : 'unknown';
}

export function FleetTimelinePane({ visible }: Pick<PaneProps, 'visible'>) {
  const [grouped, setGrouped] = useState(readGroupByLane);
  const [showCi, setShowCi] = useState(readShowCi);
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(opsRunsQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  const bus = useQuery(busFeedQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetchBus = useRefetch(busFeedQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  usePollWhileVisible(() => { if (!busFeedMissing()) refetchBus(); }, 10_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const now = Date.now();
  const timeline = data ? timelineLanes(data, now) : null;
  const mason = timeline && bus.status !== 'error' && bus.data ? masonLane(bus.data.events, timeline.from, timeline.to) : null;
  const merges = timeline && data ? mergesLane(data, timeline.from, timeline.to) : null;
  const hours = timeline ? Math.max(1, Math.min(168, Math.ceil((timeline.to - timeline.from) / 3_600_000))) : 1;
  const ciQuery = useMemo(() => ciRunsQuery(0, hours * 3_600_000), [hours]);
  const ciRead = useQuery(ciQuery, { enabled: Boolean(timeline) && visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetchCi = useRefetch(ciQuery);
  const refreshCi = useRefresh(ciQuery);
  const ci = timeline ? ciLane(ciRead.data, timeline.from, timeline.to) : null;
  usePollWhileVisible(refetchCi, 60_000, { enabled: visible && showCi && Boolean(ci?.lane), refreshOnShow: false });
  const ciVisible = showCi && ci?.lane ? ci : null;

  function openLog(job: string | null): void {
    if (!job || !JOB_ID_RE.test(job)) return;
    requestWorkerLogJob(job);
    openDockPane('worker-log');
  }

  function steer(job: string, lane: string): void {
    openInterjectDialog({ prefill: steerPrefill(job, lane) });
  }

  function selectItem(item: SwimlaneItem): void {
    if (isMasonItem(item)) {
      requestSteeringFocus({ at: item.id.slice('inbox:'.length), label: item.label ?? '' });
      openDockPane('fleet-steering');
    }
    else if (item.id.startsWith('ci:')) {
      const url = ciRunUrl(ciRead.data, item.id);
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } else if (item.status === 'merged') {
      const match = /^merge:(.+)#(\d+)$/.exec(item.id);
      const url = match ? pullUrl(match[1]!, Number(match[2])) : null;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } else openLog(jobFromItem(item));
  }

  return <div className={styles.pane} aria-label="Worker timeline">
    <header className={styles.header}>
      <p className={styles.headline}>{timeline && data
        ? <>{data.workers.length} workers · longest {timeline.longest ? <><button type="button" className={styles.longest} onClick={() => openLog(timeline.longest!.job)}>{timeline.longest.job}</button> {ageText(timeline.longest.ageSeconds)}</> : '—'} · {timeline.unknownAge} unknown age{mason ? ` · ${mason.items.length} interjections in view` : ''}</>
        : 'Worker timeline'}</p>
      {timeline?.longest && timeline.longest.ageSeconds > 45 * 60 && JOB_ID_RE.test(timeline.longest.job)
        ? <button type="button" className={styles.refresh} aria-label={`Steer ${timeline.longest.job}`} onClick={() => steer(timeline.longest!.job, timeline.longest!.lane)}>Steer</button> : null}
      <button type="button" className={styles.refresh} aria-pressed={grouped} onClick={() => {
        const next = !grouped; setGrouped(next); writeGroupByLane(next);
      }}>Group by lane</button>
      {ci?.lane ? <button type="button" className={styles.refresh} aria-pressed={showCi} onClick={() => {
        const next = !showCi; setShowCi(next); writeShowCi(next);
      }}>Show CI</button> : null}
      <button type="button" className={styles.refresh} onClick={() => { refresh(); if (ciRead.data != null) refreshCi(); }}>Refresh</button>
    </header>
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data || !timeline ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        {grouped || ciVisible ? <>
        {mason ? <Swimlane title="Mason" lanes={[mason]} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} /> : null}
        {merges?.lane ? <Swimlane title="Merges" lanes={[merges.lane]} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} /> : null}
        {ciVisible?.lane ? <div title={ciVisible.headline ?? undefined}>
          <Swimlane title="CI" lanes={[ciVisible.lane]} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} />
        </div> : null}
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
            <Swimlane title={`${group.lane} workers`} lanes={lanes} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} />
          </section>;
        }) : <Swimlane title="Worker timeline" lanes={timeline.lanes} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} />}</> : <Swimlane title="Worker timeline" lanes={[...(mason ? [mason] : []), ...(merges?.lane ? [merges.lane] : []), ...timeline.lanes]} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} onSelectItem={selectItem} />}
        {ciVisible?.unplaced ? <p className={styles.hint}>{ciVisible.unplaced} CI runs without a time in this snapshot</p> : null}
        {merges?.unplaced ? <p className={styles.hint}>{merges.unplaced} merges without a time in this snapshot</p> : null}
        {merges && !merges.lane && data.mergesLastHour.count === 0 ? <p className={styles.hint}>No merges in this window</p> : null}
        <p className={styles.hint}>{mason ? 'Click an interjection to open Steering or a worker bar to open its log.' : 'Click a bar to open its log.'}{merges?.lane ? ' Click a merge to open its pull request.' : ''}{ciVisible ? ' Click a CI run to open it in GitHub.' : ''}</p>
      </>}
  </div>;
}
