import { Swimlane } from '../../../components/charts/Swimlane.js';
import type { ChartTone } from '../../../components/charts/colors.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { ageText } from '../ops/ops-runs-model.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { timelineLanes } from './fleet-timeline-model.js';
import styles from './fleet-timeline.module.css';

function toneOf(status: string): ChartTone {
  return status === 'running' ? 'success' : status === 'slow' ? 'warning' : status === 'stuck' ? 'danger' : 'unknown';
}

export function FleetTimelinePane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(opsRunsQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(opsRunsQuery);
  const refresh = useRefresh(opsRunsQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const now = Date.now();
  const timeline = data ? timelineLanes(data, now) : null;

  return <div className={styles.pane} aria-label="Worker timeline">
    <header className={styles.header}>
      <p className={styles.headline}>{timeline && data
        ? `${data.workers.length} workers · longest ${timeline.longest ? `${timeline.longest.job} ${ageText(timeline.longest.ageSeconds)}` : '—'} · ${timeline.unknownAge} unknown age`
        : 'Worker timeline'}</p>
      <button type="button" className={styles.refresh} onClick={refresh}>Refresh</button>
    </header>
    {data === null ? <p className={styles.muted}>The fleet runs API has not landed in this build yet.</p>
      : !data || !timeline ? <p className={styles.muted} role="status">{read.status === 'error' ? 'Fleet runs are unavailable.' : 'Reading fleet runs…'}</p>
      : <>
        {read.status === 'error' ? <p className={styles.muted} role="status">Fleet runs could not refresh. Showing the last reading.</p> : null}
        <Swimlane title="Worker timeline" lanes={timeline.lanes} from={timeline.from} to={timeline.to} now={now} status={{ kind: 'ready' }} toneOf={toneOf} />
      </>}
  </div>;
}
