import { useQuery, useRefetch } from '../../../data/hooks.js';
import { RunsGraph } from '../fleet/RunsGraph.js';
import { runsGraphQuery } from '../fleet/runs-graph-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { SectionVisibilityProvider, useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { workerAgeSummary } from './graph-summary.js';
import styles from './fleet-graph.module.css';

const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function FleetGraphPane({ visible }: Pick<PaneProps, 'visible'>) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(runsGraphQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(runsGraphQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible && read.data !== null, refreshOnShow: false });
  const runs = read.data;
  const summary = runs ? workerAgeSummary(runs.workers) : null;
  return <div className={styles.pane} aria-label="Fleet graph">
    <header className={styles.summary}>
      {runs ? `${countLabel(runs.lanes?.length ?? 0, 'lane')} · ${countLabel(runs.workers.length, 'worker')} · ${runs.mergesLastHour.count === null ? 'merges unknown' : countLabel(runs.mergesLastHour.count, 'merge')} last hour`
        : runs === null ? 'Fleet runs are not available in this build.' : read.error ? 'Fleet runs could not be read.' : 'Reading fleet runs…'}
      {summary && <span>{` · ${summary}`}</span>}
    </header>
    <SectionVisibilityProvider visible={visible}><RunsGraph /></SectionVisibilityProvider>
  </div>;
}
